# Automatic updates for a Proxmox (LXC) install

These scripts keep a from-source Seerr/Jellyseerr install up to date with this
fork. Every night the container checks GitHub, and if a newer version has passed
the **Fork CI** workflow it:

1. stops Seerr and backs up the database and `settings.json` to `/var/backups/seerr`
2. pulls the new version, installs dependencies and builds it
3. starts Seerr and checks that it responds

If the build fails or Seerr doesn't come back up, it switches back to the old
version and restores the backup. Nothing needs to be reachable from the
internet: the container pulls from GitHub.

## Setup

Run once, as root inside the container, from your Seerr checkout:

```bash
cd /opt/jellyseerr   # or wherever your checkout is
bash deploy/proxmox/install.sh
```

This needs Node.js 22.19 or newer and about 4 GB of RAM for the build.

## Everyday use

| What                       | Command                                     |
| -------------------------- | ------------------------------------------- |
| Update now                 | `seerr-update`                              |
| See if an update is ready  | `seerr-update --check`                      |
| Rebuild without CI check   | `seerr-update --force`                      |
| Read the log               | `tail -n 50 /var/log/seerr-update.log`      |
| When the next check runs   | `systemctl list-timers seerr-update.timer`  |
| Turn automatic updates off | `systemctl disable --now seerr-update.timer` |

Settings such as the service name, branch or backup location are detected
automatically. To override them, edit `/etc/default/seerr-update`.

## How new versions get here

- **Fork CI** type-checks, lints, tests and builds every push to
  `feature/ai-recommendations`.
- **Sync with Seerr** merges the latest Seerr into that branch every Monday and
  runs Fork CI on the result. If the merge conflicts, the run fails, GitHub
  emails you, and the branch is left as it was.
