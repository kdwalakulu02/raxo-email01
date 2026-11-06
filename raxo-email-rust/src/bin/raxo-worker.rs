use raxo_email::{
    config::load_config_from_env,
    db,
    queue::QueueDeps,
    sentinel::Sentinel,
    smtp::SmtpConfig,
    storage::Storage,
    worker::{Worker, WorkerOptions},
};

#[tokio::main]
async fn main() {
    raxo_email::init_tracing();
    if let Err(e) = run().await {
        eprintln!("Failed to start worker: {e}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let cfg = load_config_from_env().map_err(|e| e.message)?;
    let pool = db::create_pool(&cfg.database_url, 10).await.map_err(|e| e.message)?;
    let storage = Storage::new(&cfg.storage_dir).map_err(|e| e.message)?;
    let sentinel = Sentinel::new(&cfg, storage.snapshot_dir().map_err(|e| e.message)?);
    sentinel.init_snapshot_dir().map_err(|e| e.to_string())?;
    let deps = QueueDeps {
        pool: pool.clone(),
        storage,
        smtp: SmtpConfig::from_app(&cfg),
        sentinel,
        max_mime_bytes: cfg.smtp_max_message_bytes as usize,
        outbound_enabled: cfg.outbound_enabled,
        policy: cfg.attachment_policy,
        scan_retries: cfg.attachment_scan_retries,
        notice_html: cfg.attachment_notice_html,
    };
    let worker = Worker::new(deps, WorkerOptions::new(cfg.database_url.clone()));
    let (tx, rx) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).expect("sigterm");
        tokio::select! {
            _ = term.recv() => {}
            _ = tokio::signal::ctrl_c() => {}
        }
        tracing::info!("shutting down worker gracefully");
        let _ = tx.send(true);
    });
    tracing::info!("Raxo Email (Rust) worker starting");
    let r = worker.run(rx).await.map_err(|e| e.message);
    pool.close().await;
    r
}
