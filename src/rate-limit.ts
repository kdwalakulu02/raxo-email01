import { createHash, createHmac } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "./db.js";
import { AppError } from "./errors.js";

export function computeIpHash(ipHashSecret: string, dateIso: string, remoteIp: string): string {
  const secret = ipHashSecret || "default_local_hash_secret_for_dev";
  const dateStr = dateIso.substring(0, 10); // YYYY-MM-DD
  const normalizedIp = remoteIp.trim().toLowerCase();
  return createHmac("sha256", secret).update(`${dateStr}:${normalizedIp}`).digest("hex");
}

export async function consumeRateLimit(
  pool: Pool,
  formId: string,
  ipHash: string,
  now: Date = new Date(),
  minuteLimit = 5,
  dailyLimit = 100,
): Promise<void> {
  // minute bucket key: floor to current minute (e.g. YYYY-MM-DDTHH:MM)
  const minuteFloor = new Date(Math.floor(now.getTime() / 60000) * 60000);
  const minuteKey = `${ipHash}_${minuteFloor.toISOString().substring(0, 16)}`;
  const minuteExpires = new Date(now.getTime() + 60 * 60 * 1000); // 1h expiry

  // day bucket key: UTC date (YYYY-MM-DD)
  const dayKey = now.toISOString().substring(0, 10);
  const dayExpires = new Date(now.getTime() + 36 * 60 * 60 * 1000); // 36h expiry

  await withTransaction(pool, async (client: PoolClient) => {
    // Increment minute bucket
    const minuteRes = await client.query<{ hits: number }>(
      `INSERT INTO rate_buckets (form_id, bucket_kind, bucket_key, hits, expires_at)
       VALUES ($1, 'ip_minute', $2, 1, $3)
       ON CONFLICT (form_id, bucket_kind, bucket_key)
       DO UPDATE SET hits = rate_buckets.hits + 1
       WHERE rate_buckets.hits < $4
       RETURNING hits;`,
      [formId, minuteKey, minuteExpires, minuteLimit],
    );

    if (minuteRes.rowCount === 0) {
      throw new AppError(
        "rate_limited",
        429,
        "Too many form submission attempts from your IP. Please try again later.",
      );
    }

    // Increment daily form bucket
    const dayRes = await client.query<{ hits: number }>(
      `INSERT INTO rate_buckets (form_id, bucket_kind, bucket_key, hits, expires_at)
       VALUES ($1, 'form_day', $2, 1, $3)
       ON CONFLICT (form_id, bucket_kind, bucket_key)
       DO UPDATE SET hits = rate_buckets.hits + 1
       WHERE rate_buckets.hits < $4
       RETURNING hits;`,
      [formId, dayKey, dayExpires, dailyLimit],
    );

    if (dayRes.rowCount === 0) {
      throw new AppError(
        "rate_limited",
        429,
        "Form daily attempt limit reached. Please try again tomorrow.",
      );
    }
  });
}

export async function consumeRegistrationRateLimit(
  pool: Pool,
  ipHash: string,
  now: Date = new Date(),
  hourlyLimit = 10,
): Promise<void> {
  const hourFloor = new Date(Math.floor(now.getTime() / 3600000) * 3600000);
  const hourKey = `${ipHash}_${hourFloor.toISOString().substring(0, 13)}`;
  const expires = new Date(now.getTime() + 2 * 3600000);

  await withTransaction(pool, async (client: PoolClient) => {
    const res = await client.query<{ hits: number }>(
      `INSERT INTO rate_buckets (form_id, bucket_kind, bucket_key, hits, expires_at)
       VALUES ('__registration__', 'register_ip_hour', $1, 1, $2)
       ON CONFLICT (form_id, bucket_kind, bucket_key)
       DO UPDATE SET hits = rate_buckets.hits + 1
       WHERE rate_buckets.hits < $3
       RETURNING hits;`,
      [hourKey, expires, hourlyLimit],
    );

    if (res.rowCount === 0) {
      throw new AppError(
        "rate_limited",
        429,
        "Too many form creation attempts from your IP. Please try again in an hour.",
      );
    }
  });
}

export async function consumeRecipientRegistrationRateLimit(
  pool: Pool,
  recipientEmail: string,
  now: Date = new Date(),
  hourlyLimit = 3,
): Promise<void> {
  const normalizedEmail = recipientEmail.trim().toLowerCase();
  const recipientHash = createHash("sha256").update(normalizedEmail).digest("hex");
  const hourFloor = new Date(Math.floor(now.getTime() / 3600000) * 3600000);
  const hourKey = `${recipientHash}_${hourFloor.toISOString().substring(0, 13)}`;
  const expires = new Date(now.getTime() + 2 * 3600000);

  await withTransaction(pool, async (client: PoolClient) => {
    const res = await client.query<{ hits: number }>(
      `INSERT INTO rate_buckets (form_id, bucket_kind, bucket_key, hits, expires_at)
       VALUES ('__registration_recipient__', 'register_recipient_hour', $1, 1, $2)
       ON CONFLICT (form_id, bucket_kind, bucket_key)
       DO UPDATE SET hits = rate_buckets.hits + 1
       WHERE rate_buckets.hits < $3
       RETURNING hits;`,
      [hourKey, expires, hourlyLimit],
    );

    if (res.rowCount === 0) {
      throw new AppError(
        "rate_limited",
        429,
        "Too many form creation attempts for this email address. Please try again in an hour.",
      );
    }
  });
}

export async function consumeGlobalRateLimit(
  pool: Pool,
  now: Date = new Date(),
  minuteLimit = 1000,
): Promise<void> {
  const minuteFloor = new Date(Math.floor(now.getTime() / 60000) * 60000);
  const minuteKey = minuteFloor.toISOString().substring(0, 16);
  const expires = new Date(now.getTime() + 60 * 60 * 1000);

  await withTransaction(pool, async (client: PoolClient) => {
    const res = await client.query<{ hits: number }>(
      `INSERT INTO rate_buckets (form_id, bucket_kind, bucket_key, hits, expires_at)
       VALUES ('__global__', 'global_minute', $1, 1, $2)
       ON CONFLICT (form_id, bucket_kind, bucket_key)
       DO UPDATE SET hits = rate_buckets.hits + 1
       WHERE rate_buckets.hits < $3
       RETURNING hits;`,
      [minuteKey, expires, minuteLimit],
    );

    if (res.rowCount === 0) {
      throw new AppError(
        "service_unavailable",
        503,
        "Service capacity temporarily reached. Please retry in a few moments.",
      );
    }
  });
}

export async function consumeDeactivationRateLimit(
  pool: Pool,
  formId: string,
  now: Date = new Date(),
  hourlyLimit = 5,
): Promise<void> {
  const hourFloor = new Date(Math.floor(now.getTime() / 3600000) * 3600000);
  const hourKey = hourFloor.toISOString().substring(0, 13);
  const expires = new Date(now.getTime() + 2 * 3600000);

  await withTransaction(pool, async (client: PoolClient) => {
    const res = await client.query<{ hits: number }>(
      `INSERT INTO rate_buckets (form_id, bucket_kind, bucket_key, hits, expires_at)
       VALUES ($1, 'deactivate_form_hour', $2, 1, $3)
       ON CONFLICT (form_id, bucket_kind, bucket_key)
       DO UPDATE SET hits = rate_buckets.hits + 1
       WHERE rate_buckets.hits < $4
       RETURNING hits;`,
      [formId, hourKey, expires, hourlyLimit],
    );

    if (res.rowCount === 0) {
      throw new AppError(
        "rate_limited",
        429,
        "Too many deactivation attempts for this form. Please try again later.",
      );
    }
  });
}
