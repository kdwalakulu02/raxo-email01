import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  Submission,
  Attachment,
  Notification,
  FormConfig,
  AttachmentScanState,
  NotificationState,
  WorkerHeartbeat,
} from "./types.js";
import { AppError } from "./errors.js";

export function computeFingerprint(
  fields: Record<string, string | null>,
  attachments: Array<{ originalName: string; sizeBytes: number; sha256: string }>,
): string {
  // Sort field keys alphabetically
  const sortedKeys = Object.keys(fields).sort();
  const sortedFields: Record<string, string | null> = {};
  for (const k of sortedKeys) {
    sortedFields[k] = fields[k];
  }

  // Sort attachments deterministically by originalName, size, sha256
  const sortedAttachments = [...attachments].sort((a, b) => {
    const cmp = a.originalName.localeCompare(b.originalName);
    if (cmp !== 0) return cmp;
    if (a.sizeBytes !== b.sizeBytes) return a.sizeBytes - b.sizeBytes;
    return a.sha256.localeCompare(b.sha256);
  });

  const canonicalPayload = {
    fields: sortedFields,
    attachments: sortedAttachments.map((att) => ({
      name: att.originalName,
      size: att.sizeBytes,
      sha256: att.sha256,
    })),
  };

  return createHash("sha256").update(JSON.stringify(canonicalPayload), "utf8").digest("hex");
}

export class Repository {
  constructor(private pool: Pool) {}

  async getSubmissionByClientId(
    client: PoolClient | Pool,
    formId: string,
    clientSubmissionId: string,
  ): Promise<Submission | null> {
    const res = await client.query<Submission>(
      `SELECT id, form_id, client_submission_id, fingerprint, fields, config_snapshot, created_at, deleted_at, cleanup_done
       FROM submissions
       WHERE form_id = $1 AND client_submission_id = $2`,
      [formId, clientSubmissionId],
    );
    return res.rows[0] ?? null;
  }

  async getSubmission(id: string): Promise<Submission | null> {
    const res = await this.pool.query<Submission>(
      `SELECT id, form_id, client_submission_id, fingerprint, fields, config_snapshot, created_at, deleted_at, cleanup_done
       FROM submissions
       WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async listSubmissions(formId?: string, limit = 20): Promise<Submission[]> {
    const cappedLimit = Math.min(Math.max(limit, 1), 100);
    if (formId) {
      const res = await this.pool.query<Submission>(
        `SELECT id, form_id, client_submission_id, fingerprint, NULL as fields, NULL as config_snapshot, created_at, deleted_at, cleanup_done
         FROM submissions
         WHERE form_id = $1 AND deleted_at IS NULL
         ORDER BY created_at DESC, id DESC
         LIMIT $2`,
        [formId, cappedLimit],
      );
      return res.rows;
    }

    const res = await this.pool.query<Submission>(
      `SELECT id, form_id, client_submission_id, fingerprint, NULL as fields, NULL as config_snapshot, created_at, deleted_at, cleanup_done
       FROM submissions
       WHERE deleted_at IS NULL
       ORDER BY created_at DESC, id DESC
       LIMIT $1`,
      [cappedLimit],
    );
    return res.rows;
  }

  async tombstoneSubmission(client: PoolClient | Pool, id: string): Promise<boolean> {
    const res = await client.query(
      `UPDATE submissions
       SET deleted_at = now()
       WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async getAttachmentsForSubmission(submissionId: string): Promise<Attachment[]> {
    const res = await this.pool.query<Attachment>(
      `SELECT id, submission_id, storage_key, original_name, size_bytes, sha256, scan_state, scan_version, scanned_at, created_at
       FROM attachments
       WHERE submission_id = $1
       ORDER BY created_at ASC`,
      [submissionId],
    );
    return res.rows;
  }

  async getAttachment(id: string): Promise<Attachment | null> {
    const res = await this.pool.query<Attachment>(
      `SELECT id, submission_id, storage_key, original_name, size_bytes, sha256, scan_state, scan_version, scanned_at, created_at
       FROM attachments
       WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async updateAttachmentScan(
    client: PoolClient | Pool,
    attachmentId: string,
    scanState: AttachmentScanState,
    scanVersion?: string,
  ): Promise<void> {
    await client.query(
      `UPDATE attachments
       SET scan_state = $1, scan_version = $2, scanned_at = now()
       WHERE id = $3`,
      [scanState, scanVersion ?? null, attachmentId],
    );
  }

  async getNotificationBySubmissionId(submissionId: string): Promise<Notification | null> {
    const res = await this.pool.query<Notification>(
      `SELECT id, submission_id, message_id, state, attempt_count, prepare_failures, next_attempt_at,
              lease_token, lease_expires_at, mime_key, mime_sha256, last_error_code, smtp_receipt,
              created_at, updated_at
       FROM notifications
       WHERE submission_id = $1`,
      [submissionId],
    );
    return res.rows[0] ?? null;
  }

  async getNotification(id: string): Promise<Notification | null> {
    const res = await this.pool.query<Notification>(
      `SELECT id, submission_id, message_id, state, attempt_count, prepare_failures, next_attempt_at,
              lease_token, lease_expires_at, mime_key, mime_sha256, last_error_code, smtp_receipt,
              created_at, updated_at
       FROM notifications
       WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async updateWorkerHeartbeat(timestampIso: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO schema_meta (key, value, updated_at)
       VALUES ('worker_heartbeat', $1, now())
       ON CONFLICT (key)
       DO UPDATE SET value = $1, updated_at = now()`,
      [JSON.stringify({ last_seen: timestampIso })],
    );
  }

  async getWorkerHeartbeat(): Promise<WorkerHeartbeat | null> {
    const res = await this.pool.query<{ value: WorkerHeartbeat }>(
      `SELECT value FROM schema_meta WHERE key = 'worker_heartbeat'`,
    );
    return res.rows[0]?.value ?? null;
  }
}
