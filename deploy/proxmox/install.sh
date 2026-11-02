#!/usr/bin/env bash
# Installs seerr-update and a nightly timer that runs it.
# Run as root inside the container, from your Seerr checkout:
#   bash deploy/proxmox/install.sh
set -euo pipefail

[ "$(id -u)" = 0 ] || {
  echo "Run this as root" >&2
  exit 1
}

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Link rather than copy, so the updater updates itself along with Seerr
chmod +x "$SRC_DIR/seerr-update.sh"
ln -sf "$SRC_DIR/seerr-update.sh" /usr/local/bin/seerr-update

if [ ! -f /etc/default/seerr-update ]; then
  install -m 644 "$SRC_DIR/seerr-update.conf" /etc/default/seerr-update
fi

cat >/etc/systemd/system/seerr-update.service <<'EOF'
[Unit]
Description=Update Seerr from GitHub
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=-/etc/default/seerr-update
ExecStart=/usr/local/bin/seerr-update
TimeoutStartSec=2h
EOF

cat >/etc/systemd/system/seerr-update.timer <<'EOF'
[Unit]
Description=Check for Seerr updates every night

[Timer]
OnCalendar=*-*-* 04:00:00
RandomizedDelaySec=30min
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now seerr-update.timer

echo "Installed. Seerr will update itself every night around 04:00."
echo "  Update now:        seerr-update"
echo "  Check only:        seerr-update --check"
echo "  Log:               /var/log/seerr-update.log"
echo "  Next run:          systemctl list-timers seerr-update.timer"
