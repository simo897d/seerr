#!/usr/bin/env bash
# Lets Seerr use your Claude subscription for AI recommendations and chat:
# installs Claude Code for the user Seerr runs as, and gives Seerr's service
# your sign-in token. Run as root inside the container:
#   bash deploy/proxmox/claude-code-setup.sh
#
# Then pick "Claude subscription" under Settings > AI Recommendations.
# Run it again to update Claude Code or replace the token.
set -euo pipefail

CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-stable}"
SERVICE="${SERVICE:-}"
ENV_DIR=/etc/seerr
ENV_FILE="$ENV_DIR/claude-code.env"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

[ "$(id -u)" = 0 ] || die "Run this as root"
command -v curl >/dev/null 2>&1 || die "curl is needed (apt install curl)"

if [ -z "$SERVICE" ]; then
  for name in seerr jellyseerr overseerr; do
    if systemctl cat "$name.service" >/dev/null 2>&1; then
      SERVICE="$name"
      break
    fi
  done
fi
[ -n "$SERVICE" ] || die "Could not find Seerr's systemd service. Run with SERVICE=<name>."

SERVICE_USER="$(systemctl show -p User --value "$SERVICE" 2>/dev/null || true)"
SERVICE_USER="${SERVICE_USER:-root}"
USER_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
[ -n "$USER_HOME" ] && [ -d "$USER_HOME" ] ||
  die "$SERVICE_USER has no home folder, which Claude Code needs"

# Runs a command as the service's user, with its own home folder
as_user() {
  if [ "$SERVICE_USER" = root ]; then
    HOME="$USER_HOME" "$@"
  else
    runuser -u "$SERVICE_USER" -- env HOME="$USER_HOME" "$@"
  fi
}

echo "Seerr runs as '$SERVICE_USER' ($SERVICE.service)."
echo "Installing Claude Code ($CLAUDE_CODE_VERSION) for $SERVICE_USER..."
as_user bash -c 'curl -fsSL https://claude.ai/install.sh | bash -s "$1"' _ "$CLAUDE_CODE_VERSION" ||
  die "Installing Claude Code failed"

CLAUDE="$USER_HOME/.local/bin/claude"
[ -x "$CLAUDE" ] || die "Claude Code wasn't found at $CLAUDE after installing"
echo "Installed: $(as_user "$CLAUDE" --version)"

TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$ENV_FILE" ]; then
  read -rp "A token is already saved. Replace it? [y/N] " answer
  if [[ ! "$answer" =~ ^[Yy] ]]; then
    TOKEN="$(sed -n 's/^CLAUDE_CODE_OAUTH_TOKEN=//p' "$ENV_FILE")"
  fi
fi

if [ -z "$TOKEN" ]; then
  echo
  echo "On your own computer (where you use Claude Code), run:"
  echo "  claude setup-token"
  echo "and sign in with your Claude subscription. It prints a long-lived token."
  read -rsp "Paste the token here (it won't be shown): " TOKEN
  echo
  TOKEN="$(printf '%s' "$TOKEN" | tr -d '[:space:]')"
  [ -n "$TOKEN" ] || die "No token given"
fi

echo "Checking that Claude Code can sign in with it..."
reply="$(echo 'Reply with the single word OK.' |
  as_user env CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" DISABLE_AUTOUPDATER=1 \
    "$CLAUDE" -p --model haiku --tools "" --strict-mcp-config \
    --no-session-persistence --output-format text 2>&1)" ||
  die "Claude Code couldn't answer with that token: $reply"
echo "Claude answered: $reply"

# Only root can read the token; systemd hands it to Seerr's service
install -d -m 700 "$ENV_DIR"
umask 077
printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$TOKEN" >"$ENV_FILE"
chmod 600 "$ENV_FILE"

mkdir -p "/etc/systemd/system/$SERVICE.service.d"
cat >"/etc/systemd/system/$SERVICE.service.d/claude-code.conf" <<EOF
[Service]
EnvironmentFile=$ENV_FILE
EOF
systemctl daemon-reload

echo
read -rp "Restart Seerr now so it picks up the token? [Y/n] " answer
if [[ ! "$answer" =~ ^[Nn] ]]; then
  systemctl restart "$SERVICE"
  echo "Restarted."
else
  echo "Restart later with: systemctl restart $SERVICE"
fi

echo
echo "Done. In Seerr, open Settings > AI Recommendations, pick"
echo "'Claude subscription (Claude Code on this server)', then press Test."
