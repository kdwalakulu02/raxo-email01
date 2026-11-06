use raxo_email::{config::load_config_from_env, db};

#[tokio::main]
async fn main() {
    raxo_email::init_tracing();
    let cfg = match load_config_from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Fatal startup error: {}", e.message);
            std::process::exit(1);
        }
    };
    let pool = db::create_pool(&cfg.database_url, 2).await.expect("pool");
    match db::run_migrations(&pool).await {
        Ok(r) => println!("Migrations applied: {:?}; skipped: {:?}", r.applied, r.skipped),
        Err(e) => {
            eprintln!("Migration failed: {}", e.message);
            std::process::exit(1);
        }
    }
}
