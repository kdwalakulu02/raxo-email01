use crate::errors::{AppError, Result};
use chrono::{DateTime, Duration, Utc};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, PgPool};

type HmacSha256 = Hmac<Sha256>;

pub fn compute_ip_hash(secret: &str, date_iso: &str, remote_ip: &str) -> String {
    let secret = if secret.is_empty() { "default_local_hash_secret_for_dev" } else { secret };
    let date = &date_iso[..10.min(date_iso.len())];
    let ip = remote_ip.trim().to_lowercase();
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("hmac key");
    mac.update(format!("{date}:{ip}").as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

fn iso(t: DateTime<Utc>) -> String {
    t.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn floor_to(t: DateTime<Utc>, secs: i64) -> DateTime<Utc> {
    DateTime::from_timestamp((t.timestamp() / secs) * secs, 0).unwrap()
}

/// Returns true when the bucket was incremented and false when the limit is already reached.
async fn bump(
    conn: &mut PgConnection,
    form_id: &str,
    kind: &str,
    key: &str,
    expires: DateTime<Utc>,
    limit: i32,
) -> Result<bool> {
    let row = sqlx::query(&format!(
        "INSERT INTO rate_buckets (form_id, bucket_kind, bucket_key, hits, expires_at)
         VALUES ($1, '{kind}', $2, 1, $3)
         ON CONFLICT (form_id, bucket_kind, bucket_key)
         DO UPDATE SET hits = rate_buckets.hits + 1
         WHERE rate_buckets.hits < $4
         RETURNING hits"
    ))
    .bind(form_id)
    .bind(key)
    .bind(expires)
    .bind(limit)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.is_some())
}

async fn single(
    pool: &PgPool,
    form_id: &str,
    kind: &str,
    key: &str,
    expires: DateTime<Utc>,
    limit: i32,
    err: AppError,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    if !bump(&mut tx, form_id, kind, key, expires, limit).await? {
        let _ = tx.rollback().await;
        return Err(err);
    }
    tx.commit().await?;
    Ok(())
}

pub async fn consume_rate_limit(
    pool: &PgPool,
    form_id: &str,
    ip_hash: &str,
    now: DateTime<Utc>,
    minute_limit: i32,
    daily_limit: i32,
) -> Result<()> {
    let minute_key = format!("{}_{}", ip_hash, &iso(floor_to(now, 60))[..16]);
    let day_key = iso(now)[..10].to_string();
    let mut tx = pool.begin().await?;
    if !bump(&mut tx, form_id, "ip_minute", &minute_key, now + Duration::hours(1), minute_limit).await? {
        let _ = tx.rollback().await;
        return Err(AppError::rate_limited("Too many form submission attempts from your IP. Please try again later."));
    }
    if !bump(&mut tx, form_id, "form_day", &day_key, now + Duration::hours(36), daily_limit).await? {
        let _ = tx.rollback().await;
        return Err(AppError::rate_limited("Form daily attempt limit reached. Please try again tomorrow."));
    }
    tx.commit().await?;
    Ok(())
}

pub async fn consume_registration_rate_limit(pool: &PgPool, ip_hash: &str, now: DateTime<Utc>) -> Result<()> {
    let key = format!("{}_{}", ip_hash, &iso(floor_to(now, 3600))[..13]);
    single(
        pool,
        "__registration__",
        "register_ip_hour",
        &key,
        now + Duration::hours(2),
        10,
        AppError::rate_limited("Too many form creation attempts from your IP. Please try again in an hour."),
    )
    .await
}

pub async fn consume_recipient_registration_rate_limit(pool: &PgPool, email: &str, now: DateTime<Utc>) -> Result<()> {
    let h = hex::encode(Sha256::digest(email.trim().to_lowercase().as_bytes()));
    let key = format!("{}_{}", h, &iso(floor_to(now, 3600))[..13]);
    single(
        pool,
        "__registration_recipient__",
        "register_recipient_hour",
        &key,
        now + Duration::hours(2),
        3,
        AppError::rate_limited("Too many form creation attempts for this email address. Please try again in an hour."),
    )
    .await
}

pub async fn consume_global_rate_limit(pool: &PgPool, now: DateTime<Utc>, limit: i32) -> Result<()> {
    let key = iso(floor_to(now, 60))[..16].to_string();
    single(
        pool,
        "__global__",
        "global_minute",
        &key,
        now + Duration::hours(1),
        limit,
        AppError::unavailable("Service capacity temporarily reached. Please retry in a few moments."),
    )
    .await
}

pub async fn consume_deactivation_rate_limit(pool: &PgPool, form_id: &str, now: DateTime<Utc>) -> Result<()> {
    let key = iso(floor_to(now, 3600))[..13].to_string();
    single(
        pool,
        form_id,
        "deactivate_form_hour",
        &key,
        now + Duration::hours(2),
        5,
        AppError::rate_limited("Too many deactivation attempts for this form. Please try again later."),
    )
    .await
}
