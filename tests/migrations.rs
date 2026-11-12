mod common;

use common::fresh_db;
use std::path::Path;

#[test]
fn migrations_001_to_004_are_byte_identical_to_node_reference() {
    let node = Path::new(env!("CARGO_MANIFEST_DIR")).join("../raxo-email/migrations");
    let rust = Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let mut checked = 0;
    for entry in std::fs::read_dir(&node).unwrap() {
        let name = entry.unwrap().file_name();
        let a = std::fs::read(node.join(&name)).unwrap();
        let b = std::fs::read(rust.join(&name)).unwrap_or_else(|_| panic!("missing in Rust: {name:?}"));
        assert_eq!(a, b, "{name:?} differs from the Node reference");
        checked += 1;
    }
    assert_eq!(checked, 4, "update this test when the Node reference adds migrations");
}

#[tokio::test(flavor = "multi_thread")]
async fn migrations_apply_once_and_are_idempotent_with_checksums() {
    let pool = fresh_db().await;
    let versions: Vec<String> =
        sqlx::query_scalar("SELECT version FROM schema_migrations ORDER BY version").fetch_all(&pool).await.unwrap();
    assert_eq!(
        versions,
        [
            "001_initial",
            "002_dynamic_forms",
            "003_security_hardening",
            "004_scan_results",
            "005_attachment_disposition"
        ]
    );
    let again = raxo_email::db::run_migrations(&pool).await.unwrap();
    assert!(again.applied.is_empty(), "re-running must apply nothing: {:?}", again.applied);
}
