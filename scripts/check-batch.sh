#!/usr/bin/env bash
#
# Verify a batch branch the way the maintainer will: on top of upstream/main,
# with upstream's lockfile, by actually building and booting it.
#
# Five broken imports reached upstream main because every batch was checked in
# our tree instead. Our tree has our other batches in it, so a consumer whose
# provider we forgot to include still resolves — and looks fine right up to the
# moment someone clones main.
#
# Usage:  scripts/check-batch.sh <branch>          (default: current branch)
#
set -euo pipefail

BRANCH="${1:-$(git rev-parse --abbrev-ref HEAD)}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> upstream/main + $BRANCH, dans un arbre neuf"
git -C "$REPO_ROOT" fetch origin --quiet
git -C "$REPO_ROOT" worktree add --quiet --detach "$WORK/tree" origin/main
git -C "$WORK/tree" -c user.email=check@local -c user.name=check \
    merge --quiet --no-edit "$BRANCH" \
  || { echo "ECHEC: $BRANCH n'applique pas proprement sur origin/main"; exit 1; }

cd "$WORK/tree"
echo "==> npm ci (lockfile d'upstream)"
npm ci --no-audit --no-fund >/dev/null

echo "==> le frontend doit se bundler"
npm run build >/dev/null

echo "==> le backend doit charger tous ses modules"
mkdir -p "$WORK/config" "$WORK/cache" "$WORK/files"
CONFIG_DIR="$WORK/config" CACHE_DIR="$WORK/cache" VOLUME_ROOT="$WORK/files" \
  node -e "
    require('./backend/src/app.js');
    // Le differe compte aussi: migrations, store de session, taches de fond.
    setTimeout(() => process.exit(0), 5000);
  "

cd "$REPO_ROOT"
git worktree remove --force "$WORK/tree"
echo
echo "OK: $BRANCH construit et demarre sur origin/main."
