#!/bin/bash
# Installs the nginx and fail2ban config from this directory on the server.
# Run from the checkout on the server:  sudo bash deploy/install.sh
#
# Existing files are backed up to /root/ihsoy-deploy-backup-<timestamp>/.
# If the new nginx config fails `nginx -t`, the old files are restored and
# nothing is reloaded.

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "Run as root: sudo bash $0" >&2
    exit 1
fi

DIR="$(cd "$(dirname "$0")" && pwd)"
BACKUP="/root/ihsoy-deploy-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP"

# source in this repo -> installed path
FILES=(
    "nginx/ihsoy.com.conf:/etc/nginx/sites-available/default"
    "nginx/ihsoy-ratelimit.conf:/etc/nginx/conf.d/ihsoy-ratelimit.conf"
    "fail2ban/action.d/nginx-deny.conf:/etc/fail2ban/action.d/nginx-deny.conf"
    "fail2ban/jail.d/ihsoy.conf:/etc/fail2ban/jail.d/ihsoy.conf"
)

restore() {
    echo "Restoring previous files from $BACKUP" >&2
    for entry in "${FILES[@]}"; do
        dest="${entry#*:}"
        if [ -e "$BACKUP/$(basename "$dest")" ]; then
            cp -a "$BACKUP/$(basename "$dest")" "$dest"
        else
            rm -f "$dest"
        fi
    done
}

for entry in "${FILES[@]}"; do
    src="$DIR/${entry%%:*}"
    dest="${entry#*:}"
    [ -e "$dest" ] && cp -a "$dest" "$BACKUP/$(basename "$dest")"
    install -o root -g root -m 644 "$src" "$dest"
    echo "installed $dest"
done

# The hand-edited blocklist is only created once; edit it on the server.
if [ ! -e /etc/nginx/blocklist.conf ]; then
    install -o root -g root -m 644 "$DIR/nginx/blocklist.conf" /etc/nginx/blocklist.conf
    echo "installed /etc/nginx/blocklist.conf"
else
    echo "kept existing /etc/nginx/blocklist.conf"
fi
# Maintained by fail2ban, must exist for nginx to start
if [ ! -e /etc/nginx/blocklist-auto.conf ]; then
    printf '# Managed by fail2ban (action nginx-deny), do not edit\n' > /etc/nginx/blocklist-auto.conf
    chmod 644 /etc/nginx/blocklist-auto.conf
fi

if ! nginx -t; then
    restore
    exit 1
fi
systemctl reload nginx
echo "nginx reloaded"

if ! fail2ban-client -t >/dev/null; then
    echo "fail2ban config test failed, nginx is updated but fail2ban was not reloaded" >&2
    fail2ban-client -t || true
    exit 1
fi
fail2ban-client reload
sleep 2
fail2ban-client status ihsoy-limit-req
