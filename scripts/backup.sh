#!/usr/bin/env bash
set -euo pipefail

BACKUP_ROOT="${BACKUP_ROOT:-/root/mail-test1-backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="${BACKUP_ROOT}/data-${TIMESTAMP}"

mkdir -p "$BACKUP_DIR"
chmod 0700 "$BACKUP_DIR"

echo "=== 1. Dumping PostgreSQL Database ==="
docker exec raxo_postgres pg_dump -U raxo_user -d raxo_production -F c -f /tmp/db_dump.pgcustom
docker cp raxo_postgres:/tmp/db_dump.pgcustom "${BACKUP_DIR}/db_dump.pgcustom"
docker exec raxo_postgres rm -f /tmp/db_dump.pgcustom

echo "=== 2. Archiving Attachments Storage ==="
tar -czf "${BACKUP_DIR}/storage.tar.gz" -C /var/lib/docker/volumes/mail-test1_attachment_storage/_data .

echo "=== 3. Archiving Runtime Configuration ==="
tar -czf "${BACKUP_DIR}/config.tar.gz" \
  -C /root/mail-test1 .env.production config/forms.json Caddyfile \
  -C /etc postfix/main.cf postfix/master.cf opendkim.conf sasldb2

echo "=== 4. Generating Checksums ==="
(cd "$BACKUP_DIR" && sha256sum db_dump.pgcustom storage.tar.gz config.tar.gz > SHA256SUMS)

echo "Backup completed successfully at: ${BACKUP_DIR}"
ls -lh "$BACKUP_DIR"
cat "${BACKUP_DIR}/SHA256SUMS"
