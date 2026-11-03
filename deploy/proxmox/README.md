# Automatic updates for a Proxmox (LXC) install

These scripts keep a from-source Seerr/Jellyseerr install up to date with this
fork. The slow part, installing dependencies and building, happens on GitHub,
not on your server. Every night the container checks GitHub, and if a newer
version has passed the **Fork CI** workflow it:

1. downloads the ready-made build and checks it runs on this machine, while
   Seerr keeps running
2. stops Seerr and backs up the database and `settings.json` to
   `/var/backups/seerr`
3. swaps in the new version, starts Seerr and checks that it responds

Seerr is only down for the restart. If it doesn't come back up, the old version
and the backup are put back straight away. If the download can't run on this
machine (for example a different CPU type), it builds here instead. Nothing
needs to be reachable from the internet: the container pulls from GitHub.

## Setup

Run once, as root inside the container, from your Seerr checkout:

```bash
cd /opt/jellyseerr   # or wherever your checkout is
bash deploy/proxmox/install.sh
```

This needs Node.js 22 (22.19 or newer). Building on the server, which only
happens as a fallback, also needs about 4 GB of RAM.

## Everyday use

| What                       | Command                                     |
| -------------------------- | ------------------------------------------- |
| Update now                 | `seerr-update`                              |
| See if an update is ready  | `seerr-update --check`                      |
| Reinstall current version  | `seerr-update --force`                      |
| Read the log               | `tail -n 50 /var/log/seerr-update.log`      |
| When the next check runs   | `systemctl list-timers seerr-update.timer`  |
| Turn automatic updates off | `systemctl disable --now seerr-update.timer` |

Settings such as the service name, branch or backup location are detected
automatically. To override them, edit `/etc/default/seerr-update`.

## Claude subscription for AI recommendations

Instead of an API key, AI recommendations and chat can run on your own Claude
subscription (Pro or Max). Seerr then runs the Claude Code program on the
server, which signs in with a token from `claude setup-token`. Seerr itself
never reads or stores the token. Because the subscription is yours alone,
only the server owner gets AI with this option.

Run once, as root inside the container:

```bash
cd /opt/jellyseerr   # or wherever your checkout is
bash deploy/proxmox/claude-code-setup.sh
```

It installs Claude Code for the user Seerr runs as, asks for the token (run
`claude setup-token` on your own computer to get one), checks that it works,
saves it in `/etc/seerr/claude-code.env` (readable by root only) and restarts
Seerr. Then pick **Claude subscription** under Settings → AI Recommendations.

Claude Code doesn't update itself here. Run the script again to update it or
to replace the token (tokens last a year).

## How new versions get here

- **Fork CI** type-checks, lints, tests and builds every push to
  `feature/ai-recommendations`, then publishes a ready-to-run build as a
  `build-<commit>` pre-release (the newest five are kept).
- **Sync with Seerr** merges the latest Seerr into that branch every Monday and
  runs Fork CI on the result. If the merge conflicts, the run fails, GitHub
  emails you, and the branch is left as it was.
