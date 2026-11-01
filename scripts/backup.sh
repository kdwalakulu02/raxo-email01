#!/usr/bin/env bash
set -euo pipefail

# Authoritative Raxo Email Gateway Backup Script
# Preserves local backups and creates versioned, encrypted archives for off-server replication.

BACKUP_ROOT="${BACKUP_ROOT:-/root/mail-test1-backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="${BACKUP_ROOT}/data-${TIMESTAMP}"
VERSIONED_TAR="${BACKUP_ROOT}/raxo-versioned-${TIMESTAMP}.tar.gz"
VERSIONED_ENC="${BACKUP_ROOT}/raxo-versioned-${TIMESTAMP}.tar.gz.enc"

mkdir -p "$BACKUP_DIR"
chmod 0700 "$BACKUP_DIR"

echo "=== 1. Dumping PostgreSQL Database (raxo_production) ==="
docker exec raxo_postgres pg_dump -U raxo_user -d raxo_production -F c -f /tmp/db_dump.pgcustom
docker cp raxo_postgres:/tmp/db_dump.pgcustom "${BACKUP_DIR}/db_dump.pgcustom"
docker exec raxo_postgres rm -f /tmp/db_dump.pgcustom

echo "=== 2. Archiving Authoritative Attachment Storage Volume ==="
# Docker volume mail-test1_attachment_storage mounted at /app/storage
# Contains: clean/ (promoted attachments), quarantine/ (pending scan), mime/ (rendered messages), tmp/ (in-flight)
# Note: Raw storage on disk is unencrypted with POSIX mode 0600.
tar -czf "${BACKUP_DIR}/storage.tar.gz" -C /var/lib/docker/volumes/mail-test1_attachment_storage/_data clean mime quarantine tmp

echo "=== 3. Archiving Private Runtime Configuration & Keys ==="
# Includes authoritative OpenDKIM keys, Postfix configuration, Caddy, and environment secrets
tar -czf "${BACKUP_DIR}/config_and_keys.tar.gz" \
  -C /root/mail-test1 .env.production config/forms.json Caddyfile \
  -C /etc opendkim/keys/notify.btctoons.com/postal.private \
  -C /etc opendkim/key.table opendkim/signing.table opendkim/trusted.hosts opendkim.conf \
  -C /etc postfix/main.cf postfix/master.cf sasldb2

echo "=== 4. Generating Manifest and SHA-256 Checksums ==="
cat <<EOF > "${BACKUP_DIR}/MANIFEST.txt"
Raxo Email Forms Core - Versioned Backup
Timestamp: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
Host: $(hostname -f 2>/dev/null || hostname)
Database: raxo_production
Storage Volume: mail-test1_attachment_storage (clean, mime, quarantine, tmp)
OpenDKIM Key: /etc/opendkim/keys/notify.btctoons.com/postal.private
Postfix Configuration: /etc/postfix/main.cf, /etc/postfix/master.cf, /etc/sasldb2
EOF

(cd "$BACKUP_DIR" && sha256sum db_dump.pgcustom storage.tar.gz config_and_keys.tar.gz MANIFEST.txt > SHA256SUMS)

echo "=== 5. Packaging Versioned Archive ==="
tar -czf "$VERSIONED_TAR" -C "$BACKUP_ROOT" "data-${TIMESTAMP}"
sha256sum "$VERSIONED_TAR" > "${VERSIONED_TAR}.sha256"
chmod 0600 "$VERSIONED_TAR" "${VERSIONED_TAR}.sha256"

echo "=== 6. Encryption Check (AES-256-CBC with PBKDF2) ==="
if [[ -n "${BACKUP_PASSPHRASE:-}" || -n "${BACKUP_PASSPHRASE_FILE:-}" ]]; then
  echo "Encrypting versioned archive..."
  if [[ -n "${BACKUP_PASSPHRASE_FILE:-}" && -f "$BACKUP_PASSPHRASE_FILE" ]]; then
    openssl enc -aes-256-cbc -pbkdf2 -salt -in "$VERSIONED_TAR" -out "$VERSIONED_ENC" -pass "file:${BACKUP_PASSPHRASE_FILE}"
  else
    openssl enc -aes-256-cbc -pbkdf2 -salt -in "$VERSIONED_TAR" -out "$VERSIONED_ENC" -pass "env:BACKUP_PASSPHRASE"
  fi
  sha256sum "$VERSIONED_ENC" > "${VERSIONED_ENC}.sha256"
  chmod 0600 "$VERSIONED_ENC" "${VERSIONED_ENC}.sha256"
  echo "Encrypted archive ready: ${VERSIONED_ENC}"
else
  echo "NOTICE: BACKUP_PASSPHRASE not set in environment. Versioned archive packaged in plaintext at ${VERSIONED_TAR}."
  echo "To enable encryption, export BACKUP_PASSPHRASE or BACKUP_PASSPHRASE_FILE before running."
fi

echo "=== 7. Off-Server Replication Check ==="
if [[ -n "${OFFSITE_DESTINATION:-}" ]]; then
  # Target can be SSH (user@host:/path/) or rclone/s3 target
  FILE_TO_SHIP="${VERSIONED_ENC}"
  if [[ ! -f "$FILE_TO_SHIP" ]]; then
    FILE_TO_SHIP="${VERSIONED_TAR}"
  fi
  echo "Shipping versioned archive to off-server destination: ${OFFSITE_DESTINATION}..."
  # Non-destructive copy (never use --delete against versioned repository)
  rsync -avz --ignore-existing "$FILE_TO_SHIP" "${FILE_TO_SHIP}.sha256" "${OFFSITE_DESTINATION}"
  echo "Off-server shipping completed successfully."
else
  echo "NOTICE: OFFSITE_DESTINATION not set. Preserved local backup in ${BACKUP_DIR}."
  echo "For off-server disaster recovery, set OFFSITE_DESTINATION (e.g., user@remote-vault:/backups/raxo-email/)."
fi

echo "=== Backup Complete ==="
ls -lh "$BACKUP_DIR"
cat "${BACKUP_DIR}/SHA256SUMS"
