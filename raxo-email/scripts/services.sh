#!/usr/bin/env bash
set -e

ACTION="${1:-up}"
MAILPIT_PID_FILE="${TMPDIR:-/tmp}/raxo-mailpit.pid"

if [ "$ACTION" = "up" ]; then
  # Try docker compose first if dockerd is accessible
  if docker info >/dev/null 2>&1; then
    docker compose -f compose.dev.yml up -d --wait
    echo "Services are up and healthy."
    exit 0
  fi

  echo "Docker daemon not running in this environment. Managing host services directly..."

  # PostgreSQL: only start if not already ready
  if ! pg_isready -h 127.0.0.1 -p 55432 -t 1 >/dev/null 2>&1; then
    sudo service postgresql start >/dev/null 2>&1 || true
  fi

  # ClamAV: only start if not already answering PING
  if ! node -e '
    const net = require("net");
    const client = net.createConnection({ port: 3310, host: "127.0.0.1" }, () => client.write("zPING\0"));
    client.setTimeout(1000, () => { client.destroy(); process.exit(1); });
    client.on("data", (d) => {
      if (d.toString().includes("PONG")) {
        client.end();
        process.exit(0);
      }
      process.exit(1);
    });
    client.on("error", () => process.exit(1));
  ' >/dev/null 2>&1; then
    sudo service clamav-daemon start >/dev/null 2>&1 || true
  fi

  # Mailpit: track only process this helper owns
  if [ -f "$MAILPIT_PID_FILE" ] && kill -0 "$(cat "$MAILPIT_PID_FILE")" 2>/dev/null; then
    : # already running with tracked PID
  elif ! pgrep -f "mailpit" >/dev/null 2>&1; then
    nohup mailpit --smtp 127.0.0.1:1025 --listen 127.0.0.1:8025 > /tmp/mailpit.log 2>&1 &
    echo $! > "$MAILPIT_PID_FILE"
  fi

  # Wait for postgres
  echo "Waiting for PostgreSQL at 127.0.0.1:55432..."
  PG_READY=0
  for i in $(seq 1 30); do
    if pg_isready -h 127.0.0.1 -p 55432 -t 2 >/dev/null 2>&1; then
      PG_READY=1
      break
    fi
    sleep 1
  done
  if [ "$PG_READY" -ne 1 ]; then
    echo "Error: Timed out waiting for PostgreSQL dependency at 127.0.0.1:55432" >&2
    exit 1
  fi

  # Wait for Mailpit
  echo "Waiting for Mailpit at 127.0.0.1:8025..."
  MAILPIT_READY=0
  for i in $(seq 1 30); do
    if curl -s -f --max-time 2 http://127.0.0.1:8025/api/v1/info >/dev/null 2>&1; then
      MAILPIT_READY=1
      break
    fi
    sleep 1
  done
  if [ "$MAILPIT_READY" -ne 1 ]; then
    echo "Error: Timed out waiting for Mailpit dependency at 127.0.0.1:8025" >&2
    exit 1
  fi

  # Wait for ClamAV
  echo "Waiting for ClamAV at 127.0.0.1:3310..."
  CLAMAV_READY=0
  for i in $(seq 1 36); do
    if node -e '
      const net = require("net");
      const client = net.createConnection({ port: 3310, host: "127.0.0.1" }, () => client.write("zPING\0"));
      client.setTimeout(2000, () => { client.destroy(); process.exit(1); });
      client.on("data", (d) => {
        if (d.toString().includes("PONG")) {
          client.end();
          process.exit(0);
        }
        process.exit(1);
      });
      client.on("error", () => process.exit(1));
    ' >/dev/null 2>&1; then
      CLAMAV_READY=1
      break
    fi
    sleep 2
  done
  if [ "$CLAMAV_READY" -ne 1 ]; then
    echo "Error: Timed out waiting for ClamAV dependency at 127.0.0.1:3310" >&2
    exit 1
  fi

  echo "Services are up and healthy."

elif [ "$ACTION" = "down" ]; then
  if docker info >/dev/null 2>&1; then
    docker compose -f compose.dev.yml down
    exit 0
  fi

  if [ -f "$MAILPIT_PID_FILE" ]; then
    PID=$(cat "$MAILPIT_PID_FILE")
    kill "$PID" 2>/dev/null || true
    rm -f "$MAILPIT_PID_FILE"
  fi
  echo "Services stopped (NEVER -v)."
else
  echo "Usage: $0 [up|down]"
  exit 1
fi
