# Raxo Email — Authoritative Backup & Disaster Recovery Guide

## 1. Authoritative Data Assets and Storage Layout

To achieve zero data loss and full disaster recovery, three distinct asset classes must be captured:

### 1.1 PostgreSQL Database
- **Container**: `raxo_postgres`
- **Database Name**: `raxo_production`
- **User**: `raxo_user`
- **Tables**:
  - `registered_forms`: Form configuration and routing
  - `submissions`: Inbound form submission metadata, client IP, idempotency
  - `attachments`: File metadata, original filename, SHA-256 checksums, ClamAV scan status
  - `notifications`: Delivery state machine, recipient status, attempts, retry schedule
  - `send_attempts`: Diagnostic SMTP responses, Postfix queue IDs, Message-IDs
  - `rate_buckets`: Rolling rate limit tracking
  - `schema_migrations`, `schema_meta`: Schema versioning

### 1.2 Authoritative Attachment Storage Volume
- **Docker Volume Name**: `mail-test1_attachment_storage`
- **Container Destination**: `/app/storage` (mounted into both `raxo_api` and `raxo_worker`)
- **Host Path**: `/var/lib/docker/volumes/mail-test1_attachment_storage/_data`
- **Directory Layout**:
  - `clean/`: Promoted files that passed ClamAV scanning, named by attachment UUID (e.g. `7b5abf1d-e7c1-4904-b528-01bd98ab1a70`)
  - `mime/`: Pre-rendered RFC 5322 MIME messages awaiting SMTP delivery, named by notification UUID
  - `quarantine/`: Pending files staged for ClamAV inspection
  - `tmp/`: In-flight multipart streaming buffers (drained and cleaned upon completion or abort)
- **Encryption Status on Disk**:
  > [!IMPORTANT]
  > Attachment storage on disk is **UNENCRYPTED** (standard host `ext4` filesystem). File confidentiality relies entirely on POSIX file permissions (`0600` / `-rw-------`) and Docker container isolation. Consequently, all backups destined for off-server transfer **MUST be encrypted** before leaving this server.

### 1.3 Private Runtime Configuration and Key Material
- **OpenDKIM Keys & Tables**:
  - Authoritative Private Key: `/etc/opendkim/keys/notify.btctoons.com/postal.private`
  - *(Note: Generic Debian documentation refers to `/etc/dkimkeys/postal.private`, but this host authoritatively configures `/etc/opendkim/keys/notify.btctoons.com/postal.private` matching DNS TXT selector `postal._domainkey.notify.btctoons.com`)*
  - Tables: `/etc/opendkim/key.table`, `/etc/opendkim/signing.table`, `/etc/opendkim/trusted.hosts`, `/etc/opendkim.conf`
- **MTA Configuration & SASL Credentials**:
  - Postfix Config: `/etc/postfix/main.cf`, `/etc/postfix/master.cf`
  - Postfix SASL Database: `/etc/sasldb2` (contains authenticated submission credentials)
- **Application Configuration**:
  - Environment Secrets: `/root/mail-test1/.env.production` (database credentials, Cloudflare Turnstile secret, SMTP credentials)
  - Forms Definition: `/root/mail-test1/config/forms.json`
  - Reverse Proxy: `/root/mail-test1/Caddyfile`

---

## 2. Automated Backup Execution (`scripts/backup.sh`)

The authoritative backup script creates timestamped, checksummed local backups and packages versioned, encrypted archives ready for offsite replication.

### 2.1 Running a Backup

```bash
cd /root/mail-test1

# To generate an encrypted versioned backup:
export BACKUP_PASSPHRASE="your-secure-passphrase-here"
# Or provide via file:
# export BACKUP_PASSPHRASE_FILE="/path/to/backup.key"

# Optional off-server replication target:
# export OFFSITE_DESTINATION="backupuser@vault.btctoons.com:/srv/backups/raxo-email/"

./scripts/backup.sh
```

### 2.2 What the Script Does

1. **Atomic PostgreSQL Dump**: Performs `pg_dump -F c` of `raxo_production` into `db_dump.pgcustom`.
2. **Authoritative Attachment Volume Archive**: Packages `/var/lib/docker/volumes/mail-test1_attachment_storage/_data` (`clean`, `mime`, `quarantine`, `tmp`) into `storage.tar.gz`.
3. **Private Configuration & Keys Archive**: Packages `.env.production`, `config/forms.json`, `Caddyfile`, `/etc/opendkim/...`, `/etc/postfix/...`, and `/etc/sasldb2` into `config_and_keys.tar.gz`.
4. **Manifest & SHA-256 Checksums**: Writes `MANIFEST.txt` and records `SHA256SUMS` for all artifacts.
5. **Versioned Packaging**: Packages the timestamped backup directory into `/root/mail-test1-backups/raxo-versioned-${TIMESTAMP}.tar.gz`.
6. **Symmetric Encryption (AES-256-CBC + PBKDF2)**: Encrypts the versioned archive to `raxo-versioned-${TIMESTAMP}.tar.gz.enc` using `openssl enc -aes-256-cbc -pbkdf2 -salt`.
7. **Safe Off-Server Replication**: If `OFFSITE_DESTINATION` is set, transmits via `rsync -avz --ignore-existing`. Never uses `--delete`, ensuring historical versions cannot be purged by a compromised or corrupted source.
8. **Local Backup Preservation**: All prior local backups in `/root/mail-test1-backups/` are strictly preserved.

---

## 3. Off-Server Backup Requirements & Operator Setup

To establish scheduled off-server disaster recovery, the operator must provide:

1. **Encryption Passphrase**:
   - Set in `/root/.raxo_backup_passphrase` (chmod 0400).
2. **Dedicated Off-Server Storage Destination**:
   - Remote SSH user, host, port, and destination path (e.g. `raxobackup@backup-vault.btctoons.com:/var/backups/raxo/`).
   - SSH key pair configured for automated authentication without interactive password prompt (`ssh-keygen -t ed25519 -f /root/.ssh/id_raxo_backup`).
   - Alternatively, an S3 / R2 bucket endpoint with access key / secret key if using `rclone` or `aws-cli`.
3. **Automated Cron Job**:
   Install into root's crontab:
   ```cron
   # Daily at 02:30 UTC
   30 2 * * * BACKUP_PASSPHRASE_FILE=/root/.raxo_backup_passphrase OFFSITE_DESTINATION="raxobackup@backup-vault.btctoons.com:/var/backups/raxo/" /root/mail-test1/scripts/backup.sh >> /var/log/raxo-backup.log 2>&1
   ```

---

## 4. Verification and Restoration (`scripts/restore.sh`)

### 4.1 Non-Destructive Integrity Verification

Before any disaster occurs, test archive validity at any time without impacting production services. The restore script automatically tests database restoration into an ephemeral test database (`raxo_restore_test`) and verifies archive integrity.

```bash
# Test an uncompressed directory:
./scripts/restore.sh /root/mail-test1-backups/data-YYYYMMDD_HHMMSS

# Or test an encrypted versioned archive directly:
BACKUP_PASSPHRASE="your-passphrase" ./scripts/restore.sh /root/mail-test1-backups/raxo-versioned-YYYYMMDD_HHMMSS.tar.gz.enc
```

### 4.2 Full Production Disaster Recovery Procedure

In the event of complete server loss:

1. **Provision new VPS and install base dependencies**:
   - Ubuntu 24.04 LTS
   - Docker Engine & Docker Compose
   - Postfix, OpenDKIM, SASL (`apt install postfix postfix-pcre opendkim opendkim-tools sasl2-bin libsasl2-modules`)

2. **Retrieve and decrypt the latest backup archive**:
   ```bash
   openssl enc -d -aes-256-cbc -pbkdf2 \
     -in raxo-versioned-TARGET.tar.gz.enc \
     -out raxo-versioned-TARGET.tar.gz \
     -pass "pass:${BACKUP_PASSPHRASE}"

   mkdir -p /root/restore_stage
   tar -xzf raxo-versioned-TARGET.tar.gz -C /root/restore_stage
   RESTORE_DIR=$(find /root/restore_stage -maxdepth 1 -type d -name "data-*" | head -n 1)
   ```

3. **Verify SHA-256 Checksums**:
   ```bash
   (cd "$RESTORE_DIR" && sha256sum -c SHA256SUMS)
   ```

4. **Restore Configuration and Key Material**:
   ```bash
   tar -xzf "${RESTORE_DIR}/config_and_keys.tar.gz" -C /
   chmod 0600 /etc/opendkim/keys/notify.btctoons.com/postal.private
   chown opendkim:opendkim /etc/opendkim/keys/notify.btctoons.com/postal.private
   chmod 0600 /root/mail-test1/.env.production
   systemctl restart postfix opendkim
   ```

5. **Start PostgreSQL Container and Restore Database**:
   ```bash
   cd /root/mail-test1
   docker compose -f docker-compose.prod.yml up -d postgres
   sleep 5

   docker cp "${RESTORE_DIR}/db_dump.pgcustom" raxo_postgres:/tmp/restore.dump
   docker exec -i raxo_postgres pg_restore -U raxo_user -d raxo_production --clean --if-exists -v /tmp/restore.dump
   docker exec raxo_postgres rm /tmp/restore.dump
   ```

6. **Restore Attachment Storage Volume**:
   ```bash
   # Extract storage directly into the volume directory
   tar -xzf "${RESTORE_DIR}/storage.tar.gz" -C /var/lib/docker/volumes/mail-test1_attachment_storage/_data/
   chown -R 1000:1000 /var/lib/docker/volumes/mail-test1_attachment_storage/_data/
   chmod 0700 /var/lib/docker/volumes/mail-test1_attachment_storage/_data/{clean,mime,quarantine,tmp}
   ```

7. **Start Application Services & Verify**:
   ```bash
   docker compose -f docker-compose.prod.yml up -d
   curl -f http://127.0.0.1:3000/health/ready
   ```
