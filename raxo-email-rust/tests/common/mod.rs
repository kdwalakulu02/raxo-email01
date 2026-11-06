#![allow(dead_code)]
//! Shared harness: per-test Postgres database, fake SMTP server, fake Sentinel coordinator.
//! Requires a reachable Postgres (TEST_DATABASE_URL, default below). Tests fail, not skip,
//! when it is unavailable.

use raxo_email::config::{AttachmentPolicy, FormConfig, FormField, FormFieldType, SmtpTlsMode};
use raxo_email::queue::{claim_due_notification, process_notification, ProcessResult, QueueDeps};
use raxo_email::sentinel::Sentinel;
use raxo_email::smtp::SmtpConfig;
use raxo_email::storage::Storage;
use sha2::{Digest, Sha256};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use std::io::{Read, Write};
use std::os::fd::FromRawFd;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use uuid::Uuid;

pub fn admin_url() -> String {
    std::env::var("TEST_DATABASE_URL").unwrap_or_else(|_| "postgres://test:testpw@127.0.0.1:55432/postgres".into())
}

pub async fn fresh_db() -> PgPool {
    let admin = PgPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(Duration::from_secs(5))
        .connect(&admin_url())
        .await
        .expect("test Postgres unreachable (set TEST_DATABASE_URL)");
    let name = format!("t_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {name}")).execute(&admin).await.unwrap();
    let url = admin_url().rsplit_once('/').map(|(h, _)| format!("{h}/{name}")).unwrap();
    let pool = PgPoolOptions::new().max_connections(8).connect(&url).await.unwrap();
    raxo_email::db::run_migrations(&pool).await.expect("migrations");
    pool
}

pub fn sha(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

// ---------------- fake SMTP ----------------

#[derive(Clone, Copy, PartialEq)]
pub enum SmtpMode {
    Accept,
    /// Reply 451 to DATA for the first n messages, then accept.
    TempFailFirst(usize),
}

pub struct FakeSmtp {
    pub port: u16,
    pub messages: Arc<Mutex<Vec<Vec<u8>>>>,
    pub attempts: Arc<AtomicUsize>,
}

pub async fn start_smtp(mode: SmtpMode) -> FakeSmtp {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let messages = Arc::new(Mutex::new(vec![]));
    let attempts = Arc::new(AtomicUsize::new(0));
    let (m2, a2) = (messages.clone(), attempts.clone());
    tokio::spawn(async move {
        loop {
            let Ok((s, _)) = l.accept().await else { return };
            let (m, a) = (m2.clone(), a2.clone());
            tokio::spawn(async move {
                let (rd, mut wr) = s.into_split();
                let mut rd = BufReader::new(rd);
                let _ = wr.write_all(b"220 fake ESMTP\r\n").await;
                let mut line = String::new();
                loop {
                    line.clear();
                    if rd.read_line(&mut line).await.unwrap_or(0) == 0 {
                        return;
                    }
                    let up = line.trim().to_ascii_uppercase();
                    if up.starts_with("EHLO") || up.starts_with("HELO") {
                        let _ = wr.write_all(b"250 fake\r\n").await;
                    } else if up.starts_with("MAIL") || up.starts_with("RCPT") || up.starts_with("RSET") {
                        let _ = wr.write_all(b"250 OK\r\n").await;
                    } else if up == "DATA" {
                        let n = a.fetch_add(1, Ordering::SeqCst);
                        if let SmtpMode::TempFailFirst(k) = mode {
                            if n < k {
                                let _ = wr.write_all(b"451 try later\r\n").await;
                                continue;
                            }
                        }
                        let _ = wr.write_all(b"354 go\r\n").await;
                        let mut data = Vec::new();
                        loop {
                            line.clear();
                            if rd.read_line(&mut line).await.unwrap_or(0) == 0 {
                                return;
                            }
                            if line == ".\r\n" {
                                break;
                            }
                            let l2 = line.strip_prefix("..").map(|r| format!(".{r}")).unwrap_or_else(|| line.clone());
                            data.extend_from_slice(l2.as_bytes());
                        }
                        m.lock().unwrap().push(data);
                        let _ = wr.write_all(b"250 2.0.0 queued as FAKE1\r\n").await;
                    } else if up == "QUIT" {
                        let _ = wr.write_all(b"221 bye\r\n").await;
                        return;
                    } else {
                        let _ = wr.write_all(b"250 OK\r\n").await;
                    }
                }
            });
        }
    });
    FakeSmtp { port, messages, attempts }
}

// ---------------- fake Sentinel coordinator ----------------

/// Verdict is chosen from markers inside the scanned bytes.
/// EICAR/MALWARE -> DETECTED, SUSPECT -> SUSPICIOUS, UNSCAN -> UNSCANNED, BOOM -> ERROR,
/// HANG -> never answers, anything else CLEAN.
pub struct FakeSentinel {
    pub socket: PathBuf,
    pub scans: Arc<AtomicUsize>,
    pub stop: Arc<AtomicBool>,
}

fn recv_fd_request(stream: &std::os::unix::net::UnixStream) -> Option<std::fs::File> {
    use std::os::fd::AsRawFd;
    let mut buf = vec![0u8; 70 * 1024];
    // SAFETY: standard SCM_RIGHTS receive; buffers outlive the recvmsg call.
    unsafe {
        let mut iov = libc::iovec { iov_base: buf.as_mut_ptr() as *mut _, iov_len: buf.len() };
        let space = libc::CMSG_SPACE(4) as usize;
        let mut cbuf = vec![0usize; space.div_ceil(8)];
        let mut msg: libc::msghdr = std::mem::zeroed();
        msg.msg_iov = &mut iov;
        msg.msg_iovlen = 1;
        msg.msg_control = cbuf.as_mut_ptr() as *mut _;
        msg.msg_controllen = space;
        let n = libc::recvmsg(stream.as_raw_fd(), &mut msg, 0);
        if n <= 0 {
            return None;
        }
        let c = libc::CMSG_FIRSTHDR(&msg);
        if c.is_null() {
            return None;
        }
        let mut fd: i32 = -1;
        std::ptr::copy_nonoverlapping(libc::CMSG_DATA(c), &mut fd as *mut i32 as *mut u8, 4);
        Some(std::fs::File::from_raw_fd(fd))
    }
}

pub fn start_sentinel(dir: &Path) -> FakeSentinel {
    let socket = dir.join("scan.sock");
    let l = UnixListener::bind(&socket).unwrap();
    let scans = Arc::new(AtomicUsize::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let (s2, st2) = (scans.clone(), stop.clone());
    std::thread::spawn(move || {
        for conn in l.incoming() {
            if st2.load(Ordering::SeqCst) {
                return;
            }
            let Ok(stream) = conn else { continue };
            let s3 = s2.clone();
            std::thread::spawn(move || {
                let Some(mut f) = recv_fd_request(&stream) else { return };
                s3.fetch_add(1, Ordering::SeqCst);
                let mut data = vec![];
                f.read_to_end(&mut data).unwrap();
                let has = |m: &[u8]| data.windows(m.len()).any(|w| w == m);
                if has(b"HANG") {
                    std::thread::sleep(Duration::from_secs(30));
                    return;
                }
                let (status, threats, err) = if has(b"EICAR") || has(b"MALWARE") {
                    ("DETECTED", vec![serde_json::json!({"name": "Test.Signature.Fake"})], None)
                } else if has(b"SUSPECT") {
                    ("SUSPICIOUS", vec![], None)
                } else if has(b"UNSCAN") {
                    ("UNSCANNED", vec![], Some("archive_too_deep"))
                } else if has(b"BOOM") {
                    ("ERROR", vec![], Some("internal_failure"))
                } else {
                    ("CLEAN", vec![], None)
                };
                let body = serde_json::json!({
                    "status": status,
                    "report": {"engine_version": "fake-1.0", "target": {"sha256": sha(&data)}, "threats": threats},
                    "error": err,
                    "database_generation": "gen-test",
                });
                let b = serde_json::to_vec(&body).unwrap();
                let mut out = (b.len() as u32).to_be_bytes().to_vec();
                out.extend_from_slice(&b);
                let mut s = &stream;
                let _ = s.write_all(&out);
            });
        }
    });
    FakeSentinel { socket, scans, stop }
}

// ---------------- fixtures ----------------

pub struct Env {
    pub pool: PgPool,
    pub storage: Storage,
    pub deps: QueueDeps,
    pub smtp: FakeSmtp,
    pub sentinel: Option<FakeSentinel>,
    pub _dir: tempfile::TempDir,
}

pub struct EnvOpts {
    pub policy: AttachmentPolicy,
    pub scan_retries: i32,
    pub notice_html: bool,
    pub smtp: SmtpMode,
    pub sentinel_up: bool,
    pub sentinel_timeout_ms: u64,
}

impl Default for EnvOpts {
    fn default() -> Self {
        Self {
            policy: AttachmentPolicy::Withhold,
            scan_retries: 0,
            notice_html: true,
            smtp: SmtpMode::Accept,
            sentinel_up: true,
            sentinel_timeout_ms: 3000,
        }
    }
}

pub async fn env(o: EnvOpts) -> Env {
    let dir = tempfile::tempdir().unwrap();
    let pool = fresh_db().await;
    let storage = Storage::new(&dir.path().join("storage")).unwrap();
    let sdir = dir.path().join("sock");
    std::fs::create_dir_all(&sdir).unwrap();
    let sentinel = if o.sentinel_up { Some(start_sentinel(&sdir)) } else { None };
    let sock = sentinel.as_ref().map(|s| s.socket.clone()).unwrap_or_else(|| sdir.join("absent.sock"));
    let client = Sentinel::with_params(sock, Duration::from_millis(o.sentinel_timeout_ms), storage.snapshot_dir().unwrap(), 4);
    client.init_snapshot_dir().unwrap();
    let smtp = start_smtp(o.smtp).await;
    let deps = QueueDeps {
        pool: pool.clone(),
        storage: storage.clone(),
        smtp: SmtpConfig {
            host: "127.0.0.1".into(),
            port: smtp.port,
            tls_mode: SmtpTlsMode::PlainLocal,
            username: None,
            password: None,
            timeout: Duration::from_secs(5),
        },
        sentinel: client,
        max_mime_bytes: 10 * 1024 * 1024,
        outbound_enabled: true,
        policy: o.policy,
        scan_retries: o.scan_retries,
        notice_html: o.notice_html,
    };
    Env { pool, storage, deps, smtp, sentinel, _dir: dir }
}

pub fn form() -> FormConfig {
    FormConfig {
        id: "contact".into(),
        enabled: true,
        from: "forms@example.test".into(),
        recipient: "owner@example.test".into(),
        subject_prefix: "Contact".into(),
        reply_to_field: None,
        success_url: None,
        allowed_origins: vec![],
        fields: vec![FormField { name: "message".into(), kind: FormFieldType::Text, required: true, max_length: 1000 }],
    }
}

pub struct Seeded {
    pub submission_id: Uuid,
    pub notification_id: Uuid,
    pub attachments: Vec<(Uuid, String, Vec<u8>)>,
}

/// Inserts a submission with the given (filename, content) attachments staged in quarantine.
pub async fn seed(e: &Env, message: &str, files: &[(&str, &[u8])]) -> Seeded {
    let sid = Uuid::new_v4();
    let nid = Uuid::new_v4();
    let snap = serde_json::to_value(form()).unwrap();
    sqlx::query("INSERT INTO submissions (id, form_id, fingerprint, fields, config_snapshot) VALUES ($1,'contact',$2,$3,$4)")
        .bind(sid)
        .bind(sha(sid.to_string().as_bytes()))
        .bind(serde_json::json!({"message": message}))
        .bind(snap)
        .execute(&e.pool)
        .await
        .unwrap();
    let mut out = vec![];
    for (name, content) in files {
        let mut w = e.storage.begin_stage(10 * 1024 * 1024).await.unwrap();
        w.write(content).await.unwrap();
        let staged = w.finish().await.unwrap();
        let aid = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO attachments (id, submission_id, storage_key, original_name, size_bytes, sha256) VALUES ($1,$2,$3,$4,$5,$6)",
        )
        .bind(aid)
        .bind(sid)
        .bind(&staged.key)
        .bind(*name)
        .bind(staged.size_bytes as i64)
        .bind(&staged.sha256)
        .execute(&e.pool)
        .await
        .unwrap();
        out.push((aid, name.to_string(), content.to_vec()));
    }
    sqlx::query("INSERT INTO notifications (id, submission_id, message_id) VALUES ($1,$2,$3)")
        .bind(nid)
        .bind(sid)
        .bind(format!("<{nid}@raxo.test>"))
        .execute(&e.pool)
        .await
        .unwrap();
    Seeded { submission_id: sid, notification_id: nid, attachments: out }
}

/// Claims and processes the next due notification once.
pub async fn run_once(e: &Env) -> Option<ProcessResult> {
    let (n, token) = claim_due_notification(&e.pool, 120).await.unwrap()?;
    Some(process_notification(&n, token, &e.deps, &|| true).await.unwrap())
}

pub async fn make_due(e: &Env, id: Uuid) {
    sqlx::query("UPDATE notifications SET next_attempt_at = now() - interval '1 second' WHERE id = $1")
        .bind(id)
        .execute(&e.pool)
        .await
        .unwrap();
}

pub async fn notif_state(e: &Env, id: Uuid) -> String {
    sqlx::query_scalar("SELECT state FROM notifications WHERE id = $1").bind(id).fetch_one(&e.pool).await.unwrap()
}

#[derive(Debug)]
pub struct AttRow {
    pub name: String,
    pub scan_state: String,
    pub disposition: String,
    pub category: Option<String>,
}

pub async fn att_rows(e: &Env, sid: Uuid) -> Vec<AttRow> {
    let rows: Vec<(String, String, String, Option<String>)> = sqlx::query_as(
        "SELECT original_name, scan_state, delivery_disposition, withheld_category FROM attachments
         WHERE submission_id = $1 ORDER BY created_at, original_name",
    )
    .bind(sid)
    .fetch_all(&e.pool)
    .await
    .unwrap();
    rows.into_iter().map(|(name, scan_state, disposition, category)| AttRow { name, scan_state, disposition, category }).collect()
}

pub async fn verdicts(e: &Env, sid: Uuid) -> Vec<(String, String)> {
    sqlx::query_as(
        "SELECT a.original_name, r.verdict FROM scan_results r JOIN attachments a ON a.id = r.attachment_id
         WHERE a.submission_id = $1 AND r.scanner = 'raxosentinel' AND r.shadow = false ORDER BY r.created_at",
    )
    .bind(sid)
    .fetch_all(&e.pool)
    .await
    .unwrap()
}

// ---------------- MIME inspection ----------------

pub fn as_text(raw: &[u8]) -> String {
    String::from_utf8_lossy(raw).to_string()
}

/// Filenames of parts actually attached (Content-Disposition: attachment).
pub fn attached_filenames(raw: &[u8]) -> Vec<String> {
    as_text(raw)
        .lines()
        .filter(|l| l.to_ascii_lowercase().starts_with("content-disposition: attachment"))
        .filter_map(|l| l.split("filename=\"").nth(1).map(|r| r.trim_end_matches('"').to_string()))
        .collect()
}

pub fn contains_bytes(hay: &[u8], needle: &[u8]) -> bool {
    needle.len() <= hay.len() && hay.windows(needle.len()).any(|w| w == needle)
}

pub fn b64(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

/// Decodes the first part of the given content type (7bit or base64) for assertions.
pub fn part_body(raw: &[u8], ctype: &str) -> String {
    let t = as_text(raw);
    let idx = t.find(&format!("Content-Type: {ctype}")).unwrap_or_else(|| panic!("no {ctype} part"));
    let rest = &t[idx..];
    let (head, body) = rest.split_once("\r\n\r\n").unwrap();
    let end = ["\r\n------alt_", "\r\n------raxo_"].iter().filter_map(|m| body.find(m)).min().unwrap_or(body.len());
    let body = &body[..end];
    if head.contains("base64") {
        use base64::Engine;
        let clean: String = body.split_whitespace().collect();
        String::from_utf8_lossy(&base64::engine::general_purpose::STANDARD.decode(clean).unwrap()).to_string()
    } else {
        body.to_string()
    }
}

pub fn plain_body(raw: &[u8]) -> String {
    part_body(raw, "text/plain")
}

pub fn html_body(raw: &[u8]) -> String {
    part_body(raw, "text/html")
}

/// Header block (up to the first blank line).
pub fn headers(raw: &[u8]) -> String {
    as_text(raw).split("\r\n\r\n").next().unwrap().to_string()
}

/// Every declared boundary must open and close exactly once more than it separates.
pub fn assert_mime_balanced(raw: &[u8]) {
    let t = as_text(raw);
    let mut declared = vec![];
    for seg in t.split("boundary=\"").skip(1) {
        declared.push(seg.split('"').next().unwrap().to_string());
    }
    assert!(!declared.is_empty(), "expected multipart message");
    for b in declared {
        assert_eq!(t.matches(&format!("--{b}--\r\n")).count(), 1, "boundary {b} must close exactly once");
        assert!(t.matches(&format!("--{b}\r\n")).count() >= 1, "boundary {b} must have parts");
    }
}
