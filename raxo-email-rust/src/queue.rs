use crate::config::{AttachmentPolicy, FormConfig};
use crate::errors::{AppError, Result};
use crate::mime::{build_notification, NotificationAttachment, NotificationPayload, WithheldAttachment};
use crate::sentinel::{disposition_of, record_scan_result, Disposition, Sentinel, WithheldCategory};
use crate::smtp::{submit_raw, SmtpConfig, SubmitResult};
use crate::storage::{sha256_hex, Area, Storage};
use chrono::{DateTime, Utc};
use sqlx::{FromRow, PgPool};
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

#[derive(Clone)]
pub struct QueueDeps {
    pub pool: PgPool,
    pub storage: Storage,
    pub smtp: SmtpConfig,
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

pub async fn claim_due_notification(pool: &PgPool, lease_secs: i64) -> Result<Option<(Notification, Uuid)>> {
    let token = Uuid::new_v4();
    let mut tx = pool.begin().await?;
    let n: Option<Notification> = sqlx::query_as(
        "SELECT n.id, n.submission_id, n.message_id, n.state, n.attempt_count, n.prepare_failures,
                n.next_attempt_at, n.lease_token, n.lease_expires_at, n.mime_key, n.mime_sha256, n.last_error_code
         FROM notifications n JOIN submissions s ON s.id = n.submission_id
         WHERE n.state IN ('queued','retry_wait') AND n.next_attempt_at <= now() AND s.deleted_at IS NULL
         ORDER BY n.next_attempt_at ASC, n.created_at ASC
         FOR UPDATE OF n SKIP LOCKED LIMIT 1",
    )
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
    tx.commit().await?;
    Ok(Some((n, token)))
}

pub async fn renew_lease(pool: &PgPool, id: Uuid, token: Uuid, lease_secs: i64) -> Result<bool> {
    let r = sqlx::query(
        "UPDATE notifications SET lease_expires_at = now() + make_interval(secs => $1), updated_at = now()
         WHERE id = $2 AND lease_token = $3",
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
    let pool = &deps.pool;
    let storage = &deps.storage;

    let sub: Option<SubmissionRow> = sqlx::query_as(
        "SELECT id, fields, config_snapshot, created_at, deleted_at FROM submissions WHERE id = $1",
    )
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
    let form: FormConfig = serde_json::from_value(sub.config_snapshot.clone().unwrap_or_default())
        .map_err(|e| AppError::new("bad_request", 500, format!("invalid config snapshot: {e}")))?;
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
                _ => WithheldCategory::NotInspected,
            };
            withheld.push(WithheldAttachment { filename: att.original_name.clone(), category });
            continue;
        }
        let area = if att.scan_state == "clean" { Area::Clean } else { Area::Quarantine };
        let content = match storage.read(&att.storage_key, Some(area)) {
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
            && att.scanned_at.map(|t| (Utc::now() - t).num_milliseconds() <= 48 * 3600 * 1000).unwrap_or(false);
        let mut content = content;
        if !fresh_clean {
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
                Disposition::Deliver { version } => {
                    storage.move_to_clean(&att.storage_key)?;
                    update_attachment_scan(pool, att.id, "clean", Some(&version)).await?;
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
                        let scan_state = if category == WithheldCategory::Flagged { "blocked" } else { "error" };
                        set_withheld(pool, att.id, scan_state, category, &reason).await?;
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
                        set_withheld(pool, att.id, "blocked", category, &reason).await?;
                        block_notification(pool, notif, token, &reason, None).await?;
                        return res("blocked", reason);
                    }
                },
            }
        }
        included_ids.push(att.id);
        scanned.push(NotificationAttachment { filename: att.original_name.clone(), content });
    }

    // Build or reuse the immutable MIME message.
    let mime: Vec<u8>;
    if let Some(key) = &notif.mime_key {
        let stored = notif.mime_sha256.as_ref().and_then(|expected| {
            storage.read(key, Some(Area::Mime)).ok().filter(|b| &sha256_hex(b) == expected)
        });
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
             WHERE id = $3 AND lease_token = $4",
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
    }

    // preparing -> submitting compare-and-swap before any network I/O
    let attempt_id = Uuid::new_v4();
    let attempt_no = notif.attempt_count + 1;
    if !is_owner() {
        return res("aborted", "ownership_lost".to_string());
    }
    if !cas_to_submitting(pool, notif, token, attempt_id, attempt_no, deps.outbound_enabled, is_owner).await? {
        return res("aborted", "lease_lost_or_deleted".to_string());
    }
    if !is_owner() {
        return res("aborted", "ownership_lost".to_string());
    }

    let result = submit_raw(&mime, &form.from, &form.recipient, &deps.smtp).await;
    record_outcome(pool, notif, token, attempt_id, attempt_no, &result).await?;
    let kind = match result {
        SubmitResult::Submitted { .. } => "submitted",
        SubmitResult::SafeRetry(_) => "safe_retry",
        SubmitResult::Failed(_) => "failed",
        SubmitResult::Unknown(_) => "unknown",
    };
    res("processed", kind.to_string())
}

async fn update_attachment_scan(pool: &PgPool, id: Uuid, state: &str, version: Option<&str>) -> Result<()> {
    sqlx::query("UPDATE attachments SET scan_state = $1, scan_version = $2, scanned_at = now() WHERE id = $3")
        .bind(state)
        .bind(version)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

async fn set_withheld(pool: &PgPool, id: Uuid, scan_state: &str, category: WithheldCategory, reason: &str) -> Result<()> {
    sqlx::query(
        "UPDATE attachments SET scan_state = $1, scanned_at = now(), delivery_disposition = 'withheld',
           withheld_category = $2, disposition_reason = $3, disposition_at = now() WHERE id = $4",
    )
    .bind(scan_state)
    .bind(category.as_str())
    .bind(reason)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
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

async fn block_notification(pool: &PgPool, notif: &Notification, token: Uuid, code: &str, failures: Option<i32>) -> Result<()> {
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

async fn cas_to_submitting(
    pool: &PgPool,
    notif: &Notification,
    token: Uuid,
    attempt_id: Uuid,
    attempt_no: i32,
    outbound_enabled: bool,
    is_owner: &(dyn Fn() -> bool + Send + Sync),
) -> Result<bool> {
    let mut tx = pool.begin().await?;
    let row: Option<(String, Option<Uuid>, Option<DateTime<Utc>>)> =
        sqlx::query_as("SELECT state, lease_token, lease_expires_at FROM notifications WHERE id = $1 FOR UPDATE")
            .bind(notif.id)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((state, lt, exp)) = row else { return Ok(false) };
    if state != "preparing" || lt != Some(token) || exp.map(|e| e <= Utc::now()).unwrap_or(true) {
        return Ok(false);
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
        return Ok(false);
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
        return Ok(false);
    }
    if !is_owner() {
        return Ok(false);
    }
    let upd = sqlx::query(
        "UPDATE notifications SET state = 'submitting', attempt_count = attempt_count + 1,
           lease_expires_at = now() + interval '120 seconds', updated_at = now()
         WHERE id = $1 AND lease_token = $2 AND state = 'preparing' AND lease_expires_at > clock_timestamp()",
    )
    .bind(notif.id)
    .bind(token)
    .execute(&mut *tx)
    .await?;
    if upd.rows_affected() == 0 {
        return Ok(false);
    }
    sqlx::query(
        "INSERT INTO send_attempts (id, notification_id, attempt_number, outcome, started_at)
         VALUES ($1, $2, $3, 'submitting', now())",
    )
    .bind(attempt_id)
    .bind(notif.id)
    .bind(attempt_no)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(true)
}

async fn record_outcome(
    pool: &PgPool,
    notif: &Notification,
    token: Uuid,
    attempt_id: Uuid,
    attempt_no: i32,
    r: &SubmitResult,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    let fin = |outcome: &'static str| {
        sqlx::query("UPDATE send_attempts SET outcome = $1, error_code = $2, receipt = $3, finished_at = now() WHERE id = $4")
            .bind(outcome)
    };
    match r {
        SubmitResult::Submitted { .. } => {
            let receipt = r.receipt();
            fin("submitted")
                .bind(Option::<String>::None)
                .bind(&receipt)
                .bind(attempt_id)
                .execute(&mut *tx)
                .await?;
            sqlx::query(
                "UPDATE notifications SET state = 'submitted', smtp_receipt = $1, lease_token = NULL,
                   lease_expires_at = NULL, updated_at = now() WHERE id = $2 AND lease_token = $3",
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
            fin("safe_retry").bind(Some(code)).bind(Option::<serde_json::Value>::None).bind(attempt_id).execute(&mut *tx).await?;
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
            let (outcome, state) = if matches!(r, SubmitResult::Failed(_)) { ("failed", "failed") } else { ("unknown", "unknown") };
            fin(outcome).bind(Some(code)).bind(Option::<serde_json::Value>::None).bind(attempt_id).execute(&mut *tx).await?;
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
    tx.commit().await?;
    Ok(())
}
