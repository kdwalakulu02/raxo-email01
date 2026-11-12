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

    if let Some(code) = run_mail_command(primary, secondary, &args).await {
        return code;
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
                 WHERE s.form_id = $1 AND s.deleted_at IS NULL AND s.kind = 'form'
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
                 FROM submissions WHERE id = $1 AND kind = 'form'",
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
        ("capacity", _) => capacity_command(secondary, args.get(2..).unwrap_or_default(), config, pool).await,
        _ => {
            eprintln!("Error: Unknown command '{primary} {secondary}'");
            Ok(2)
        }
    }
}

async fn capacity_command(
    action: &str,
    args: &[String],
    config: &AppConfig,
    pool: &PgPool,
) -> Result<i32, sqlx::Error> {
    match action {
        "node" => {
            let Some(o) = parse_opts(args, &["--node", "--provider", "--per-minute", "--connections"]) else {
                return Ok(2);
            };
            let node = o.get("node").map(String::as_str).unwrap_or(&config.smtp_node_id);
            let per_minute =
                o.get("per-minute").and_then(|v| v.parse::<i32>().ok()).filter(|v| (1..=100000).contains(v));
            let connections = o.get("connections").and_then(|v| v.parse::<i32>().ok()).filter(|v| (1..=64).contains(v));
            let provider = o.get("provider").map(String::as_str);
            if !crate::capacity::valid_node_id(node)
                || per_minute.is_none()
                || connections.is_none()
                || provider.is_some_and(|p| p.trim().is_empty() || p.len() > 80 || p.chars().any(char::is_control))
            {
                eprintln!(
                    "Error: capacity node [--node ID] [--provider NAME] --per-minute 1..100000 --connections 1..64"
                );
                return Ok(2);
            }
            let row: Value = sqlx::query_scalar(
                "INSERT INTO smtp_nodes (node_id, provider, messages_per_minute, max_connections)
                 VALUES ($1, COALESCE($2, 'unspecified'), $3, $4)
                 ON CONFLICT (node_id) DO UPDATE SET
                   provider = COALESCE($2, smtp_nodes.provider), messages_per_minute = $3,
                   max_connections = $4, updated_at = clock_timestamp()
                 RETURNING to_jsonb(smtp_nodes) - 'lock_identity' - 'lock_device' - 'lock_inode'",
            )
            .bind(node)
            .bind(provider)
            .bind(per_minute)
            .bind(connections)
            .fetch_one(pool)
            .await?;
            out(&row);
            Ok(0)
        }
        "default" => {
            let Some(o) = parse_opts(args, &["--per-minute"]) else { return Ok(2) };
            let Some(limit) =
                o.get("per-minute").and_then(|v| v.parse::<i32>().ok()).filter(|v| (1..=100000).contains(v))
            else {
                eprintln!("Error: capacity default --per-minute 1..100000");
                return Ok(2);
            };
            sqlx::query("UPDATE smtp_capacity_settings SET default_recipient_per_minute = $1 WHERE singleton")
                .bind(limit)
                .execute(pool)
                .await?;
            out(&json!({"default_recipient_per_minute":limit}));
            Ok(0)
        }
        "recipient" => {
            let Some(o) = parse_opts(args, &["--email", "--per-minute"]) else { return Ok(2) };
            let recipient = match crate::forms::validate_recipient_email(o.get("email").map(String::as_str)) {
                Ok(recipient) => recipient,
                Err(e) => {
                    eprintln!("Error: {}", e.message);
                    return Ok(2);
                }
            };
            let limit = match o.get("per-minute").map(String::as_str) {
                Some("default") => None,
                Some(s) => match s.parse::<i32>().ok().filter(|v| (1..=100000).contains(v)) {
                    Some(n) => Some(n),
                    None => {
                        eprintln!("Error: capacity recipient --email ADDRESS --per-minute 1..100000|default");
                        return Ok(2);
                    }
                },
                None => {
                    eprintln!("Error: capacity recipient --email ADDRESS --per-minute 1..100000|default");
                    return Ok(2);
                }
            };
            sqlx::query(
                "INSERT INTO smtp_recipient_capacity (recipient_key, messages_per_minute) VALUES ($1, $2)
                 ON CONFLICT (recipient_key) DO UPDATE SET messages_per_minute = EXCLUDED.messages_per_minute",
            )
            .bind(&recipient)
            .bind(limit)
            .execute(pool)
            .await?;
            out(&json!({"recipient":recipient,"messages_per_minute":limit}));
            Ok(0)
        }
        "stats" => {
            let Some(o) = parse_opts(args, &["--node"]) else { return Ok(2) };
            let node = o.get("node").map(String::as_str).unwrap_or(&config.smtp_node_id);
            if !crate::capacity::valid_node_id(node) {
                eprintln!("Error: invalid SMTP node ID");
                return Ok(2);
            }
            let policies = rows_json(
                pool,
                "SELECT node_id, provider, messages_per_minute, max_connections,
                   (SELECT count(*) FROM send_attempts a WHERE a.node_id = smtp_nodes.node_id
                     AND (a.finished_at IS NULL OR a.finished_at > clock_timestamp() - interval '60 seconds'))
                     AS active_or_recent_attempts
                 FROM smtp_nodes WHERE node_id = $1",
                vec![Bind::Text(node.into())],
            )
            .await?;
            let Some(policy) = policies.into_iter().next() else {
                eprintln!("Error: SMTP node policy not found");
                return Ok(3);
            };
            let attempts = rows_json(
                pool,
                "SELECT outcome, count(*) AS count FROM send_attempts
                 WHERE node_id = $1 AND started_at > clock_timestamp() - interval '24 hours'
                 GROUP BY outcome ORDER BY outcome",
                vec![Bind::Text(node.into())],
            )
            .await?;
            let queue = rows_json(
                pool,
                "SELECT state, count(*) AS count FROM notifications GROUP BY state ORDER BY state",
                vec![],
            )
            .await?;
            let backoff = rows_json(
                pool,
                "SELECT destination_domain, failures, not_before FROM smtp_destination_backoff
                 WHERE node_id = $1 AND not_before > clock_timestamp() ORDER BY not_before",
                vec![Bind::Text(node.into())],
            )
            .await?;
            let default_limit: i32 =
                sqlx::query_scalar("SELECT default_recipient_per_minute FROM smtp_capacity_settings WHERE singleton")
                    .fetch_one(pool)
                    .await?;
            out(&json!({"node":policy,"default_recipient_per_minute":default_limit,
                "attempts_last_24_hours":attempts,"queue":queue,"destination_backoff":backoff}));
            Ok(0)
        }
        _ => {
            eprintln!("Error: capacity requires node, default, recipient or stats");
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

// ---------------- mail commands ----------------

/// Parses `--name value` options; returns None (after printing an error) on unknown or
/// incomplete options.
fn parse_opts(args: &[String], allowed: &[&str]) -> Option<std::collections::HashMap<String, String>> {
    let mut m = std::collections::HashMap::new();
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if allowed.contains(&a) && args.get(i + 1).is_some() {
            m.insert(a.trim_start_matches('-').to_string(), args[i + 1].clone());
            i += 2;
        } else {
            eprintln!("Error: Unrecognized or incomplete option '{a}'");
            return None;
        }
    }
    Some(m)
}

async fn run_mail_command(primary: &str, secondary: &str, args: &[String]) -> Option<i32> {
    match (primary, secondary) {
        ("dkim", "generate") => Some(dkim_generate(&args[2..])),
        ("dkim", "check") => Some(dkim_check(&args[2..]).await),
        ("send-test", _) => Some(send_test(&args[1..]).await),
        _ => None,
    }
}

fn dkim_generate(args: &[String]) -> i32 {
    let Some(o) = parse_opts(args, &["--domain", "--selector", "--out"]) else { return 2 };
    let (Some(domain), Some(selector), Some(out_path)) = (o.get("domain"), o.get("selector"), o.get("out")) else {
        eprintln!("Error: usage: dkim generate --domain <domain> --selector <selector> --out <path>");
        return 2;
    };
    let (domain, selector) = match crate::dkim::normalize_names(domain, selector) {
        Ok(x) => x,
        Err(e) => {
            eprintln!("Error: {e}");
            return 2;
        }
    };
    let path = PathBuf::from(out_path);
    if path.exists() {
        eprintln!("Error: Output file already exists (refusing to overwrite): {}", path.display());
        return 2;
    }
    let (pem, public_key) = match crate::dkim::generate_rsa_2048() {
        Ok(x) => x,
        Err(e) => {
            eprintln!("Error: {e}");
            return 4;
        }
    };
    let res = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .and_then(|mut f| f.write_all(pem.as_bytes()).and_then(|_| f.sync_all()));
    if let Err(e) = res {
        eprintln!("Error: Failed to write key file {}: {e}", path.display());
        return 2;
    }
    let name = format!("{selector}._domainkey.{domain}");
    let value = crate::dkim::dns_txt_value(&public_key);
    let chunks: Vec<String> =
        value.as_bytes().chunks(250).map(|c| format!("\"{}\"", String::from_utf8_lossy(c))).collect();
    println!("Wrote RSA-2048 private key (PKCS#8 PEM, mode 0600) to {}", path.display());
    println!();
    println!("Publish this DNS TXT record:");
    println!("  Name:  {name}");
    println!("  Type:  TXT");
    println!("  Value: {value}");
    println!();
    println!("Zone-file form (strings over 255 bytes must be split):");
    println!("  {name}. IN TXT ( {} )", chunks.join(" "));
    println!();
    println!("Then configure: DKIM_DOMAIN={domain} DKIM_SELECTOR={selector} DKIM_PRIVATE_KEY_PATH={}", path.display());
    0
}

async fn dkim_check(args: &[String]) -> i32 {
    if !args.is_empty() {
        eprintln!("Error: Unrecognized option '{}'", args[0]);
        return 2;
    }
    let cfg = match load_config_from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Configuration error: {}", e.message);
            return 2;
        }
    };
    let Some(dkim) = cfg.dkim.clone() else {
        eprintln!("Error: DKIM is not configured (set DKIM_DOMAIN, DKIM_SELECTOR, DKIM_PRIVATE_KEY_PATH).");
        return 2;
    };
    let unaligned: Vec<&String> = cfg
        .forms
        .values()
        .filter(|f| f.from.rsplit_once('@').map(|(_, d)| !dkim.aligned_with(d)).unwrap_or(true))
        .map(|f| &f.id)
        .collect();
    let system_from_aligned = dkim.aligned_with(&cfg.message_id_domain);
    let name = dkim.dns_name();
    let mut report = json!({
        "dns_name": name,
        "expected_value": dkim.dns_value(),
        "key_bits": rsa::traits::PublicKeyParts::size(dkim.public_key()) * 8,
        "system_from_aligned": system_from_aligned,
        "unaligned_forms": unaligned,
    });
    let resolver = match crate::smtp::SystemResolver::new() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Dependency failure: {e}");
            return 4;
        }
    };
    let records: Vec<String> = match resolver.inner().txt_lookup(format!("{name}.")).await {
        Ok(l) => l
            .answers()
            .iter()
            .filter_map(|r| match &r.data {
                hickory_resolver::proto::rr::RData::TXT(t) => {
                    Some(t.txt_data.iter().map(|c| String::from_utf8_lossy(c).into_owned()).collect::<String>())
                }
                _ => None,
            })
            .collect(),
        Err(e) if e.is_no_records_found() => vec![],
        Err(e) => {
            report["status"] = json!("dns_error");
            report["error"] = json!(e.to_string());
            out(&report);
            return 4;
        }
    };
    let dkim_records: Vec<&String> = records.iter().filter(|r| r.contains("p=")).collect();
    report["published"] = json!(dkim_records);
    let (status, code) = match dkim_records.as_slice() {
        [] => ("not_published", 3),
        [r] => match crate::dkim::parse_dns_public_key(r) {
            Ok(k) if &k == dkim.public_key() => ("match", 0),
            Ok(_) => ("mismatch", 3),
            Err(e) => {
                report["error"] = json!(e);
                ("invalid_record", 3)
            }
        },
        _ => ("multiple_records", 3),
    };
    report["status"] = json!(status);
    report["match"] = json!(code == 0);
    out(&report);
    code
}

async fn send_test(args: &[String]) -> i32 {
    let Some(o) = parse_opts(args, &["--to", "--from"]) else { return 2 };
    let Some(to) = o.get("to").map(|s| s.trim().to_string()) else {
        eprintln!("Error: usage: send-test --to <address> [--from <address>]");
        return 2;
    };
    let (cfg, storage, pool) = match init().await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Configuration or storage error: {e}");
            return 2;
        }
    };
    let from = o.get("from").cloned().unwrap_or_else(|| format!("notifications@{}", cfg.message_id_domain));
    for a in [&to, &from] {
        if !crate::config::email_regex().is_match(a) {
            eprintln!("Error: Invalid email address: {a}");
            return 2;
        }
    }
    let mode = match cfg.smtp_delivery_mode {
        crate::config::DeliveryMode::Relay => "relay",
        crate::config::DeliveryMode::Direct => "direct",
    };
    let now = Utc::now().to_rfc3339();
    let text = format!("This is a Raxo Email delivery test queued at {now} via {mode} delivery.\n");
    let html = format!("<p>This is a Raxo Email delivery test queued at {now} via {mode} delivery.</p>");
    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(e) => {
            eprintln!("Database connection failure: {e}");
            return 4;
        }
    };
    let notification_id = match crate::outbox::enqueue_system_message(
        &mut tx,
        &storage,
        &crate::outbox::SystemMessage {
            form_id: "__system_test__",
            from: &from,
            to: &to,
            subject: "Raxo Email delivery test",
            text: &text,
            html: &html,
            message_id_domain: &cfg.message_id_domain,
            not_after: None,
        },
    )
    .await
    {
        Ok(id) => id,
        Err(e) => {
            eprintln!("Could not queue test message: {}", e.message);
            return 4;
        }
    };
    if let Err(e) = tx.commit().await {
        eprintln!("Could not commit test message: {e}");
        return 4;
    }
    out(&json!({
        "mode": mode,
        "from": from,
        "to": to,
        "dkim": cfg.dkim.as_ref().map(|d| json!({"d": d.domain(), "s": d.selector()})),
        "classification": "queued",
        "notification_id": notification_id,
    }));
    0
}
