#!/usr/bin/env bash
#
# Install or update NextExplorer without Docker.
#
# Run it as many times as you like: it installs on the first run and updates on
# every one after that, and it never touches what it did not put there. Your
# configuration file, your database and your files are read, never rewritten.
#
#   sudo ./install.sh
#
# What it does, in order: works out what is missing and offers to install it,
# makes a system account, puts the program under /opt, writes a configuration
# file if there is not one already, and hands the service to systemd.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- What the operator can choose -------------------------------------------
prefix=""
service_user="nextexplorer"
service_group=""
port=""
volumes_dir=""
assume_yes=no
with_deps=yes
with_service=yes
with_account=yes
action=install

node_given=""

usage() {
  cat <<'USAGE'
Usage: install.sh [options]

  --prefix DIR      install under DIR instead of / (for packaging and tests)
  --user NAME       system account to run as (default: nextexplorer)
  --group NAME      its group (default: the same name as the user)
  --port N          port to listen on, first install only (default: 3000)
  --volumes DIR     where the volumes live, first install only
                    (default: /srv/nextexplorer)
  --node PATH       the Node to run it with, for the archive that brings
                    none. Worth naming: run under sudo, root's PATH is not
                    yours, and a Node installed for your account is invisible
  --yes             answer yes to installing missing tools
  --skip-deps       do not touch the package manager
  --no-service      install the files, leave systemd alone
  --no-account      do not create the system account
  --uninstall       remove the service and the program, keep every file it holds
  -h, --help        this

Everything above is remembered in /etc/nextexplorer/nextexplorer.env after the
first run. Later runs update the program and leave that file exactly as it is.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) prefix="${2%/}"; shift 2 ;;
    --user) service_user="$2"; shift 2 ;;
    --group) service_group="$2"; shift 2 ;;
    --port) port="$2"; shift 2 ;;
    --volumes) volumes_dir="${2%/}"; shift 2 ;;
    --node) node_given="$2"; shift 2 ;;
    --yes|-y) assume_yes=yes; shift ;;
    --skip-deps) with_deps=no; shift ;;
    --no-service) with_service=no; shift ;;
    --no-account) with_account=no; shift ;;
    --uninstall) action=uninstall; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install: unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ -n "$service_group" ] || service_group="$service_user"

# --- Where everything goes --------------------------------------------------
PROGRAM_DIR="$prefix/opt/nextexplorer"
ETC_DIR="$prefix/etc/nextexplorer"
ENV_FILE="$ETC_DIR/nextexplorer.env"
STATE_DIR="$prefix/var/lib/nextexplorer"
CACHE_DIR="$prefix/var/cache/nextexplorer"
UNIT_FILE="$prefix/etc/systemd/system/nextexplorer.service"
UPGRADE_BIN="$prefix/usr/local/bin/nextexplorer-upgrade"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
die() { printf '\nerror: %s\n' "$*" >&2; exit 1; }

# Asking is only possible when somebody is there to answer.
confirm() {
  [ "$assume_yes" = yes ] && return 0
  [ -t 0 ] || return 1
  printf '  %s [y/N] ' "$1"
  local reply=""
  read -r reply || return 1
  case "$reply" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

# --- Removing it, if that is what was asked ---------------------------------
if [ "$action" = uninstall ]; then
  say "Removing NextExplorer"
  if [ -z "$prefix" ] && [ "$with_service" = yes ] && command -v systemctl >/dev/null 2>&1; then
    systemctl disable --now nextexplorer.service 2>/dev/null || true
  fi
  rm -f "$UNIT_FILE" "$UPGRADE_BIN"
  rm -rf "$PROGRAM_DIR"
  if [ -z "$prefix" ] && [ "$with_service" = yes ] && command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload || true
  fi
  note "Program removed."
  note "Kept, because they are yours: $ETC_DIR, $STATE_DIR, $CACHE_DIR, and every volume."
  exit 0
fi

# --- Can this machine run what is in the archive? ---------------------------
[ -d "$SELF_DIR/app/src" ] || die "$SELF_DIR does not look like an unpacked release: app/src is missing."

version="$(cat "$SELF_DIR/VERSION" 2>/dev/null || echo unknown)"
packaged_arch="$(cat "$SELF_DIR/ARCH" 2>/dev/null || echo unknown)"
case "$(uname -m)" in
  x86_64) machine_arch=x64 ;;
  aarch64|arm64) machine_arch=arm64 ;;
  *) machine_arch="$(uname -m)" ;;
esac
[ "$packaged_arch" = "$machine_arch" ] \
  || die "this archive is for linux-$packaged_arch and the machine is $machine_arch. Take the other one."

# --- Which Node runs it -----------------------------------------------------
#
# The full archive brings one; the minimal archive does not, and then this
# machine's own has to do. Either way the answer is settled here and written
# into the unit, so nothing is decided again at start-up.
#
# The major matters and nothing else does: two of the three native modules in
# this tree are prebuilt per ABI, and a major none of them has a prebuild for
# refuses them with NODE_MODULE_VERSION a few seconds after the service
# starts, which is the failure nobody reads. Better to say so here.
#
# A list and not a single number, because it is not one ABI any more. The
# image processor is N-API and takes any major; the SQLite driver publishes
# 137, 141 and 147; the terminal publishes the same three since 0.14. What is
# left is the majors all three agree on, minus the ones that are no longer
# supported upstream — 25 reached end of life on 31 March 2026.
#
# The archive's own runtime is 24, the release line under long-term support.
# This list is what an archive that brings none will accept from the machine.
NODE_MAJORS_SUPPORTED="24 26"

supported_node_major() {
  case " $NODE_MAJORS_SUPPORTED " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

# "24 or 26", for a sentence rather than for a test.
node_majors_phrase="$(printf '%s' "$NODE_MAJORS_SUPPORTED" | sed 's/ / or /g')"

if [ -x "$SELF_DIR/runtime/bin/node" ]; then
  if ! "$SELF_DIR/runtime/bin/node" -e 'process.exit(0)' >/dev/null 2>&1; then
    die "the bundled Node runtime will not run here. It is linked against glibc, so on Alpine or another musl system use the Docker image instead."
  fi
  node_for_unit="@PROGRAM_DIR@/runtime/bin/node"
  node_note="the one in the archive"
else
  if [ -n "$node_given" ]; then
    system_node="$node_given"
    [ -x "$system_node" ] || die "--node $system_node is not something this can run."
  else
    system_node="$(command -v node 2>/dev/null || true)"
  fi
  [ -n "$system_node" ] \
    || die "this archive brings no Node runtime and there is none on PATH. Install Node ${node_majors_phrase} and name it with --node, or take the archive without -minimal in its name."
  node_major="$("$system_node" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo unknown)"
  supported_node_major "$node_major" \
    || die "this tree's native modules have prebuilds for Node ${node_majors_phrase}, and $system_node is $node_major. Install one of those, or take the archive without -minimal in its name."
  node_for_unit="$system_node"
  node_note="$system_node"
fi

if [ "$prefix" = "" ] && [ "$(id -u)" != 0 ]; then
  die "run this as root: sudo ./install.sh"
fi

upgrading=no
[ -e "$ENV_FILE" ] && upgrading=yes

say "NextExplorer $version, linux-$machine_arch — Node: $node_note"
[ "$upgrading" = yes ] && note "Updating an existing installation." || note "First installation."

# --- The tools the distribution provides ------------------------------------
# Each is optional: the application asks whether it is there and does without
# it. What is lost by doing without is printed rather than implied.
DEP_BINARIES=(ffprobe rg pdftotext perl rsync)
DEP_REASONS=(
  "video thumbnails, stills from HEIC photos, and media durations"
  "searching inside files quickly"
  "reading text out of PDFs for the search index"
  "reading the metadata of RAW photos"
  "copying and moving large folders with progress"
)
DEP_APT=(ffmpeg ripgrep poppler-utils perl rsync)
DEP_DNF=(ffmpeg-free ripgrep poppler-utils perl-interpreter rsync)
DEP_PACMAN=(ffmpeg ripgrep poppler perl rsync)
DEP_ZYPPER=(ffmpeg ripgrep poppler-tools perl rsync)

package_manager() {
  for candidate in apt-get dnf pacman zypper; do
    command -v "$candidate" >/dev/null 2>&1 && { echo "$candidate"; return; }
  done
  echo none
}

package_for() {
  local index="$1"
  case "$(package_manager)" in
    apt-get) echo "${DEP_APT[$index]}" ;;
    dnf) echo "${DEP_DNF[$index]}" ;;
    pacman) echo "${DEP_PACMAN[$index]}" ;;
    zypper) echo "${DEP_ZYPPER[$index]}" ;;
    *) echo "" ;;
  esac
}

install_one_package() {
  local package="$1"
  case "$(package_manager)" in
    apt-get) DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$package" ;;
    dnf) dnf install -y "$package" ;;
    pacman) pacman -S --noconfirm --needed "$package" ;;
    zypper) zypper --non-interactive install -y "$package" ;;
    *) return 1 ;;
  esac
}

missing_indexes=()
for index in "${!DEP_BINARIES[@]}"; do
  command -v "${DEP_BINARIES[$index]}" >/dev/null 2>&1 || missing_indexes+=("$index")
done

say "Tools"
if [ ${#missing_indexes[@]} -eq 0 ]; then
  note "Everything optional is already here."
else
  for index in "${missing_indexes[@]}"; do
    note "${DEP_BINARIES[$index]} is missing — without it: ${DEP_REASONS[$index]}."
  done

  manager="$(package_manager)"
  if [ "$with_deps" != yes ]; then
    note "Left alone, as asked. Install them yourself and run this again to have them picked up."
  elif [ "$manager" = none ]; then
    warn "No apt, dnf, pacman or zypper here, so nothing can be installed for you."
    note "Install the tools above and run this again."
  else
    packages=()
    for index in "${missing_indexes[@]}"; do packages+=("$(package_for "$index")"); done
    note "This would run: $manager install ${packages[*]}"
    if confirm "Install them now?"; then
      [ "$manager" = apt-get ] && { DEBIAN_FRONTEND=noninteractive apt-get update -qq || warn "apt-get update failed; trying anyway."; }
      # One at a time: a name this distribution does not carry then costs its
      # own line rather than the whole set.
      for package in "${packages[@]}"; do
        if install_one_package "$package" >/dev/null 2>&1; then
          note "installed $package"
        else
          warn "could not install $package"
        fi
      done
      # ffmpeg has two names in the RPM world, and only one of them is in
      # Fedora's own repositories.
      if ! command -v ffprobe >/dev/null 2>&1 && [ "$manager" = dnf ]; then
        install_one_package ffmpeg >/dev/null 2>&1 && note "installed ffmpeg" || true
      fi
      still_missing=()
      for index in "${!DEP_BINARIES[@]}"; do
        command -v "${DEP_BINARIES[$index]}" >/dev/null 2>&1 || still_missing+=("${DEP_BINARIES[$index]}")
      done
      if [ ${#still_missing[@]} -eq 0 ]; then
        note "All present now."
      else
        warn "Still missing: ${still_missing[*]}. The application runs without them."
      fi
    else
      note "Skipped. The application runs without them, and picks them up whenever you install them."
    fi
  fi
fi
note "7-Zip comes with this archive, so archives open whatever the distribution ships."

# --- The account it runs as -------------------------------------------------
say "Account"
if [ "$with_account" != yes ]; then
  note "Left alone, as asked."
elif id -u "$service_user" >/dev/null 2>&1; then
  note "$service_user already exists."
else
  if command -v useradd >/dev/null 2>&1; then
    getent group "$service_group" >/dev/null 2>&1 || groupadd --system "$service_group"
    useradd --system --gid "$service_group" --home-dir "$STATE_DIR" \
      --shell /usr/sbin/nologin --comment "NextExplorer" "$service_user"
    note "Created $service_user:$service_group."
  else
    warn "No useradd here; create $service_user yourself and run this again."
  fi
fi

# --- The program ------------------------------------------------------------
say "Program"
service_is_running=no
if [ "$with_service" = yes ] && command -v systemctl >/dev/null 2>&1; then
  systemctl is-active --quiet nextexplorer.service && service_is_running=yes
fi
[ "$service_is_running" = yes ] && { note "Stopping the service for the swap."; systemctl stop nextexplorer.service; }

mkdir -p "$PROGRAM_DIR"
# Replaced wholesale rather than merged, so a file that left the release stops
# being installed. Only ever this directory, which nothing but this script
# writes.
for part in app runtime bin; do
  rm -rf "$PROGRAM_DIR/$part"
  # The minimal archive has no runtime and no 7-Zip. Removing what is not
  # there is still right — an update from a full release to a minimal one must
  # not leave the old runtime behind, answering for a version nobody installed.
  [ -e "$SELF_DIR/$part" ] || continue
  cp -a "$SELF_DIR/$part" "$PROGRAM_DIR/$part"
done
install -m 0755 "$SELF_DIR/install.sh" "$PROGRAM_DIR/install.sh"
install -m 0644 "$SELF_DIR/VERSION" "$PROGRAM_DIR/VERSION"
install -m 0644 "$SELF_DIR/ARCH" "$PROGRAM_DIR/ARCH"
# The source tree has to be readable by the account that runs it, whatever
# umask the archive was unpacked under.
chmod -R a+rX "$PROGRAM_DIR/app/src"
note "$PROGRAM_DIR — version $version"

mkdir -p "$(dirname "$UPGRADE_BIN")"
install -m 0755 "$SELF_DIR/upgrade.sh" "$UPGRADE_BIN"
note "$UPGRADE_BIN — fetches and installs the next release"

# --- The directories that hold your things ----------------------------------
say "Directories"
mkdir -p "$ETC_DIR" "$STATE_DIR" "$CACHE_DIR"
if id -u "$service_user" >/dev/null 2>&1 && [ "$(id -u)" = 0 ]; then
  chown "$service_user:$service_group" "$STATE_DIR" "$CACHE_DIR"
fi
note "$STATE_DIR — the database, the secrets, what cannot be made again"
note "$CACHE_DIR — thumbnails and the search index, all of it disposable"

# --- The configuration, written once and then left alone --------------------
say "Configuration"
if [ -e "$ENV_FILE" ]; then
  note "$ENV_FILE is yours and was not touched."
else
  effective_port="${port:-3000}"
  effective_volumes="${volumes_dir:-$prefix/srv/nextexplorer}"
  mkdir -p "$effective_volumes"
  if id -u "$service_user" >/dev/null 2>&1 && [ "$(id -u)" = 0 ]; then
    chown "$service_user:$service_group" "$effective_volumes"
  fi
  sed \
    -e "s|@PORT@|$effective_port|g" \
    -e "s|@VOLUME_ROOT@|${effective_volumes#$prefix}|g" \
    -e "s|@CONFIG_DIR@|${STATE_DIR#$prefix}|g" \
    -e "s|@CACHE_DIR@|${CACHE_DIR#$prefix}|g" \
    "$SELF_DIR/config.env.example" > "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
  if id -u "$service_user" >/dev/null 2>&1 && [ "$(id -u)" = 0 ]; then
    chown "root:$service_group" "$ENV_FILE"
  fi
  note "$ENV_FILE written. Every later run leaves it alone."
  note "Volumes live in ${effective_volumes#$prefix} — each folder in there is a volume, the way a drive is one in a file manager."
fi

# Read back what is in force, so the unit and the closing summary describe the
# installation rather than this run's arguments.
env_value() { sed -n "s/^[[:space:]]*$1=//p" "$ENV_FILE" | tail -1 | tr -d '"'; }
live_port="$(env_value PORT)"; live_port="${live_port:-3000}"
live_volumes="$(env_value VOLUME_ROOT)"; live_volumes="${live_volumes:-/srv/nextexplorer}"

# --- systemd ----------------------------------------------------------------
say "Service"
if [ "$with_service" != yes ]; then
  note "Left alone, as asked."
else
  mkdir -p "$(dirname "$UNIT_FILE")"
  sed \
    -e "s|@USER@|$service_user|g" \
    -e "s|@GROUP@|$service_group|g" \
    -e "s|@NODE@|${node_for_unit}|g" \
    -e "s|@PROGRAM_DIR@|${PROGRAM_DIR#$prefix}|g" \
    -e "s|@ENV_FILE@|${ENV_FILE#$prefix}|g" \
    -e "s|@STATE_DIR@|${STATE_DIR#$prefix}|g" \
    -e "s|@CACHE_DIR@|${CACHE_DIR#$prefix}|g" \
    -e "s|@VOLUME_ROOT@|$live_volumes|g" \
    "$SELF_DIR/nextexplorer.service.in" > "$UNIT_FILE"
  chmod 0644 "$UNIT_FILE"
  note "$UNIT_FILE"

  if [ -n "$prefix" ]; then
    # A staged install: the unit is under the prefix, where this machine's
    # systemd cannot see it. Reloading it here would reload somebody else's
    # configuration and start nothing.
    note "Staged under a prefix, so systemd was not asked to do anything."
  elif command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload
    systemctl enable nextexplorer.service >/dev/null 2>&1 || warn "could not enable the service at boot"
    systemctl restart nextexplorer.service
    note "Started, and it comes back after a reboot."
  else
    warn "No systemctl here. The unit is written; start it however this machine starts things."
  fi
fi

say "Done"
if [ "$upgrading" = yes ]; then
  note "Updated to $version. Your configuration, database and files were left as they were."
else
  note "Open http://$(hostname -f 2>/dev/null || hostname):$live_port and make the first account."
fi
note "Configuration: $ENV_FILE  (systemctl restart nextexplorer after a change)"
note "Logs:          journalctl -u nextexplorer -f"
note "Next release:  sudo nextexplorer-upgrade"
