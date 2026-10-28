import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { FormConfig, Receipt, NotificationState } from "./types.js";
import type { ParsedInput } from "./multipart.js";
import type { StorageAdapter } from "./storage.js";
import { computeFingerprint, Repository } from "./repository.js";
import { withTransaction } from "./db.js";
import { AppError } from "./errors.js";

export interface AcceptDependencies {
  pool: Pool;
  storage: StorageAdapter;
  messageIdDomain?: string;
  initialNotificationState?: NotificationState;
}

export async function acceptSubmission(
  parsed: ParsedInput,
  form: FormConfig,
  deps: AcceptDependencies,
): Promise<Receipt> {
  const { pool, storage, messageIdDomain = "notifications.example.test" } = deps;
  const repo = new Repository(pool);

  // Honeypot short-circuit: already cleaned in multipart parser
  if (parsed.isHoneypot) {
    return {
      submission_id: null,
      status: "received",
    };
  }

  const fingerprint = computeFingerprint(
    parsed.fields,
    parsed.attachments.map((a) => ({
      originalName: a.originalName,
      sizeBytes: a.sizeBytes,
      sha256: a.sha256,
    })),
  );

  // If client_submission_id was provided, check for existing submission
  if (parsed.clientSubmissionId) {
    const existing = await repo.getSubmissionByClientId(pool, form.id, parsed.clientSubmissionId);
    if (existing) {
      // Check 24-hour expiration window
      const ageMs = Date.now() - new Date(existing.created_at).getTime();
      const maxAgeMs = 24 * 60 * 60 * 1000;
      if (ageMs > maxAgeMs) {
        // Clean newly staged files
        for (const att of parsed.attachments) {
          storage.delete(att.storageKey);
        }
        throw new AppError(
          "expired_submission_id",
          409,
          "Client submission ID expired (older than 24 hours). Please generate a new submission ID.",
        );
      }

      // Check if tombstoned / deleted
      if (existing.deleted_at !== null) {
        for (const att of parsed.attachments) {
          storage.delete(att.storageKey);
        }
        throw new AppError(
          "idempotency_conflict",
          410,
          "Submission was deleted and cannot be resubmitted.",
        );
      }

      // Compare fingerprints
      if (existing.fingerprint === fingerprint) {
        // Idempotent retry: clean up duplicate newly staged files and return original receipt
        for (const att of parsed.attachments) {
          storage.delete(att.storageKey);
        }
        return {
          submission_id: existing.id,
          status: "received",
        };
      } else {
        // Conflicting payload for same client ID
        for (const att of parsed.attachments) {
          storage.delete(att.storageKey);
        }
        throw new AppError(
          "idempotency_conflict",
          409,
          "A submission with this _submission_id already exists with different fields or attachments.",
        );
      }
    }
  }

  // Create new durable submission inside a single database transaction
  const submissionId = parsed.submissionId || randomUUID();
  const notificationId = randomUUID();
  const messageId = `<${randomUUID()}@${messageIdDomain}>`;

  try {
    return await withTransaction(pool, async (client: PoolClient) => {
      // If clientSubmissionId is present, handle potential concurrent race with ON CONFLICT DO NOTHING
      if (parsed.clientSubmissionId) {
        const insertRes = await client.query<{ id: string }>(
          `INSERT INTO submissions (
             id, form_id, client_submission_id, fingerprint, fields, config_snapshot, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, now())
           ON CONFLICT (form_id, client_submission_id) DO NOTHING
           RETURNING id`,
          [
            submissionId,
            form.id,
            parsed.clientSubmissionId,
            fingerprint,
            JSON.stringify(parsed.fields),
            JSON.stringify(form),
          ],
        );

        if (insertRes.rows.length === 0) {
          // A concurrent insert occurred with the same (form_id, client_submission_id).
          // Because ON CONFLICT DO NOTHING was used, the transaction remains healthy.
          const existingRes = await client.query<{
            id: string;
            fingerprint: string;
            deleted_at: string | null;
            created_at: string;
          }>(
            `SELECT id, fingerprint, deleted_at, created_at
             FROM submissions
             WHERE form_id = $1 AND client_submission_id = $2`,
            [form.id, parsed.clientSubmissionId],
          );
          const existing = existingRes.rows[0];
          if (!existing) {
            throw new AppError(
              "service_unavailable",
              500,
              "Concurrent submission conflict could not locate existing submission record.",
            );
          }

          // Check 24-hour expiration window
          const ageMs = Date.now() - new Date(existing.created_at).getTime();
          const maxAgeMs = 24 * 60 * 60 * 1000;
          if (ageMs > maxAgeMs) {
            throw new AppError(
              "expired_submission_id",
              409,
              "Client submission ID expired (older than 24 hours). Please generate a new submission ID.",
            );
          }

          // Check if tombstoned / deleted
          if (existing.deleted_at !== null) {
            throw new AppError(
              "idempotency_conflict",
              410,
              "Submission was deleted and cannot be resubmitted.",
            );
          }

          // Compare fingerprints
          if (existing.fingerprint !== fingerprint) {
            throw new AppError(
              "idempotency_conflict",
              409,
              "A submission with this _submission_id already exists with different fields or attachments.",
            );
          }

          // Concurrent duplicate matches: clean newly staged duplicate files and return original receipt
          for (const att of parsed.attachments) {
            storage.delete(att.storageKey);
          }
          return {
            submission_id: existing.id,
            status: "received",
          };
        }
      } else {
        // No clientSubmissionId provided: standard insert
        await client.query(
          `INSERT INTO submissions (
             id, form_id, client_submission_id, fingerprint, fields, config_snapshot, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, now())`,
          [
            submissionId,
            form.id,
            null,
            fingerprint,
            JSON.stringify(parsed.fields),
            JSON.stringify(form),
          ],
        );
      }

      // Insert attachment records for newly created submission
      for (const att of parsed.attachments) {
        await client.query(
          `INSERT INTO attachments (
             id, submission_id, storage_key, original_name, size_bytes, sha256, scan_state, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', now())`,
          [att.id, submissionId, att.storageKey, att.originalName, att.sizeBytes, att.sha256],
        );
      }

      // Insert single outbox notification (queued or held_unverified)
      const notificationState = deps.initialNotificationState || "queued";
      await client.query(
        `INSERT INTO notifications (
           id, submission_id, message_id, state, attempt_count, prepare_failures, next_attempt_at, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 0, 0, now(), now(), now())`,
        [notificationId, submissionId, messageId, notificationState],
      );

      return {
        submission_id: submissionId,
        status: "received",
      };
    });
  } catch (err) {
    // Transaction rolled back or failed: clean newly staged files
    for (const att of parsed.attachments) {
      storage.delete(att.storageKey);
    }
    throw err;
  }
}
