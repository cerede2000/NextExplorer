#!/usr/bin/env bash
#
# Assemble the archive somebody installs without Docker.
#
# What goes in is what the image runs, plus the two things a container gets for
# free: the Node runtime itself, and the official 7-Zip build with the RAR
# codec. Everything else — ffmpeg, ripgrep, pdftotext, perl, rsync — is left to
# the distribution, because each is large, each is packaged everywhere, and the
# application already works without any of them.
#
# Native modules are not cross-compiled and not cross-downloaded: this runs on
# the architecture it packages for, which is why the workflow has one job per
# architecture rather than one job with a flag.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"

NODE_VERSION="${NODE_VERSION:-24.21.0}"
SEVEN_ZIP_VERSION="${SEVEN_ZIP_VERSION:-26.03}"
# Pinned beside the Dockerfile's own pins, and for the same reason: a build
# that fetches whatever is behind a URL today is not a build anybody can repeat.
SEVEN_ZIP_SHA256_x64=dc99eff5008f1ab79bd7084c68513701547a808a89502bf4133683535ab3c695
SEVEN_ZIP_SHA256_arm64=2389ba20e4d8295e8709c20b6263b69bd1ec4972fe38a04ad7a1badbf595b996

out_dir="$root/dist-standalone"
keep_tree=no

usage() {
  cat <<'USAGE'
Usage: assemble.sh [--out DIR] [--keep-tree]

  --out DIR     where to write the archive (default: dist-standalone/)
  --keep-tree   leave the assembled directory in place beside the archive
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --out) out_dir="$2"; shift 2 ;;
    --keep-tree) keep_tree=yes; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "assemble: unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$(uname -s)" in
  Linux) ;;
  *) echo "assemble: the archive is a Linux one; this is $(uname -s)." >&2; exit 2 ;;
esac

case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo "assemble: unsupported architecture $(uname -m)." >&2; exit 2 ;;
esac

version="$(node -p "require('$root/package.json').version")"
name="nextexplorer-${version}-linux-${arch}"
stage="$out_dir/$name"

echo "==> Assembling $name"
rm -rf "$stage"
mkdir -p "$stage/app" "$stage/runtime" "$stage/bin"

# --- The application, laid out the way the image lays it out -----------------
echo "==> Frontend"
npm --prefix "$root" ci --workspace frontend
npm --prefix "$root" run -w frontend build -- --sourcemap false

echo "==> Backend production dependencies"
# Cleaned first: the frontend install above filled this same tree with build
# tools, and a workspace-filtered `npm ci` leaves what it did not ask for —
# 4.6 MB of Babel rode into the 3.8.1 archive that way, extraneous to
# everything in it.
rm -rf "$root/node_modules"
# On glibc every native module here has a published prebuild for Node 24, so
# nothing is compiled — the smoke test in CI is what proves it, by installing
# on a machine with no compiler.
#
# Without the optional ones: @tus/server offers a Redis lock it is never asked
# for here, and npm installs those by default — 9.5 MB of a client for a
# server this does not speak to. The whole backend suite passes without them.
NODE_ENV=production npm --prefix "$root" ci --omit=dev --omit=optional --workspace backend

cp -a "$root/node_modules" "$stage/app/node_modules"
cp "$root/package.json" "$stage/app/package.json"
cp -a "$root/backend/src" "$stage/app/src"
cp "$root/docker/healthcheck.js" "$stage/app/healthcheck.js"
mkdir -p "$stage/app/src/public"
cp -a "$root/frontend/dist/." "$stage/app/src/public/"

# Nothing at runtime reads a dependency's own coverage dump, and one package
# ships 11 MB of it. `@types` is the same kind of passenger: declaration files
# a type checker reads and Node never opens, 2.5 MB of them.
find "$stage/app/node_modules" -type d \( -name coverage -o -name .nyc_output \) \
  -prune -exec rm -rf {} + 2>/dev/null || true
rm -rf "$stage/app/node_modules/@types"

# --- The Node runtime, so nothing has to be installed first ------------------
echo "==> Node $NODE_VERSION"
node_archive="node-v${NODE_VERSION}-linux-${arch}.tar.xz"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
curl -fsSL -o "$work/$node_archive" "https://nodejs.org/dist/v${NODE_VERSION}/${node_archive}"
curl -fsSL -o "$work/SHASUMS256.txt" "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
(cd "$work" && grep " ${node_archive}\$" SHASUMS256.txt | sha256sum -c -)
tar -xJf "$work/$node_archive" -C "$work"
# The interpreter and its libraries; npm, npx and the documentation are not
# what this runs.
mkdir -p "$stage/runtime/bin" "$stage/runtime/include"
cp "$work/node-v${NODE_VERSION}-linux-${arch}/bin/node" "$stage/runtime/bin/node"
chmod 0755 "$stage/runtime/bin/node"
rmdir "$stage/runtime/include"

# --- 7-Zip, the one external tool a distribution cannot give us -------------
# Alpine's and Debian's p7zip builds have no RAR codec; the official static
# build does, and it is 2.5 MB.
echo "==> 7-Zip $SEVEN_ZIP_VERSION"
seven_zip_arch=$arch
eval "expected=\$SEVEN_ZIP_SHA256_${arch}"
archive_version="$(printf '%s' "$SEVEN_ZIP_VERSION" | tr -d .)"
curl -fsSL -o "$work/7z.tar.xz" \
  "https://github.com/ip7z/7zip/releases/download/${SEVEN_ZIP_VERSION}/7z${archive_version}-linux-${seven_zip_arch}.tar.xz"
echo "${expected}  $work/7z.tar.xz" | sha256sum -c -
mkdir -p "$work/7z"
tar -xJf "$work/7z.tar.xz" -C "$work/7z"
install -m 0755 "$(find "$work/7z" -type f -name 7zzs -print -quit)" "$stage/bin/7z"

# --- What installs it -------------------------------------------------------
install -m 0755 "$here/install.sh" "$stage/install.sh"
install -m 0755 "$here/upgrade.sh" "$stage/upgrade.sh"
install -m 0644 "$here/nextexplorer.service.in" "$stage/nextexplorer.service.in"
install -m 0644 "$here/config.env.example" "$stage/config.env.example"
install -m 0644 "$here/README.md" "$stage/README.md"
printf '%s\n' "$version" > "$stage/VERSION"
printf '%s\n' "$arch" > "$stage/ARCH"

# --- The archive ------------------------------------------------------------
echo "==> Archive"
tar -czf "$out_dir/$name.tar.gz" -C "$out_dir" "$name"
(cd "$out_dir" && sha256sum "$name.tar.gz" > "$name.tar.gz.sha256")
[ "$keep_tree" = yes ] || rm -rf "$stage"

echo
echo "$out_dir/$name.tar.gz"
du -h "$out_dir/$name.tar.gz" | cut -f1
