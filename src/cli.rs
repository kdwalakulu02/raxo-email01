use crate::config::{load_config_from_env, AppConfig};
use crate::db::create_pool;
use crate::retention::run_retention;
use crate::sentinel::{outcome_of, record_scan_result, ScanOutcome, Sentinel};
use crate::storage::{sha256_hex, Area, Storage};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use uuid::Uuid;

fn parse_uuid(s: Option<&String>) -> Option<Uuid> {
    let s = s?;
    if s.len() != 36 {
        return None;
    }
    Uuid::parse_str(s).ok()
}

fn out(v: &Value) {
    println!("{}", serde_json::to_string_pretty(v).unwrap());
}

pub async fn run_cli(args: Vec<String>) -> i32 {
    if args.is_empty() {
        eprintln!("Error: No command specified.");
        return 2;
    }
    let primary = args[0].as_str();
    let secondary = args.get(1).map(String::as_str).unwrap_or("");

    if primary == "forms" && secondary == "validate" {
        return match load_config_from_env() {
            Ok(c) => {
                println!(
                    "{}",
                    json!({"status":"ok","forms_config_path":c.forms_config_path,"form_count":c.forms.len(),
                           "forms":c.forms.keys().collect::<Vec<_>>()})
                );
                0
            }
            Err(e) => {
                eprintln!("Configuration validation error: {}", e.message);
                2
            }
        };
    }

    let (config, storage, pool) = match init().await {
        Ok(x) => x,
        Err(e) => {
            eprintln!("Failed to initialize configuration or storage: {e}");
            return 4;
        }
    };
    if let Err(e) = sqlx::query("SELECT 1").execute(&pool).await {
        eprintln!("Database connection failure: {e}");
        return 4;
    }
    match dispatch(primary, secondary, &args, &config, &storage, &pool).await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Internal command error: {e}");
            4
        }
    }
}

async fn init() -> Result<(AppConfig, Storage, PgPool), String> {
    let config = load_config_from_env().map_err(|e| e.message)?;
    let storage = Storage::new(&config.storage_dir).map_err(|e| e.message)?;
    let pool = create_pool(&config.database_url, 2).await.map_err(|e| e.message)?;
    Ok((config, storage, pool))
}

async fn rows_json(pool: &PgPool, sql: &str, binds: Vec<Bind>) -> Result<Vec<Value>, sqlx::Error> {
    let wrapped = format!("SELECT to_jsonb(t) FROM ({sql}) t");
    let mut q = sqlx::query_scalar::<_, Value>(&wrapped);
    for b in binds {
        q = match b {
            Bind::Text(s) => q.bind(s),
            Bind::Uuid(u) => q.bind(u),
            Bind::Int(i) => q.bind(i),
        };
    }
    q.fetch_all(pool).await
}

enum Bind {
    Text(String),
    Uuid(Uuid),
    Int(i64),
}

async fn dispatch(
    primary: &str,
    secondary: &str,
    args: &[String],
    config: &AppConfig,
    storage: &Storage,
    pool: &PgPool,
) -> Result<i32, sqlx::Error> {
    match (primary, secondary) {
        ("submissions", "list") => {
            let mut form: Option<String> = None;
            let mut limit: i64 = 20;
            let mut i = 2;
            while i < args.len() {
                match args[i].as_str() {
                    "--form" if args.get(i + 1).is_some() => {
                        i += 1;
                        form = Some(args[i].clone());
                    }
                    "--limit" if args.get(i + 1).is_some() => {
                        i += 1;
                        match args[i].parse::<i64>() {
                            Ok(n) if (1..=100).contains(&n) => limit = n,
                            _ => {
                                eprintln!("Error: --limit must be an integer between 1 and 100.");
                                return Ok(2);
                            }
                        }
                    }
                    "--json" => {}
                    other => {
                        eprintln!("Error: Unrecognized option '{other}'");
                        return Ok(2);
                    }
                }
                i += 1;
            }
            let Some(form) = form else {
                eprintln!("Error: --form <form-id> is required.");
                return Ok(2);
            };
            let rows = rows_json(
                pool,
                "SELECT s.id, s.form_id, s.client_submission_id, s.fingerprint, s.created_at,
                        count(a.id)::int AS attachment_count, n.state AS notification_state
                 FROM submissions s LEFT JOIN attachments a ON a.submission_id = s.id
                 LEFT JOIN notifications n ON n.submission_id = s.id
                 WHERE s.form_id = $1 AND s.deleted_at IS NULL
                 GROUP BY s.id, n.state ORDER BY s.created_at DESC, s.id DESC LIMIT $2",
                vec![Bind::Text(form), Bind::Int(limit)],
            )
            .await?;
            out(&Value::Array(rows));
            Ok(0)
        }
        ("submissions", "show") => {
            let Some(id) = parse_uuid(args.get(2)) else {
                eprintln!("Error: Valid submission UUID is required.");
                return Ok(2);
            };
            let sub = rows_json(
                pool,
                "SELECT id, form_id, client_submission_id, fingerprint, fields, created_at, deleted_at
                 FROM submissions WHERE id = $1",
                vec![Bind::Uuid(id)],
            )
            .await?;
            let Some(mut sub) = sub.into_iter().next().filter(|s| s["deleted_at"].is_null()) else {
                eprintln!("Error: Submission {id} not found or has been deleted.");
                return Ok(3);
            };
            sub.as_object_mut().unwrap().remove("deleted_at");
            let atts = rows_json(
                pool,
                "SELECT id, original_name, size_bytes, sha256, scan_state, scanned_at, created_at
                 FROM attachments WHERE submission_id = $1 ORDER BY created_at ASC",
                vec![Bind::Uuid(id)],
            )
            .await?;
            let n = rows_json(
                pool,
                "SELECT id, state, attempt_count, next_attempt_at, last_error_code, smtp_receipt, created_at, updated_at
                 FROM notifications WHERE submission_id = $1",
                vec![Bind::Uuid(id)],
            )
            .await?;
            out(&json!({"submission": sub, "attachments": atts, "notification": n.into_iter().next()}));
            Ok(0)
        }
        ("attachments", "export") => export_attachment(args, config, storage, pool).await,
        ("submissions", "delete") => {
            let Some(id) = parse_uuid(args.get(2)) else {
                eprintln!("Error: Valid submission UUID is required.");
                return Ok(2);
            };
            if !args.iter().any(|a| a == "--confirm") {
                eprintln!("Error: --confirm flag is required to delete submission.");
                return Ok(2);
            }
            let mut tx = pool.begin().await?;
            let notif: Option<(Uuid, String)> =
                sqlx::query_as("SELECT id, state FROM notifications WHERE submission_id = $1 FOR UPDATE")
                    .bind(id)
                    .fetch_optional(&mut *tx)
                    .await?;
            let sub: Option<(Uuid, Option<DateTime<Utc>>)> =
                sqlx::query_as("SELECT id, deleted_at FROM submissions WHERE id = $1 FOR UPDATE")
                    .bind(id)
                    .fetch_optional(&mut *tx)
                    .await?;
            let Some((_, deleted)) = sub else {
                eprintln!("Error: Submission {id} not found.");
                return Ok(3);
            };
            if deleted.is_none() {
                sqlx::query("UPDATE submissions SET deleted_at = now() WHERE id = $1")
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
            }
            if let Some((nid, state)) = notif {
                if ["queued", "retry_wait", "preparing"].contains(&state.as_str()) {
                    sqlx::query("UPDATE notifications SET state = 'cancelled', updated_at = now() WHERE id = $1")
                        .bind(nid)
                        .execute(&mut *tx)
                        .await?;
                }
            }
            tx.commit().await?;
            println!("{}", json!({"status":"tombstoned","submission_id":id}));
            Ok(0)
        }
        ("retention", "run") => {
            let mut reference = Utc::now();
            let mut i = 2;
            while i < args.len() {
                if args[i] == "--now" && args.get(i + 1).is_some() {
                    i += 1;
                    match DateTime::parse_from_rfc3339(&args[i]) {
                        Ok(d) => reference = d.with_timezone(&Utc),
                        Err(_) => {
                            eprintln!("Error: Invalid ISO-UTC timestamp for --now.");
                            return Ok(2);
                        }
                    }
                } else {
                    eprintln!("Error: Unrecognized option '{}'", args[i]);
                    return Ok(2);
                }
                i += 1;
            }
            match run_retention(pool, storage, reference).await {
                Ok(r) => {
                    println!(
                        "{}",
                        json!({"status":"completed","tombstonesCleaned":r.tombstones_cleaned,
                               "expiredCleaned":r.expired_cleaned,"orphansSwept":r.orphans_swept,
                               "rateBucketsCleaned":r.rate_buckets_cleaned,"unverifiedCleaned":r.unverified_cleaned})
                    );
                    Ok(0)
                }
                Err(e) => {
                    eprintln!("Internal command error: {}", e.message);
                    Ok(4)
                }
            }
        }
        ("notifications", "show") => {
            let Some(id) = parse_uuid(args.get(2)) else {
                eprintln!("Error: Valid notification UUID is required.");
                return Ok(2);
            };
            let n = rows_json(
                pool,
                "SELECT n.*, s.form_id FROM notifications n JOIN submissions s ON s.id = n.submission_id WHERE n.id = $1",
                vec![Bind::Uuid(id)],
            )
            .await?;
            let Some(n) = n.into_iter().next() else {
                eprintln!("Error: Notification {id} not found.");
                return Ok(3);
            };
            let attempts = rows_json(
                pool,
                "SELECT id, attempt_number, outcome, error_code, receipt, started_at, finished_at
                 FROM send_attempts WHERE notification_id = $1 ORDER BY attempt_number ASC",
                vec![Bind::Uuid(id)],
            )
            .await?;
            out(&json!({"notification": n, "attempts": attempts}));
            Ok(0)
        }
        _ => {
            eprintln!("Error: Unknown command '{primary} {secondary}'");
            Ok(2)
        }
    }
}

async fn export_attachment(
    args: &[String],
    config: &AppConfig,
    storage: &Storage,
    pool: &PgPool,
) -> Result<i32, sqlx::Error> {
    let Some(id) = parse_uuid(args.get(2)) else {
        eprintln!("Error: Valid attachment UUID is required.");
        return Ok(2);
    };
    let mut out_path: Option<String> = None;
    let mut i = 3;
    while i < args.len() {
        if args[i] == "--out" && args.get(i + 1).is_some() {
            i += 1;
            out_path = Some(args[i].clone());
        } else {
            eprintln!("Error: Unrecognized option '{}'", args[i]);
            return Ok(2);
        }
        i += 1;
    }
    let Some(out_path) = out_path else {
        eprintln!("Error: --out <path> is required.");
        return Ok(2);
    };
    let cwd = std::env::current_dir().unwrap_or_default();
    let resolved: PathBuf = cwd.join(&out_path);
    let storage_abs = cwd.join(&config.storage_dir);
    if resolved.starts_with(&storage_abs) {
        eprintln!("Error: Output path cannot be located inside STORAGE_DIR.");
        return Ok(2);
    }
    if resolved.exists() {
        eprintln!("Error: Output file already exists: {}", resolved.display());
        return Ok(2);
    }
    type Row = (String, String, i64, String, Option<DateTime<Utc>>, Option<DateTime<Utc>>, Uuid);
    let row: Option<Row> = sqlx::query_as(
        "SELECT a.storage_key, a.scan_state, a.size_bytes, a.sha256, a.scanned_at, s.deleted_at, a.id
         FROM attachments a JOIN submissions s ON s.id = a.submission_id WHERE a.id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    let Some((key, state, _size, sha, scanned_at, deleted, att_id)) = row.filter(|r| r.5.is_none()) else {
        eprintln!("Error: Attachment {id} not found or parent submission was deleted.");
        return Ok(3);
    };
    let _ = deleted;
    if state == "blocked" {
        eprintln!("Error: Attachment is blocked by scanner and cannot be exported.");
        return Ok(3);
    }
    if state == "deleted" {
        eprintln!("Error: Attachment has been deleted.");
        return Ok(3);
    }
    let fresh = state == "clean" && scanned_at.map(|t| (Utc::now() - t).num_hours() <= 48).unwrap_or(false);
    if !fresh {
        let content = match storage.read(&key, None) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("Error reading file from storage: {}", e.message);
                return Ok(3);
            }
        };
        let actual = sha256_hex(&content);
        if actual != sha {
            eprintln!("Error: Stored file SHA-256 checksum mismatch.");
            return Ok(3);
        }
        let snap = match storage.snapshot_dir() {
            Ok(p) => p,
            Err(e) => {
                eprintln!("Dependency failure: {}", e.message);
                return Ok(4);
            }
        };
        let sentinel = Sentinel::new(config, snap);
        let rec = sentinel.scan(content, &actual, &att_id.to_string()).await;
        let notif: Option<(Uuid,)> = sqlx::query_as(
            "SELECT n.id FROM notifications n JOIN attachments a ON a.submission_id = n.submission_id WHERE a.id = $1",
        )
        .bind(att_id)
        .fetch_optional(pool)
        .await?;
        if let Some((nid,)) = notif {
            let _ = record_scan_result(pool, att_id, nid, &rec).await;
        }
        match outcome_of(&rec) {
            ScanOutcome::Error { reason } => {
                eprintln!("Dependency failure: Scanner error: {reason}");
                return Ok(4);
            }
            ScanOutcome::Blocked { reason } => {
                sqlx::query("UPDATE attachments SET scan_state = 'blocked', scanned_at = now() WHERE id = $1")
                    .bind(att_id)
                    .execute(pool)
                    .await?;
                eprintln!("Error: Attachment scan blocked: {reason}");
                return Ok(3);
            }
            ScanOutcome::Clean { version } => {
                if let Err(e) = storage.move_to_clean(&key) {
                    eprintln!("Error: {}", e.message);
                    return Ok(3);
                }
                sqlx::query(
                    "UPDATE attachments SET scan_state = 'clean', scan_version = $1, scanned_at = now() WHERE id = $2",
                )
                .bind(version)
                .bind(att_id)
                .execute(pool)
                .await?;
            }
        }
    }
    let content = match storage.read(&key, Some(Area::Clean)) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Error reading file from storage: {}", e.message);
            return Ok(3);
        }
    };
    let digest = sha256_hex(&content);
    if digest != sha {
        eprintln!("Error: Stored file SHA-256 checksum mismatch.");
        return Ok(3);
    }
    let res = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&resolved)
        .and_then(|mut f| f.write_all(&content));
    match res {
        Ok(()) => {
            println!(
                "{}",
                json!({"status":"exported","attachment_id":att_id,"out":resolved,"size_bytes":content.len(),"sha256":digest})
            );
            Ok(0)
        }
        Err(e) => {
            eprintln!("Failed to write output file: {e}");
            Ok(2)
        }
    }
}
