#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(raxo_email::cli::run_cli(args).await);
}
