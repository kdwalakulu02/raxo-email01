use crate::errors::Result;
use chrono::{DateTime, Utc};
use sqlx::PgPool;

pub async fn update_worker_heartbeat(pool: &PgPool) -> Result<()> {
    let val = serde_json::json!({ "last_seen": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true) });
    sqlx::query(
        "INSERT INTO schema_meta (key, value, updated_at) VALUES ('worker_heartbeat', $1, now())
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()",
    )
    .bind(val)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_worker_heartbeat(pool: &PgPool) -> Result<Option<DateTime<Utc>>> {
    let row: Option<(serde_json::Value,)> =
        sqlx::query_as("SELECT value FROM schema_meta WHERE key = 'worker_heartbeat'").fetch_optional(pool).await?;
    let Some((v,)) = row else { return Ok(None) };
    let s = match &v {
        serde_json::Value::String(s) => Some(s.as_str()),
        serde_json::Value::Object(o) => o.get("last_seen").and_then(|x| x.as_str()),
        _ => None,
    };
    Ok(s.and_then(|s| DateTime::parse_from_rfc3339(s).ok()).map(|d| d.with_timezone(&Utc)))
}
