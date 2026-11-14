use crate::errors::{AppError, Result};
use sha2::{Digest, Sha256};
use sqlx::postgres::{PgPool, PgPoolOptions};
use std::path::Path;
use std::time::Duration;

const MIGRATION_LOCK_KEY: i64 = 726900;

pub async fn create_pool(url: &str, max: u32) -> Result<PgPool> {
    PgPoolOptions::new()
        .max_connections(max)
        .idle_timeout(Duration::from_secs(30))
        .acquire_timeout(Duration::from_secs(5))
        .connect_lazy(url)
        .map_err(|e| AppError::config("bad_request", format!("Invalid DATABASE_URL: {e}")))
}

#[derive(Debug, Default)]
pub struct MigrationResult {
    pub applied: Vec<String>,
    pub skipped: Vec<String>,
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// Migrations are embedded at compile time. 001–004 are byte-identical to the
/// Node reference migrations (same schema and `schema_migrations` checksums);
/// 005–007 are Rust-only additive extensions.
pub const EMBEDDED: &[(&str, &str)] = &[
    ("001_initial", include_str!("../migrations/001_initial.sql")),
    ("002_dynamic_forms", include_str!("../migrations/002_dynamic_forms.sql")),
    ("003_security_hardening", include_str!("../migrations/003_security_hardening.sql")),
    ("004_scan_results", include_str!("../migrations/004_scan_results.sql")),
    ("005_attachment_disposition", include_str!("../migrations/005_attachment_disposition.sql")),
    ("006_outbound_capacity", include_str!("../migrations/006_outbound_capacity.sql")),
    ("007_partial_inspection", include_str!("../migrations/007_partial_inspection.sql")),
];

pub async fn run_migrations(pool: &PgPool) -> Result<MigrationResult> {
    run_migrations_with(pool, EMBEDDED.iter().map(|(v, s)| (v.to_string(), s.to_string())).collect()).await
}

pub fn read_migrations_dir(dir: &Path) -> Result<Vec<(String, String)>> {
    let mut files: Vec<_> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".sql"))
        .collect();
    files.sort_by_key(|e| e.file_name());
    files
        .into_iter()
        .map(|e| {
            let name = e.file_name().to_string_lossy().trim_end_matches(".sql").to_string();
            Ok((name, std::fs::read_to_string(e.path())?))
        })
        .collect()
}

pub async fn run_migrations_with(pool: &PgPool, migrations: Vec<(String, String)>) -> Result<MigrationResult> {
    let mut conn = pool.acquire().await?;
    sqlx::query("SELECT pg_advisory_lock($1)").bind(MIGRATION_LOCK_KEY).execute(&mut *conn).await?;
    let res = migrate_locked(&mut conn, migrations).await;
    let _ = sqlx::query("SELECT pg_advisory_unlock($1)").bind(MIGRATION_LOCK_KEY).execute(&mut *conn).await;
    res
}

async fn migrate_locked(conn: &mut sqlx::PgConnection, migrations: Vec<(String, String)>) -> Result<MigrationResult> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
           version text PRIMARY KEY,
           sha256 text NOT NULL,
           applied_at timestamptz NOT NULL DEFAULT now())",
    )
    .execute(&mut *conn)
    .await?;
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT version, sha256 FROM schema_migrations ORDER BY version ASC")
            .fetch_all(&mut *conn)
            .await?;
    let applied_map: std::collections::HashMap<_, _> = rows.into_iter().collect();
    let mut out = MigrationResult::default();
    for (version, sql) in migrations {
        let sha = sha256_hex(sql.as_bytes());
        if let Some(recorded) = applied_map.get(&version) {
            if *recorded != sha {
                return Err(AppError::config(
                    "bad_request",
                    format!(
                        "Migration {version} checksum mismatch! Recorded: {recorded}, current: {sha}. Refusing to run with modified applied migration."
                    ),
                ));
            }
            out.skipped.push(version);
        } else {
            let mut tx = sqlx::Connection::begin(&mut *conn).await?;
            sqlx::raw_sql(&sql).execute(&mut *tx).await?;
            sqlx::query("INSERT INTO schema_migrations (version, sha256) VALUES ($1, $2)")
                .bind(&version)
                .bind(&sha)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            out.applied.push(version);
        }
    }
    Ok(out)
}
