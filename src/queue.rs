use crate::capacity::{Admission, Capacity, ConnectionSlot};
use crate::config::{AttachmentPolicy, FormConfig};
use crate::errors::{AppError, Result};
use crate::mime::{build_notification, NotificationAttachment, NotificationPayload, WithheldAttachment};
use crate::sentinel::{disposition_of, record_scan_result, Disposition, Sentinel, WithheldCategory};
use crate::smtp::{submit_raw, SmtpConfig, SubmitResult};
use crate::storage::{sha256_hex, Area, Storage};
use chrono::{DateTime, Utc};
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use std::collections::BTreeMap;
use uuid::Uuid;

const RETRY_DELAYS_SECONDS: [i64; 4] = [60, 300, 1800, 7200];

#[derive(Debug, Clone, FromRow)]
pub struct Notification {
    pub id: Uuid,
    pub submission_id: Uuid,
    pub message_id: String,
    pub state: String,
    pub attempt_count: i32,
    pub prepare_failures: i32,
    pub next_attempt_at: DateTime<Utc>,
    pub lease_token: Option<Uuid>,
    pub lease_expires_at: Option<DateTime<Utc>>,
    pub mime_key: Option<String>,
    pub mime_sha256: Option<String>,
    pub last_error_code: Option<String>,
    pub not_after: Option<DateTime<Utc>>,
    pub recipient_key: Option<String>,
}

#[derive(Debug, FromRow)]
struct SubmissionRow {
    id: Uuid,
    fields: Option<serde_json::Value>,
    config_snapshot: Option<serde_json::Value>,
    created_at: DateTime<Utc>,
    deleted_at: Option<DateTime<Utc>>,
}

#[derive(Debug, FromRow)]
struct AttachmentRow {
    id: Uuid,
    storage_key: String,
    original_name: String,
    size_bytes: i64,
    sha256: String,
    scan_state: String,
    scanned_at: Option<DateTime<Utc>>,
    delivery_disposition: String,
    withheld_category: Option<String>,
}

#[derive(FromRow)]
struct LeaseRow {
    state: String,
    lease_token: Option<Uuid>,
    lease_expires_at: Option<DateTime<Utc>>,
    not_after: Option<DateTime<Utc>>,
    checked_at: DateTime<Utc>,
}

#[derive(Clone)]
pub struct QueueDeps {
    pub pool: PgPool,
    pub storage: Storage,
    pub smtp: SmtpConfig,
    pub capacity: Capacity,
    pub sentinel: Sentinel,
    pub max_mime_bytes: usize,
    pub outbound_enabled: bool,
    pub policy: AttachmentPolicy,
    /// Extra scan attempts (60 s apart) after a transient scanner failure before withholding.
    pub scan_retries: i32,
    pub notice_html: bool,
}

#[derive(Debug, PartialEq)]
pub struct ProcessResult {
    pub status: &'static str,
    pub outcome: Option<String>,
}

fn res(status: &'static str, outcome: impl Into<Option<String>>) -> Result<ProcessResult> {
    Ok(ProcessResult { status, outcome: outcome.into() })
}

pub async fn recover_expired_leases(pool: &PgPool) -> Result<(u64, u64)> {
    let mut tx = pool.begin().await?;
    let prep = sqlx::query(
        "UPDATE notifications SET state = 'queued', lease_token = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE state = 'preparing' AND lease_expires_at < now()",
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();
    let rows: Vec<(Uuid,)> = sqlx::query_as(
        "UPDATE notifications SET state = 'unknown', last_error_code = 'lease_expired_during_submitting',
           lease_token = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE state = 'submitting' AND lease_expires_at < now() RETURNING id",
    )
    .fetch_all(&mut *tx)
    .await?;
    for (id,) in &rows {
        sqlx::query(
            "UPDATE send_attempts SET outcome = 'unknown', error_code = 'lease_expired_during_submitting',
               finished_at = now() WHERE notification_id = $1 AND outcome = 'submitting'",
        )
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok((prep, rows.len() as u64))
}

pub async fn claim_due_notification(
    pool: &PgPool,
    capacity: &Capacity,
    lease_secs: i64,
) -> Result<Option<(Notification, Uuid)>> {
    let token = Uuid::new_v4();
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)").bind(726902_i64).execute(&mut *tx).await?;
    let n: Option<Notification> = sqlx::query_as(
        "SELECT n.id, n.submission_id, n.message_id, n.state, n.attempt_count, n.prepare_failures,
                n.next_attempt_at, n.lease_token, n.lease_expires_at, n.mime_key, n.mime_sha256, n.last_error_code,
                n.not_after, lower(s.config_snapshot->>'recipient') AS recipient_key
         FROM notifications n JOIN submissions s ON s.id = n.submission_id
         LEFT JOIN smtp_recipient_capacity r ON r.recipient_key = lower(s.config_snapshot->>'recipient')
         LEFT JOIN smtp_destination_backoff b
           ON b.node_id = $1 AND b.destination_domain = split_part(lower(s.config_snapshot->>'recipient'), '@', 2)
           AND b.not_before > clock_timestamp()
         WHERE n.state IN ('queued','retry_wait') AND n.next_attempt_at <= now() AND s.deleted_at IS NULL
           AND b.node_id IS NULL
         ORDER BY COALESCE(r.last_selected, 0), n.next_attempt_at ASC, n.created_at ASC, n.id ASC
         FOR UPDATE OF n SKIP LOCKED LIMIT 1",
    )
    .bind(&capacity.node_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(n) = n else {
        tx.rollback().await.ok();
        return Ok(None);
    };
    sqlx::query(
        "UPDATE notifications SET state = 'preparing', lease_token = $1,
           lease_expires_at = now() + make_interval(secs => $2), updated_at = now() WHERE id = $3",
    )
    .bind(token)
    .bind(lease_secs as f64)
    .bind(n.id)
    .execute(&mut *tx)
    .await?;
    if let Some(recipient) = n.recipient_key.as_deref().filter(|s| !s.is_empty()) {
        sqlx::query(
            "INSERT INTO smtp_recipient_capacity (recipient_key, last_selected)
             VALUES ($1, nextval('smtp_fair_sequence'))
             ON CONFLICT (recipient_key) DO UPDATE SET last_selected = EXCLUDED.last_selected",
        )
        .bind(recipient)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(Some((n, token)))
}

pub async fn renew_lease(pool: &PgPool, id: Uuid, token: Uuid, lease_secs: i64) -> Result<bool> {
    let r = sqlx::query(
        "UPDATE notifications SET lease_expires_at = clock_timestamp() + make_interval(secs => $1),
           updated_at = clock_timestamp()
         WHERE id = $2 AND lease_token = $3 AND state IN ('preparing', 'submitting')
           AND lease_expires_at > clock_timestamp()",
    )
    .bind(lease_secs as f64)
    .bind(id)
    .bind(token)
    .execute(pool)
    .await?;
    Ok(r.rows_affected() > 0)
}

async fn fail_with(pool: &PgPool, id: Uuid, token: Uuid, code: &str) -> Result<()> {
    sqlx::query(
        "UPDATE notifications SET state = 'failed', last_error_code = $1, lease_token = NULL,
           lease_expires_at = NULL, updated_at = now() WHERE id = $2 AND lease_token = $3",
    )
    .bind(code)
    .bind(id)
    .bind(token)
    .execute(pool)
    .await?;
    Ok(())
}

fn json_to_fields(v: Option<serde_json::Value>) -> BTreeMap<String, Option<String>> {
    v.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
}

pub async fn process_notification(
    notif: &Notification,
    token: Uuid,
    deps: &QueueDeps,
    is_owner: &(dyn Fn() -> bool + Send + Sync),
) -> Result<ProcessResult> {
    let result = process_claimed(notif, token, deps, is_owner).await?;
    // Removes the MIME of a terminal notification and attachment files that are no longer
    // needed; a no-op while the notification can still be prepared or retried.
    if let Err(e) = crate::outbox::cleanup_notification_files(&deps.pool, &deps.storage, notif.id).await {
        tracing::error!(notification_id = %notif.id, error = %e.message, "notification file cleanup failed");
    }
    Ok(result)
}

async fn process_claimed(
    notif: &Notification,
    token: Uuid,
    deps: &QueueDeps,
    is_owner: &(dyn Fn() -> bool + Send + Sync),
) -> Result<ProcessResult> {
    let pool = &deps.pool;
    let storage = &deps.storage;

    let sub: Option<SubmissionRow> =
        sqlx::query_as("SELECT id, fields, config_snapshot, created_at, deleted_at FROM submissions WHERE id = $1")
            .bind(notif.submission_id)
            .fetch_optional(pool)
            .await?;
    let Some(sub) = sub.filter(|s| s.deleted_at.is_none()) else {
        sqlx::query(
            "UPDATE notifications SET state = 'cancelled', lease_token = NULL, lease_expires_at = NULL,
               updated_at = now() WHERE id = $1 AND lease_token = $2",
        )
        .bind(notif.id)
        .bind(token)
        .execute(pool)
        .await?;
        return res("cancelled", None);
    };
    let form: FormConfig = match serde_json::from_value(sub.config_snapshot.clone().unwrap_or_default()) {
        Ok(form) => form,
        Err(e) => {
            tracing::error!(notification_id = %notif.id, error = %e, "invalid config snapshot");
            fail_with(pool, notif.id, token, "invalid_config_snapshot").await?;
            return res("failed", "invalid_config_snapshot".to_string());
        }
    };
    if !crate::config::email_regex().is_match(&form.recipient) {
        fail_with(pool, notif.id, token, "invalid_recipient").await?;
        return res("failed", "invalid_recipient".to_string());
    }
    let atts: Vec<AttachmentRow> = sqlx::query_as(
        "SELECT id, storage_key, original_name, size_bytes, sha256, scan_state, scanned_at,
                delivery_disposition, withheld_category
         FROM attachments WHERE submission_id = $1 ORDER BY created_at ASC",
    )
    .bind(notif.submission_id)
    .fetch_all(pool)
    .await?;

    let mut scanned: Vec<NotificationAttachment> = vec![];
    let mut included_ids: Vec<Uuid> = vec![];
    let mut withheld: Vec<WithheldAttachment> = vec![];
    // Once a MIME message exists it is immutable and was built from the decisions made at
    // that time: retries re-send it verbatim and never re-scan or re-decide attachments.
    let prepare = notif.mime_key.is_none();
    for att in atts.iter().filter(|_| prepare) {
        if att.scan_state == "deleted" {
            return Err(AppError::not_found("Attachment was deleted"));
        }
        // Withheld is a one-way decision: never rescanned, read, or delivered.
        if att.delivery_disposition == "withheld" {
            let category = match att.withheld_category.as_deref() {
                Some("flagged") => WithheldCategory::Flagged,
                Some("policy") => WithheldCategory::Policy,
                Some("not_retained") => WithheldCategory::NotRetained,
                _ => WithheldCategory::NotInspected,
            };
            withheld.push(WithheldAttachment { filename: att.original_name.clone(), category });
            continue;
        }
        let in_clean = storage.exists(&att.storage_key, Some(Area::Clean));
        if in_clean && storage.exists(&att.storage_key, Some(Area::Quarantine)) {
            fail_with(pool, notif.id, token, "attachment_integrity_error").await?;
            return res("failed", "attachment_integrity_error".to_string());
        }
        let content = match storage.read(&att.storage_key, None) {
            Ok(c) => c,
            Err(_) => {
                fail_with(pool, notif.id, token, "attachment_integrity_error").await?;
                return res("failed", "attachment_integrity_error".to_string());
            }
        };
        let actual = sha256_hex(&content);
        if content.len() as i64 != att.size_bytes || actual != att.sha256 {
            fail_with(pool, notif.id, token, "attachment_integrity_error").await?;
            return res("failed", "attachment_integrity_error".to_string());
        }

        let fresh_clean = att.scan_state == "clean"
            && in_clean
            && att.scanned_at.map(|t| (Utc::now() - t).num_milliseconds() <= 48 * 3600 * 1000).unwrap_or(false);
        let mut content = content;
        let partial;
        if fresh_clean {
            // Reuse the partial-inspection note of the scan that made this attachment clean.
            let incomplete: Option<Option<String>> = sqlx::query_scalar(
                "SELECT incomplete FROM scan_results WHERE attachment_id = $1 AND scanner = 'raxosentinel'
                   AND shadow = false AND verdict = 'CLEAN' ORDER BY created_at DESC LIMIT 1",
            )
            .bind(att.id)
            .fetch_optional(pool)
            .await?;
            partial = incomplete.flatten().is_some();
        } else {
            let rec = deps.sentinel.scan(content.clone(), &actual, &att.id.to_string()).await;
            if let Err(e) = record_scan_result(pool, att.id, notif.id, &rec).await {
                tracing::error!(error = %e, "failed to record scan result (delivery policy unaffected)");
            }
            tracing::info!(
                event = "scan",
                attachment_id = %att.id,
                scanner = "raxosentinel",
                verdict = rec.verdict.as_str(),
                ms = rec.duration_ms,
                generation = rec.database_generation.as_deref().unwrap_or(""),
            );
            match disposition_of(&rec) {
                Disposition::Deliver { version, partial: incomplete } => {
                    partial = incomplete;
                    if !mark_clean(pool, storage, notif.id, token, att.id, &att.storage_key, &version).await? {
                        return res("aborted", "ownership_lost_or_attachment_changed".to_string());
                    }
                    content = storage.read(&att.storage_key, Some(Area::Clean))?;
                    if sha256_hex(&content) != actual {
                        fail_with(pool, notif.id, token, "attachment_integrity_error").await?;
                        return res("failed", "attachment_integrity_error".to_string());
                    }
                }
                Disposition::Withhold { category, reason, transient } => match deps.policy {
                    AttachmentPolicy::Withhold => {
                        if transient && notif.prepare_failures < deps.scan_retries {
                            return scanner_retry(pool, notif, token, "scanner_error").await;
                        }
                        let scan_state = if category == WithheldCategory::NotInspected { "error" } else { "blocked" };
                        if !set_withheld(deps, notif.id, token, att, scan_state, category, &reason).await? {
                            return res("aborted", "ownership_lost_or_attachment_changed".to_string());
                        }
                        withheld.push(WithheldAttachment { filename: att.original_name.clone(), category });
                        continue;
                    }
                    AttachmentPolicy::BlockMessage => {
                        if transient {
                            let failures = notif.prepare_failures + 1;
                            if failures >= 5 {
                                block_notification(pool, notif, token, "scanner_unavailable", Some(failures)).await?;
                                return res("blocked", "scanner_unavailable".to_string());
                            }
                            return scanner_retry(pool, notif, token, "scanner_error").await;
                        }
                        if !set_withheld(deps, notif.id, token, att, "blocked", category, &reason).await? {
                            return res("aborted", "ownership_lost_or_attachment_changed".to_string());
                        }
                        block_notification(pool, notif, token, &reason, None).await?;
                        return res("blocked", reason);
                    }
                },
            }
        }
        included_ids.push(att.id);
        scanned.push(NotificationAttachment { filename: att.original_name.clone(), content, partial });
    }

    // Build or reuse the immutable MIME message.
    let mime: Vec<u8>;
    if let Some(key) = &notif.mime_key {
        let stored = notif
            .mime_sha256
            .as_ref()
            .and_then(|expected| storage.read(key, Some(Area::Mime)).ok().filter(|b| &sha256_hex(b) == expected));
        match stored {
            Some(b) => mime = b,
            None => {
                fail_with(pool, notif.id, token, "mime_integrity_error").await?;
                return res("failed", "mime_integrity_error".to_string());
            }
        }
    } else {
        let fields = json_to_fields(sub.fields.clone());
        let built = build_notification(
            &form,
            &NotificationPayload {
                submission_id: sub.id.to_string(),
                created_at: sub.created_at,
                fields: &fields,
                message_id: notif.message_id.clone(),
                withheld: &withheld,
                notice_html: deps.notice_html,
            },
            &scanned,
            deps.max_mime_bytes,
        );
        match built {
            Ok(b) => mime = b,
            Err(e) if e.code == "mime_too_large" => {
                fail_with(pool, notif.id, token, "mime_too_large").await?;
                return res("failed", "mime_too_large".to_string());
            }
            Err(e) => return Err(e),
        }
        let (k, h) = storage.persist_mime(&mime)?;
        let mut tx = pool.begin().await?;
        let upd = sqlx::query(
            "UPDATE notifications SET mime_key = $1, mime_sha256 = $2, updated_at = now()
             WHERE id = $3 AND lease_token = $4 AND state = 'preparing' AND lease_expires_at > clock_timestamp()",
        )
        .bind(&k)
        .bind(&h)
        .bind(notif.id)
        .bind(token)
        .execute(&mut *tx)
        .await?;
        if upd.rows_affected() == 0 {
            return res("aborted", "lease_lost_or_deleted".to_string());
        }
        // Record exactly which attachments are inside the persisted MIME.
        sqlx::query(
            "UPDATE attachments SET delivery_disposition = 'included', disposition_at = now()
             WHERE id = ANY($1) AND delivery_disposition = 'pending'",
        )
        .bind(&included_ids)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        // The MIME is now the only copy needed for delivery and retries; drop the attachment
        // files (included and withheld) of this submission.
        if let Err(e) = crate::outbox::cleanup_notification_files(pool, storage, notif.id).await {
            tracing::error!(notification_id = %notif.id, error = %e.message, "attachment file cleanup failed");
        }
    }

    // preparing -> submitting compare-and-swap before any network I/O
    let attempt_id = Uuid::new_v4();
    let attempt_no = notif.attempt_count + 1;
    if !is_owner() {
        return res("aborted", "ownership_lost".to_string());
    }
    let _slot = match cas_to_submitting(
        pool,
        notif,
        token,
        attempt_id,
        attempt_no,
        deps.outbound_enabled,
        is_owner,
        &deps.capacity,
        &form.recipient,
    )
    .await?
    {
        SubmitStart::Started(slot) => slot,
        SubmitStart::Deferred => return res("throttled", None),
        SubmitStart::Expired => return res("failed", "message_expired".to_string()),
        SubmitStart::Aborted => return res("aborted", "lease_lost_or_deleted".to_string()),
    };
    if !is_owner() {
        return res("aborted", "ownership_lost".to_string());
    }

    let delivery = submit_raw(&mime, &form.from, &form.recipient, &deps.smtp);
    tokio::pin!(delivery);
    let result = loop {
        tokio::select! {
            result = &mut delivery => break result,
            _ = tokio::time::sleep(std::time::Duration::from_millis(250)) => {
                if !is_owner() {
                    tracing::error!(notification_id = %notif.id, "lease lost during SMTP; outcome remains unknown");
                    return res("aborted", "ownership_lost_during_smtp".to_string());
                }
            }
        }
    };
    if !record_outcome(pool, notif, token, attempt_id, attempt_no, &result, &deps.capacity, &form.recipient).await? {
        return res("aborted", "lease_lost_during_smtp".to_string());
    }
    let kind = match result {
        SubmitResult::Submitted { .. } => "submitted",
        SubmitResult::SafeRetry(_) => "safe_retry",
        SubmitResult::Failed(_) => "failed",
        SubmitResult::Unknown(_) => "unknown",
    };
    res("processed", kind.to_string())
}

async fn lock_preparing(tx: &mut Transaction<'_, Postgres>, notification_id: Uuid, token: Uuid) -> Result<bool> {
    let owner: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM notifications WHERE id = $1 AND state = 'preparing' AND lease_token = $2
           AND lease_expires_at > clock_timestamp() FOR UPDATE",
    )
    .bind(notification_id)
    .bind(token)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(owner.is_some())
}

async fn mark_clean(
    pool: &PgPool,
    storage: &Storage,
    notification_id: Uuid,
    token: Uuid,
    attachment_id: Uuid,
    storage_key: &str,
    version: &str,
) -> Result<bool> {
    let mut tx = pool.begin().await?;
    if !lock_preparing(&mut tx, notification_id, token).await? {
        return Ok(false);
    }
    let disposition: Option<String> = sqlx::query_scalar(
        "SELECT delivery_disposition FROM attachments WHERE id = $1 AND scan_state <> 'deleted' FOR UPDATE",
    )
    .bind(attachment_id)
    .fetch_optional(&mut *tx)
    .await?;
    if disposition.is_none() || disposition.as_deref() == Some("withheld") {
        return Ok(false);
    }
    storage.move_to_clean(storage_key)?;
    sqlx::query("UPDATE attachments SET scan_state = 'clean', scan_version = $1, scanned_at = now() WHERE id = $2")
        .bind(version)
        .bind(attachment_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(true)
}

async fn set_withheld(
    deps: &QueueDeps,
    notification_id: Uuid,
    token: Uuid,
    attachment: &AttachmentRow,
    scan_state: &str,
    category: WithheldCategory,
    reason: &str,
) -> Result<bool> {
    let mut tx = deps.pool.begin().await?;
    if !lock_preparing(&mut tx, notification_id, token).await? {
        return Ok(false);
    }
    let updated = sqlx::query(
        "UPDATE attachments SET scan_state = $1, scanned_at = now(), delivery_disposition = 'withheld',
           withheld_category = $2, disposition_reason = $3, disposition_at = now()
         WHERE id = $4 AND scan_state <> 'deleted' AND delivery_disposition <> 'withheld'",
    )
    .bind(scan_state)
    .bind(category.as_str())
    .bind(reason)
    .bind(attachment.id)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() != 1 {
        return Ok(false);
    }
    deps.storage.move_to_quarantine(&attachment.storage_key)?;
    tx.commit().await?;
    Ok(true)
}

async fn scanner_retry(pool: &PgPool, notif: &Notification, token: Uuid, code: &str) -> Result<ProcessResult> {
    sqlx::query(
        "UPDATE notifications SET state = 'retry_wait', prepare_failures = prepare_failures + 1,
           last_error_code = $1, next_attempt_at = now() + interval '60 seconds',
           lease_token = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE id = $2 AND lease_token = $3",
    )
    .bind(code)
    .bind(notif.id)
    .bind(token)
    .execute(pool)
    .await?;
    res("retry_wait", code.to_string())
}

async fn block_notification(
    pool: &PgPool,
    notif: &Notification,
    token: Uuid,
    code: &str,
    failures: Option<i32>,
) -> Result<()> {
    sqlx::query(
        "UPDATE notifications SET state = 'blocked', last_error_code = $1,
           prepare_failures = COALESCE($2, prepare_failures), lease_token = NULL,
           lease_expires_at = NULL, updated_at = now() WHERE id = $3 AND lease_token = $4",
    )
    .bind(code)
    .bind(failures)
    .bind(notif.id)
    .bind(token)
    .execute(pool)
    .await?;
    Ok(())
}

enum SubmitStart {
    Started(ConnectionSlot),
    Deferred,
    Expired,
    Aborted,
}

#[allow(clippy::too_many_arguments)]
async fn cas_to_submitting(
    pool: &PgPool,
    notif: &Notification,
    token: Uuid,
    attempt_id: Uuid,
    attempt_no: i32,
    outbound_enabled: bool,
    is_owner: &(dyn Fn() -> bool + Send + Sync),
    capacity: &Capacity,
    recipient: &str,
) -> Result<SubmitStart> {
    let mut tx = pool.begin().await?;
    let row: Option<LeaseRow> = sqlx::query_as(
        "SELECT state, lease_token, lease_expires_at, not_after, clock_timestamp() AS checked_at
         FROM notifications WHERE id = $1 FOR UPDATE",
    )
    .bind(notif.id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(row) = row else { return Ok(SubmitStart::Aborted) };
    if row.state != "preparing"
        || row.lease_token != Some(token)
        || row.lease_expires_at.map(|e| e <= row.checked_at).unwrap_or(true)
    {
        return Ok(SubmitStart::Aborted);
    }
    if row.not_after.is_some_and(|t| t <= row.checked_at) {
        sqlx::query(
            "UPDATE notifications SET state = 'failed', last_error_code = 'message_expired',
               lease_token = NULL, lease_expires_at = NULL, updated_at = clock_timestamp() WHERE id = $1",
        )
        .bind(notif.id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(SubmitStart::Expired);
    }
    let del: Option<(Option<DateTime<Utc>>,)> =
        sqlx::query_as("SELECT deleted_at FROM submissions WHERE id = $1 FOR UPDATE")
            .bind(notif.submission_id)
            .fetch_optional(&mut *tx)
            .await?;
    if del.as_ref().map(|d| d.0.is_some()).unwrap_or(true) {
        sqlx::query(
            "UPDATE notifications SET state = 'cancelled', lease_token = NULL, lease_expires_at = NULL,
               updated_at = now() WHERE id = $1",
        )
        .bind(notif.id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(SubmitStart::Aborted);
    }
    if !outbound_enabled {
        sqlx::query(
            "UPDATE notifications SET state = 'queued', lease_token = NULL, lease_expires_at = NULL,
               updated_at = now() WHERE id = $1",
        )
        .bind(notif.id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(SubmitStart::Aborted);
    }
    if !is_owner() {
        return Ok(SubmitStart::Aborted);
    }
    let slot = match capacity.admit(&mut tx, recipient).await? {
        Admission::Granted(slot) => slot,
        Admission::Deferred { until, reason } => {
            sqlx::query(
                "UPDATE notifications SET state = 'queued', next_attempt_at = $1, last_error_code = $2,
                   lease_token = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
                 WHERE id = $3 AND lease_token = $4 AND state = 'preparing'",
            )
            .bind(until)
            .bind(reason)
            .bind(notif.id)
            .bind(token)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            return Ok(SubmitStart::Deferred);
        }
    };
    if !is_owner() {
        return Ok(SubmitStart::Aborted);
    }
    let upd = sqlx::query(
        "UPDATE notifications SET state = 'submitting', attempt_count = attempt_count + 1,
           lease_expires_at = clock_timestamp() + interval '120 seconds', last_error_code = NULL,
           updated_at = clock_timestamp()
         WHERE id = $1 AND lease_token = $2 AND state = 'preparing' AND lease_expires_at > clock_timestamp()
           AND (not_after IS NULL OR not_after > clock_timestamp())",
    )
    .bind(notif.id)
    .bind(token)
    .execute(&mut *tx)
    .await?;
    if upd.rows_affected() == 0 {
        let expired = sqlx::query(
            "UPDATE notifications SET state = 'failed', last_error_code = 'message_expired',
               lease_token = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
             WHERE id = $1 AND lease_token = $2 AND state = 'preparing' AND not_after <= clock_timestamp()",
        )
        .bind(notif.id)
        .bind(token)
        .execute(&mut *tx)
        .await?;
        if expired.rows_affected() > 0 {
            tx.commit().await?;
            return Ok(SubmitStart::Expired);
        }
        return Ok(SubmitStart::Aborted);
    }
    let recipient_key = recipient.trim().to_ascii_lowercase();
    let destination = recipient_key.rsplit_once('@').expect("validated recipient").1;
    sqlx::query(
        "INSERT INTO send_attempts
           (id, notification_id, attempt_number, outcome, started_at, node_id, recipient_key, destination_domain)
         VALUES ($1, $2, $3, 'submitting', clock_timestamp(), $4, $5, $6)",
    )
    .bind(attempt_id)
    .bind(notif.id)
    .bind(attempt_no)
    .bind(&capacity.node_id)
    .bind(&recipient_key)
    .bind(destination)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(SubmitStart::Started(slot))
}

#[allow(clippy::too_many_arguments)]
async fn record_outcome(
    pool: &PgPool,
    notif: &Notification,
    token: Uuid,
    attempt_id: Uuid,
    attempt_no: i32,
    r: &SubmitResult,
    capacity: &Capacity,
    recipient: &str,
) -> Result<bool> {
    let mut tx = pool.begin().await?;
    let owned: Option<LeaseRow> = sqlx::query_as(
        "SELECT state, lease_token, lease_expires_at, not_after, clock_timestamp() AS checked_at
         FROM notifications WHERE id = $1 FOR UPDATE",
    )
    .bind(notif.id)
    .fetch_optional(&mut *tx)
    .await?;
    if !owned.is_some_and(|row| {
        row.state == "submitting"
            && row.lease_token == Some(token)
            && row.lease_expires_at.is_some_and(|expiry| expiry > row.checked_at)
    }) {
        tracing::error!(notification_id = %notif.id, "SMTP result arrived after notification ownership was lost");
        return Ok(false);
    }
    let fin = |outcome: &'static str| {
        sqlx::query(
            "UPDATE send_attempts SET outcome = $1, error_code = $2, receipt = $3, finished_at = now() WHERE id = $4",
        )
        .bind(outcome)
    };
    match r {
        SubmitResult::Submitted { .. } => {
            let receipt = r.receipt();
            fin("submitted").bind(Option::<String>::None).bind(&receipt).bind(attempt_id).execute(&mut *tx).await?;
            sqlx::query(
                "UPDATE notifications SET state = 'submitted', smtp_receipt = $1, lease_token = NULL,
                   lease_expires_at = NULL, last_error_code = NULL, updated_at = now() WHERE id = $2 AND lease_token = $3",
            )
            .bind(&receipt)
            .bind(notif.id)
            .bind(token)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "UPDATE attachments SET delivery_disposition = 'delivered', disposition_at = now()
                 WHERE submission_id = $1 AND delivery_disposition = 'included'",
            )
            .bind(notif.submission_id)
            .execute(&mut *tx)
            .await?;
        }
        SubmitResult::SafeRetry(code) => {
            fin("safe_retry")
                .bind(Some(code))
                .bind(Option::<serde_json::Value>::None)
                .bind(attempt_id)
                .execute(&mut *tx)
                .await?;
            if attempt_no >= 5 {
                sqlx::query(
                    "UPDATE notifications SET state = 'failed', last_error_code = 'too_many_retries', lease_token = NULL,
                       lease_expires_at = NULL, updated_at = now() WHERE id = $1 AND lease_token = $2",
                )
                .bind(notif.id)
                .bind(token)
                .execute(&mut *tx)
                .await?;
            } else {
                let delay = RETRY_DELAYS_SECONDS.get((attempt_no - 1) as usize).copied().unwrap_or(60);
                sqlx::query(
                    "UPDATE notifications SET state = 'retry_wait', last_error_code = $1,
                       next_attempt_at = now() + make_interval(secs => $2), lease_token = NULL, lease_expires_at = NULL,
                       updated_at = now() WHERE id = $3 AND lease_token = $4",
                )
                .bind(code)
                .bind(delay as f64)
                .bind(notif.id)
                .bind(token)
                .execute(&mut *tx)
                .await?;
            }
        }
        SubmitResult::Failed(code) | SubmitResult::Unknown(code) => {
            let (outcome, state) =
                if matches!(r, SubmitResult::Failed(_)) { ("failed", "failed") } else { ("unknown", "unknown") };
            fin(outcome)
                .bind(Some(code))
                .bind(Option::<serde_json::Value>::None)
                .bind(attempt_id)
                .execute(&mut *tx)
                .await?;
            sqlx::query(
                "UPDATE notifications SET state = $1, last_error_code = $2, lease_token = NULL, lease_expires_at = NULL,
                   updated_at = now() WHERE id = $3 AND lease_token = $4",
            )
            .bind(state)
            .bind(code)
            .bind(notif.id)
            .bind(token)
            .execute(&mut *tx)
            .await?;
        }
    }
    capacity.record_destination(&mut tx, recipient, attempt_id, r).await?;
    tx.commit().await?;
    Ok(true)
}
