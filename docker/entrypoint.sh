#!/bin/bash
set -e

# Provide sensible defaults to avoid surprises on first run.
PUID=${PUID:-1000}
PGID=${PGID:-1000}

CONFIG_DIR=${CONFIG_DIR:-/config}
CACHE_DIR=${CACHE_DIR:-/cache}

ensure_dir() {
  mkdir -p "$1"
}

# Ensure the base appuser exists before attempting modifications.
if ! id appuser >/dev/null 2>&1; then
  echo "ERROR: Expected user 'appuser' to be present in the image."
  exit 1
fi

CURRENT_UID=$(id -u appuser)
CURRENT_GID=$(id -g appuser)

# Update user/group IDs only when they differ from the requested values.
if [ "$CURRENT_UID" != "$PUID" ] || [ "$CURRENT_GID" != "$PGID" ]; then
  echo "INFO: Updating appuser UID:GID from ${CURRENT_UID}:${CURRENT_GID} to ${PUID}:${PGID}"
  groupmod -o -g "$PGID" appuser
  usermod -o -u "$PUID" appuser
fi

# Guarantee every host-facing directory exists before touching it.
ensure_dir "/app"
ensure_dir "$CONFIG_DIR"
ensure_dir "$CACHE_DIR"
ensure_dir "${CACHE_DIR}/thumbnails"
ensure_dir "${CONFIG_DIR}/extensions"
ensure_dir "${CONFIG_DIR}/extensions/icons"
ensure_dir "${CONFIG_DIR}/extensions/brand"

# Fix ownership on key directories that map to host volumes.
for path in "$CONFIG_DIR" "$CACHE_DIR"; do
  if [ -e "$path" ]; then
    chown -R appuser:appuser "$path"
  fi
done

is_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

DEMO_MODE="${DEMO_MODE:-false}"
# Demo mode also pre-fills the sign-in form, which a demo may want without
# paying for the sample archive on every boot: it is 80 MB, and where storage is
# not persistent that download happens at every restart. Defaults to on, so
# existing demos are unaffected.
DEMO_SAMPLES="${DEMO_SAMPLES:-true}"
SAMPLE_URL="${SAMPLE_URL:-https://github.com/vikramsoni2/nextExplorer/releases/download/v2.0.0/samples.zip}"
SAMPLES_DIR="${SAMPLES_DIR:-/mnt/Samples}"


if is_true "$DEMO_MODE" && is_true "$DEMO_SAMPLES"; then
  echo "INFO: DEMO_MODE enabled; seeding demo samples into ${SAMPLES_DIR} (read-only)"
  mkdir -p "$SAMPLES_DIR"

  if ! SAMPLE_URL="$SAMPLE_URL" SAMPLES_DIR="$SAMPLES_DIR" node /app/src/scripts/downloadSamples.js; then
    echo "WARN: DEMO_MODE sample download failed; continuing without seeded samples"
  fi
  
fi

echo "INFO: Launching process as appuser (${PUID}:${PGID})"
exec gosu appuser "$@"
