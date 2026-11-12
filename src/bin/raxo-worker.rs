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
    log_delivery_config(&cfg);
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

fn log_delivery_config(cfg: &raxo_email::config::AppConfig) {
    use raxo_email::config::DeliveryMode;
    let dkim = cfg.dkim.as_ref().map(|d| d.dns_name());
    match cfg.smtp_delivery_mode {
        DeliveryMode::Relay => {
            tracing::info!(host = %cfg.smtp_host, port = cfg.smtp_port, ?dkim, "delivery mode: relay")
        }
        DeliveryMode::Direct => tracing::info!(
            helo = cfg.smtp_helo_name.as_deref().unwrap_or(""),
            port = cfg.smtp_direct_port,
            ipv4_only = cfg.smtp_direct_ipv4_only,
            ?dkim,
            "delivery mode: direct MX"
        ),
    }
    match &cfg.dkim {
        None if cfg.smtp_delivery_mode == DeliveryMode::Direct => {
            tracing::warn!("direct delivery without DKIM: messages will likely be rejected or marked as spam")
        }
        None => {}
        Some(d) => {
            for f in cfg.forms.values() {
                let domain = f.from.rsplit_once('@').map(|(_, d)| d).unwrap_or("");
                if !d.aligned_with(domain) {
                    tracing::warn!(form = %f.id, from_domain = domain, dkim_domain = d.domain(), "form From domain not aligned with DKIM_DOMAIN");
                }
            }
        }
    }
}
