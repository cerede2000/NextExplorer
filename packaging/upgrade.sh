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

# The flavour that is installed is the flavour that gets installed.
#
# Somebody who took the minimal archive did so to be rid of the bundled
# runtime; handing them the full one at the next update would put 121 MB back
# without asking, and silently change which Node the service runs. The tree
# says which it is: the minimal archive has no runtime directory.
flavour=""
if [ -d "$PROGRAM_DIR/app" ] && [ ! -x "$PROGRAM_DIR/runtime/bin/node" ]; then
  flavour="-minimal"
fi
# GitHub allows an unauthenticated address sixty calls an hour and answers 403
# after that — which is a machine behind a shared address, a workplace or a CI
# runner, being told the release feed does not exist. A token, when there is one,
# raises that to five thousand; without one nothing changes.
api_auth=()
api_token="${NEXTEXPLORER_API_TOKEN:-${GITHUB_TOKEN:-${GH_TOKEN:-}}}"
[ -n "$api_token" ] && api_auth=(-H "Authorization: Bearer $api_token")

feed=""
for attempt in 1 2 3; do
  feed="$(curl -fsSL "${api_auth[@]+"${api_auth[@]}"}" "$API_URL" 2>/dev/null || true)"
  [ -n "$feed" ] && break
  # Short on purpose. A rate limit will not clear in three seconds; what this is
  # for is a name that did not resolve or a connection dropped on the way out,
  # and waiting longer than that only makes a real refusal slow to report.
  [ "$attempt" = 3 ] || sleep "$attempt"
done
[ -n "$feed" ] || die "could not read the release feed at $API_URL. If this machine shares its address with others, GitHub may be rate-limiting it: set NEXTEXPLORER_API_TOKEN to a token, or NEXTEXPLORER_API to a feed it can read."

latest="$(printf '%s' "$feed" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -1)"
[ -n "$latest" ] || die "the release feed at $API_URL named no release."

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

name="nextexplorer-${latest}-linux-${arch}${flavour}.tar.gz"
[ -n "$flavour" ] && note "Keeping the minimal archive, as installed."
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
release_dir="$work/nextexplorer-${latest}-linux-${arch}${flavour}"
[ -x "$release_dir/install.sh" ] || die "the archive has no install script in it."

note "Installing $latest"
# Expanded only when there is something in it: an empty array under `set -u` is
# an error on the bash some of these machines still run.
if [ ${#install_args[@]} -gt 0 ]; then
  "$release_dir/install.sh" "${install_args[@]}"
else
  "$release_dir/install.sh"
fi
