import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import type { StorageAdapter } from "./storage.js";
import { withTransaction } from "./db.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RetentionResult {
  tombstonesCleaned: number;
  expiredCleaned: number;
  orphansSwept: number;
  rateBucketsCleaned: number;
  unverifiedCleaned: number;
}

export interface RetentionOptions {
  storageFileDeleter?: (key: string, area?: "quarantine" | "clean" | "mime") => void;
}

export async function runRetention(
  pool: Pool,
  storage: StorageAdapter,
  referenceDate = new Date(),
  options: RetentionOptions = {},
): Promise<RetentionResult> {
  const deleteFile = options.storageFileDeleter ?? ((key, area) => storage.delete(key, area));
  let tombstonesCleaned = 0;
  let expiredCleaned = 0;
  let unverifiedCleaned = 0;

  // 1a. Process 7-day expired unverified submissions:
  // Submissions whose notifications are held_unverified and created_at < referenceDate - 7 days
  const sevenDaysAgo = new Date(referenceDate.getTime() - 7 * 24 * 60 * 60 * 1000);
  const unverifiedRes = await pool.query<{ id: string }>(
    `SELECT s.id FROM submissions s
     JOIN notifications n ON n.submission_id = s.id
     WHERE n.state = 'held_unverified' AND s.created_at < $1 AND s.deleted_at IS NULL`,
    [sevenDaysAgo],
  );

  for (const row of unverifiedRes.rows) {
    await withTransaction(pool, async (client: PoolClient) => {
      await client.query(`SELECT id FROM notifications WHERE submission_id = $1 FOR UPDATE`, [
        row.id,
      ]);
      await client.query(`SELECT id FROM submissions WHERE id = $1 FOR UPDATE`, [row.id]);
      await client.query(`UPDATE submissions SET deleted_at = $1 WHERE id = $2`, [
        referenceDate,
        row.id,
      ]);
      await client.query(
        `UPDATE notifications SET state = 'cancelled', updated_at = now()
         WHERE submission_id = $1 AND state = 'held_unverified'`,
        [row.id],
      );
    });
    unverifiedCleaned++;
  }

  // Expire abandoned pending forms older than 7 days
  await pool.query(
    `UPDATE registered_forms
     SET status = 'deactivated', deactivated_at = now()
     WHERE status = 'pending_verification' AND created_at < $1`,
    [sevenDaysAgo],
  );

  // 1b. Process 90-day expired submissions: created_at < referenceDate - 90 days
  const ninetyDaysAgo = new Date(referenceDate.getTime() - 90 * 24 * 60 * 60 * 1000);

  // Find 90-day expired submissions that are not yet marked deleted
  const expiredRes = await pool.query<{ id: string }>(
    `SELECT id FROM submissions
     WHERE created_at < $1 AND deleted_at IS NULL`,
    [ninetyDaysAgo],
  );

  for (const row of expiredRes.rows) {
    await withTransaction(pool, async (client: PoolClient) => {
      // F07: Lock notification first, then submission
      await client.query(`SELECT id FROM notifications WHERE submission_id = $1 FOR UPDATE`, [
        row.id,
      ]);
      await client.query(`SELECT id FROM submissions WHERE id = $1 FOR UPDATE`, [row.id]);

      // Tombstone and cancel unstarted notification
      await client.query(`UPDATE submissions SET deleted_at = $1 WHERE id = $2`, [
        referenceDate,
        row.id,
      ]);
      await client.query(
        `UPDATE notifications
         SET state = 'cancelled', updated_at = now()
         WHERE submission_id = $1 AND state IN ('queued', 'retry_wait', 'preparing')`,
        [row.id],
      );
    });
  }

  // 2. Clean all tombstoned submissions where cleanup_done = false
  const tombstonedRes = await pool.query<{ id: string; created_at: Date }>(
    `SELECT id, created_at FROM submissions
     WHERE deleted_at IS NOT NULL AND cleanup_done = false`,
  );

  for (const row of tombstonedRes.rows) {
    const isNinetyDayExpired = new Date(row.created_at).getTime() < ninetyDaysAgo.getTime();

    // Fetch attachment storage keys and notification mime key
    const attRes = await pool.query<{ id: string; storage_key: string }>(
      `SELECT id, storage_key FROM attachments WHERE submission_id = $1`,
      [row.id],
    );

    const notifRes = await pool.query<{ id: string; mime_key: string | null }>(
      `SELECT id, mime_key FROM notifications WHERE submission_id = $1`,
      [row.id],
    );

    let diskDeletionFailed = false;

    // Delete attachment files from storage
    for (const att of attRes.rows) {
      try {
        deleteFile(att.storage_key);
      } catch (err) {
        diskDeletionFailed = true;
        console.error(`Failed to delete disk storage key ${att.storage_key}:`, err);
      }
    }

    // Delete MIME file if persisted
    if (notifRes.rows[0]?.mime_key) {
      try {
        deleteFile(notifRes.rows[0].mime_key, "mime");
      } catch (err) {
        diskDeletionFailed = true;
        console.error(`Failed to delete MIME file ${notifRes.rows[0].mime_key}:`, err);
      }
    }

    if (diskDeletionFailed) {
      // F02: When any attachment or MIME deletion fails, retain keys and cleanup_done=false; retry next run.
      continue;
    }

    // Disk deletion succeeded! Redact SQL fields and set cleanup_done = true
    await withTransaction(pool, async (client: PoolClient) => {
      // F07: Lock notification first, then submission
      await client.query(`SELECT id FROM notifications WHERE submission_id = $1 FOR UPDATE`, [
        row.id,
      ]);
      await client.query(`SELECT id FROM submissions WHERE id = $1 FOR UPDATE`, [row.id]);

      await client.query(
        `UPDATE submissions
         SET fields = NULL, config_snapshot = NULL, cleanup_done = true
         WHERE id = $1`,
        [row.id],
      );

      // F02: Redact original_name to neutral value '[redacted]'
      await client.query(
        `UPDATE attachments
         SET scan_state = 'deleted', original_name = '[redacted]'
         WHERE submission_id = $1`,
        [row.id],
      );

      await client.query(
        `UPDATE notifications
         SET mime_key = NULL, mime_sha256 = NULL, smtp_receipt = NULL, updated_at = now()
         WHERE submission_id = $1`,
        [row.id],
      );

      if (notifRes.rows[0]?.id) {
        await client.query(
          `UPDATE send_attempts
           SET receipt = NULL
           WHERE notification_id = $1`,
          [notifRes.rows[0].id],
        );
      }
    });

    if (isNinetyDayExpired) {
      expiredCleaned++;
    } else {
      tombstonesCleaned++;
    }
  }

  // 3. Orphan sweep (F01):
  // 3a. Storage age-only sweep operates on temporary staging files only (tmp/)
  const sweptTmp = storage.sweepTmp(24 * 60 * 60 * 1000, referenceDate);
  let orphansSwept = sweptTmp.length;

  // 3b. Sweep quarantine separately:
  // Query references successfully before deleting quarantine files. A database error must NOT become permission to delete them.
  const allAttKeysRes = await pool.query<{ storage_key: string }>(
    `SELECT storage_key FROM attachments`,
  );
  const referencedKeys = new Set(allAttKeysRes.rows.map((r) => r.storage_key));

  const quarantineDir = join(storage.storageDir, "quarantine");
  if (existsSync(quarantineDir)) {
    const files = readdirSync(quarantineDir);
    for (const f of files) {
      if (!UUID_REGEX.test(f)) continue;
      const fullPath = join(quarantineDir, f);
      try {
        const stats = statSync(fullPath);
        const ageMs = referenceDate.getTime() - stats.mtimeMs;
        // Delete only files older than 24h with NO committed attachment reference
        if (ageMs > 24 * 60 * 60 * 1000 && !referencedKeys.has(f)) {
          unlinkSync(fullPath);
          orphansSwept++;
        }
      } catch (err: unknown) {
        const error = err as NodeJS.ErrnoException;
        if (error.code !== "ENOENT") {
          console.error(`Failed to remove unreferenced quarantine file ${f}:`, err);
        }
      }
    }
  }

  // 4. Rate bucket cleanup
  const bucketRes = await pool.query(`DELETE FROM rate_buckets WHERE expires_at < $1`, [
    referenceDate,
  ]);
  const rateBucketsCleaned = bucketRes.rowCount ?? 0;

  return {
    tombstonesCleaned,
    expiredCleaned,
    orphansSwept,
    rateBucketsCleaned,
    unverifiedCleaned,
  };
}
