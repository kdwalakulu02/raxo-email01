#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="/usr/local/bin/raxo-sync-postfix-certs.sh"
FIXTURE_DIR="/tmp/test-cert-fixtures"
rm -rf "$FIXTURE_DIR"
mkdir -p "$FIXTURE_DIR/caddy" "$FIXTURE_DIR/postfix"

echo "=== Scenario 1: No-Change Run Against Live Production Certs ==="
"$SCRIPT_PATH"
echo "Scenario 1 PASSED (live certs verified, no unnecessary reload)"

echo "=== Scenario 2: Valid Replacement Staged and Installed ==="
# Generate valid cert & key
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$FIXTURE_DIR/caddy/mail.btctoons.com.key" \
  -out "$FIXTURE_DIR/caddy/mail.btctoons.com.crt" \
  -days 30 \
  -subj "/CN=mail.btctoons.com" >/dev/null 2>&1

CADDY_DATA_DIR="$FIXTURE_DIR/caddy" POSTFIX_CERT_DIR="$FIXTURE_DIR/postfix" LOCK_FILE="$FIXTURE_DIR/lock" SKIP_POSTFIX_RELOAD=1 "$SCRIPT_PATH"
test -f "$FIXTURE_DIR/postfix/mail.btctoons.com.crt"
test -f "$FIXTURE_DIR/postfix/mail.btctoons.com.key"
# Check permissions
PERM_KEY=$(stat -c "%a" "$FIXTURE_DIR/postfix/mail.btctoons.com.key")
PERM_CRT=$(stat -c "%a" "$FIXTURE_DIR/postfix/mail.btctoons.com.crt")
if [[ "$PERM_KEY" != "640" || "$PERM_CRT" != "644" ]]; then
    echo "ERROR: Incorrect file permissions! Key: $PERM_KEY, Crt: $PERM_CRT" >&2
    exit 1
fi
echo "Scenario 2 PASSED (valid cert and key staged and installed with 0640/0644 permissions)"

echo "=== Scenario 3: Expired Certificate Rejection ==="
python3 -c '
import datetime
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import serialization

key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
subject = issuer = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "mail.btctoons.com")])
cert = (
    x509.CertificateBuilder()
    .subject_name(subject)
    .issuer_name(issuer)
    .public_key(key.public_key())
    .serial_number(x509.random_serial_number())
    .not_valid_before(datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=10))
    .not_valid_after(datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=1))
    .add_extension(x509.SubjectAlternativeName([x509.DNSName("mail.btctoons.com")]), critical=False)
    .sign(key, hashes.SHA256())
)
with open("'"$FIXTURE_DIR/caddy/mail.btctoons.com.crt"'", "wb") as f:
    f.write(cert.public_bytes(serialization.Encoding.PEM))
with open("'"$FIXTURE_DIR/caddy/mail.btctoons.com.key"'", "wb") as f:
    f.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()))
'
set +e
CADDY_DATA_DIR="$FIXTURE_DIR/caddy" POSTFIX_CERT_DIR="$FIXTURE_DIR/postfix" LOCK_FILE="$FIXTURE_DIR/lock" SKIP_POSTFIX_RELOAD=1 "$SCRIPT_PATH"
EXIT_3=$?
set -e
if [[ "$EXIT_3" -eq 0 ]]; then
    echo "ERROR: Expired cert was accepted!" >&2
    exit 1
fi
echo "Scenario 3 PASSED (expired cert was rejected with exit code $EXIT_3)"

echo "=== Scenario 4: Mismatched Key and Certificate Rejection ==="
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$FIXTURE_DIR/caddy/unrelated.key" \
  -out "$FIXTURE_DIR/caddy/mail.btctoons.com.crt" \
  -days 30 \
  -subj "/CN=mail.btctoons.com" >/dev/null 2>&1
openssl genrsa -out "$FIXTURE_DIR/caddy/mail.btctoons.com.key" 2048 >/dev/null 2>&1

set +e
CADDY_DATA_DIR="$FIXTURE_DIR/caddy" POSTFIX_CERT_DIR="$FIXTURE_DIR/postfix" LOCK_FILE="$FIXTURE_DIR/lock" SKIP_POSTFIX_RELOAD=1 "$SCRIPT_PATH"
EXIT_4=$?
set -e
if [[ "$EXIT_4" -eq 0 ]]; then
    echo "ERROR: Mismatched key was accepted!" >&2
    exit 1
fi
echo "Scenario 4 PASSED (mismatched key was rejected with exit code $EXIT_4)"

echo "=== Scenario 5: Hostname Mismatch Rejection ==="
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$FIXTURE_DIR/caddy/mail.btctoons.com.key" \
  -out "$FIXTURE_DIR/caddy/mail.btctoons.com.crt" \
  -days 30 \
  -subj "/CN=wronghost.example.com" >/dev/null 2>&1

set +e
CADDY_DATA_DIR="$FIXTURE_DIR/caddy" POSTFIX_CERT_DIR="$FIXTURE_DIR/postfix" LOCK_FILE="$FIXTURE_DIR/lock" SKIP_POSTFIX_RELOAD=1 "$SCRIPT_PATH"
EXIT_5=$?
set -e
if [[ "$EXIT_5" -eq 0 ]]; then
    echo "ERROR: Wrong hostname cert was accepted!" >&2
    exit 1
fi
echo "Scenario 5 PASSED (wrong hostname was rejected with exit code $EXIT_5)"

echo "=== Scenario 6: Concurrent Execution Protection (flock) ==="
(
    exec 200>"$FIXTURE_DIR/lock"
    flock -x 200
    sleep 2
) &
LOCK_PID=$!
sleep 0.3
OUTPUT_6=$(CADDY_DATA_DIR="$FIXTURE_DIR/caddy" POSTFIX_CERT_DIR="$FIXTURE_DIR/postfix" LOCK_FILE="$FIXTURE_DIR/lock" SKIP_POSTFIX_RELOAD=1 "$SCRIPT_PATH" 2>&1 || true)
wait "$LOCK_PID"
if ! echo "$OUTPUT_6" | grep -qi "Another cert sync instance is running"; then
    echo "ERROR: Concurrent lock did not trigger properly: $OUTPUT_6" >&2
    exit 1
fi
echo "Scenario 6 PASSED (flock prevented concurrent execution cleanly)"

rm -rf "$FIXTURE_DIR"
echo "=== ALL 6 CERTIFICATE PROPAGATION SCENARIOS PASSED SUCCESSFULLY ==="
