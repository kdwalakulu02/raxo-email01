#!/usr/bin/env bash
set -euo pipefail

TARGET_DOMAIN="${TARGET_DOMAIN:-mail.btctoons.com}"
CADDY_DATA_DIR="${CADDY_DATA_DIR:-/var/lib/docker/volumes/mail-test1_caddy_data/_data/caddy/certificates}"
POSTFIX_CERT_DIR="${POSTFIX_CERT_DIR:-/etc/postfix/certs}"
LOCK_FILE="${LOCK_FILE:-/run/lock/raxo-cert-sync.lock}"
SKIP_POSTFIX_RELOAD="${SKIP_POSTFIX_RELOAD:-0}"

# 1. Prevent concurrent runs
mkdir -p "$(dirname "$LOCK_FILE")"
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
    echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Another cert sync instance is running. Exiting." >&2
    exit 0
fi

# 2. Locate source certificate and key
SRC_CERT=""
SRC_KEY=""

if [[ -n "${SRC_CERT_OVERRIDE:-}" && -n "${SRC_KEY_OVERRIDE:-}" ]]; then
    SRC_CERT="$SRC_CERT_OVERRIDE"
    SRC_KEY="$SRC_KEY_OVERRIDE"
    if [[ ! -f "$SRC_CERT" || ! -f "$SRC_KEY" ]]; then
        echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] ERROR: Override certificate or key file not found: $SRC_CERT, $SRC_KEY" >&2
        exit 1
    fi
else
    if [[ ! -d "$CADDY_DATA_DIR" ]]; then
        echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] ERROR: Caddy certificates directory does not exist: $CADDY_DATA_DIR" >&2
        exit 1
    fi

    # Find candidate cert files matching TARGET_DOMAIN
    CANDIDATES=$(find "$CADDY_DATA_DIR" -type f -name "${TARGET_DOMAIN}.crt" 2>/dev/null || true)
    if [[ -z "$CANDIDATES" ]]; then
        echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] ERROR: No certificate found for ${TARGET_DOMAIN} in ${CADDY_DATA_DIR}" >&2
        exit 1
    fi

    # Pick the newest candidate by mtime
    NEWEST_CERT=$(ls -t $CANDIDATES 2>/dev/null | head -n 1)
    DIR=$(dirname "$NEWEST_CERT")
    NEWEST_KEY="${DIR}/${TARGET_DOMAIN}.key"

    if [[ ! -f "$NEWEST_KEY" ]]; then
        echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] ERROR: Certificate found at ${NEWEST_CERT} but key missing at ${NEWEST_KEY}" >&2
        exit 1
    fi
    SRC_CERT="$NEWEST_CERT"
    SRC_KEY="$NEWEST_KEY"
fi

# 3. Validate Candidate Certificate & Key before touching active deployment
# a. Validity: not expired (valid for at least 1 day)
if ! openssl x509 -in "$SRC_CERT" -noout -checkend 86400 >/dev/null 2>&1; then
    echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] ERROR: Source certificate is expired or expiring within 24 hours: ${SRC_CERT}" >&2
    exit 1
fi

# b. Hostname match
if ! openssl x509 -in "$SRC_CERT" -noout -text 2>/dev/null | grep -qE "DNS:${TARGET_DOMAIN}|CN\s*=\s*${TARGET_DOMAIN}"; then
    echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] ERROR: Source certificate does not contain domain ${TARGET_DOMAIN}" >&2
    exit 1
fi

# c. Key and Cert match
CERT_PUBKEY_HASH=$(openssl x509 -in "$SRC_CERT" -noout -pubkey 2>/dev/null | openssl sha256 | awk '{print $NF}')
KEY_PUBKEY_HASH=$(openssl pkey -in "$SRC_KEY" -pubout 2>/dev/null | openssl sha256 | awk '{print $NF}')

if [[ -z "$CERT_PUBKEY_HASH" || -z "$KEY_PUBKEY_HASH" || "$CERT_PUBKEY_HASH" != "$KEY_PUBKEY_HASH" ]]; then
    echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] ERROR: Public key mismatch between certificate and private key" >&2
    exit 1
fi

# 4. Check if active cert and key exist and if they are identical to source
ACTIVE_CERT="${POSTFIX_CERT_DIR}/${TARGET_DOMAIN}.crt"
ACTIVE_KEY="${POSTFIX_CERT_DIR}/${TARGET_DOMAIN}.key"
mkdir -p "$POSTFIX_CERT_DIR"

if [[ -f "$ACTIVE_CERT" && -f "$ACTIVE_KEY" ]]; then
    SRC_CERT_SHA=$(sha256sum "$SRC_CERT" | awk '{print $1}')
    ACTIVE_CERT_SHA=$(sha256sum "$ACTIVE_CERT" | awk '{print $1}')
    SRC_KEY_SHA=$(sha256sum "$SRC_KEY" | awk '{print $1}')
    ACTIVE_KEY_SHA=$(sha256sum "$ACTIVE_KEY" | awk '{print $1}')

    if [[ "$SRC_CERT_SHA" == "$ACTIVE_CERT_SHA" && "$SRC_KEY_SHA" == "$ACTIVE_KEY_SHA" ]]; then
        echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Certificate and key for ${TARGET_DOMAIN} are up to date. No action needed."
        exit 0
    fi
fi

# 5. Stage the files in a temporary staging directory
STAGING_DIR="${POSTFIX_CERT_DIR}/.staging"
BACKUP_DIR="${POSTFIX_CERT_DIR}/.backup"
mkdir -p "$STAGING_DIR" "$BACKUP_DIR"
chmod 700 "$STAGING_DIR" "$BACKUP_DIR"

# Stage with restrictive permissions
cp "$SRC_CERT" "${STAGING_DIR}/${TARGET_DOMAIN}.crt"
cp "$SRC_KEY" "${STAGING_DIR}/${TARGET_DOMAIN}.key"
chmod 0644 "${STAGING_DIR}/${TARGET_DOMAIN}.crt"
chmod 0640 "${STAGING_DIR}/${TARGET_DOMAIN}.key"

# Handle postfix group ownership if group exists
if getent group postfix >/dev/null 2>&1; then
    chown root:postfix "${STAGING_DIR}/${TARGET_DOMAIN}.crt" "${STAGING_DIR}/${TARGET_DOMAIN}.key"
fi

# 6. Verify staged files before activating
STAGED_CERT_PUBKEY=$(openssl x509 -in "${STAGING_DIR}/${TARGET_DOMAIN}.crt" -noout -pubkey 2>/dev/null | openssl sha256 | awk '{print $NF}')
STAGED_KEY_PUBKEY=$(openssl pkey -in "${STAGING_DIR}/${TARGET_DOMAIN}.key" -pubout 2>/dev/null | openssl sha256 | awk '{print $NF}')

if [[ "$STAGED_CERT_PUBKEY" != "$STAGED_KEY_PUBKEY" ]]; then
    echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] ERROR: Staged certificate and key validation failed" >&2
    rm -rf "$STAGING_DIR"
    exit 1
fi

# 7. Backup existing active cert and key if present
if [[ -f "$ACTIVE_CERT" && -f "$ACTIVE_KEY" ]]; then
    cp -p "$ACTIVE_CERT" "${BACKUP_DIR}/${TARGET_DOMAIN}.crt"
    cp -p "$ACTIVE_KEY" "${BACKUP_DIR}/${TARGET_DOMAIN}.key"
fi

# 8. Activate the new certificate and key atomically
mv "${STAGING_DIR}/${TARGET_DOMAIN}.crt" "$ACTIVE_CERT"
mv "${STAGING_DIR}/${TARGET_DOMAIN}.key" "$ACTIVE_KEY"
rm -rf "$STAGING_DIR"

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Successfully installed new certificate and key for ${TARGET_DOMAIN}"

# 9. Test postfix configuration and reload
if [[ "$SKIP_POSTFIX_RELOAD" -eq 1 ]]; then
    echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] SKIP_POSTFIX_RELOAD is set to 1. Skipping Postfix reload."
    exit 0
fi

if ! postfix check; then
    echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] ERROR: postfix check failed after installing new certificates! Rolling back..." >&2
    if [[ -f "${BACKUP_DIR}/${TARGET_DOMAIN}.crt" && -f "${BACKUP_DIR}/${TARGET_DOMAIN}.key" ]]; then
        mv "${BACKUP_DIR}/${TARGET_DOMAIN}.crt" "$ACTIVE_CERT"
        mv "${BACKUP_DIR}/${TARGET_DOMAIN}.key" "$ACTIVE_KEY"
        echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Rollback completed." >&2
    fi
    exit 1
fi

postfix reload
echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Postfix successfully reloaded."
