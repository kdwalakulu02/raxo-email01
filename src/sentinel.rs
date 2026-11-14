//! Native RaxoSentinel coordinator client.
//!
//! Speaks the coordinator's Unix-socket protocol directly (4-byte big-endian
//! length prefix + JSON `ScanRequest`, one regular-file descriptor passed with
//! SCM_RIGHTS, framed JSON response). No scanner port is ever exposed.
//!
//! RaxoSentinel is the sole malware scanner in the Rust implementation, so a
//! verdict other than CLEAN never results in delivery (fail-closed).

use crate::config::AppConfig;
use crate::storage::sha256_hex;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;
use uuid::Uuid;

const MAX_REQUEST_PAYLOAD: usize = 64 * 1024;
const MAX_RESPONSE_PAYLOAD: usize = 2 * 1024 * 1024;
const BUSY_RETRIES: u32 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Verdict {
    Clean,
    Detected,
    Suspicious,
    Unscanned,
    Error,
    Busy,
    Timeout,
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Clean => "CLEAN",
            Verdict::Detected => "DETECTED",
            Verdict::Suspicious => "SUSPICIOUS",
            Verdict::Unscanned => "UNSCANNED",
            Verdict::Error => "ERROR",
            Verdict::Busy => "BUSY",
            Verdict::Timeout => "TIMEOUT",
        }
    }
}

#[derive(Serialize)]
struct ScanRequest<'a> {
    file_name: Option<&'a str>,
    max_size: Option<u64>,
    timeout: Option<u64>,
    max_depth: Option<usize>,
    test_worker_action: Option<&'a str>,
}

#[derive(Deserialize, Debug, Default)]
struct Target {
    sha256: Option<String>,
}

#[derive(Deserialize, Debug, Default)]
struct Threat {
    name: Option<String>,
}

#[derive(Deserialize, Debug, Default)]
struct Report {
    #[serde(default)]
    threats: Vec<Threat>,
    #[serde(default)]
    sub_targets: Vec<Report>,
    engine_version: Option<String>,
    target: Option<Target>,
    /// RaxoSentinel v2: reasons why inspection was partial (verdict covers only what was inspected).
    #[serde(default)]
    incomplete: Vec<String>,
}

#[derive(Deserialize, Debug)]
struct CoordinatorResponse {
    status: String,
    report: Option<Report>,
    error: Option<String>,
    database_generation: Option<String>,
}

fn collect_detections(r: &Report, out: &mut Vec<String>) {
    for t in &r.threats {
        if let Some(n) = &t.name {
            out.push(n.clone());
        }
    }
    for s in &r.sub_targets {
        collect_detections(s, out);
    }
}

#[derive(Debug, Clone)]
pub struct ScanRecord {
    pub scanner: &'static str,
    pub shadow: bool,
    pub verdict: Verdict,
    pub detection: Option<String>,
    /// Individual threat names behind `detection` (not truncated).
    pub detections: Vec<String>,
    /// Non-empty when the scanner could only partially inspect the content.
    pub incomplete: Vec<String>,
    pub engine_version: Option<String>,
    pub database_generation: Option<String>,
    pub sha256: String,
    pub size_bytes: i64,
    pub duration_ms: i32,
    pub error: Option<String>,
}

/// Delivery decision derived from a scan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScanOutcome {
    Clean {
        version: String,
    },
    Blocked {
        reason: String,
    },
    /// Transient or infrastructure failure: never delivers, retried by the worker.
    Error {
        reason: String,
    },
}

pub fn outcome_of(rec: &ScanRecord) -> ScanOutcome {
    match rec.verdict {
        Verdict::Clean => {
            ScanOutcome::Clean { version: rec.engine_version.clone().unwrap_or_else(|| "raxosentinel".into()) }
        }
        Verdict::Detected | Verdict::Suspicious => ScanOutcome::Blocked {
            reason: rec.detection.clone().unwrap_or_else(|| rec.verdict.as_str().to_lowercase()),
        },
        // The scanner could not establish that the content is safe: fail closed.
        Verdict::Unscanned => ScanOutcome::Blocked {
            reason: format!("unscanned: {}", rec.error.clone().unwrap_or_else(|| "content not scannable".into())),
        },
        Verdict::Error | Verdict::Busy | Verdict::Timeout => {
            ScanOutcome::Error { reason: rec.error.clone().unwrap_or_else(|| rec.verdict.as_str().to_string()) }
        }
    }
}

/// Why an attachment is withheld. `NotInspected` must never be presented as a detection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WithheldCategory {
    Flagged,
    NotInspected,
    /// Blocked by the file-type policy (executables, scripts, disk images, macro documents).
    Policy,
    /// Uploaded while the form was not verified; the file was discarded at submission time.
    NotRetained,
}

impl WithheldCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            WithheldCategory::Flagged => "flagged",
            WithheldCategory::NotInspected => "not_inspected",
            WithheldCategory::Policy => "policy",
            WithheldCategory::NotRetained => "not_retained",
        }
    }
}

/// Per-attachment decision under the `withhold` policy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Disposition {
    /// `partial`: CLEAN in everything inspected, but inspection was incomplete.
    Deliver {
        version: String,
        partial: bool,
    },
    Withhold {
        category: WithheldCategory,
        reason: String,
        transient: bool,
    },
}

pub fn disposition_of(rec: &ScanRecord) -> Disposition {
    let reason = || rec.error.clone().unwrap_or_else(|| rec.verdict.as_str().to_lowercase());
    match rec.verdict {
        Verdict::Clean => Disposition::Deliver {
            version: rec.engine_version.clone().unwrap_or_else(|| "raxosentinel".into()),
            partial: !rec.incomplete.is_empty(),
        },
        Verdict::Detected | Verdict::Suspicious => Disposition::Withhold {
            category: if !rec.detections.is_empty() && rec.detections.iter().all(|d| d.starts_with("Policy.")) {
                WithheldCategory::Policy
            } else {
                WithheldCategory::Flagged
            },
            reason: rec.detection.clone().unwrap_or_else(|| rec.verdict.as_str().to_lowercase()),
            transient: false,
        },
        Verdict::Unscanned => Disposition::Withhold {
            category: WithheldCategory::NotInspected,
            reason: format!("unscanned: {}", reason()),
            transient: false,
        },
        Verdict::Error | Verdict::Busy | Verdict::Timeout => {
            Disposition::Withhold { category: WithheldCategory::NotInspected, reason: reason(), transient: true }
        }
    }
}

/// Fills verdict and report details from a coordinator response into `r`.
fn apply_response(resp: &CoordinatorResponse, expected_sha: &str, r: &mut ScanRecord) {
    let error = resp.error.as_ref().map(|e| e.chars().take(500).collect::<String>());
    r.database_generation = resp.database_generation.clone();
    // An ERROR report carries an empty target hash; only a reported, non-empty hash is compared.
    let reported = resp
        .report
        .as_ref()
        .and_then(|x| x.target.as_ref())
        .and_then(|t| t.sha256.as_deref())
        .filter(|s| !s.is_empty());
    if reported.is_some_and(|rs| rs.to_lowercase() != expected_sha) {
        r.verdict = Verdict::Error;
        r.error = Some(match &error {
            Some(e) => format!("sentinel_scanned_sha256_mismatch: {e}").chars().take(500).collect(),
            None => "sentinel_scanned_sha256_mismatch".into(),
        });
        return;
    }
    r.verdict = match resp.status.as_str() {
        "CLEAN" => Verdict::Clean,
        "DETECTED" => Verdict::Detected,
        "SUSPICIOUS" => Verdict::Suspicious,
        "UNSCANNED" => Verdict::Unscanned,
        "BUSY" => Verdict::Busy,
        _ => Verdict::Error,
    };
    let mut names = vec![];
    if let Some(rep) = &resp.report {
        collect_detections(rep, &mut names);
        r.engine_version = rep.engine_version.clone();
        r.incomplete = rep.incomplete.iter().map(|i| i.chars().take(200).collect()).collect();
    }
    if !names.is_empty() {
        r.detection = Some(names.join(", ").chars().take(500).collect());
    }
    r.detections = names;
    r.error = error;
}

#[derive(Clone)]
pub struct Sentinel {
    socket: PathBuf,
    timeout: Duration,
    max_size: u64,
    snapshot_dir: PathBuf,
    gate: Arc<Semaphore>,
}

impl Sentinel {
    pub fn new(cfg: &AppConfig, snapshot_dir: PathBuf) -> Self {
        Self {
            socket: cfg.sentinel_socket.clone(),
            timeout: Duration::from_millis(cfg.sentinel_timeout_ms),
            max_size: cfg.sentinel_max_size,
            snapshot_dir,
            // Coordinator defaults to one worker and one pending slot; keep
            // our own concurrency to that to avoid avoidable BUSY replies.
            gate: Arc::new(Semaphore::new(1)),
        }
    }

    pub fn with_params(socket: PathBuf, timeout: Duration, snapshot_dir: PathBuf, concurrency: usize) -> Self {
        Self { socket, timeout, max_size: 52_428_800, snapshot_dir, gate: Arc::new(Semaphore::new(concurrency)) }
    }

    /// Discard snapshots a crashed process left behind; they are never reused.
    pub fn init_snapshot_dir(&self) -> std::io::Result<()> {
        let _ = std::fs::remove_dir_all(&self.snapshot_dir);
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&self.snapshot_dir)
    }

    pub fn socket_exists(&self) -> bool {
        UnixStream::connect(&self.socket).is_ok()
    }

    /// Scan the SHA-256-verified bytes. Never panics or errors: every failure
    /// is represented as an ERROR/TIMEOUT/BUSY record.
    pub async fn scan(&self, content: Vec<u8>, sha256: &str, attachment_id: &str) -> ScanRecord {
        let start = Instant::now();
        let size = content.len() as i64;
        let mk = move |verdict: Verdict, f: &dyn Fn(&mut ScanRecord)| {
            let mut r = ScanRecord {
                scanner: "raxosentinel",
                shadow: false,
                verdict,
                detection: None,
                detections: vec![],
                incomplete: vec![],
                engine_version: None,
                database_generation: None,
                sha256: String::new(),
                size_bytes: size,
                duration_ms: 0,
                error: None,
            };
            f(&mut r);
            r
        };
        let sha = sha256.to_string();
        let finish = |mut r: ScanRecord| {
            r.sha256 = sha.clone();
            r.duration_ms = start.elapsed().as_millis().min(i32::MAX as u128) as i32;
            r
        };

        let _permit = match self.gate.acquire().await {
            Ok(p) => p,
            Err(_) => return finish(mk(Verdict::Error, &|r| r.error = Some("sentinel_gate_closed".into()))),
        };

        let snap_dir = self.snapshot_dir.join(Uuid::new_v4().to_string());
        let this = self.clone();
        let expected = sha256.to_string();
        let att = attachment_id.to_string();
        let joined =
            tokio::task::spawn_blocking(move || this.scan_blocking(&snap_dir, &att, &content, &expected)).await;
        let result = match joined {
            Ok(r) => r,
            Err(e) => Err((Verdict::Error, format!("sentinel_internal: {e}"))),
        };
        match result {
            Ok(resp) => finish(mk(Verdict::Error, &|r| apply_response(&resp, sha256, r))),
            Err((verdict, msg)) => finish(mk(verdict, &|r| r.error = Some(msg.chars().take(500).collect()))),
        }
    }

    fn scan_blocking(
        &self,
        dir: &Path,
        attachment_id: &str,
        content: &[u8],
        expected_sha: &str,
    ) -> Result<CoordinatorResponse, (Verdict, String)> {
        let err = |m: &str| (Verdict::Error, m.to_string());
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .map_err(|e| (Verdict::Error, format!("sentinel_internal: {e}")))?;
        let result = (|| {
            let file = dir.join(format!("{attachment_id}.pdf"));
            {
                let mut f = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o400)
                    .open(&file)
                    .map_err(|e| (Verdict::Error, format!("sentinel_internal: {e}")))?;
                f.write_all(content)
                    .and_then(|_| f.sync_all())
                    .map_err(|e| (Verdict::Error, format!("sentinel_internal: {e}")))?;
            }
            let _ = std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o400));
            let before = std::fs::read(&file).map_err(|e| (Verdict::Error, format!("sentinel_internal: {e}")))?;
            if sha256_hex(&before) != expected_sha {
                return Err(err("snapshot_sha256_mismatch_before_scan"));
            }
            let mut attempt = 0;
            let resp = loop {
                let resp = self.round_trip(&file)?;
                if resp.status == "BUSY" && attempt < BUSY_RETRIES {
                    attempt += 1;
                    std::thread::sleep(Duration::from_millis(150 * (1 << attempt)));
                    continue;
                }
                break resp;
            };
            let after = std::fs::read(&file).map_err(|e| (Verdict::Error, format!("sentinel_internal: {e}")))?;
            if sha256_hex(&after) != expected_sha {
                return Err(err("snapshot_sha256_mismatch_after_scan"));
            }
            Ok(resp)
        })();
        let _ = std::fs::remove_dir_all(dir);
        result
    }

    fn round_trip(&self, file: &Path) -> Result<CoordinatorResponse, (Verdict, String)> {
        let unavailable = |m: String| (Verdict::Error, format!("sentinel_unavailable: {m}"));
        let f = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(file)
            .map_err(|e| unavailable(format!("cannot open snapshot: {e}")))?;
        let mut stream = UnixStream::connect(&self.socket)
            .map_err(|e| unavailable(format!("cannot connect to {}: {e}", self.socket.display())))?;
        stream.set_read_timeout(Some(self.timeout)).ok();
        stream.set_write_timeout(Some(self.timeout)).ok();

        let name = file.file_name().map(|s| s.to_string_lossy().into_owned());
        let req = ScanRequest {
            file_name: name.as_deref(),
            max_size: Some(self.max_size),
            timeout: None,
            max_depth: None,
            test_worker_action: None,
        };
        send_fd_request(&stream, f.as_raw_fd(), &req).map_err(unavailable)?;

        let timed_out =
            |e: &std::io::Error| matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut);
        let mut len = [0u8; 4];
        if let Err(e) = stream.read_exact(&mut len) {
            return Err(if timed_out(&e) {
                (Verdict::Timeout, format!("sentinel client exceeded {}ms", self.timeout.as_millis()))
            } else {
                unavailable(format!("cannot read response header: {e}"))
            });
        }
        let n = u32::from_be_bytes(len) as usize;
        if n == 0 || n > MAX_RESPONSE_PAYLOAD {
            return Err(unavailable(format!("invalid response payload length {n}")));
        }
        let mut body = vec![0u8; n];
        if let Err(e) = stream.read_exact(&mut body) {
            return Err(if timed_out(&e) {
                (Verdict::Timeout, format!("sentinel client exceeded {}ms", self.timeout.as_millis()))
            } else {
                unavailable(format!("cannot read response body: {e}"))
            });
        }
        let resp: CoordinatorResponse =
            serde_json::from_slice(&body).map_err(|e| unavailable(format!("malformed response: {e}")))?;
        if !matches!(resp.status.as_str(), "CLEAN" | "DETECTED" | "SUSPICIOUS" | "UNSCANNED" | "ERROR" | "BUSY") {
            return Err(unavailable(format!("unknown status {}", resp.status)));
        }
        Ok(resp)
    }
}

fn send_fd_request(stream: &UnixStream, fd: i32, req: &ScanRequest) -> Result<(), String> {
    let payload = serde_json::to_vec(req).map_err(|e| format!("cannot serialize request: {e}"))?;
    if payload.len() > MAX_REQUEST_PAYLOAD {
        return Err("request payload exceeds limit".into());
    }
    let mut message = Vec::with_capacity(4 + payload.len());
    message.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    message.extend_from_slice(&payload);
    let mut iov = libc::iovec { iov_base: message.as_mut_ptr() as *mut libc::c_void, iov_len: message.len() };
    // SAFETY: standard SCM_RIGHTS construction; buffers outlive the sendmsg call.
    unsafe {
        let space = libc::CMSG_SPACE(std::mem::size_of::<i32>() as u32) as usize;
        let mut cbuf = vec![0usize; space.div_ceil(std::mem::size_of::<usize>())];
        let mut msg: libc::msghdr = std::mem::zeroed();
        msg.msg_iov = &mut iov;
        msg.msg_iovlen = 1;
        msg.msg_control = cbuf.as_mut_ptr() as *mut libc::c_void;
        msg.msg_controllen = space;
        let cmsg = libc::CMSG_FIRSTHDR(&msg);
        if cmsg.is_null() {
            return Err("cannot construct control message".into());
        }
        (*cmsg).cmsg_level = libc::SOL_SOCKET;
        (*cmsg).cmsg_type = libc::SCM_RIGHTS;
        (*cmsg).cmsg_len = libc::CMSG_LEN(std::mem::size_of::<i32>() as u32) as usize;
        std::ptr::copy_nonoverlapping(
            &fd as *const i32 as *const u8,
            libc::CMSG_DATA(cmsg),
            std::mem::size_of::<i32>(),
        );
        if libc::sendmsg(stream.as_raw_fd(), &msg, libc::MSG_NOSIGNAL) < 0 {
            return Err(format!("sendmsg failed: {}", std::io::Error::last_os_error()));
        }
    }
    Ok(())
}

pub async fn record_scan_result(
    pool: &PgPool,
    attachment_id: Uuid,
    notification_id: Uuid,
    r: &ScanRecord,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO scan_results (id, attachment_id, notification_id, scanner, shadow, verdict, detection,
           engine_version, database_generation, sha256, size_bytes, duration_ms, error, incomplete, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())",
    )
    .bind(Uuid::new_v4())
    .bind(attachment_id)
    .bind(notification_id)
    .bind(r.scanner)
    .bind(r.shadow)
    .bind(r.verdict.as_str())
    .bind(&r.detection)
    .bind(&r.engine_version)
    .bind(&r.database_generation)
    .bind(&r.sha256)
    .bind(r.size_bytes)
    .bind(r.duration_ms)
    .bind(&r.error)
    .bind((!r.incomplete.is_empty()).then(|| r.incomplete.join("; ")))
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(resp: serde_json::Value, expected_sha: &str) -> ScanRecord {
        let resp: CoordinatorResponse = serde_json::from_value(resp).unwrap();
        let mut r = ScanRecord {
            scanner: "raxosentinel",
            shadow: false,
            verdict: Verdict::Clean,
            detection: None,
            detections: vec![],
            incomplete: vec![],
            engine_version: None,
            database_generation: None,
            sha256: expected_sha.into(),
            size_bytes: 1,
            duration_ms: 0,
            error: None,
        };
        apply_response(&resp, expected_sha, &mut r);
        r
    }

    #[test]
    fn error_with_empty_reported_sha_keeps_the_coordinator_error() {
        let r = record(
            serde_json::json!({"status":"ERROR","report":{"target":{"sha256":""}},"error":"worker crashed"}),
            "abc",
        );
        assert_eq!(r.verdict, Verdict::Error);
        assert_eq!(r.error.as_deref(), Some("worker crashed"));
    }

    #[test]
    fn real_sha_mismatch_is_an_error_that_keeps_the_coordinator_error() {
        let r =
            record(serde_json::json!({"status":"CLEAN","report":{"target":{"sha256":"def"}},"error":"note"}), "abc");
        assert_eq!(r.verdict, Verdict::Error);
        assert_eq!(r.error.as_deref(), Some("sentinel_scanned_sha256_mismatch: note"));
        let r = record(serde_json::json!({"status":"CLEAN","report":{"target":{"sha256":"DEF"}}}), "abc");
        assert_eq!(r.error.as_deref(), Some("sentinel_scanned_sha256_mismatch"));
    }

    #[test]
    fn clean_with_incomplete_inspection_is_delivered_as_partial() {
        let r = record(
            serde_json::json!({"status":"CLEAN","report":{"target":{"sha256":"ABC"},"engine_version":"2.0",
                "incomplete":["too_many_pdf_objects","unsupported_stream_encoding"]}}),
            "abc",
        );
        assert_eq!(r.incomplete, vec!["too_many_pdf_objects", "unsupported_stream_encoding"]);
        assert_eq!(disposition_of(&r), Disposition::Deliver { version: "2.0".into(), partial: true });
        let full = record(serde_json::json!({"status":"CLEAN","report":{"target":{"sha256":"abc"}}}), "abc");
        assert!(matches!(disposition_of(&full), Disposition::Deliver { partial: false, .. }));
        let unscanned = record(
            serde_json::json!({"status":"UNSCANNED","report":{"incomplete":["encrypted"]},"error":"encrypted"}),
            "abc",
        );
        assert!(matches!(
            disposition_of(&unscanned),
            Disposition::Withhold { category: WithheldCategory::NotInspected, .. }
        ));
    }

    #[test]
    fn policy_only_detections_are_withheld_as_policy() {
        let cat = |status: &str, threats: serde_json::Value| match disposition_of(&record(
            serde_json::json!({"status":status,"report":{"threats":threats}}),
            "abc",
        )) {
            Disposition::Withhold { category, .. } => category,
            other => panic!("expected withhold, got {other:?}"),
        };
        let policy = serde_json::json!([{"name":"Policy.Executable.PE"},{"name":"Policy.Office.Macro"}]);
        assert_eq!(cat("SUSPICIOUS", policy.clone()), WithheldCategory::Policy);
        assert_eq!(cat("DETECTED", policy), WithheldCategory::Policy);
        let mixed = serde_json::json!([{"name":"Policy.Script.JavaScript"},{"name":"Win.Trojan.Fake"}]);
        assert_eq!(cat("SUSPICIOUS", mixed), WithheldCategory::Flagged);
        assert_eq!(cat("SUSPICIOUS", serde_json::json!([])), WithheldCategory::Flagged);
    }
}
