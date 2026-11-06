pub mod accept;
pub mod captcha;
pub mod cli;
pub mod config;
pub mod db;
pub mod errors;
pub mod forms;
pub mod http;
pub mod input;
pub mod inbound;
pub mod mime;
pub mod queue;
pub mod ratelimit;
pub mod repo;
pub mod retention;
pub mod sentinel;
pub mod smtp;
pub mod storage;
pub mod views;
pub mod worker;

pub fn init_tracing() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with_target(false)
        .try_init();
}
