use crate::errors::{AppError, Result};
use crate::smtp::SubmitResult;
use chrono::{DateTime, Duration, Utc};
use sqlx::{PgConnection, PgPool};
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration as StdDuration;
use uuid::Uuid;

const MAX_CONNECTIONS: usize = 64;
const DESTINATION_DELAYS: [i64; 4] = [60, 300, 1800, 7200];

#[derive(Clone, Debug)]
pub struct Capacity {
    pub node_id: String,
    lock_dir: PathBuf,
    identity: Uuid,
    gate_device: i64,
    gate_inode: i64,
}

pub struct ConnectionSlot {
    _file: File,
}

pub enum Admission {
    Granted(ConnectionSlot),
    Deferred { until: DateTime<Utc>, reason: &'static str },
}

pub fn valid_node_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'_')
        && id.as_bytes()[0].is_ascii_alphanumeric()
}

fn open_lock(path: &Path) -> std::io::Result<File> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
}

fn try_lock(file: &File) -> std::io::Result<bool> {
    // SAFETY: flock only borrows the valid file descriptor.
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        Ok(true)
    } else {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::WouldBlock {
            Ok(false)
        } else {
            Err(error)
        }
    }
}

impl Capacity {
    pub async fn initialize(pool: &PgPool, storage_root: &Path, node_id: &str) -> Result<Self> {
        if !valid_node_id(node_id) {
            return Err(AppError::config("bad_request", "Invalid SMTP sending node ID"));
        }
        let lock_dir = storage_root.join("smtp-capacity").join(node_id);
        DirBuilder::new().recursive(true).mode(0o700).create(&lock_dir)?;
        let mut identity = None;
        for _ in 0..100 {
            let gate = open_lock(&lock_dir.join("gate"))?;
            if !try_lock(&gate)? {
                tokio::time::sleep(StdDuration::from_millis(50)).await;
                continue;
            }
            let path = lock_dir.join("identity");
            let id = match OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(&path) {
                Ok(mut file) => {
                    let mut text = String::new();
                    file.read_to_string(&mut text)?;
                    Uuid::parse_str(text.trim())
                        .map_err(|_| AppError::config("bad_request", "Invalid SMTP capacity lock identity"))?
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    let id = Uuid::new_v4();
                    let mut file = OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .mode(0o600)
                        .custom_flags(libc::O_NOFOLLOW)
                        .open(&path)?;
                    write!(file, "{id}")?;
                    file.sync_all()?;
                    id
                }
                Err(e) => return Err(e.into()),
            };
            let metadata = gate.metadata()?;
            let device = i64::try_from(metadata.dev())
                .map_err(|_| AppError::config("bad_request", "Invalid SMTP lock device"))?;
            let inode = i64::try_from(metadata.ino())
                .map_err(|_| AppError::config("bad_request", "Invalid SMTP lock inode"))?;
            identity = Some((id, device, inode));
            break;
        }
        let (identity, gate_device, gate_inode) =
            identity.ok_or_else(|| AppError::unavailable("SMTP capacity lock is busy"))?;
        sqlx::query("INSERT INTO smtp_nodes (node_id) VALUES ($1) ON CONFLICT (node_id) DO NOTHING")
            .bind(node_id)
            .execute(pool)
            .await?;
        let bound: Option<(Uuid, i64, i64)> = sqlx::query_as(
            "UPDATE smtp_nodes SET lock_identity = COALESCE(lock_identity, $2),
               lock_device = COALESCE(lock_device, $3), lock_inode = COALESCE(lock_inode, $4)
             WHERE node_id = $1 AND (lock_identity IS NULL OR lock_identity = $2)
               AND (lock_device IS NULL OR lock_device = $3) AND (lock_inode IS NULL OR lock_inode = $4)
             RETURNING lock_identity, lock_device, lock_inode",
        )
        .bind(node_id)
        .bind(identity)
        .bind(gate_device)
        .bind(gate_inode)
        .fetch_optional(pool)
        .await?;
        if bound != Some((identity, gate_device, gate_inode)) {
            return Err(AppError::config(
                "bad_request",
                "Workers for this SMTP node do not share the same capacity lock directory",
            ));
        }
        Ok(Self { node_id: node_id.to_string(), lock_dir, identity, gate_device, gate_inode })
    }

    fn try_connection_slot(&self, max_connections: usize) -> Result<Option<ConnectionSlot>> {
        let gate = open_lock(&self.lock_dir.join("gate"))?;
        let metadata = gate.metadata()?;
        if i64::try_from(metadata.dev()).ok() != Some(self.gate_device)
            || i64::try_from(metadata.ino()).ok() != Some(self.gate_inode)
        {
            return Err(AppError::config("bad_request", "SMTP capacity gate was replaced"));
        }
        if !try_lock(&gate)? {
            return Ok(None);
        }
        for i in 0..max_connections {
            drop(open_lock(&self.lock_dir.join(format!("slot-{i}")))?);
        }
        let mut free = None;
        let mut occupied = 0;
        for entry in fs::read_dir(&self.lock_dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let Some(index) = name.strip_prefix("slot-").and_then(|n| n.parse::<usize>().ok()) else { continue };
            if index >= MAX_CONNECTIONS {
                continue;
            }
            let file = open_lock(&entry.path())?;
            if try_lock(&file)? {
                if free.is_none() {
                    free = Some(file);
                }
            } else {
                occupied += 1;
            }
        }
        if occupied >= max_connections {
            return Ok(None);
        }
        Ok(free.map(|file| ConnectionSlot { _file: file }))
    }

    pub async fn admit(&self, conn: &mut PgConnection, recipient: &str) -> Result<Admission> {
        let recipient = recipient.trim().to_ascii_lowercase();
        if !crate::config::email_regex().is_match(&recipient) {
            return Err(AppError::config("bad_request", "Invalid outbound recipient"));
        }
        let domain = recipient.rsplit_once('@').expect("validated email").1;
        let node: Option<(i32, i32, Option<Uuid>)> = sqlx::query_as(
            "SELECT messages_per_minute, max_connections, lock_identity
             FROM smtp_nodes WHERE node_id = $1 FOR UPDATE",
        )
        .bind(&self.node_id)
        .fetch_optional(&mut *conn)
        .await?;
        let Some((node_limit, max_connections, Some(identity))) = node else {
            return Err(AppError::config("bad_request", "SMTP node capacity policy is missing"));
        };
        if identity != self.identity {
            return Err(AppError::config("bad_request", "SMTP capacity lock identity changed"));
        }
        sqlx::query("INSERT INTO smtp_recipient_capacity (recipient_key) VALUES ($1) ON CONFLICT DO NOTHING")
            .bind(&recipient)
            .execute(&mut *conn)
            .await?;
        let recipient_limit: Option<i32> = sqlx::query_scalar(
            "SELECT messages_per_minute FROM smtp_recipient_capacity WHERE recipient_key = $1 FOR UPDATE",
        )
        .bind(&recipient)
        .fetch_one(&mut *conn)
        .await?;
        let default_limit: i32 = sqlx::query_scalar(
            "SELECT default_recipient_per_minute FROM smtp_capacity_settings WHERE singleton FOR SHARE",
        )
        .fetch_one(&mut *conn)
        .await?;
        let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()").fetch_one(&mut *conn).await?;
        let cutoff = now - Duration::seconds(60);
        let node_usage: (i64, Option<DateTime<Utc>>) = sqlx::query_as(
            "SELECT count(*), min(finished_at) FROM send_attempts
             WHERE (node_id = $1 AND (finished_at IS NULL OR finished_at > $2))
                OR (node_id IS NULL AND (finished_at > $2 OR (finished_at IS NULL AND started_at > $2)))",
        )
        .bind(&self.node_id)
        .bind(cutoff)
        .fetch_one(&mut *conn)
        .await?;
        let recipient_usage: (i64, Option<DateTime<Utc>>) = sqlx::query_as(
            "SELECT count(*), min(finished_at) FROM send_attempts
             WHERE recipient_key = $1 AND (finished_at IS NULL OR finished_at > $2)",
        )
        .bind(&recipient)
        .bind(cutoff)
        .fetch_one(&mut *conn)
        .await?;
        let backoff: Option<DateTime<Utc>> = sqlx::query_scalar(
            "SELECT not_before FROM smtp_destination_backoff
             WHERE node_id = $1 AND destination_domain = $2 AND not_before > $3",
        )
        .bind(&self.node_id)
        .bind(domain)
        .bind(now)
        .fetch_optional(&mut *conn)
        .await?;

        let next = |oldest: Option<DateTime<Utc>>| {
            oldest.map(|t| t + Duration::seconds(60) + Duration::milliseconds(1)).unwrap_or(now + Duration::seconds(1))
        };
        let mut deferred = None;
        if node_usage.0 >= i64::from(node_limit) {
            deferred = Some((next(node_usage.1), "smtp_node_rate_limited"));
        }
        if recipient_usage.0 >= i64::from(recipient_limit.unwrap_or(default_limit)) {
            let until = next(recipient_usage.1);
            if deferred.map(|(t, _)| until > t).unwrap_or(true) {
                deferred = Some((until, "smtp_recipient_rate_limited"));
            }
        }
        if let Some(until) = backoff {
            if deferred.map(|(t, _)| until > t).unwrap_or(true) {
                deferred = Some((until, "smtp_destination_backoff"));
            }
        }
        if let Some((until, reason)) = deferred {
            return Ok(Admission::Deferred { until, reason });
        }
        match self.try_connection_slot(max_connections as usize)? {
            Some(slot) => Ok(Admission::Granted(slot)),
            None => Ok(Admission::Deferred { until: now + Duration::seconds(1), reason: "smtp_connections_busy" }),
        }
    }

    pub async fn record_destination(
        &self,
        conn: &mut PgConnection,
        recipient: &str,
        attempt_id: Uuid,
        outcome: &SubmitResult,
    ) -> Result<()> {
        let domain = recipient
            .rsplit_once('@')
            .map(|(_, d)| d.to_ascii_lowercase())
            .ok_or_else(|| AppError::config("bad_request", "Invalid outbound recipient while recording destination"))?;
        match outcome {
            SubmitResult::SafeRetry(_) => {
                sqlx::query(
                    "INSERT INTO smtp_destination_backoff (node_id, destination_domain)
                     VALUES ($1, $2) ON CONFLICT DO NOTHING",
                )
                .bind(&self.node_id)
                .bind(&domain)
                .execute(&mut *conn)
                .await?;
                let failures: i32 = sqlx::query_scalar(
                    "SELECT failures FROM smtp_destination_backoff
                     WHERE node_id = $1 AND destination_domain = $2 FOR UPDATE",
                )
                .bind(&self.node_id)
                .bind(&domain)
                .fetch_one(&mut *conn)
                .await?;
                let delay = DESTINATION_DELAYS[(failures as usize).min(DESTINATION_DELAYS.len() - 1)];
                sqlx::query(
                    "UPDATE smtp_destination_backoff
                     SET failures = LEAST(failures + 1, 4), last_failure_at = clock_timestamp(),
                         not_before = GREATEST(not_before, clock_timestamp() + make_interval(secs => $3))
                     WHERE node_id = $1 AND destination_domain = $2",
                )
                .bind(&self.node_id)
                .bind(&domain)
                .bind(delay as f64)
                .execute(&mut *conn)
                .await?;
            }
            SubmitResult::Submitted { .. } => {
                sqlx::query(
                    "DELETE FROM smtp_destination_backoff
                     WHERE node_id = $1 AND destination_domain = $2
                       AND last_failure_at <= (SELECT started_at FROM send_attempts WHERE id = $3)",
                )
                .bind(&self.node_id)
                .bind(&domain)
                .bind(attempt_id)
                .execute(&mut *conn)
                .await?;
            }
            SubmitResult::Failed(_) | SubmitResult::Unknown(_) => {}
        }
        Ok(())
    }
}
