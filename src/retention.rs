use crate::errors::Result;
use crate::storage::{Area, Storage};
use chrono::{DateTime, Duration as CDuration, Utc};
use sqlx::PgPool;
use std::collections::HashSet;
use std::time::Duration;
use uuid::Uuid;

#[derive(Debug, Default, Clone, PartialEq)]
pub struct RetentionResult {
    pub tombstones_cleaned: u64,
    pub expired_cleaned: u64,
    pub orphans_swept: u64,
    pub rate_buckets_cleaned: u64,
    pub unverified_cleaned: u64,
}

pub async fn run_retention(pool: &PgPool, storage: &Storage, reference: DateTime<Utc>) -> Result<RetentionResult> {
    let mut out = RetentionResult::default();
    crate::outbox::cleanup_unneeded_files(pool, storage).await?;
    let seven = reference - CDuration::days(7);
    let ninety = reference - CDuration::days(90);

    // 7-day unverified held submissions
    let ids: Vec<(Uuid,)> = sqlx::query_as(
        "SELECT s.id FROM submissions s JOIN notifications n ON n.submission_id = s.id
         WHERE n.state = 'held_unverified' AND s.created_at < $1 AND s.deleted_at IS NULL",
    )
    .bind(seven)
    .fetch_all(pool)
    .await?;
    for (id,) in ids {
        let mut tx = pool.begin().await?;
        lock(&mut tx, id).await?;
        sqlx::query("UPDATE submissions SET deleted_at = $1 WHERE id = $2")
            .bind(reference)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "UPDATE notifications SET state = 'cancelled', updated_at = now()
             WHERE submission_id = $1 AND state = 'held_unverified'",
        )
        .bind(id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        out.unverified_cleaned += 1;
    }

    sqlx::query(
        "UPDATE registered_forms SET status = 'deactivated', deactivated_at = now()
         WHERE status = 'pending_verification' AND created_at < $1",
    )
    .bind(seven)
    .execute(pool)
    .await?;

    // 90-day expiry
    let ids: Vec<(Uuid,)> = sqlx::query_as("SELECT id FROM submissions WHERE created_at < $1 AND deleted_at IS NULL")
        .bind(ninety)
        .fetch_all(pool)
        .await?;
    for (id,) in ids {
        let mut tx = pool.begin().await?;
        lock(&mut tx, id).await?;
        sqlx::query("UPDATE submissions SET deleted_at = $1 WHERE id = $2")
            .bind(reference)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "UPDATE notifications SET state = 'cancelled', updated_at = now()
             WHERE submission_id = $1 AND state IN ('queued','retry_wait','preparing')",
        )
        .bind(id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
    }

    // Clean tombstoned submissions
    let tombs: Vec<(Uuid, DateTime<Utc>)> =
        sqlx::query_as("SELECT id, created_at FROM submissions WHERE deleted_at IS NOT NULL AND cleanup_done = false")
            .fetch_all(pool)
            .await?;
    for (id, created) in tombs {
        let atts: Vec<(String,)> = sqlx::query_as("SELECT storage_key FROM attachments WHERE submission_id = $1")
            .bind(id)
            .fetch_all(pool)
            .await?;
        let notifs: Vec<(Uuid, Option<String>)> =
            sqlx::query_as("SELECT id, mime_key FROM notifications WHERE submission_id = $1")
                .bind(id)
                .fetch_all(pool)
                .await?;
        let mut failed = false;
        for (k,) in &atts {
            if let Err(e) = storage.delete(k, None) {
                failed = true;
                tracing::error!(key = %k, error = %e.message, "failed to delete attachment file");
            }
        }
        if let Some(k) = notifs.first().and_then(|n| n.1.as_ref()) {
            if let Err(e) = storage.delete(k, Some(Area::Mime)) {
                failed = true;
                tracing::error!(key = %k, error = %e.message, "failed to delete MIME file");
            }
        }
        if failed {
            continue;
        }
        let mut tx = pool.begin().await?;
        lock(&mut tx, id).await?;
        sqlx::query("UPDATE submissions SET fields = NULL, config_snapshot = NULL, cleanup_done = true WHERE id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "UPDATE attachments SET scan_state = 'deleted', original_name = '[redacted]' WHERE submission_id = $1",
        )
        .bind(id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE notifications SET mime_key = NULL, mime_sha256 = NULL, smtp_receipt = NULL, updated_at = now()
             WHERE submission_id = $1",
        )
        .bind(id)
        .execute(&mut *tx)
        .await?;
        if let Some((nid, _)) = notifs.first() {
            sqlx::query("UPDATE send_attempts SET receipt = NULL WHERE notification_id = $1")
                .bind(nid)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        if created < ninety {
            out.expired_cleaned += 1;
        } else {
            out.tombstones_cleaned += 1;
        }
    }

    // Orphan sweeps. The reference query must succeed before any quarantine deletion.
    let day = Duration::from_secs(24 * 3600);
    out.orphans_swept += storage.sweep_tmp(day).len() as u64;
    let refs: Vec<(String,)> = sqlx::query_as("SELECT storage_key FROM attachments").fetch_all(pool).await?;
    let refs: HashSet<String> = refs.into_iter().map(|r| r.0).collect();
    out.orphans_swept += storage.sweep_unreferenced_quarantine(day, &refs).len() as u64;
    let refs: Vec<(String,)> =
        sqlx::query_as("SELECT mime_key FROM notifications WHERE mime_key IS NOT NULL").fetch_all(pool).await?;
    let refs: HashSet<String> = refs.into_iter().map(|r| r.0).collect();
    out.orphans_swept += storage.sweep_unreferenced_mime(day, &refs).len() as u64;

    out.rate_buckets_cleaned = sqlx::query("DELETE FROM rate_buckets WHERE expires_at < $1")
        .bind(reference)
        .execute(pool)
        .await?
        .rows_affected();
    Ok(out)
}

async fn lock(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, id: Uuid) -> Result<()> {
    sqlx::query("SELECT id FROM notifications WHERE submission_id = $1 FOR UPDATE")
        .bind(id)
        .fetch_all(&mut **tx)
        .await?;
    sqlx::query("SELECT id FROM submissions WHERE id = $1 FOR UPDATE").bind(id).fetch_all(&mut **tx).await?;
    Ok(())
}
