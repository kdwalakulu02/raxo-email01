#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="${1:-}"
if [[ -z "$BACKUP_DIR" || ! -d "$BACKUP_DIR" ]]; then
    echo "Usage: $0 /path/to/backup/data-YYYYMMDD_HHMMSS" >&2
    exit 1
fi

echo "=== 1. Verifying Checksums ==="
(cd "$BACKUP_DIR" && sha256sum -c SHA256SUMS)

echo "=== 2. Testing Database Restore into Isolated Database (raxo_restore_test) ==="
docker exec raxo_postgres psql -U raxo_user -d postgres -c "DROP DATABASE IF EXISTS raxo_restore_test;"
docker exec raxo_postgres psql -U raxo_user -d postgres -c "CREATE DATABASE raxo_restore_test OWNER raxo_user;"
docker cp "${BACKUP_DIR}/db_dump.pgcustom" raxo_postgres:/tmp/restore_test.dump
docker exec raxo_postgres pg_restore -U raxo_user -d raxo_restore_test --no-owner --no-privileges /tmp/restore_test.dump
docker exec raxo_postgres rm -f /tmp/restore_test.dump

echo "Verifying restored schema and tables in raxo_restore_test:"
docker exec raxo_postgres psql -U raxo_user -d raxo_restore_test -c "\dt"

docker exec raxo_postgres psql -U raxo_user -d postgres -c "DROP DATABASE raxo_restore_test;"
echo "Isolated database restore test completed successfully!"

echo "=== 3. Testing Storage Archive Integrity ==="
TEST_EXTRACT="/tmp/test_storage_extract_$$"
mkdir -p "$TEST_EXTRACT"
tar -xzf "${BACKUP_DIR}/storage.tar.gz" -C "$TEST_EXTRACT"
ls -la "$TEST_EXTRACT"
rm -rf "$TEST_EXTRACT"
echo "Storage archive integrity verified!"

echo "=== 4. Testing Configuration Archive Integrity ==="
tar -tzf "${BACKUP_DIR}/config.tar.gz"
echo "Configuration archive integrity verified!"

echo "Restore verification test SUCCEEDED completely."
