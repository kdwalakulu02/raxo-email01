use crate::errors::{AppError, Result};
use crate::queue::{claim_due_notification, process_notification, recover_expired_leases, renew_lease, QueueDeps};
use crate::repo::update_worker_heartbeat;
use crate::retention::run_retention;
use chrono::Utc;
use sqlx::{Connection, PgConnection};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{watch, Mutex};

pub const WORKER_ADVISORY_LOCK_ID: i64 = 726901;

pub struct WorkerOptions {
    pub database_url: String,
    pub poll_interval: Duration,
    pub heartbeat_interval: Duration,
    pub lease_secs: i64,
}

impl WorkerOptions {
    pub fn new(database_url: String) -> Self {
        Self { database_url, poll_interval: Duration::from_secs(1), heartbeat_interval: Duration::from_secs(20), lease_secs: 120 }
    }
}

pub struct Worker {
    deps: QueueDeps,
    opts: WorkerOptions,
    has_lock: Arc<AtomicBool>,
    lock_conn: Arc<Mutex<Option<PgConnection>>>,
}

impl Worker {
    pub fn new(deps: QueueDeps, opts: WorkerOptions) -> Self {
        Self { deps, opts, has_lock: Arc::new(AtomicBool::new(false)), lock_conn: Arc::new(Mutex::new(None)) }
    }

    /// Takes the single-worker advisory lock on a dedicated connection. Losing that
    /// connection means losing ownership.
    pub async fn acquire_lock(&self) -> bool {
        let Ok(mut conn) = PgConnection::connect(&self.opts.database_url).await else { return false };
        let got: std::result::Result<(bool,), sqlx::Error> = sqlx::query_as("SELECT pg_try_advisory_lock($1)").bind(WORKER_ADVISORY_LOCK_ID).fetch_one(&mut conn).await;
        match got {
            Ok((true,)) => {
                *self.lock_conn.lock().await = Some(conn);
                self.has_lock.store(true, Ordering::SeqCst);
                true
            }
            _ => false,
        }
    }

    pub async fn release_lock(&self) {
        self.has_lock.store(false, Ordering::SeqCst);
        if let Some(mut c) = self.lock_conn.lock().await.take() {
            let _ = sqlx::query("SELECT pg_advisory_unlock($1)").bind(WORKER_ADVISORY_LOCK_ID).execute(&mut c).await;
            let _ = c.close().await;
        }
    }

    pub async fn process_one(&self) -> bool {
        if !self.deps.outbound_enabled || !self.has_lock.load(Ordering::SeqCst) {
            return false;
        }
        let claimed = match claim_due_notification(&self.deps.pool, self.opts.lease_secs).await {
            Ok(Some(c)) => c,
            Ok(None) => return false,
            Err(e) => {
                tracing::error!(error = %e.message, "claim failed");
                return false;
            }
        };
        let (notif, token) = claimed;
        let lease_valid = Arc::new(AtomicBool::new(true));

        let renew = {
            let pool = self.deps.pool.clone();
            let valid = lease_valid.clone();
            let secs = self.opts.lease_secs;
            let id = notif.id;
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(20)).await;
                    match renew_lease(&pool, id, token, secs).await {
                        Ok(true) => {}
                        _ => {
                            valid.store(false, Ordering::SeqCst);
                            tracing::error!("failed to renew lease");
                        }
                    }
                }
            })
        };

        let has_lock = self.has_lock.clone();
        let valid = lease_valid.clone();
        let owner = move || has_lock.load(Ordering::SeqCst) && valid.load(Ordering::SeqCst);
        let result = process_notification(&notif, token, &self.deps, &owner).await;
        renew.abort();

        match result {
            Ok(r) => r.status != "aborted",
            Err(e) => {
                tracing::error!(error = %e.message, "worker error during notification processing");
                let _ = sqlx::query(
                    "UPDATE notifications SET state = 'queued', lease_token = NULL, lease_expires_at = NULL, updated_at = now()
                     WHERE id = $1 AND lease_token = $2 AND state = 'preparing'",
                )
                .bind(notif.id)
                .bind(token)
                .execute(&self.deps.pool)
                .await;
                false
            }
        }
    }

    /// Runs until `shutdown` flips to true.
    pub async fn run(&self, mut shutdown: watch::Receiver<bool>) -> Result<()> {
        if !self.acquire_lock().await {
            return Err(AppError::config(
                "worker_lock",
                format!("Worker could not acquire advisory lock {WORKER_ADVISORY_LOCK_ID}. Another worker is already running."),
            ));
        }
        match recover_expired_leases(&self.deps.pool).await {
            Ok((p, s)) if p > 0 || s > 0 => {
                tracing::info!("Worker crash recovery: recovered {p} preparing, marked {s} submitting as unknown.")
            }
            Ok(_) => {}
            Err(e) => tracing::error!(error = %e.message, "startup lease recovery failed"),
        }
        let _ = update_worker_heartbeat(&self.deps.pool).await;
        match run_retention(&self.deps.pool, &self.deps.storage, Utc::now()).await {
            Ok(_) => {}
            Err(e) => tracing::error!(error = %e.message, "startup retention sweep failed"),
        }

        let bg = self.spawn_background(shutdown.clone());

        loop {
            if *shutdown.borrow() {
                break;
            }
            if self.process_one().await {
                continue;
            }
            tokio::select! {
                _ = tokio::time::sleep(self.opts.poll_interval) => {}
                _ = shutdown.changed() => {}
            }
        }
        for h in bg {
            h.abort();
        }
        self.release_lock().await;
        Ok(())
    }

    fn spawn_background(&self, shutdown: watch::Receiver<bool>) -> Vec<tokio::task::JoinHandle<()>> {
        let mut handles = vec![];

        // heartbeat plus liveness probe of the lock connection
        let (pool, lock_conn, has_lock, every) =
            (self.deps.pool.clone(), self.lock_conn.clone(), self.has_lock.clone(), self.opts.heartbeat_interval);
        handles.push(tokio::spawn(async move {
            loop {
                tokio::time::sleep(every).await;
                let alive = {
                    let mut g = lock_conn.lock().await;
                    match g.as_mut() {
                        Some(c) => sqlx::query("SELECT 1").execute(c).await.is_ok(),
                        None => false,
                    }
                };
                if !alive {
                    if has_lock.swap(false, Ordering::SeqCst) {
                        tracing::error!("worker advisory lock connection lost; ownership lost");
                    }
                    continue;
                }
                if let Err(e) = update_worker_heartbeat(&pool).await {
                    tracing::error!(error = %e.message, "worker heartbeat failed");
                }
            }
        }));

        let (pool, has_lock) = (self.deps.pool.clone(), self.has_lock.clone());
        handles.push(tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                if !has_lock.load(Ordering::SeqCst) {
                    continue;
                }
                if let Err(e) = recover_expired_leases(&pool).await {
                    tracing::error!(error = %e.message, "periodic lease recovery failed");
                }
            }
        }));

        let (pool, storage) = (self.deps.pool.clone(), self.deps.storage.clone());
        handles.push(tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(3600)).await;
                if let Err(e) = run_retention(&pool, &storage, Utc::now()).await {
                    tracing::error!(error = %e.message, "hourly retention sweep failed");
                }
            }
        }));
        let _ = shutdown;
        handles
    }
}
