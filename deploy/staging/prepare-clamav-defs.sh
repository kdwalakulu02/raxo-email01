#!/usr/bin/env bash
# Populate $PRIVATE_DIR/clamav-defs with ClamAV signatures for the isolated staging ClamAV container
# (which runs without freshclam). Does not touch any running ClamAV service.
#
#   deploy/staging/prepare-clamav-defs.sh [PRIVATE_DIR]           download with freshclam (one-off container)
#   CLAMAV_DEFS_SRC=/path/to/defs deploy/staging/prepare-clamav-defs.sh [PRIVATE_DIR]   copy an existing set
set -euo pipefail
priv=${1:-$HOME/raxo-combo-private}
dest=$priv/clamav-defs
mkdir -p "$dest"
if [ -n "${CLAMAV_DEFS_SRC:-}" ]; then
  cp -a "$CLAMAV_DEFS_SRC"/. "$dest"/
else
  # clamav image runs as uid 100; the one-off container only writes into $dest
  chmod 777 "$dest"
  docker run --rm -v "$dest:/var/lib/clamav" --entrypoint freshclam clamav/clamav:stable --foreground --stdout
  chmod 755 "$dest"
fi
ls "$dest"
