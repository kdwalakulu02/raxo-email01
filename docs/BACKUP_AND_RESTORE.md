# Raxo Email — Backup & Disaster Recovery Guide

## 1. Overview of Data Assets

To fully restore a Raxo Email deployment, two persistent state stores must be backed up:

1. **PostgreSQL Database (`postgres_data` volume)**:
   - Dynamic form registrations (`registered_forms`)
   - Form submission metadata and client IDs (`submissions`)
   - Attachment metadata, checksums, and scan status (`attachments`)
   - Notification delivery records, retry states, and receipts (`notifications`)
   - Rate limit buckets and counters (`rate_buckets`)
   - Database migration ledger (`schema_migrations`)

2. **Attachment Disk Storage (`attachment_storage` volume)**:
   - Staged quarantine attachments (`/app/storage/quarantine`)
   - Verified clean scanned attachments (`/app/storage/clean`)
   - Serialized RFC 5322 MIME messages awaiting delivery (`/app/storage/mime`)

---

## 2. Backup Procedures

### 2.1 Automated PostgreSQL Database Dump

Run an atomic PostgreSQL dump from inside the running container without service downtime:

```bash
# Set timestamp
BACKUP_DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/var/backups/raxo"
mkdir -p "$BACKUP_DIR"

# Execute compressed custom-format pg_dump
docker exec -t raxo_postgres pg_dump \
  -U raxo_user \
  -d raxo_production \
  -F c \
  -b \
  -v \
  -f "/tmp/raxo_db_${BACKUP_DATE}.dump"

# Copy dump from container to host backup directory
docker cp raxo_postgres:"/tmp/raxo_db_${BACKUP_DATE}.dump" "$BACKUP_DIR/"
docker exec raxo_postgres rm "/tmp/raxo_db_${BACKUP_DATE}.dump"

# Restrict permissions
chmod 600 "${BACKUP_DIR}/raxo_db_${BACKUP_DATE}.dump"
```

### 2.2 Attachment Storage Backup

Backup the persistent attachment storage volume using a temporary Alpine helper:

```bash
# Export persistent attachment storage volume to compressed tarball
docker run --rm \
  -v attachment_storage:/data:ro \
  -v "${BACKUP_DIR}:/backup" \
  alpine:3.19 \
  tar -czf "/backup/raxo_storage_${BACKUP_DATE}.tar.gz" -C /data .

chmod 600 "${BACKUP_DIR}/raxo_storage_${BACKUP_DATE}.tar.gz"
```

---

## 3. Restoration Procedure

### 3.1 Restoring the PostgreSQL Database

1. **Stop active API and worker processes** to prevent write conflicts during restore:
   ```bash
   docker compose -f docker-compose.prod.yml stop api worker
   ```

2. **Drop existing connections and restore database**:
   ```bash
   # Copy dump into database container
   docker cp /var/backups/raxo/raxo_db_TARGET.dump raxo_postgres:/tmp/restore.dump

   # Terminate active sessions and run pg_restore with clean recreation
   docker exec -i raxo_postgres pg_restore \
     -U raxo_user \
     -d raxo_production \
     --clean \
     --if-exists \
     -v \
     /tmp/restore.dump

   # Clean up temporary dump inside container
   docker exec raxo_postgres rm /tmp/restore.dump
   ```

### 3.2 Restoring Attachment Disk Storage

```bash
# Restore files into persistent volume
docker run --rm \
  -v attachment_storage:/data \
  -v /var/backups/raxo:/backup:ro \
  alpine:3.19 \
  sh -c "rm -rf /data/* && tar -xzf /backup/raxo_storage_TARGET.tar.gz -C /data"
```

### 3.3 Restarting the Stack & Verifying Health

```bash
# Start API and worker
docker compose -f docker-compose.prod.yml start api worker

# Verify container logs and readiness probe
docker logs --tail 50 raxo_api
docker logs --tail 50 raxo_worker

# Test HTTP readiness
curl -f http://127.0.0.1:3000/health/ready
```

---

## 4. Automated Daily Backup Script (`/usr/local/bin/raxo-backup.sh`)

```bash
#!/bin/bash
set -euo pipefail

BACKUP_DIR="/var/backups/raxo"
DATE=$(date +%Y%m%d_%H%M%S)
RETENTION_DAYS=14

mkdir -p "$BACKUP_DIR"

# 1. Database Dump
docker exec -t raxo_postgres pg_dump -U raxo_user -d raxo_production -F c -f "/tmp/db_${DATE}.dump"
docker cp raxo_postgres:"/tmp/db_${DATE}.dump" "${BACKUP_DIR}/db_${DATE}.dump"
docker exec raxo_postgres rm "/tmp/db_${DATE}.dump"
chmod 600 "${BACKUP_DIR}/db_${DATE}.dump"

# 2. Storage Snapshot
docker run --rm -v attachment_storage:/data:ro -v "${BACKUP_DIR}:/backup" alpine:3.19 \
  tar -czf "/backup/storage_${DATE}.tar.gz" -C /data .
chmod 600 "${BACKUP_DIR}/storage_${DATE}.tar.gz"

# 3. Rotate old backups (> 14 days)
find "$BACKUP_DIR" -type f -name "db_*.dump" -mtime +$RETENTION_DAYS -delete
find "$BACKUP_DIR" -type f -name "storage_*.tar.gz" -mtime +$RETENTION_DAYS -delete

echo "[$(date -Iseconds)] Raxo backup completed successfully."
```

Install to root cron:
```cron
# Run daily at 02:30 AM UTC
30 2 * * * /usr/local/bin/raxo-backup.sh >> /var/log/raxo-backup.log 2>&1
```
