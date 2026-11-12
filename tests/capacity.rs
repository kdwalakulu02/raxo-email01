mod common;

use common::*;
use raxo_email::capacity::{Admission, Capacity};
use raxo_email::queue::{claim_due_notification, process_notification, recover_expired_leases, renew_lease};
use raxo_email::storage::Area;
use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use uuid::Uuid;

struct TestWorker(Child);

impl Drop for TestWorker {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

async fn database_url(e: &Env) -> String {
    let db: String = sqlx::query_scalar("SELECT current_database()").fetch_one(&e.pool).await.unwrap();
    format!("{}/{}", admin_url().rsplit_once('/').unwrap().0, db)
}

async fn run_cli(e: &Env, args: &[&str]) -> std::process::Output {
    let forms = e._dir.path().join("cli-forms.json");
    std::fs::write(&forms, r#"{"version":1,"forms":[]}"#).unwrap();
    Command::new(env!("CARGO_BIN_EXE_raxo-cli"))
        .env_clear()
        .env("DATABASE_URL", database_url(e).await)
        .env("FORMS_CONFIG_PATH", forms)
        .env("STORAGE_DIR", e.storage.root())
        .env("SMTP_HOST", "127.0.0.1")
        .env("SMTP_PORT", e.smtp.port.to_string())
        .env("SMTP_NODE_ID", "test-node")
        .args(args)
        .output()
        .unwrap()
}

#[tokio::test]
async fn capacity_cli_reports_a_missing_subcommand() {
    let e = env(EnvOpts::default()).await;
    let output = run_cli(&e, &["capacity"]).await;
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("capacity requires node, default, recipient or stats"));
}

#[tokio::test]
async fn capacity_cli_updates_and_reports_policies() {
    let e = env(EnvOpts::default()).await;
    for args in [
        vec![
            "capacity",
            "node",
            "--node",
            "test-node",
            "--provider",
            "contabo",
            "--per-minute",
            "7",
            "--connections",
            "2",
        ],
        vec!["capacity", "default", "--per-minute", "4"],
        vec!["capacity", "recipient", "--email", "OWNER@example.test", "--per-minute", "2"],
    ] {
        let output = run_cli(&e, &args).await;
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    }
    let output = run_cli(&e, &["capacity", "stats", "--node", "test-node"]).await;
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let stats: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(stats["node"]["provider"], "contabo");
    assert_eq!(stats["node"]["messages_per_minute"], 7);
    assert_eq!(stats["node"]["max_connections"], 2);
    assert_eq!(stats["default_recipient_per_minute"], 4);
    let limit: Option<i32> = sqlx::query_scalar(
        "SELECT messages_per_minute FROM smtp_recipient_capacity WHERE recipient_key = 'owner@example.test'",
    )
    .fetch_one(&e.pool)
    .await
    .unwrap();
    assert_eq!(limit, Some(2));

    let output =
        run_cli(&e, &["capacity", "recipient", "--email", "owner@example.test", "--per-minute", "default"]).await;
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let limit: Option<i32> = sqlx::query_scalar(
        "SELECT messages_per_minute FROM smtp_recipient_capacity WHERE recipient_key = 'owner@example.test'",
    )
    .fetch_one(&e.pool)
    .await
    .unwrap();
    assert_eq!(limit, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn operator_test_mail_is_queued_before_any_smtp_attempt() {
    let e = env(EnvOpts::default()).await;
    let output =
        run_cli(&e, &["send-test", "--to", "owner@example.test", "--from", "notifications@example.test"]).await;
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["classification"], "queued");
    let id = Uuid::parse_str(result["notification_id"].as_str().unwrap()).unwrap();
    assert_eq!(notif_state(&e, id).await, "queued");
    assert!(e.smtp.messages.lock().unwrap().is_empty());
    assert_eq!(run_once(&e).await.unwrap().outcome.as_deref(), Some("submitted"));
    assert_eq!(notif_state(&e, id).await, "submitted");
}

async fn start_worker(e: &Env) -> TestWorker {
    let config = e._dir.path().join("worker-forms.json");
    std::fs::write(&config, r#"{"version":1,"forms":[]}"#).unwrap();
    let socket = e._dir.path().join("sock").join("scan.sock");
    let child = Command::new(env!("CARGO_BIN_EXE_raxo-worker"))
        .env_clear()
        .env("DATABASE_URL", database_url(e).await)
        .env("FORMS_CONFIG_PATH", config)
        .env("STORAGE_DIR", e.storage.root())
        .env("SMTP_HOST", "127.0.0.1")
        .env("SMTP_PORT", e.smtp.port.to_string())
        .env("SMTP_NODE_ID", "test-node")
        .env("SMTP_WORKER_CONCURRENCY", "3")
        .env("SENTINEL_SOCKET", socket)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    TestWorker(child)
}

async fn submitted_count(e: &Env) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM notifications WHERE state = 'submitted'").fetch_one(&e.pool).await.unwrap()
}

async fn wait_for_submitted(e: &Env, wanted: i64) {
    let deadline = Instant::now() + Duration::from_secs(25);
    loop {
        let count = submitted_count(e).await;
        assert!(count <= wanted, "sent {count} messages while expecting at most {wanted}");
        if count == wanted {
            return;
        }
        assert!(Instant::now() < deadline, "only {count} messages submitted, expected {wanted}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn seed_recipient(e: &Env, recipient: &str) -> Seeded {
    let seeded = seed(e, "capacity test", &[]).await;
    sqlx::query("UPDATE submissions SET config_snapshot = jsonb_set(config_snapshot, '{recipient}', to_jsonb($1::text)) WHERE id = $2")
        .bind(recipient)
        .bind(seeded.submission_id)
        .execute(&e.pool)
        .await
        .unwrap();
    seeded
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_worker_processes_share_the_exact_node_window_and_connection_cap() {
    let e = env(EnvOpts { smtp: SmtpMode::SlowAccept(300), ..Default::default() }).await;
    for i in 0..20 {
        seed_recipient(&e, &format!("user{i}@example.test")).await;
    }
    let mut first = start_worker(&e).await;
    let mut second = start_worker(&e).await;
    wait_for_submitted(&e, 15).await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(submitted_count(&e).await, 15, "the total node cap is 15, not 15 per worker");
    assert!(first.0.try_wait().unwrap().is_none());
    assert!(second.0.try_wait().unwrap().is_none());
    let peak = e.smtp.peak_connections.load(Ordering::SeqCst);
    assert_eq!(peak, 3, "the two processes must share a three-connection cap");

    sqlx::query("UPDATE send_attempts SET finished_at = clock_timestamp() - interval '30 seconds'")
        .execute(&e.pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE send_attempts SET finished_at = clock_timestamp() - interval '61 seconds'
         WHERE id = (SELECT id FROM send_attempts ORDER BY started_at LIMIT 1)",
    )
    .execute(&e.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE notifications SET next_attempt_at = clock_timestamp() WHERE state = 'queued'")
        .execute(&e.pool)
        .await
        .unwrap();
    wait_for_submitted(&e, 16).await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(submitted_count(&e).await, 16, "only one slot expired from the rolling window");

    sqlx::query("UPDATE send_attempts SET finished_at = clock_timestamp() - interval '61 seconds'")
        .execute(&e.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE notifications SET next_attempt_at = clock_timestamp() WHERE state = 'queued'")
        .execute(&e.pool)
        .await
        .unwrap();
    wait_for_submitted(&e, 20).await;
    assert!(e.smtp.peak_connections.load(Ordering::SeqCst) <= 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn fair_recipient_queues_share_capacity_and_apply_recipient_overrides() {
    let e = env(EnvOpts::default()).await;
    sqlx::query(
        "INSERT INTO smtp_recipient_capacity (recipient_key, messages_per_minute)
         VALUES ('a@example.test', 2), ('b@example.test', 2)",
    )
    .execute(&e.pool)
    .await
    .unwrap();
    for _ in 0..3 {
        seed_recipient(&e, "a@example.test").await;
    }
    for _ in 0..2 {
        seed_recipient(&e, "b@example.test").await;
    }
    for _ in 0..5 {
        run_once(&e).await.unwrap();
    }
    let order: Vec<String> = sqlx::query_scalar("SELECT recipient_key FROM send_attempts ORDER BY started_at, id")
        .fetch_all(&e.pool)
        .await
        .unwrap();
    assert_eq!(order, ["a@example.test", "b@example.test", "a@example.test", "b@example.test"]);
    assert_eq!(submitted_count(&e).await, 4);
    let deferred: (String, i32) =
        sqlx::query_as("SELECT last_error_code, attempt_count FROM notifications WHERE state = 'queued'")
            .fetch_one(&e.pool)
            .await
            .unwrap();
    assert_eq!(deferred, ("smtp_recipient_rate_limited".into(), 0));
}

#[tokio::test(flavor = "multi_thread")]
async fn destination_backoff_does_not_stall_unrelated_domains() {
    let e = env(EnvOpts { smtp: SmtpMode::TempFailFirst(1), ..Default::default() }).await;
    let first = seed_recipient(&e, "one@busy.test").await;
    let blocked = seed_recipient(&e, "two@busy.test").await;
    let unrelated = seed_recipient(&e, "three@other.test").await;
    assert_eq!(run_once(&e).await.unwrap().outcome.as_deref(), Some("safe_retry"));
    assert_eq!(notif_state(&e, first.notification_id).await, "retry_wait");
    assert_eq!(run_once(&e).await.unwrap().outcome.as_deref(), Some("submitted"));
    assert_eq!(notif_state(&e, unrelated.notification_id).await, "submitted");
    assert_eq!(notif_state(&e, blocked.notification_id).await, "queued");
    assert!(run_once(&e).await.is_none());

    sqlx::query("UPDATE smtp_destination_backoff SET not_before = clock_timestamp() - interval '1 second'")
        .execute(&e.pool)
        .await
        .unwrap();
    assert_eq!(run_once(&e).await.unwrap().outcome.as_deref(), Some("submitted"));
    assert_eq!(notif_state(&e, blocked.notification_id).await, "submitted");
}

#[tokio::test(flavor = "multi_thread")]
async fn recipient_limit_is_shared_across_different_nodes() {
    let e = env(EnvOpts::default()).await;
    sqlx::query(
        "INSERT INTO smtp_recipient_capacity (recipient_key, messages_per_minute) VALUES ('same@example.test', 1)",
    )
    .execute(&e.pool)
    .await
    .unwrap();
    seed_recipient(&e, "same@example.test").await;
    let second = seed_recipient(&e, "same@example.test").await;
    assert_eq!(run_once(&e).await.unwrap().outcome.as_deref(), Some("submitted"));
    let capacity = Capacity::initialize(&e.pool, e.storage.root(), "another-node").await.unwrap();
    let mut deps = e.deps.clone();
    deps.capacity = capacity;
    let (notification, token) = claim_due_notification(&e.pool, &deps.capacity, 120).await.unwrap().unwrap();
    let result = process_notification(&notification, token, &deps, &|| true).await.unwrap();
    assert_eq!(result.status, "throttled");
    assert_eq!(notif_state(&e, second.notification_id).await, "queued");
    assert_eq!(e.smtp.attempts.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn lowering_connection_limit_counts_slots_from_the_previous_policy() {
    let e = env(EnvOpts::default()).await;
    let mut held = Vec::new();
    for i in 0..3 {
        let mut tx = e.pool.begin().await.unwrap();
        let admission = e.deps.capacity.admit(&mut tx, &format!("user{i}@example.test")).await.unwrap();
        let Admission::Granted(slot) = admission else { panic!("slot should be available") };
        tx.commit().await.unwrap();
        held.push(slot);
    }
    sqlx::query("UPDATE smtp_nodes SET max_connections = 1 WHERE node_id = 'test-node'")
        .execute(&e.pool)
        .await
        .unwrap();
    for remaining in [3, 1, 0] {
        while held.len() > remaining {
            held.pop();
        }
        let mut tx = e.pool.begin().await.unwrap();
        let admission = e.deps.capacity.admit(&mut tx, "other@example.test").await.unwrap();
        if remaining == 0 {
            assert!(matches!(admission, Admission::Granted(_)));
        } else {
            assert!(matches!(admission, Admission::Deferred { reason: "smtp_connections_busy", .. }));
        }
        drop(admission);
        tx.rollback().await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn long_running_attempts_remain_in_the_rate_window_until_they_finish() {
    let e = env(EnvOpts::default()).await;
    sqlx::query("UPDATE smtp_nodes SET messages_per_minute = 1 WHERE node_id = 'test-node'")
        .execute(&e.pool)
        .await
        .unwrap();
    let seeded = seed_recipient(&e, "old@example.test").await;
    sqlx::query(
        "INSERT INTO send_attempts (id, notification_id, attempt_number, outcome, started_at, node_id, recipient_key)
         VALUES ($1, $2, 1, 'submitting', clock_timestamp() - interval '3 minutes', 'test-node', 'old@example.test')",
    )
    .bind(Uuid::new_v4())
    .bind(seeded.notification_id)
    .execute(&e.pool)
    .await
    .unwrap();
    let mut tx = e.pool.begin().await.unwrap();
    let admission = e.deps.capacity.admit(&mut tx, "new@example.test").await.unwrap();
    assert!(matches!(admission, Admission::Deferred { reason: "smtp_node_rate_limited", .. }));
    tx.rollback().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_late_smtp_result_cannot_overwrite_an_expired_lease() {
    let e = env(EnvOpts { smtp: SmtpMode::SlowAccept(800), ..Default::default() }).await;
    let seeded = seed(&e, "late", &[("clean.pdf", b"%PDF-1.4 clean")]).await;
    let (notification, token) = claim_due_notification(&e.pool, &e.deps.capacity, 120).await.unwrap().unwrap();
    let deps = e.deps.clone();
    let processing = tokio::spawn(async move { process_notification(&notification, token, &deps, &|| true).await });
    let deadline = Instant::now() + Duration::from_secs(10);
    while e.smtp.attempts.load(Ordering::SeqCst) == 0 {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    sqlx::query("UPDATE notifications SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1")
        .bind(seeded.notification_id)
        .execute(&e.pool)
        .await
        .unwrap();
    recover_expired_leases(&e.pool).await.unwrap();
    assert_eq!(processing.await.unwrap().unwrap().status, "aborted");
    assert_eq!(notif_state(&e, seeded.notification_id).await, "unknown");
    assert_eq!(att_rows(&e, seeded.submission_id).await[0].disposition, "included");
    let outcome: String = sqlx::query_scalar("SELECT outcome FROM send_attempts WHERE notification_id = $1")
        .bind(seeded.notification_id)
        .fetch_one(&e.pool)
        .await
        .unwrap();
    assert_eq!(outcome, "unknown");
}

#[tokio::test]
async fn expired_lease_cannot_be_renewed_before_recovery() {
    let e = env(EnvOpts::default()).await;
    let seeded = seed_recipient(&e, "lease@example.test").await;
    let (_, token) = claim_due_notification(&e.pool, &e.deps.capacity, 120).await.unwrap().unwrap();
    sqlx::query("UPDATE notifications SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1")
        .bind(seeded.notification_id)
        .execute(&e.pool)
        .await
        .unwrap();
    assert!(!renew_lease(&e.pool, seeded.notification_id, token, 120).await.unwrap());
    assert_eq!(recover_expired_leases(&e.pool).await.unwrap().0, 1);
    assert_eq!(notif_state(&e, seeded.notification_id).await, "queued");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stale_scan_cannot_change_a_new_workers_attachment_decision() {
    for data in [b"%PDF-1.4 WAIT_SCAN BOOM".as_slice(), b"%PDF-1.4 WAIT_SCAN CLEAN".as_slice()] {
        let e = env(EnvOpts { sentinel_timeout_ms: 10000, ..Default::default() }).await;
        let seeded = seed(&e, "scan lease", &[("attachment.pdf", data)]).await;
        let (notification, token) = claim_due_notification(&e.pool, &e.deps.capacity, 120).await.unwrap().unwrap();
        let deps = e.deps.clone();
        let processing = tokio::spawn(async move { process_notification(&notification, token, &deps, &|| true).await });
        let deadline = Instant::now() + Duration::from_secs(10);
        while e.sentinel.as_ref().unwrap().scans.load(Ordering::SeqCst) == 0 {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        sqlx::query(
            "UPDATE notifications SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
        )
        .bind(seeded.notification_id)
        .execute(&e.pool)
        .await
        .unwrap();
        assert_eq!(recover_expired_leases(&e.pool).await.unwrap().0, 1);
        claim_due_notification(&e.pool, &e.deps.capacity, 120).await.unwrap().unwrap();
        sqlx::query(
            "UPDATE attachments SET scan_state = 'blocked', delivery_disposition = 'withheld',
               withheld_category = 'flagged' WHERE submission_id = $1",
        )
        .bind(seeded.submission_id)
        .execute(&e.pool)
        .await
        .unwrap();

        e.sentinel.as_ref().unwrap().release_scan.store(true, Ordering::SeqCst);
        assert_eq!(processing.await.unwrap().unwrap().status, "aborted");
        let attachment = &att_rows(&e, seeded.submission_id).await[0];
        assert_eq!(attachment.scan_state, "blocked");
        assert_eq!(attachment.disposition, "withheld");
        assert_eq!(attachment.category.as_deref(), Some("flagged"));
        assert!(e.smtp.messages.lock().unwrap().is_empty());
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn lock_identity_mismatch_fails_closed_even_if_identity_file_was_copied() {
    let e = env(EnvOpts::default()).await;
    let other = tempfile::tempdir().unwrap();
    let other_dir = other.path().join("smtp-capacity/test-node");
    std::fs::create_dir_all(&other_dir).unwrap();
    std::fs::copy(e.storage.root().join("smtp-capacity/test-node/identity"), other_dir.join("identity")).unwrap();
    let error = Capacity::initialize(&e.pool, other.path(), "test-node").await.unwrap_err();
    assert!(error.message.contains("do not share"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn crashed_worker_releases_its_connection_slot_without_retrying_ambiguous_mail() {
    let e = env(EnvOpts { smtp: SmtpMode::SlowAccept(5000), ..Default::default() }).await;
    sqlx::query("UPDATE smtp_nodes SET max_connections = 1 WHERE node_id = 'test-node'")
        .execute(&e.pool)
        .await
        .unwrap();
    let seeded = seed_recipient(&e, "crash@busy.test").await;
    let mut worker = start_worker(&e).await;
    let deadline = Instant::now() + Duration::from_secs(10);
    while e.smtp.attempts.load(Ordering::SeqCst) == 0 {
        assert!(Instant::now() < deadline);
        assert!(worker.0.try_wait().unwrap().is_none());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    worker.0.kill().unwrap();
    worker.0.wait().unwrap();
    sqlx::query("UPDATE notifications SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1")
        .bind(seeded.notification_id)
        .execute(&e.pool)
        .await
        .unwrap();
    let recovered = recover_expired_leases(&e.pool).await.unwrap();
    assert_eq!(recovered.1, 1);
    assert_eq!(notif_state(&e, seeded.notification_id).await, "unknown");
    let outcome: String = sqlx::query_scalar("SELECT outcome FROM send_attempts WHERE notification_id = $1")
        .bind(seeded.notification_id)
        .fetch_one(&e.pool)
        .await
        .unwrap();
    assert_eq!(outcome, "unknown");
    let mut tx = e.pool.begin().await.unwrap();
    let slot = e.deps.capacity.admit(&mut tx, "other@other.test").await.unwrap();
    assert!(matches!(slot, Admission::Granted(_)), "crashed process must release its slot");
    drop(slot);
    tx.rollback().await.unwrap();
    assert!(run_once(&e).await.is_none(), "unknown messages must not be automatically retried");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn registration_queues_activation_atomically_and_hides_the_production_test_page() {
    let e = env(EnvOpts::default()).await;
    let forms = e._dir.path().join("api-forms.json");
    std::fs::write(&forms, r#"{"version":1,"forms":[]}"#).unwrap();
    let mut env = HashMap::new();
    env.insert("NODE_ENV".into(), "production".into());
    env.insert("DATABASE_URL".into(), database_url(&e).await);
    env.insert("FORMS_CONFIG_PATH".into(), forms.to_string_lossy().into_owned());
    env.insert("STORAGE_DIR".into(), e.storage.root().to_string_lossy().into_owned());
    env.insert("SMTP_DELIVERY_MODE".into(), "direct".into());
    env.insert("SMTP_HELO_NAME".into(), "mail.example.test".into());
    env.insert("SMTP_NODE_ID".into(), "test-node".into());
    env.insert("IP_HASH_SECRET".into(), "test-only-ip-hash-key".into());
    env.insert("CAPTCHA_SECRET".into(), "test-only-captcha-key".into());
    let config = raxo_email::config::load_config(&env, None).unwrap();
    let state = raxo_email::http::AppState::new(config, e.pool.clone(), e.storage.clone(), e.deps.sentinel.clone());
    let router = raxo_email::http::build_router(state).into_make_service_with_connect_info::<std::net::SocketAddr>();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let client = reqwest::Client::new();
    assert_eq!(client.get(format!("{base}/test")).send().await.unwrap().status(), 404);
    let response = client
        .post(format!("{base}/api/forms"))
        .header("accept", "application/json")
        .json(&serde_json::json!({"email":"owner@example.test"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 201);
    let body: serde_json::Value = response.json().await.unwrap();
    assert!(body["message"].as_str().unwrap().contains("queued"));
    assert!(e.smtp.messages.lock().unwrap().is_empty(), "registration must not send outside the queue");
    let management = body["management_token"].as_str().unwrap();
    let form_id = body["form_id"].as_str().unwrap();
    sqlx::query("UPDATE registered_forms SET last_verification_sent_at = now() - interval '61 seconds'")
        .execute(&e.pool)
        .await
        .unwrap();
    let resend = client
        .post(format!("{base}/api/forms/{form_id}/resend"))
        .header("accept", "application/json")
        .send()
        .await
        .unwrap();
    assert_eq!(resend.status(), 429, "a queued activation must not be invalidated by a resend");
    let (notification, key): (Uuid, String) = sqlx::query_as(
        "SELECT n.id, n.mime_key FROM notifications n JOIN submissions s ON s.id = n.submission_id WHERE s.kind = 'system'",
    )
    .fetch_one(&e.pool)
    .await
    .unwrap();
    let path = e.storage.resolve(&key, Area::Mime).unwrap();
    assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    assert!(std::fs::read_to_string(&path).unwrap().contains(management));
    assert_eq!(run_once(&e).await.unwrap().outcome.as_deref(), Some("submitted"));
    assert!(!path.exists(), "terminal activation MIME containing tokens must be removed");
    let key_after: Option<String> = sqlx::query_scalar("SELECT mime_key FROM notifications WHERE id = $1")
        .bind(notification)
        .fetch_one(&e.pool)
        .await
        .unwrap();
    assert!(key_after.is_none());
    let raw = e.smtp.messages.lock().unwrap()[0].clone();
    let text = plain_body(&raw);
    assert!(text.contains(management));
    let token = text.split("/verify?token=").nth(1).unwrap().split_whitespace().next().unwrap();
    assert_eq!(client.get(format!("{base}/verify?token={token}")).send().await.unwrap().status(), 200);
    let status: String = sqlx::query_scalar("SELECT status FROM registered_forms").fetch_one(&e.pool).await.unwrap();
    assert_eq!(status, "active");

    let mut tx = e.pool.begin().await.unwrap();
    let expired = raxo_email::outbox::enqueue_system_message(
        &mut tx,
        &e.storage,
        &raxo_email::outbox::SystemMessage {
            form_id: "expired",
            from: "notifications@example.test",
            to: "expired@example.test",
            subject: "Expired activation",
            text: "Expired token",
            html: "<p>Expired token</p>",
            message_id_domain: "example.test",
            not_after: Some(chrono::Utc::now() - chrono::Duration::seconds(1)),
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let expired_key: String = sqlx::query_scalar("SELECT mime_key FROM notifications WHERE id = $1")
        .bind(expired)
        .fetch_one(&e.pool)
        .await
        .unwrap();
    let expired_result = run_once(&e).await.unwrap();
    assert_eq!(expired_result.outcome.as_deref(), Some("message_expired"));
    assert_eq!(e.smtp.attempts.load(Ordering::SeqCst), 1);
    assert!(!e.storage.exists(&expired_key, Some(Area::Mime)));

    sqlx::raw_sql(
        "CREATE FUNCTION reject_test_queue() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'test queue failure'; END $$;
         CREATE TRIGGER reject_test_queue BEFORE INSERT ON notifications
         FOR EACH ROW EXECUTE FUNCTION reject_test_queue();",
    )
    .execute(&e.pool)
    .await
    .unwrap();
    let failed = client
        .post(format!("{base}/api/forms"))
        .header("accept", "application/json")
        .json(&serde_json::json!({"email":"another@example.test"}))
        .send()
        .await
        .unwrap();
    assert!(failed.status().is_server_error());
    let forms_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM registered_forms").fetch_one(&e.pool).await.unwrap();
    assert_eq!(forms_count, 1, "form registration must roll back if activation cannot be queued");
    assert!(e.storage.list_keys(Area::Mime).is_empty());
    server.abort();
}
