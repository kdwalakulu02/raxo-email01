#!/usr/bin/env bash
# Obtain the pinned RaxoSentinel executable and private database and lay them out for the staging stack.
#
#   deploy/sentinel/fetch-sentinel.sh [PRIVATE_DIR]          (default: $HOME/raxo-combo-private)
#
# Source of the archives (first match wins):
#   SENTINEL_LOCAL_REPO=/path/to/raxosentinel   an existing checkout (must contain SENTINEL_ARTIFACT_COMMIT)
#   SENTINEL_GIT_TOKEN or SENTINEL_GIT_TOKEN_FILE   GitHub token with read access to the private repo
# Every archive is verified against the SHA-256 values pinned in PINNED.env before extraction.
# The database holds third-party intelligence with unverified redistribution rights: it is never committed here.
set -euo pipefail
umask 077
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
. "$here/PINNED.env"
priv=${1:-$HOME/raxo-combo-private}
owner=${SENTINEL_UID:-1000}   # uid the containers run as
[ "$(uname -m)" = x86_64 ] || { echo 'Requires Linux x86_64' >&2; exit 1; }

work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
src=""
if [ -n "${SENTINEL_LOCAL_REPO:-}" ]; then
  git -C "$SENTINEL_LOCAL_REPO" cat-file -e "$SENTINEL_ARTIFACT_COMMIT^{commit}" ||
    { echo "Pinned commit $SENTINEL_ARTIFACT_COMMIT not found in $SENTINEL_LOCAL_REPO" >&2; exit 1; }
  git -C "$SENTINEL_LOCAL_REPO" archive "$SENTINEL_ARTIFACT_COMMIT" deploy | tar -x -C "$work"
  src=$work/deploy
else
  tok=${SENTINEL_GIT_TOKEN:-}
  [ -z "$tok" ] && [ -n "${SENTINEL_GIT_TOKEN_FILE:-}" ] && tok=$(tr -d ' \r\n' < "$SENTINEL_GIT_TOKEN_FILE")
  [ -n "$tok" ] || { echo 'Set SENTINEL_LOCAL_REPO, SENTINEL_GIT_TOKEN or SENTINEL_GIT_TOKEN_FILE' >&2; exit 1; }
  auth=$(printf 'x-access-token:%s' "$tok" | base64 -w0)
  g() { git -c "http.extraheader=Authorization: Basic $auth" "$@"; }
  git init -q "$work/repo"
  g -C "$work/repo" fetch -q --depth 1 "$SENTINEL_REPO_URL" "$SENTINEL_ARTIFACT_COMMIT"
  git -C "$work/repo" checkout -q FETCH_HEAD -- deploy
  [ "$(git -C "$work/repo" rev-parse FETCH_HEAD)" = "$SENTINEL_ARTIFACT_COMMIT" ]
  src=$work/repo/deploy
fi

verify() { echo "$2  $1" | sha256sum -c --quiet - || { echo "SHA-256 mismatch: $1" >&2; exit 1; }; }
verify "$src/${SENTINEL_BINARY_ARCHIVE#deploy/}" "$SENTINEL_BINARY_ARCHIVE_SHA256"
verify "$src/${SENTINEL_DB_ARCHIVE#deploy/}" "$SENTINEL_DB_ARCHIVE_SHA256"

if [ -e "$priv/bin/bin/raxosentinel" ] || [ -e "$priv/rsidb/current" ]; then
  echo "Refusing to overwrite existing artifacts in $priv (remove bin/ and rsidb/ first)" >&2; exit 1
fi
install -d -m 700 "$priv" "$priv/bin" "$priv/rsidb" "$priv/run" "$priv/clamav-defs"
tar -xzf "$src/${SENTINEL_BINARY_ARCHIVE#deploy/}" -C "$priv/bin"
tar -xzf "$src/${SENTINEL_DB_ARCHIVE#deploy/}" -C "$priv/rsidb"
verify "$priv/bin/bin/raxosentinel" "$SENTINEL_BINARY_SHA256"
verify "$priv/rsidb/$SENTINEL_DB_GENERATION/database.rsidb" "$SENTINEL_DB_FILE_SHA256"
chmod -R go-w "$priv/bin"; chmod 755 "$priv/bin" "$priv/bin/bin"
if [ "$(id -u)" = 0 ]; then chown -R "$owner:$owner" "$priv/bin" "$priv/rsidb" "$priv/run"; fi
echo "RaxoSentinel $SENTINEL_SOURCE_COMMIT / DB $SENTINEL_DB_GENERATION installed under $priv"
echo "Set PRIVATE_DIR=$priv in deploy/staging/.env.staging. ClamAV signatures: deploy/staging/prepare-clamav-defs.sh"
