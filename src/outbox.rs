use crate::config::FormConfig;
use crate::errors::{AppError, Result};
use crate::storage::{Area, Storage};
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

pub struct SystemMessage<'a> {
    pub form_id: &'a str,
    pub from: &'a str,
    pub to: &'a str,
    pub subject: &'a str,
    pub text: &'a str,
    pub html: &'a str,
    pub message_id_domain: &'a str,
    pub not_after: Option<DateTime<Utc>>,
}

pub async fn enqueue_system_message(
    tx: &mut Transaction<'_, Postgres>,
    storage: &Storage,
    message: &SystemMessage<'_>,
) -> Result<Uuid> {
    if !crate::config::email_regex().is_match(message.from) || !crate::config::email_regex().is_match(message.to) {
        return Err(AppError::bad_request("Invalid system message address"));
    }
    let submission_id = Uuid::new_v4();
    let notification_id = Uuid::new_v4();
    let message_id = format!("<{}@{}>", Uuid::new_v4(), message.message_id_domain);
    let raw = crate::mime::build_system_message(
        message.from,
        message.to,
        message.subject,
        message.text,
        message.html,
        &message_id,
    );
    let (key, digest) = storage.persist_mime(&raw)?;
    let snapshot = FormConfig {
        id: message.form_id.to_string(),
        enabled: true,
        from: message.from.to_string(),
        recipient: message.to.to_string(),
        subject_prefix: message.subject.to_string(),
        reply_to_field: None,
        success_url: None,
        allowed_origins: vec![],
        fields: vec![],
    };
    let result: Result<()> = async {
        sqlx::query(
            "INSERT INTO submissions (id, form_id, fingerprint, config_snapshot, kind)
             VALUES ($1, $2, $3, $4, 'system')",
        )
        .bind(submission_id)
        .bind(message.form_id)
        .bind(&digest)
        .bind(serde_json::to_value(snapshot).map_err(|e| AppError::config("bad_request", e.to_string()))?)
        .execute(&mut **tx)
        .await?;
        sqlx::query(
            "INSERT INTO notifications (id, submission_id, message_id, mime_key, mime_sha256, not_after)
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(notification_id)
        .bind(submission_id)
        .bind(&message_id)
        .bind(&key)
        .bind(&digest)
        .bind(message.not_after)
        .execute(&mut **tx)
        .await?;
        Ok(())
    }
    .await;
    if let Err(error) = result {
        if let Err(cleanup) = storage.delete(&key, Some(Area::Mime)) {
            tracing::error!(error = %cleanup.message, "could not remove unqueued system message");
        }
        return Err(error);
    }
    Ok(notification_id)
}

/// Notification states that are never prepared, sent or retried again.
pub const TERMINAL_STATES: &[&str] = &["submitted", "unknown", "failed", "blocked", "cancelled"];

/// Removes files that are no longer needed for a notification (any submission kind):
/// - attachment files (clean and quarantine) once no notification of the submission still needs to
///   build its MIME, i.e. each one has a persisted MIME or is terminal;
/// - the MIME file of a terminal notification (and its `mime_key`/`mime_sha256`).
///
/// Nothing is removed while a notification can still need it: `queued`, `retry_wait`, `preparing`
/// and `submitting` keep their MIME, and `held_unverified` (or any notification without MIME) keeps
/// the attachment files. Attachment deletion failures are logged; a MIME deletion failure is returned.
pub async fn cleanup_notification_files(pool: &PgPool, storage: &Storage, notification_id: Uuid) -> Result<()> {
    let mut tx = pool.begin().await?;
    let row: Option<(Uuid, String, Option<String>)> =
        sqlx::query_as("SELECT submission_id, state, mime_key FROM notifications WHERE id = $1 FOR UPDATE")
            .bind(notification_id)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((submission_id, state, mime_key)) = row else { return Ok(()) };
    let terminal = TERMINAL_STATES.contains(&state.as_str());
    let attachments_needed: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM notifications WHERE submission_id = $1 AND mime_key IS NULL
           AND state <> ALL($2))",
    )
    .bind(submission_id)
    .bind(TERMINAL_STATES)
    .fetch_one(&mut *tx)
    .await?;
    if !attachments_needed {
        let keys: Vec<String> = sqlx::query_scalar("SELECT storage_key FROM attachments WHERE submission_id = $1")
            .bind(submission_id)
            .fetch_all(&mut *tx)
            .await?;
        for key in keys {
            for area in [Area::Clean, Area::Quarantine] {
                if let Err(e) = storage.delete(&key, Some(area)) {
                    tracing::error!(key = %key, error = %e.message, "failed to delete attachment file");
                }
            }
        }
    }
    if let (true, Some(key)) = (terminal, mime_key) {
        storage.delete(&key, Some(Area::Mime))?;
        sqlx::query("UPDATE notifications SET mime_key = NULL, mime_sha256 = NULL WHERE id = $1")
            .bind(notification_id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Retention sweep for files missed by the inline cleanup (crashes, cancellations made without
/// storage access): MIME of terminal notifications and attachment files still on disk whose
/// notification has a persisted MIME or is terminal.
pub async fn cleanup_unneeded_files(pool: &PgPool, storage: &Storage) -> Result<()> {
    let mut ids: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM notifications WHERE mime_key IS NOT NULL AND state = ANY($1)")
            .bind(TERMINAL_STATES)
            .fetch_all(pool)
            .await?;
    let mut on_disk = storage.list_keys(Area::Clean);
    on_disk.extend(storage.list_keys(Area::Quarantine));
    if !on_disk.is_empty() {
        let more: Vec<Uuid> = sqlx::query_scalar(
            "SELECT DISTINCT n.id FROM attachments a JOIN notifications n ON n.submission_id = a.submission_id
             WHERE a.storage_key = ANY($1) AND (n.mime_key IS NOT NULL OR n.state = ANY($2))",
        )
        .bind(&on_disk)
        .bind(TERMINAL_STATES)
        .fetch_all(pool)
        .await?;
        ids.extend(more);
    }
    ids.sort();
    ids.dedup();
    for id in ids {
        if let Err(e) = cleanup_notification_files(pool, storage, id).await {
            tracing::error!(notification_id = %id, error = %e.message, "notification file cleanup failed");
        }
    }
    Ok(())
}
