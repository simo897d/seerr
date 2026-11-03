#!/usr/bin/env bash
# Keeps a Swizzin server and its apps up to date by itself, every night:
#   1. system packages (apt), which also updates the apps Swizzin installs
#      from their own package sources, such as Plex, Jellyfin, Ombi and nginx
#   2. Swizzin itself (`box update`)
#   3. every installed app that has a Swizzin upgrade script. Apps are found
#      when the script runs, so ones you install later are included.
#
# Set it up once, as root inside the container, from your Seerr checkout:
#   bash deploy/proxmox/swizzin-update.sh --install
#
# Then:
#   swizzin-update                 update now
#   swizzin-update --dry-run       only show what would be updated
#   journalctl -u swizzin-update   see what the last runs did
set -euo pipefail

UPGRADE_DIR=/etc/swizzin/scripts/upgrade
# How long one step may take. A step that runs longer is most likely stuck
# on a question nobody can answer.
STEP_TIMEOUT="${STEP_TIMEOUT:-45m}"

# Swizzin upgrade scripts that aren't plain app updates
declare -A SKIP=(
  [nginx]="it resets your nginx configs (apt updates nginx itself)"
  [curl]="it builds curl from source, which only Debian 10 needs"
  [sonarr]="it only moves Sonarr v2 to v3 (Sonarr updates itself)"
  [plex]="apt updates Plex from Plex's own package source"
  [ombi]="apt updates Ombi from Ombi's own package source"
)

die() {
  echo "ERROR: $*" >&2
  exit 1
}

[ "$(id -u)" = 0 ] || die "Run this as root"

install_timer() {
  local src
  src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  command -v box >/dev/null 2>&1 || die "Swizzin's 'box' command wasn't found"

  # Link rather than copy, so the script updates itself along with Seerr
  chmod +x "$src"
  ln -sf "$src" /usr/local/bin/swizzin-update

  cat >/etc/systemd/system/swizzin-update.service <<'EOF'
[Unit]
Description=Update Swizzin and its apps
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/swizzin-update
TimeoutStartSec=6h
Nice=10
EOF

  # Before Seerr's own update at 04:00
  cat >/etc/systemd/system/swizzin-update.timer <<'EOF'
[Unit]
Description=Update Swizzin and its apps every night

[Timer]
OnCalendar=*-*-* 03:00:00
RandomizedDelaySec=20min
Persistent=true

[Install]
WantedBy=timers.target
EOF

  systemctl daemon-reload
  systemctl enable --now swizzin-update.timer
  echo "Swizzin and its apps will now update every night around 03:00."
  echo "  Update now:        swizzin-update"
  echo "  See what it would: swizzin-update --dry-run"
  echo "  Read the log:      journalctl -u swizzin-update"
  echo "  Next run:          systemctl list-timers swizzin-update.timer"
  echo "  Turn it off:       systemctl disable --now swizzin-update.timer"
}

DRY_RUN=0
case "${1:-}" in
  --install)
    install_timer
    exit 0
    ;;
  --dry-run) DRY_RUN=1 ;;
  "") ;;
  *) die "Unknown option: $1 (use --install or --dry-run)" ;;
esac

command -v box >/dev/null 2>&1 || die "Swizzin's 'box' command wasn't found"

# Only one run at a time
exec 9>/run/swizzin-update.lock
flock -n 9 || die "Another update is already running"

# Without a terminal (the nightly run) Swizzin's colour codes only add noise
[ -t 1 ] || export TERM=dumb

UPDATED=()
FAILED=()
SKIPPED=()

# Runs one step with a time limit and records how it went
run_step() {
  local name="$1"
  shift
  echo
  echo "== $name"
  if [ "$DRY_RUN" = 1 ]; then
    echo "(dry run: would update)"
    UPDATED+=("$name")
    return
  fi
  if timeout --kill-after=1m "$STEP_TIMEOUT" "$@" </dev/null; then
    UPDATED+=("$name")
  else
    local code=$?
    if [ "$code" = 124 ] || [ "$code" = 137 ]; then
      FAILED+=("$name (stopped after $STEP_TIMEOUT, probably waiting for an answer)")
    else
      FAILED+=("$name (exit code $code)")
    fi
  fi
}

apt_upgrade() {
  export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
  apt-get -q -o DPkg::Lock::Timeout=600 update &&
    apt-get -q -y -o DPkg::Lock::Timeout=600 \
      -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold \
      upgrade
}
export -f apt_upgrade

# A script that asks questions would wait forever with nobody to answer
asks_questions() {
  grep -Eq '(^|[^_[:alnum:]])(ask|select|read)[[:space:]]|whiptail|echo_query' "$1"
}

echo "Swizzin update, $(date '+%Y-%m-%d %H:%M')"

run_step "System packages (apt)" bash -c apt_upgrade
run_step "Swizzin (box update)" box update

NO_SCRIPT=()
mapfile -t INSTALLED < <(
  find /install -maxdepth 1 -name '.*.lock' -printf '%f\n' 2>/dev/null |
    sed 's/^\.//; s/\.lock$//' | sort -u
)

for app in "${INSTALLED[@]}"; do
  script="$UPGRADE_DIR/$app.sh"
  if [ ! -f "$script" ]; then
    NO_SCRIPT+=("$app")
  elif [ -n "${SKIP[$app]:-}" ]; then
    SKIPPED+=("$app: ${SKIP[$app]}")
  elif asks_questions "$script"; then
    SKIPPED+=("$app: it asks questions, so run 'box upgrade $app' yourself")
  else
    # Swizzin scripts expect its helper functions, which `box` normally loads
    run_step "$app" bash -c '. /etc/swizzin/sources/globals.sh && bash "$1"' swizzin "$script"
  fi
done

# Sonarr, Radarr and friends update themselves, but only when that's turned on
ARR_MANUAL=()
while IFS= read -r cfg; do
  grep -qi '<UpdateAutomatically>true' "$cfg" ||
    ARR_MANUAL+=("$(basename "$(dirname "$cfg")")")
done < <(
  find /home /var/lib -maxdepth 4 -iname config.xml 2>/dev/null |
    grep -Ei '/(sonarr|radarr|lidarr|readarr|prowlarr|whisparr)/config\.xml$' || true
)

echo
echo "== Summary"
list() {
  local title="$1"
  shift
  [ "$#" -gt 0 ] || return 0
  echo "$title"
  printf '  - %s\n' "$@"
}
list "Updated:" "${UPDATED[@]}"
list "Skipped:" "${SKIPPED[@]}"
list "Failed (see /root/logs/swizzin.log):" "${FAILED[@]}"
if [ "${#NO_SCRIPT[@]}" -gt 0 ]; then
  echo "No Swizzin upgrade script (these update themselves or through apt):"
  echo "  ${NO_SCRIPT[*]}"
fi
if [ "${#ARR_MANUAL[@]}" -gt 0 ]; then
  echo "Automatic updates are off in: ${ARR_MANUAL[*]}"
  echo "  Turn them on under Settings > General > Updates (show advanced settings)."
fi

[ "${#FAILED[@]}" = 0 ]
