#!/usr/bin/env bash
# Updates a from-source Seerr/Jellyseerr install (for example a Proxmox LXC)
# to the newest commit of its branch that passed Fork CI on GitHub.
#
# Before updating it backs up the database and settings. If the build fails
# or the new version doesn't start, it puts the old version and the backup
# back.
#
# Usage: seerr-update [--check] [--force]
#   --check  only say whether an update is available
#   --force  rebuild even when up to date, and skip the CI check
#
# Settings are read from /etc/default/seerr-update (see seerr-update.conf).
set -Eeuo pipefail

APP_DIR="${APP_DIR:-}"
SERVICE="${SERVICE:-}"
REMOTE="${REMOTE:-}"
BRANCH="${BRANCH:-}"
REQUIRE_CI="${REQUIRE_CI:-true}"
CI_WORKFLOW="${CI_WORKFLOW:-fork-ci.yml}"
PORT="${PORT:-}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/seerr}"
KEEP_BACKUPS="${KEEP_BACKUPS:-5}"
LOG_FILE="${LOG_FILE:-/var/log/seerr-update.log}"
LOCK_FILE="${LOCK_FILE:-/run/seerr-update.lock}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"

CHECK_ONLY=false
FORCE=false
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=true ;;
    --force) FORCE=true ;;
    -h | --help)
      sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG_FILE" >&2; }
die() {
  log "ERROR: $*"
  exit 1
}

# Only one update at a time
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  flock -n 9 || die "Another update is already running"
fi

# --- Find the install ------------------------------------------------------

if [ -z "$SERVICE" ]; then
  for name in seerr jellyseerr overseerr; do
    if systemctl cat "$name.service" >/dev/null 2>&1; then
      SERVICE="$name"
      break
    fi
  done
fi
[ -n "$SERVICE" ] || die "Could not find the systemd service. Set SERVICE in /etc/default/seerr-update."

if [ -z "$APP_DIR" ]; then
  APP_DIR="$(systemctl show -p WorkingDirectory --value "$SERVICE" 2>/dev/null || true)"
  [ -n "$APP_DIR" ] || APP_DIR="/opt/$SERVICE"
fi
[ -d "$APP_DIR/.git" ] || die "$APP_DIR is not a git checkout. Set APP_DIR in /etc/default/seerr-update."
cd "$APP_DIR"

# systemd starts us without HOME, which pnpm needs. Also let root use the
# checkout even if another user owns it.
export HOME="${HOME:-/root}"
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$APP_DIR"
SERVICE_USER="$(systemctl show -p User --value "$SERVICE" 2>/dev/null || true)"

# Reads a variable the service is started with (inline or from its env file)
service_env() {
  local name="$1" value file
  value="$(systemctl show -p Environment --value "$SERVICE" 2>/dev/null |
    tr ' ' '\n' | sed -n "s/^$name=//p" | tail -n 1)"
  if [ -z "$value" ]; then
    for file in $(systemctl show -p EnvironmentFiles --value "$SERVICE" 2>/dev/null | grep -o '/[^ ]*'); do
      [ -f "$file" ] || continue
      value="$(sed -n "s/^[[:space:]]*\(export[[:space:]]\+\)\{0,1\}$name=//p" "$file" |
        tail -n 1 | tr -d "\"'")"
      [ -n "$value" ] && break
    done
  fi
  printf '%s' "$value"
}

CONFIG_DIR="$(service_env CONFIG_DIRECTORY)"
CONFIG_DIR="${CONFIG_DIR:-$APP_DIR/config}"
[ -n "$PORT" ] || PORT="$(service_env PORT)"
PORT="${PORT:-5055}"

# Follow whatever the local branch tracks (e.g. fork/feature/ai-recommendations)
if [ -z "$REMOTE" ] || [ -z "$BRANCH" ]; then
  upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
  if [ -n "$upstream" ]; then
    REMOTE="${REMOTE:-${upstream%%/*}}"
    BRANCH="${BRANCH:-${upstream#*/}}"
  fi
fi
REMOTE="${REMOTE:-fork}"
BRANCH="${BRANCH:-feature/ai-recommendations}"
git remote get-url "$REMOTE" >/dev/null 2>&1 || die "There is no git remote called $REMOTE in $APP_DIR"

# --- Check the toolchain -----------------------------------------------------

command -v node >/dev/null 2>&1 || die "Node.js is not installed"
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 19) ? 0 : 1)' ||
  die "Node.js $(node -v) is too old; Seerr needs 22.19 or newer"

if command -v pnpm >/dev/null 2>&1; then
  PNPM=(pnpm)
else
  PNPM=(npx --yes "$(node -p 'require("./package.json").packageManager')")
fi

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  die "$APP_DIR has local changes. Commit or stash them (git stash) first."
fi

# --- Work out what to install -----------------------------------------------

git fetch --quiet "$REMOTE" "$BRANCH" || die "Could not fetch $REMOTE/$BRANCH"
CURRENT="$(git rev-parse HEAD)"
LATEST="$(git rev-parse FETCH_HEAD)"

git merge-base --is-ancestor "$CURRENT" "$LATEST" ||
  die "The installed version has commits that aren't on $REMOTE/$BRANCH. Fix this by hand."

TARGET="$LATEST"
if [ "$REQUIRE_CI" = true ] && [ "$FORCE" = false ] && [ "$CURRENT" != "$LATEST" ]; then
  repo="$(git remote get-url "$REMOTE" | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')"
  # Newest commits that passed CI on this branch, newest first
  passed="$(curl -fsS -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/$repo/actions/workflows/$CI_WORKFLOW/runs?branch=$BRANCH&status=success&per_page=30" |
    node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      for (const run of JSON.parse(s).workflow_runs ?? []) console.log(run.head_sha);
    })')" || die "Could not ask GitHub which versions passed CI"

  TARGET=""
  for sha in $passed; do
    if git cat-file -e "$sha^{commit}" 2>/dev/null &&
      git merge-base --is-ancestor "$sha" "$LATEST" &&
      git merge-base --is-ancestor "$CURRENT" "$sha"; then
      TARGET="$sha"
      break
    fi
  done
  TARGET="${TARGET:-$CURRENT}"
fi

short() { git rev-parse --short "$1"; }

if [ "$TARGET" = "$CURRENT" ] && [ "$FORCE" = false ]; then
  if [ "$CURRENT" = "$LATEST" ]; then
    log "Up to date ($(short "$CURRENT"))"
  else
    log "Newer version $(short "$LATEST") hasn't passed CI yet; staying on $(short "$CURRENT")"
  fi
  exit 0
fi

if [ "$CHECK_ONLY" = true ]; then
  log "Update available: $(short "$CURRENT") -> $(short "$TARGET"):"
  git log --oneline --no-merges "$CURRENT..$TARGET" | head -n 20 >&2 || true
  exit 0
fi

# --- Update -----------------------------------------------------------------

export CYPRESS_INSTALL_BINARY=0
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=3072}"

build() {
  "${PNPM[@]}" install --frozen-lockfile &&
    "${PNPM[@]}" build || return 1
  # We build as root; hand the files back if the service runs as someone else
  if [ -n "$SERVICE_USER" ] && [ "$SERVICE_USER" != root ]; then
    chown -R "$SERVICE_USER": "$APP_DIR"
  fi
}

healthy() {
  local waited=0
  while [ "$waited" -lt "$HEALTH_TIMEOUT" ]; do
    if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/v1/status"; then
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

BACKUP_DIR="$BACKUP_ROOT/$(date +%Y%m%d-%H%M%S)-$(short "$CURRENT")"

rollback() {
  log "Rolling back to $(short "$CURRENT")"
  systemctl stop "$SERVICE" || true
  git reset --quiet --hard "$CURRENT"
  # The new version may have changed the database, so put the backup back
  if [ -d "$BACKUP_DIR/db" ]; then
    rm -rf "$CONFIG_DIR/db"
    cp -a "$BACKUP_DIR/db" "$CONFIG_DIR/db"
  fi
  [ -f "$BACKUP_DIR/settings.json" ] && cp -a "$BACKUP_DIR/settings.json" "$CONFIG_DIR/settings.json"
  build >>"$LOG_FILE" 2>&1 || die "Rollback build failed. Restore by hand from $BACKUP_DIR"
  systemctl start "$SERVICE"
  healthy || die "Seerr didn't start after rolling back. Check: journalctl -u $SERVICE"
  log "Rolled back to $(short "$CURRENT"); backup kept in $BACKUP_DIR"
}

log "Updating $SERVICE in $APP_DIR: $(short "$CURRENT") -> $(short "$TARGET")"
systemctl stop "$SERVICE"

mkdir -p "$BACKUP_DIR"
[ -d "$CONFIG_DIR/db" ] && cp -a "$CONFIG_DIR/db" "$BACKUP_DIR/db"
[ -f "$CONFIG_DIR/settings.json" ] && cp -a "$CONFIG_DIR/settings.json" "$BACKUP_DIR/"
echo "$CURRENT" >"$BACKUP_DIR/commit"
log "Backed up database and settings to $BACKUP_DIR"

if ! git merge --quiet --ff-only "$TARGET"; then
  log "Could not move to $(short "$TARGET")"
  rollback
  exit 1
fi

log "Installing dependencies and building (this takes a few minutes)"
if ! build >>"$LOG_FILE" 2>&1; then
  log "Build failed (details in $LOG_FILE)"
  rollback
  exit 1
fi

systemctl start "$SERVICE"
if ! healthy; then
  log "Seerr didn't come back up within ${HEALTH_TIMEOUT}s"
  rollback
  exit 1
fi

# Keep only the newest backups
ls -1dt "$BACKUP_ROOT"/*/ 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))" | xargs -r rm -rf || true

log "Updated to $(short "$TARGET")"
