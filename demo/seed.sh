#!/bin/bash
set -euo pipefail

# Put the demo folders back, then hand over to the real entrypoint.
#
# The demo runs without a persistent disk: every restart starts from an empty
# volume, and this fills it again. That is the reset — nothing to schedule, and
# nothing a visitor can leave behind.
#
# The image also supports DEMO_MODE, which downloads a sample archive at boot.
# It is not used here: on a free plan the service sleeps, and 80 MB fetched on
# every wake is most of the delay a first visitor would feel. Set DEMO_MODE=true
# if you would rather have the photos and videos than the fast start.

VOLUME_ROOT="${VOLUME_ROOT:-/mnt}"
DEMO_CONTENT="${DEMO_CONTENT:-/demo-content}"

if [ -d "$DEMO_CONTENT" ]; then
  echo "INFO: seeding demo content into ${VOLUME_ROOT}"
  mkdir -p "$VOLUME_ROOT"
  # -n: never overwrite. A restart reseeds an empty volume; it does not fight
  # with anything already there.
  cp -rn "$DEMO_CONTENT/." "$VOLUME_ROOT/" 2>/dev/null || true
fi

exec entrypoint.sh "$@"
