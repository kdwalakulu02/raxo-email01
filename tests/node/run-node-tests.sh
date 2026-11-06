#!/usr/bin/env bash
# Runs the Node.js reference test-suite (format, typecheck, unit, integration) against throw-away
# PostgreSQL / Mailpit / ClamAV containers that share one private network namespace (so the tests'
# hard-coded 127.0.0.1 endpoints work). No ports are published on the host.
#
#   PRIVATE_DIR=$HOME/raxo-combo-private tests/node/run-node-tests.sh [pnpm-script ...]
#
# PRIVATE_DIR/clamav-defs must contain ClamAV signatures (see deploy/staging/prepare-clamav-defs.sh).
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
priv=${PRIVATE_DIR:-$HOME/raxo-combo-private}
pfx=raxo_nodetest
scripts=("$@"); [ ${#scripts[@]} -gt 0 ] || scripts=(format:check typecheck test:unit test:integration)
pgpass=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16)

cleanup() { docker rm -f ${pfx}_pg ${pfx}_clam ${pfx}_mail >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
docker run -d --name ${pfx}_mail axllent/mailpit:latest >/dev/null
docker run -d --name ${pfx}_pg --network container:${pfx}_mail -e POSTGRES_USER=raxo_demo -e POSTGRES_PASSWORD="$pgpass" \
  -e POSTGRES_DB=raxo_email_demo postgres:16-alpine -c port=55432 >/dev/null
docker run -d --name ${pfx}_clam --network container:${pfx}_mail -e CLAMAV_NO_FRESHCLAMD=true \
  -v "$priv/clamav-defs:/var/lib/clamav" clamav/clamav:stable >/dev/null

until docker exec ${pfx}_pg pg_isready -p 55432 -U raxo_demo -d raxo_email_demo >/dev/null 2>&1; do sleep 1; done
sleep 2
docker exec ${pfx}_pg psql -p 55432 -U raxo_demo -d raxo_email_demo -c 'CREATE DATABASE raxo_email_test;' >/dev/null
echo "waiting for clamd..."
for _ in $(seq 1 120); do
  docker exec ${pfx}_clam clamdscan --version >/dev/null 2>&1 && break; sleep 2
done

docker run --rm --network container:${pfx}_mail -v "$root/raxo-email:/src:ro" -e PGPASS="$pgpass" -e RUN_SCRIPTS="${scripts[*]}" \
  node:22.23.3-bookworm-slim bash -ec '
  cp -r /src /work && cd /work
  (apt-get update -qq && apt-get install -y -qq curl >/dev/null)
  corepack enable
  cat > .env <<EOF
NODE_ENV=development
HOST=127.0.0.1
PORT=3000
DATABASE_URL=postgres://raxo_demo:$PGPASS@127.0.0.1:55432/raxo_email_demo
DB_TEST_URL=postgres://raxo_demo:$PGPASS@127.0.0.1:55432/raxo_email_test
FORMS_CONFIG_PATH=config/forms.example.json
STORAGE_DIR=./data
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
SMTP_TLS_MODE=plain_local
SMTP_MAX_MESSAGE_BYTES=20971520
MESSAGE_ID_DOMAIN=notifications.example.test
CLAMD_HOST=127.0.0.1
CLAMD_PORT=3310
DEMO_MODE=true
IP_HASH_SECRET=test-only-secret-not-for-production-0123456789
OUTBOUND_ENABLED=true
EOF
  pnpm install --frozen-lockfile >/dev/null
  for s in $RUN_SCRIPTS; do echo "=== pnpm run $s"; pnpm run "$s"; done
'
