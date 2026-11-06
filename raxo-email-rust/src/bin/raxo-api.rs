use raxo_email::{config::load_config_from_env, db, http, sentinel::Sentinel, storage::Storage};
use std::net::SocketAddr;

#[tokio::main]
async fn main() {
    raxo_email::init_tracing();
    if let Err(e) = run().await {
        eprintln!("Fatal startup error: {e}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let cfg = load_config_from_env().map_err(|e| e.message)?;
    let pool = db::create_pool(&cfg.database_url, 10).await.map_err(|e| e.message)?;
    let storage = Storage::new(&cfg.storage_dir).map_err(|e| e.message)?;
    let sentinel = Sentinel::new(&cfg, storage.snapshot_dir().map_err(|e| e.message)?);
    let addr: SocketAddr = format!("{}:{}", cfg.host, cfg.port).parse().map_err(|e| format!("bad HOST/PORT: {e}"))?;
    let state = http::AppState::new(cfg, pool.clone(), storage, sentinel);
    let app = http::build_router(state).into_make_service_with_connect_info::<SocketAddr>();
    let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| e.to_string())?;
    tracing::info!("Raxo Email (Rust) HTTP server listening on http://{addr}");
    axum::serve(listener, app).with_graceful_shutdown(shutdown_signal()).await.map_err(|e| e.to_string())?;
    pool.close().await;
    Ok(())
}

async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut term = signal(SignalKind::terminate()).expect("sigterm");
    tokio::select! {
        _ = term.recv() => {}
        _ = tokio::signal::ctrl_c() => {}
    }
    tracing::info!("shutting down HTTP server");
}
