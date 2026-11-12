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

pub async fn cleanup_system_mime(pool: &PgPool, storage: &Storage, notification_id: Uuid) -> Result<()> {
    let mut tx = pool.begin().await?;
    let key: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT n.mime_key FROM notifications n JOIN submissions s ON s.id = n.submission_id
         WHERE n.id = $1 AND s.kind = 'system'
           AND n.state IN ('submitted','unknown','failed','blocked','cancelled')
         FOR UPDATE OF n",
    )
    .bind(notification_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((Some(key),)) = key {
        storage.delete(&key, Some(Area::Mime))?;
        sqlx::query("UPDATE notifications SET mime_key = NULL, mime_sha256 = NULL WHERE id = $1")
            .bind(notification_id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn cleanup_terminal_system_mimes(pool: &PgPool, storage: &Storage) -> Result<()> {
    let ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT n.id FROM notifications n JOIN submissions s ON s.id = n.submission_id
         WHERE s.kind = 'system' AND n.mime_key IS NOT NULL
           AND n.state IN ('submitted','unknown','failed','blocked','cancelled')",
    )
    .fetch_all(pool)
    .await?;
    for id in ids {
        if let Err(e) = cleanup_system_mime(pool, storage, id).await {
            tracing::error!(notification_id = %id, error = %e.message, "system message cleanup failed");
        }
    }
    Ok(())
}
