#!/usr/bin/env bash
set -euo pipefail

BACKUP_INPUT="${1:-}"
if [[ -z "$BACKUP_INPUT" ]]; then
    echo "Usage: $0 /path/to/backup/data-YYYYMMDD_HHMMSS (or .tar.gz / .tar.gz.enc archive)" >&2
    exit 1
fi

# If an archive or encrypted archive is supplied, extract it to a temporary staging folder
TEMP_EXTRACT=""
cleanup() {
    if [[ -n "$TEMP_EXTRACT" && -d "$TEMP_EXTRACT" ]]; then
        rm -rf "$TEMP_EXTRACT"
    fi
}
trap cleanup EXIT

BACKUP_DIR="$BACKUP_INPUT"
if [[ -f "$BACKUP_INPUT" ]]; then
    ARCHIVE_FILE="$BACKUP_INPUT"
    TEMP_EXTRACT="/tmp/raxo_restore_test_$$"
    mkdir -p "$TEMP_EXTRACT"
    
    if [[ "$ARCHIVE_FILE" == *.enc ]]; then
        echo "=== Decrypting Archive ==="
        PLAINTEXT_TAR="${TEMP_EXTRACT}/decrypted.tar.gz"
        if [[ -n "${BACKUP_PASSPHRASE_FILE:-}" && -f "$BACKUP_PASSPHRASE_FILE" ]]; then
            openssl enc -d -aes-256-cbc -pbkdf2 -in "$ARCHIVE_FILE" -out "$PLAINTEXT_TAR" -pass "file:${BACKUP_PASSPHRASE_FILE}"
        elif [[ -n "${BACKUP_PASSPHRASE:-}" ]]; then
            openssl enc -d -aes-256-cbc -pbkdf2 -in "$ARCHIVE_FILE" -out "$PLAINTEXT_TAR" -pass "env:BACKUP_PASSPHRASE"
        else
            echo "ERROR: Encrypted backup requires BACKUP_PASSPHRASE or BACKUP_PASSPHRASE_FILE." >&2
            exit 1
        fi
        tar -xzf "$PLAINTEXT_TAR" -C "$TEMP_EXTRACT"
        rm -f "$PLAINTEXT_TAR"
    else
        tar -xzf "$ARCHIVE_FILE" -C "$TEMP_EXTRACT"
    fi
    # Find the data-* directory inside the extracted archive
    EXTRACTED_DIR=$(find "$TEMP_EXTRACT" -maxdepth 2 -type d -name "data-*" | head -n 1)
    if [[ -z "$EXTRACTED_DIR" ]]; then
        EXTRACTED_DIR="$TEMP_EXTRACT"
    fi
    BACKUP_DIR="$EXTRACTED_DIR"
fi

if [[ ! -d "$BACKUP_DIR" ]]; then
    echo "Usage: $0 /path/to/backup/data-YYYYMMDD_HHMMSS (or .tar.gz / .tar.gz.enc archive)" >&2
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
if [[ -f "${BACKUP_DIR}/config_and_keys.tar.gz" ]]; then
    tar -tzf "${BACKUP_DIR}/config_and_keys.tar.gz"
elif [[ -f "${BACKUP_DIR}/config.tar.gz" ]]; then
    tar -tzf "${BACKUP_DIR}/config.tar.gz"
else
    echo "ERROR: Neither config_and_keys.tar.gz nor config.tar.gz found in $BACKUP_DIR" >&2
    exit 1
fi
echo "Configuration archive integrity verified!"

echo "Restore verification test SUCCEEDED completely."
