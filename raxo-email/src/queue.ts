import { randomUUID, createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Notification, Submission, Attachment, FormConfig, SubmitResult } from "./types.js";
import type { StorageAdapter } from "./storage.js";
import { Repository } from "./repository.js";
import { withTransaction } from "./db.js";
import { dualScan, type SentinelConfig } from "./dual-scan.js";
import { buildNotification } from "./mime.js";
import { submitRaw, type SmtpConfig } from "./smtp.js";
import { AppError } from "./errors.js";

const RETRY_DELAYS_SECONDS = [60, 300, 1800, 7200]; // 1m, 5m, 30m, 2h (initial try + 4 retries = 5 attempts)

export interface QueueDependencies {
  pool: Pool;
  storage: StorageAdapter;
  smtpConfig: SmtpConfig;
  scannerHost: string;
  scannerPort: number;
  maxMimeBytes?: number;
  outboundEnabled?: boolean;
  isOwnershipValid?: () => boolean;
  sentinel?: SentinelConfig;
}

export async function recoverExpiredLeases(
  pool: Pool,
): Promise<{ recoveredPreparing: number; expiredSubmitting: number }> {
  let recoveredPreparing = 0;
  let expiredSubmitting = 0;

  await withTransaction(pool, async (client: PoolClient) => {
    // 1. Recover expired preparing -> queued (so it can be prepared again safely)
    const prepRes = await client.query(
      `UPDATE notifications
       SET state = 'queued', lease_token = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE state = 'preparing' AND lease_expires_at < now()`,
    );
    recoveredPreparing = prepRes.rowCount ?? 0;

    // 2. Expired submitting -> unknown (as remote MTA may have accepted DATA)
    const subRes = await client.query<{ id: string }>(
      `UPDATE notifications
       SET state = 'unknown', last_error_code = 'lease_expired_during_submitting',
           lease_token = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE state = 'submitting' AND lease_expires_at < now()
       RETURNING id`,
    );
    expiredSubmitting = subRes.rowCount ?? 0;

    for (const row of subRes.rows) {
      await client.query(
        `UPDATE send_attempts
         SET outcome = 'unknown', error_code = 'lease_expired_during_submitting', finished_at = now()
         WHERE notification_id = $1 AND outcome = 'submitting'`,
        [row.id],
      );
    }
  });

  return { recoveredPreparing, expiredSubmitting };
}

export async function claimDueNotification(
  pool: Pool,
  leaseDurationSeconds = 120,
): Promise<{ notification: Notification; leaseToken: string } | null> {
  const leaseToken = randomUUID();

  return withTransaction(pool, async (client: PoolClient) => {
    // Select due notification with FOR UPDATE SKIP LOCKED
    const res = await client.query<Notification>(
      `SELECT n.id, n.submission_id, n.message_id, n.state, n.attempt_count, n.prepare_failures,
              n.next_attempt_at, n.lease_token, n.lease_expires_at, n.mime_key, n.mime_sha256,
              n.last_error_code, n.smtp_receipt, n.created_at, n.updated_at
       FROM notifications n
       JOIN submissions s ON s.id = n.submission_id
       WHERE n.state IN ('queued', 'retry_wait')
         AND n.next_attempt_at <= now()
         AND s.deleted_at IS NULL
       ORDER BY n.next_attempt_at ASC, n.created_at ASC
       FOR UPDATE OF n SKIP LOCKED
       LIMIT 1`,
    );

    if (res.rows.length === 0) {
      return null;
    }

    const notif = res.rows[0];

    // Mark as preparing and set lease token
    await client.query(
      `UPDATE notifications
       SET state = 'preparing',
           lease_token = $1,
           lease_expires_at = now() + ($2 || ' seconds')::interval,
           updated_at = now()
       WHERE id = $3`,
      [leaseToken, leaseDurationSeconds, notif.id],
    );

    return { notification: notif, leaseToken };
  });
}

export async function renewLease(
  pool: Pool,
  notificationId: string,
  leaseToken: string,
  leaseDurationSeconds = 120,
): Promise<boolean> {
  const res = await pool.query(
    `UPDATE notifications
     SET lease_expires_at = now() + ($1 || ' seconds')::interval, updated_at = now()
     WHERE id = $2 AND lease_token = $3`,
    [leaseDurationSeconds, notificationId, leaseToken],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function processNotification(
  notif: Notification,
  leaseToken: string,
  deps: QueueDependencies,
): Promise<{ status: string; outcome?: string }> {
  const { pool, storage, smtpConfig, scannerHost, scannerPort } = deps;
  const repo = new Repository(pool);

  // 1. Fetch submission and verify not deleted
  const submission = await repo.getSubmission(notif.submission_id);
  if (!submission || submission.deleted_at !== null) {
    // Submission was deleted: mark cancelled
    await pool.query(
      `UPDATE notifications
       SET state = 'cancelled', lease_token = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND lease_token = $2`,
      [notif.id, leaseToken],
    );
    return { status: "cancelled" };
  }

  const formConfig = submission.config_snapshot as FormConfig;
  const attachments = await repo.getAttachmentsForSubmission(notif.submission_id);

  // 2. Scan attachments
  const scannedAttachments: Array<{ filename: string; content: Buffer }> = [];

  for (const att of attachments) {
    // If deleted, stop
    if (att.scan_state === "deleted") {
      throw new AppError("not_found", 404, "Attachment was deleted");
    }

    // F05: Verify attachment size and SHA-256 before relying on cached clean scan or MIME
    const area = att.scan_state === "clean" ? "clean" : "quarantine";
    let content: Buffer;
    try {
      content = storage.read(att.storage_key, area);
    } catch {
      await pool.query(
        `UPDATE notifications
         SET state = 'failed', last_error_code = 'attachment_integrity_error',
             lease_token = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE id = $1 AND lease_token = $2`,
        [notif.id, leaseToken],
      );
      return { status: "failed", outcome: "attachment_integrity_error" };
    }

    const actualSha256 = createHash("sha256").update(content).digest("hex");
    if (content.length !== Number(att.size_bytes) || actualSha256 !== att.sha256) {
      await pool.query(
        `UPDATE notifications
         SET state = 'failed', last_error_code = 'attachment_integrity_error',
             lease_token = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE id = $1 AND lease_token = $2`,
        [notif.id, leaseToken],
      );
      return { status: "failed", outcome: "attachment_integrity_error" };
    }

    // Check if fresh clean scan <= 48h exists
    const isCleanFresh =
      att.scan_state === "clean" &&
      att.scanned_at &&
      Date.now() - new Date(att.scanned_at).getTime() <= 48 * 60 * 60 * 1000;

    if (!isCleanFresh) {
      // Both scanners examine the same SHA-256-verified bytes; only ClamAV drives the policy below.
      const scanRes = await dualScan(
        pool,
        att.id,
        notif.id,
        content,
        actualSha256,
        { host: scannerHost, port: scannerPort },
        deps.sentinel,
      );

      if (scanRes.kind === "blocked") {
        // Malware detected! Mark attachment and notification blocked
        await repo.updateAttachmentScan(pool, att.id, "blocked");
        await pool.query(
          `UPDATE notifications
           SET state = 'blocked', last_error_code = $1, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
           WHERE id = $2 AND lease_token = $3`,
          [scanRes.reason, notif.id, leaseToken],
        );
        return { status: "blocked", outcome: scanRes.reason };
      }

      if (scanRes.kind === "error") {
        // Scanner failure/unavailable: increment prepare_failures
        const newFailures = notif.prepare_failures + 1;
        if (newFailures >= 5) {
          // Exceeded 5 scan failure budget: mark blocked
          await pool.query(
            `UPDATE notifications
             SET state = 'blocked', prepare_failures = $1, last_error_code = 'scanner_unavailable',
                 lease_token = NULL, lease_expires_at = NULL, updated_at = now()
             WHERE id = $2 AND lease_token = $3`,
            [newFailures, notif.id, leaseToken],
          );
          return { status: "blocked", outcome: "scanner_unavailable" };
        } else {
          // Schedule retry_wait after 60s
          await pool.query(
            `UPDATE notifications
             SET state = 'retry_wait', prepare_failures = $1, last_error_code = 'scanner_error',
                 next_attempt_at = now() + interval '60 seconds',
                 lease_token = NULL, lease_expires_at = NULL, updated_at = now()
             WHERE id = $2 AND lease_token = $3`,
            [newFailures, notif.id, leaseToken],
          );
          return { status: "retry_wait", outcome: "scanner_error" };
        }
      }

      // Scanner verdict: clean!
      storage.moveToClean(att.storage_key);
      await repo.updateAttachmentScan(pool, att.id, "clean", scanRes.version);
      content = storage.read(att.storage_key, "clean");
      if (createHash("sha256").update(content).digest("hex") !== actualSha256) {
        await pool.query(
          `UPDATE notifications
           SET state = 'failed', last_error_code = 'attachment_integrity_error',
               lease_token = NULL, lease_expires_at = NULL, updated_at = now()
           WHERE id = $1 AND lease_token = $2`,
          [notif.id, leaseToken],
        );
        return { status: "failed", outcome: "attachment_integrity_error" };
      }
    }

    scannedAttachments.push({
      filename: att.original_name,
      content,
    });
  }

  // 3. Build or reuse immutable MIME (F05)
  let mimeBuffer: Buffer;
  let mimeKey = notif.mime_key;

  if (mimeKey) {
    if (!notif.mime_sha256) {
      await pool.query(
        `UPDATE notifications
         SET state = 'failed', last_error_code = 'mime_integrity_error',
             lease_token = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE id = $1 AND lease_token = $2`,
        [notif.id, leaseToken],
      );
      return { status: "failed", outcome: "mime_integrity_error" };
    }

    try {
      mimeBuffer = storage.read(mimeKey, "mime");
    } catch {
      // Stored MIME missing or unreadable on retry: do not recompose silently
      await pool.query(
        `UPDATE notifications
         SET state = 'failed', last_error_code = 'mime_integrity_error',
             lease_token = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE id = $1 AND lease_token = $2`,
        [notif.id, leaseToken],
      );
      return { status: "failed", outcome: "mime_integrity_error" };
    }

    const actualMimeSha256 = createHash("sha256").update(mimeBuffer).digest("hex");
    if (actualMimeSha256 !== notif.mime_sha256) {
      // MIME bytes altered or corrupted!
      await pool.query(
        `UPDATE notifications
         SET state = 'failed', last_error_code = 'mime_integrity_error',
             lease_token = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE id = $1 AND lease_token = $2`,
        [notif.id, leaseToken],
      );
      return { status: "failed", outcome: "mime_integrity_error" };
    }
  } else {
    try {
      mimeBuffer = await buildNotification(
        formConfig,
        {
          submissionId: submission.id,
          createdAt: submission.created_at,
          fields: submission.fields || {},
          messageId: notif.message_id,
        },
        scannedAttachments,
        deps.maxMimeBytes,
      );
    } catch (err) {
      if (err instanceof AppError && err.code === "mime_too_large") {
        await pool.query(
          `UPDATE notifications
           SET state = 'failed', last_error_code = 'mime_too_large', lease_token = NULL, lease_expires_at = NULL, updated_at = now()
           WHERE id = $1 AND lease_token = $2`,
          [notif.id, leaseToken],
        );
        return { status: "failed", outcome: "mime_too_large" };
      }
      throw err;
    }

    const persisted = storage.persistMime(mimeBuffer);
    mimeKey = persisted.key;

    await pool.query(
      `UPDATE notifications
       SET mime_key = $1, mime_sha256 = $2, updated_at = now()
       WHERE id = $3 AND lease_token = $4`,
      [persisted.key, persisted.sha256, notif.id, leaseToken],
    );
  }

  // 4. Compare-and-swap preparing -> submitting before network I/O
  const attemptId = randomUUID();
  const nextAttemptNumber = notif.attempt_count + 1;

  if (deps.isOwnershipValid && !deps.isOwnershipValid()) {
    return { status: "aborted", outcome: "ownership_lost" };
  }

  const casSuccess = await withTransaction(pool, async (client: PoolClient) => {
    // F07: Lock notification first FOR UPDATE
    const notifRow = await client.query<{
      state: string;
      lease_token: string;
      lease_expires_at: Date;
    }>(`SELECT state, lease_token, lease_expires_at FROM notifications WHERE id = $1 FOR UPDATE`, [
      notif.id,
    ]);

    if (notifRow.rows.length === 0) {
      return false;
    }

    const currentNotif = notifRow.rows[0];
    if (
      currentNotif.state !== "preparing" ||
      currentNotif.lease_token !== leaseToken ||
      new Date(currentNotif.lease_expires_at).getTime() <= Date.now()
    ) {
      return false;
    }

    // F07: Lock submission second FOR UPDATE
    const subCheck = await client.query<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM submissions WHERE id = $1 FOR UPDATE`,
      [notif.submission_id],
    );

    if (!subCheck.rows[0] || subCheck.rows[0].deleted_at !== null) {
      await client.query(
        `UPDATE notifications
         SET state = 'cancelled', lease_token = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE id = $1`,
        [notif.id],
      );
      return false;
    }

    // F06: Check outbound permission again at final preflight
    if (deps.outboundEnabled === false) {
      await client.query(
        `UPDATE notifications
         SET state = 'queued', lease_token = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE id = $1`,
        [notif.id],
      );
      return false;
    }

    // F08: Recheck ownership after row lock waits before changing state to submitting
    if (deps.isOwnershipValid && deps.isOwnershipValid() === false) {
      return false;
    }

    // F08: Include matching-token, preparing-state, and still-unexpired-lease predicate using DB now()
    const notifUpdate = await client.query(
      `UPDATE notifications
       SET state = 'submitting',
           attempt_count = attempt_count + 1,
           lease_expires_at = now() + interval '120 seconds',
           updated_at = now()
       WHERE id = $1
         AND lease_token = $2
         AND state = 'preparing'
         AND lease_expires_at > clock_timestamp()`,
      [notif.id, leaseToken],
    );

    if ((notifUpdate.rowCount ?? 0) === 0) {
      return false;
    }

    await client.query(
      `INSERT INTO send_attempts (id, notification_id, attempt_number, outcome, started_at)
       VALUES ($1, $2, $3, 'submitting', now())`,
      [attemptId, notif.id, nextAttemptNumber],
    );

    return true;
  });

  if (!casSuccess) {
    return { status: "aborted", outcome: "lease_lost_or_deleted" };
  }

  // F08: Recheck ownership immediately after preflight transaction commits and immediately before SMTP
  if (deps.isOwnershipValid && deps.isOwnershipValid() === false) {
    return { status: "aborted", outcome: "ownership_lost" };
  }

  // 5. Submit raw buffer through SMTP adapter
  const envelope = {
    from: formConfig.from,
    to: formConfig.recipient,
  };

  const submitResult = await submitRaw(mimeBuffer!, envelope, smtpConfig);

  // 6. Record outcome
  await withTransaction(pool, async (client: PoolClient) => {
    if (submitResult.kind === "submitted") {
      await client.query(
        `UPDATE send_attempts
         SET outcome = 'submitted', receipt = $1, finished_at = now()
         WHERE id = $2`,
        [JSON.stringify(submitResult.receipt), attemptId],
      );

      await client.query(
        `UPDATE notifications
         SET state = 'submitted', smtp_receipt = $1, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE id = $2 AND lease_token = $3`,
        [JSON.stringify(submitResult.receipt), notif.id, leaseToken],
      );
    } else if (submitResult.kind === "safe_retry") {
      await client.query(
        `UPDATE send_attempts
         SET outcome = 'safe_retry', error_code = $1, finished_at = now()
         WHERE id = $2`,
        [submitResult.code, attemptId],
      );

      // Check max retries (initial + 4 retries = 5 attempts max)
      if (nextAttemptNumber >= 5) {
        await client.query(
          `UPDATE notifications
           SET state = 'failed', last_error_code = 'too_many_retries', lease_token = NULL, lease_expires_at = NULL, updated_at = now()
           WHERE id = $1 AND lease_token = $2`,
          [notif.id, leaseToken],
        );
      } else {
        const delaySec = RETRY_DELAYS_SECONDS[nextAttemptNumber - 1] ?? 60;
        await client.query(
          `UPDATE notifications
           SET state = 'retry_wait',
               last_error_code = $1,
               next_attempt_at = now() + ($2 || ' seconds')::interval,
               lease_token = NULL,
               lease_expires_at = NULL,
               updated_at = now()
           WHERE id = $3 AND lease_token = $4`,
          [submitResult.code, delaySec, notif.id, leaseToken],
        );
      }
    } else if (submitResult.kind === "failed") {
      await client.query(
        `UPDATE send_attempts
         SET outcome = 'failed', error_code = $1, finished_at = now()
         WHERE id = $2`,
        [submitResult.code, attemptId],
      );

      await client.query(
        `UPDATE notifications
         SET state = 'failed', last_error_code = $1, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE id = $2 AND lease_token = $3`,
        [submitResult.code, notif.id, leaseToken],
      );
    } else {
      // unknown outcome
      await client.query(
        `UPDATE send_attempts
         SET outcome = 'unknown', error_code = $1, finished_at = now()
         WHERE id = $2`,
        [submitResult.code, attemptId],
      );

      await client.query(
        `UPDATE notifications
         SET state = 'unknown', last_error_code = $1, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE id = $2 AND lease_token = $3`,
        [submitResult.code, notif.id, leaseToken],
      );
    }
  });

  return { status: "processed", outcome: submitResult.kind };
}
