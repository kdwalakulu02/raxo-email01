use crate::errors::{AppError, Result};
use crate::queue::{claim_due_notification, process_notification, recover_expired_leases, renew_lease, QueueDeps};
use crate::repo::update_worker_heartbeat;
use crate::retention::run_retention;
use chrono::Utc;
use sqlx::{Connection, PgConnection};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;
use tokio::task::JoinSet;

const MAINTENANCE_ADVISORY_LOCK_ID: i64 = 726901;

#[derive(Clone)]
pub struct WorkerOptions {
    pub database_url: String,
    pub poll_interval: Duration,
    pub heartbeat_interval: Duration,
    pub lease_secs: i64,
    pub concurrency: usize,
}

impl WorkerOptions {
    pub fn new(database_url: String) -> Self {
        Self {
            database_url,
            poll_interval: Duration::from_secs(1),
            heartbeat_interval: Duration::from_secs(20),
            lease_secs: 120,
            concurrency: 3,
        }
    }
}

#[derive(Clone)]
pub struct Worker {
    deps: QueueDeps,
    opts: WorkerOptions,
}

impl Worker {
    pub fn new(deps: QueueDeps, opts: WorkerOptions) -> Self {
        Self { deps, opts }
    }

    pub async fn process_one(&self) -> bool {
        if !self.deps.outbound_enabled {
            return false;
        }
        let claimed = match claim_due_notification(&self.deps.pool, &self.deps.capacity, self.opts.lease_secs).await {
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
                            tracing::error!(notification_id = %id, "failed to renew notification lease");
                            break;
                        }
                    }
                }
            })
        };
        let valid = lease_valid.clone();
        let owner = move || valid.load(Ordering::SeqCst);
        let result = process_notification(&notif, token, &self.deps, &owner).await;
        renew.abort();
        match result {
            Ok(r) => r.status != "aborted",
            Err(e) => {
                tracing::error!(notification_id = %notif.id, error = %e.message, "worker error during processing");
                if let Err(reset) = sqlx::query(
                    "UPDATE notifications SET state = 'queued', lease_token = NULL, lease_expires_at = NULL, updated_at = now()
                     WHERE id = $1 AND lease_token = $2 AND state = 'preparing'",
                )
                .bind(notif.id)
                .bind(token)
                .execute(&self.deps.pool)
                .await
                {
                    tracing::error!(notification_id = %notif.id, error = %reset, "failed to release preparation lease");
                }
                false
            }
        }
    }

    pub async fn run(&self, mut shutdown: watch::Receiver<bool>) -> Result<()> {
        match recover_expired_leases(&self.deps.pool).await {
            Ok((p, s)) if p > 0 || s > 0 => {
                tracing::info!("Worker crash recovery: recovered {p} preparing, marked {s} submitting as unknown.")
            }
            Ok(_) => {}
            Err(e) => tracing::error!(error = %e.message, "startup lease recovery failed"),
        }
        if let Err(e) = update_worker_heartbeat(&self.deps.pool).await {
            tracing::error!(error = %e.message, "startup heartbeat failed");
        }
        if let Err(e) = self.run_maintenance().await {
            tracing::error!(error = %e.message, "startup retention sweep failed");
        }
        let background = self.spawn_background();
        let mut workers = JoinSet::new();
        for _ in 0..self.opts.concurrency {
            let worker = self.clone();
            let mut stop = shutdown.clone();
            workers.spawn(async move {
                loop {
                    if *stop.borrow() {
                        break;
                    }
                    if worker.process_one().await {
                        continue;
                    }
                    tokio::select! {
                        _ = tokio::time::sleep(worker.opts.poll_interval) => {}
                        _ = stop.changed() => {}
                    }
                }
            });
        }

        let failure = loop {
            if *shutdown.borrow() {
                break None;
            }
            tokio::select! {
                changed = shutdown.changed() => {
                    if changed.is_err() {
                        break Some("shutdown channel closed".to_string());
                    }
                    if *shutdown.borrow() {
                        break None;
                    }
                }
                exited = workers.join_next() => {
                    if *shutdown.borrow() {
                        break None;
                    }
                    break Some(format!("worker task exited unexpectedly: {exited:?}"));
                }
            }
        };
        if failure.is_some() {
            workers.abort_all();
        }
        while let Some(joined) = workers.join_next().await {
            if let Err(e) = joined {
                if failure.is_none() {
                    tracing::error!(error = %e, "worker task failed during shutdown");
                }
            }
        }
        for handle in background {
            handle.abort();
        }
        match failure {
            Some(message) => Err(AppError::unavailable(message)),
            None => Ok(()),
        }
    }

    async fn run_maintenance(&self) -> Result<()> {
        let mut conn = PgConnection::connect(&self.opts.database_url).await?;
        let got: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock($1)")
            .bind(MAINTENANCE_ADVISORY_LOCK_ID)
            .fetch_one(&mut conn)
            .await?;
        if got {
            run_retention(&self.deps.pool, &self.deps.storage, Utc::now()).await?;
        }
        conn.close().await?;
        Ok(())
    }

    fn spawn_background(&self) -> Vec<tokio::task::JoinHandle<()>> {
        let mut handles = vec![];
        let (pool, every) = (self.deps.pool.clone(), self.opts.heartbeat_interval);
        handles.push(tokio::spawn(async move {
            loop {
                tokio::time::sleep(every).await;
                if let Err(e) = update_worker_heartbeat(&pool).await {
                    tracing::error!(error = %e.message, "worker heartbeat failed");
                }
            }
        }));
        let pool = self.deps.pool.clone();
        handles.push(tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                if let Err(e) = recover_expired_leases(&pool).await {
                    tracing::error!(error = %e.message, "periodic lease recovery failed");
                }
            }
        }));
        let worker = self.clone();
        handles.push(tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(3600)).await;
                if let Err(e) = worker.run_maintenance().await {
                    tracing::error!(error = %e.message, "hourly retention sweep failed");
                }
            }
        }));
        handles
    }
}
