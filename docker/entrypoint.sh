#!/bin/bash
set -e

# Provide sensible defaults to avoid surprises on first run. Whether they were
# asked for is kept, so the message below can tell somebody their setting is
# being ignored without saying it to everybody who never wrote one.
PUID_REQUESTED=${PUID:+yes}
PGID_REQUESTED=${PGID:+yes}
PUID=${PUID:-1000}
PGID=${PGID:-1000}

CONFIG_DIR=${CONFIG_DIR:-/config}
CACHE_DIR=${CACHE_DIR:-/cache}

ensure_dir() {
  mkdir -p "$1"
}

# Who this script is running as, which decides everything below.
#
# Started as root — the default, and what Compose's `user: root` also gives —
# the entrypoint renumbers appuser to PUID:PGID, takes ownership of the
# directories that map to host volumes, and drops to it.
#
# Started as anyone else (`docker run --user`, Compose `user: 1000:1000`, a
# Kubernetes securityContext with runAsNonRoot) none of that is possible:
# groupmod, usermod and chown all need root, and with `set -e` the first one
# would take the container with it before the server ever started. It is not
# needed either — the process is already the user it was asked to be. So the
# id juggling is skipped and the application runs as whoever started it.
STARTED_AS_UID=$(id -u)
STARTED_AS_GID=$(id -g)
RUNNING_AS_ROOT=false
[ "$STARTED_AS_UID" = "0" ] && RUNNING_AS_ROOT=true

if [ "$RUNNING_AS_ROOT" = "true" ]; then
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
elif [ -n "$PUID_REQUESTED" ] || [ -n "$PGID_REQUESTED" ]; then
  echo "INFO: PUID/PGID (${PUID}:${PGID}) ignored: the container was started as ${STARTED_AS_UID}:${STARTED_AS_GID}, which is already what the process runs as."
fi

# Guarantee every host-facing directory exists before touching it.
#
# Advisory when we are not root: a mount whose permissions do not allow it is
# the deployment's business, and the application says so far better than a
# shell abort with no message does.
for path in \
  "/app" \
  "$CONFIG_DIR" \
  "$CACHE_DIR" \
  "${CACHE_DIR}/thumbnails" \
  "${CONFIG_DIR}/extensions" \
  "${CONFIG_DIR}/extensions/icons" \
  "${CONFIG_DIR}/extensions/brand"; do
  if [ "$RUNNING_AS_ROOT" = "true" ]; then
    ensure_dir "$path"
  elif ! ensure_dir "$path" 2>/dev/null; then
    echo "WARN: could not create ${path} as ${STARTED_AS_UID}:${STARTED_AS_GID}; the mount must already provide it"
  fi
done

# Fix ownership on key directories that map to host volumes. Only root can, and
# only root needs to: started as a fixed user, the deployment has already
# decided who owns these — a Kubernetes fsGroup does under a cluster what
# PUID/PGID do under Docker.
if [ "$RUNNING_AS_ROOT" = "true" ]; then
  for path in "$CONFIG_DIR" "$CACHE_DIR"; do
    if [ -e "$path" ]; then
      chown -R appuser:appuser "$path"
    fi
  done
fi

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
  if ! mkdir -p "$SAMPLES_DIR" 2>/dev/null; then
    echo "WARN: could not create ${SAMPLES_DIR}; continuing without seeded samples"
  fi

  if ! SAMPLE_URL="$SAMPLE_URL" SAMPLES_DIR="$SAMPLES_DIR" node /app/src/scripts/downloadSamples.js; then
    echo "WARN: DEMO_MODE sample download failed; continuing without seeded samples"
  fi
  
fi

if [ "$RUNNING_AS_ROOT" = "true" ]; then
  echo "INFO: Launching process as appuser (${PUID}:${PGID})"
  exec gosu appuser "$@"
fi

echo "INFO: Launching process as ${STARTED_AS_UID}:${STARTED_AS_GID}, the user the container was started as"
exec "$@"
