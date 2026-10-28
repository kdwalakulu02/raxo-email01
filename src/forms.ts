import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { RegisteredForm } from "./types.js";
import { AppError } from "./errors.js";
import { withTransaction } from "./db.js";

const EMAIL_REGEX =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

export function computeTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Generate a cryptographically secure 192-bit random identifier.
 * 192 bits = 24 bytes, URL-safe base64url encoded (32 chars: [A-Za-z0-9_-]).
 */
export function generate192BitFormId(): string {
  return randomBytes(24).toString("base64url");
}

export function generateToken(byteLength = 32): { token: string; hash: string } {
  const token = randomBytes(byteLength).toString("base64url");
  const hash = computeTokenHash(token);
  return { token, hash };
}

export function validateRecipientEmail(rawEmail: unknown): string {
  if (typeof rawEmail !== "string") {
    throw new AppError("bad_request", 400, "Recipient email is required");
  }

  const email = rawEmail.trim();
  if (email.length === 0) {
    throw new AppError("bad_request", 400, "Recipient email cannot be empty");
  }

  if (email.length > 254) {
    throw new AppError(
      "bad_request",
      400,
      "Recipient email exceeds maximum length of 254 characters",
    );
  }

  if (/[\r\n]/.test(email)) {
    throw new AppError("bad_request", 400, "Recipient email contains forbidden control characters");
  }

  if (!EMAIL_REGEX.test(email)) {
    throw new AppError("bad_request", 400, "Invalid recipient email format");
  }

  return email.toLowerCase();
}

export interface CreateFormResult {
  form: RegisteredForm;
  formId: string;
  verificationToken: string;
  managementToken: string;
}

export async function createDynamicForm(
  pool: Pool,
  rawEmail: string,
  options: { maxRetries?: number } = {},
): Promise<CreateFormResult> {
  const email = validateRecipientEmail(rawEmail);
  const maxRetries = options.maxRetries ?? 3;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const formId = generate192BitFormId();
    const { token: verificationToken, hash: verificationTokenHash } = generateToken(32);
    const { token: managementToken, hash: managementTokenHash } = generateToken(32);
    const verificationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
    const formUuid = randomBytes(16).toString("hex");
    // Format uuid: 8-4-4-4-12
    const formattedUuid = [
      formUuid.substring(0, 8),
      formUuid.substring(8, 12),
      formUuid.substring(12, 16),
      formUuid.substring(16, 20),
      formUuid.substring(20, 32),
    ].join("-");

    try {
      const res = await pool.query<RegisteredForm>(
        `INSERT INTO registered_forms (
           id, public_id, recipient_email, status,
           verification_token_hash, verification_expires_at,
           management_token_hash, resend_count, last_verification_sent_at,
           created_at
         ) VALUES ($1, $2, $3, 'pending_verification', $4, $5, $6, 0, now(), now())
         RETURNING id, public_id, recipient_email, status,
                   verification_token_hash, verification_expires_at,
                   management_token_hash, resend_count, last_verification_sent_at,
                   created_at, verified_at, deactivated_at;`,
        [
          formattedUuid,
          formId,
          email,
          verificationTokenHash,
          verificationExpiresAt,
          managementTokenHash,
        ],
      );

      return {
        form: res.rows[0],
        formId,
        verificationToken,
        managementToken,
      };
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      // PostgreSQL unique violation is error code 23505
      if (pgErr.code === "23505" && attempt < maxRetries - 1) {
        continue;
      }
      throw err;
    }
  }

  throw new AppError(
    "service_unavailable",
    500,
    "Failed to generate unique Form ID after maximum retries",
  );
}

export async function getDynamicFormByPublicId(
  pool: Pool,
  publicId: string,
): Promise<RegisteredForm | null> {
  const res = await pool.query<RegisteredForm>(
    `SELECT id, public_id, recipient_email, status,
            verification_token_hash, verification_expires_at,
            management_token_hash, resend_count, last_verification_sent_at,
            created_at, verified_at, deactivated_at
     FROM registered_forms
     WHERE public_id = $1`,
    [publicId],
  );
  return res.rows[0] ?? null;
}

export interface VerifyResult {
  form: RegisteredForm;
  promotedNotifications: number;
}

export async function verifyDynamicForm(pool: Pool, token: string): Promise<VerifyResult> {
  if (!token || typeof token !== "string" || token.trim().length === 0) {
    throw new AppError("bad_request", 400, "Verification token is required");
  }

  const tokenHash = computeTokenHash(token.trim());

  return await withTransaction(pool, async (client: PoolClient) => {
    const res = await client.query<RegisteredForm>(
      `SELECT id, public_id, recipient_email, status,
              verification_token_hash, verification_expires_at,
              management_token_hash, resend_count, last_verification_sent_at,
              created_at, verified_at, deactivated_at
       FROM registered_forms
       WHERE verification_token_hash = $1
       FOR UPDATE`,
      [tokenHash],
    );

    const form = res.rows[0];
    if (!form) {
      throw new AppError("not_found", 404, "Invalid or already used verification token");
    }

    if (form.status === "deactivated") {
      throw new AppError("forbidden", 403, "This form has been deactivated");
    }

    if (form.verification_expires_at && new Date(form.verification_expires_at) < new Date()) {
      throw new AppError(
        "bad_request",
        400,
        "Verification token has expired. Please request a new verification email.",
      );
    }

    // Activate the form and clear the single-use token
    const updateRes = await client.query<RegisteredForm>(
      `UPDATE registered_forms
       SET status = 'active',
           verified_at = now(),
           verification_token_hash = NULL,
           verification_expires_at = NULL
       WHERE id = $1
       RETURNING id, public_id, recipient_email, status,
                 verification_token_hash, verification_expires_at,
                 management_token_hash, resend_count, last_verification_sent_at,
                 created_at, verified_at, deactivated_at;`,
      [form.id],
    );

    // Promote all held notifications for this form to queued
    const promoteRes = await client.query(
      `UPDATE notifications
       SET state = 'queued', next_attempt_at = now(), updated_at = now()
       FROM submissions s
       WHERE notifications.submission_id = s.id
         AND s.form_id = $1
         AND notifications.state = 'held_unverified'`,
      [form.public_id],
    );

    return {
      form: updateRes.rows[0],
      promotedNotifications: promoteRes.rowCount ?? 0,
    };
  });
}

export async function deactivateDynamicForm(
  pool: Pool,
  publicId: string,
  managementToken: string,
): Promise<boolean> {
  if (
    !managementToken ||
    typeof managementToken !== "string" ||
    managementToken.trim().length === 0
  ) {
    throw new AppError("bad_request", 400, "Management token is required for deactivation");
  }

  const tokenHash = computeTokenHash(managementToken.trim());

  return await withTransaction(pool, async (client: PoolClient) => {
    const res = await client.query<RegisteredForm>(
      `SELECT id, public_id, management_token_hash, status
       FROM registered_forms
       WHERE public_id = $1
       FOR UPDATE`,
      [publicId],
    );

    const form = res.rows[0];
    if (!form) {
      throw new AppError("not_found", 404, "Form not found");
    }

    const expectedHash = Buffer.from(form.management_token_hash, "utf8");
    const actualHash = Buffer.from(tokenHash, "utf8");
    if (expectedHash.length !== actualHash.length || !timingSafeEqual(expectedHash, actualHash)) {
      throw new AppError("forbidden", 403, "Invalid management token");
    }

    await client.query(
      `UPDATE registered_forms
       SET status = 'deactivated', deactivated_at = now()
       WHERE id = $1`,
      [form.id],
    );

    // Cancel any pending notifications
    await client.query(
      `UPDATE notifications
       SET state = 'cancelled', updated_at = now()
       FROM submissions s
       WHERE notifications.submission_id = s.id
         AND s.form_id = $1
         AND notifications.state IN ('queued', 'retry_wait', 'held_unverified')`,
      [publicId],
    );

    return true;
  });
}

export async function resendDynamicFormVerification(
  pool: Pool,
  publicId: string,
): Promise<{ form: RegisteredForm; verificationToken: string }> {
  return await withTransaction(pool, async (client: PoolClient) => {
    const res = await client.query<RegisteredForm>(
      `SELECT id, public_id, recipient_email, status, resend_count, last_verification_sent_at
       FROM registered_forms
       WHERE public_id = $1
       FOR UPDATE`,
      [publicId],
    );

    const form = res.rows[0];
    if (!form) {
      throw new AppError("not_found", 404, "Form not found");
    }

    if (form.status === "active") {
      throw new AppError("bad_request", 400, "Form is already verified and active");
    }

    if (form.status === "deactivated") {
      throw new AppError("forbidden", 403, "Form has been deactivated");
    }

    // Rate limiting: at least 60 seconds between resends, max 5 total resends
    const now = Date.now();
    const lastSentMs = new Date(form.last_verification_sent_at).getTime();
    if (now - lastSentMs < 60000) {
      throw new AppError(
        "rate_limited",
        429,
        `Please wait at least 60 seconds before requesting another verification email (${Math.ceil((60000 - (now - lastSentMs)) / 1000)}s remaining)`,
      );
    }

    if (form.resend_count >= 5) {
      throw new AppError(
        "rate_limited",
        429,
        "Maximum verification resend limit reached for this form",
      );
    }

    const { token: verificationToken, hash: verificationTokenHash } = generateToken(32);
    const verificationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const updateRes = await client.query<RegisteredForm>(
      `UPDATE registered_forms
       SET verification_token_hash = $1,
           verification_expires_at = $2,
           resend_count = resend_count + 1,
           last_verification_sent_at = now()
       WHERE id = $3
       RETURNING id, public_id, recipient_email, status,
                 verification_token_hash, verification_expires_at,
                 management_token_hash, resend_count, last_verification_sent_at,
                 created_at, verified_at, deactivated_at;`,
      [verificationTokenHash, verificationExpiresAt, form.id],
    );

    return {
      form: updateRes.rows[0],
      verificationToken,
    };
  });
}

export function generateHtmlSnippet(baseUrl: string, formId: string): string {
  const cleanBase = baseUrl.replace(/\/+$/, "");
  return `<form action="${cleanBase}/f/${formId}" method="POST">
  <!-- Recipient fields -->
  <label for="name">Your Name</label>
  <input type="text" id="name" name="name" required placeholder="Alex Smith">

  <label for="email">Your Email</label>
  <input type="email" id="email" name="email" required placeholder="alex@example.com">

  <label for="message">Message</label>
  <textarea id="message" name="message" rows="4" required placeholder="Hello..."></textarea>

  <!-- Spam prevention: honeypot field (hidden from real users) -->
  <input type="text" name="_honey" style="display:none" tabindex="-1" autocomplete="off">

  <!-- Optional custom redirect URL after submission -->
  <!-- <input type="hidden" name="_next" value="https://example.com/thanks"> -->

  <button type="submit">Send Message</button>
</form>`;
}
