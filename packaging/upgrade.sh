#!/usr/bin/env bash
#
# Fetch the next release and install it.
#
#   sudo nextexplorer-upgrade            update if there is something newer
#   sudo nextexplorer-upgrade --check    say what there is, change nothing
#
# It downloads from the project's own releases, checks the archive against the
# checksum published beside it, and hands over to that release's own install
# script — which keeps your configuration, your database and your files.
#
# Nothing here runs on a timer. Updating a file server is a decision somebody
# makes, not something that happens to them overnight.
set -euo pipefail

REPO="${NEXTEXPLORER_REPO:-cerede2000/NextExplorer}"
PROGRAM_DIR="${NEXTEXPLORER_PROGRAM_DIR:-/opt/nextexplorer}"
BASE_URL="${NEXTEXPLORER_RELEASE_BASE:-https://github.com/$REPO/releases/download}"
API_URL="${NEXTEXPLORER_API:-https://api.github.com/repos/$REPO/releases/latest}"

check_only=no
install_args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --check) check_only=yes; shift ;;
    -h|--help)
      sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    # Anything else is for the install script that comes with the release:
    # --yes, --skip-deps, --port, and the rest.
    *) install_args+=("$1"); shift ;;
  esac
done

die() { printf '\nerror: %s\n' "$*" >&2; exit 1; }
note() { printf '  %s\n' "$*"; }

for tool in curl tar sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is needed and is not here."
done

case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) die "no release is published for $(uname -m)." ;;
esac

installed="$(cat "$PROGRAM_DIR/VERSION" 2>/dev/null || echo none)"
latest="$(curl -fsSL "$API_URL" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -1)"
[ -n "$latest" ] || die "could not read the latest release from GitHub."

printf '\n\033[1mNextExplorer\033[0m\n'
note "installed: $installed"
note "published: $latest"

if [ "$installed" = "$latest" ]; then
  note "Already on the latest release."
  exit 0
fi
if [ "$check_only" = yes ]; then
  note "Run without --check to install it."
  exit 0
fi

[ "$(id -u)" = 0 ] || die "run this as root: sudo nextexplorer-upgrade"

name="nextexplorer-${latest}-linux-${arch}.tar.gz"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

note "Downloading $name"
curl -fSL --progress-bar -o "$work/$name" "$BASE_URL/v$latest/$name"
curl -fsSL -o "$work/$name.sha256" "$BASE_URL/v$latest/$name.sha256" \
  || die "no checksum published beside the archive; stopping rather than installing something unchecked."

# The published file names the archive by its own path, so compare the digests
# themselves rather than trusting the layout of a file downloaded from a URL.
published="$(awk '{print $1; exit}' "$work/$name.sha256")"
computed="$(sha256sum "$work/$name" | awk '{print $1}')"
[ -n "$published" ] || die "the published checksum is empty."
[ "$published" = "$computed" ] \
  || die "the archive does not match its published checksum. Nothing was installed."
note "Checksum matches."

tar -xzf "$work/$name" -C "$work"
release_dir="$work/nextexplorer-${latest}-linux-${arch}"
[ -x "$release_dir/install.sh" ] || die "the archive has no install script in it."

note "Installing $latest"
# Expanded only when there is something in it: an empty array under `set -u` is
# an error on the bash some of these machines still run.
if [ ${#install_args[@]} -gt 0 ]; then
  "$release_dir/install.sh" "${install_args[@]}"
else
  "$release_dir/install.sh"
fi
