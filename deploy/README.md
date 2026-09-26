# Server config for ihsoy.com

nginx and fail2ban config for the vultr host. The API itself runs from this
repo's `index.js` under PM2 (`ihsoy-api`, 127.0.0.1:3030).

| File | Installed as |
|---|---|
| `nginx/ihsoy.com.conf` | `/etc/nginx/sites-available/default` |
| `nginx/ihsoy-ratelimit.conf` | `/etc/nginx/conf.d/ihsoy-ratelimit.conf` |
| `nginx/blocklist.conf` | `/etc/nginx/blocklist.conf` (only created once, then edited on the server) |
| `fail2ban/action.d/nginx-deny.conf` | `/etc/fail2ban/action.d/nginx-deny.conf` |
| `fail2ban/jail.d/ihsoy.conf` | `/etc/fail2ban/jail.d/ihsoy.conf` |

Install or update (backs up the old files, rolls nginx back if `nginx -t` fails):

```
cd /var/www/ihsoy.com.api && git pull && sudo bash deploy/install.sh
```

## Blocking clients

Traffic arrives through Cloudflare, so blocking happens in nginx (`deny`),
not in the firewall. nginx sees the real visitor address via
`conf.d/cloudflare.conf` (`real_ip_header CF-Connecting-IP`).

- **By hand:** add `deny 1.2.3.0/24;` to `/etc/nginx/blocklist.conf`, then
  `sudo nginx -t && sudo systemctl reload nginx`.
- **Automatically:** `/api` and `/reddit-comments` are rate limited per IP
  (60 and 12 requests per minute, with an equal burst). The fail2ban jail
  `ihsoy-limit-req` bans an IP that gets 30 rate-limit rejections within
  10 minutes by adding it to `/etc/nginx/blocklist-auto.conf`: 1 hour at
  first, doubling for repeat offenders up to a week.

Useful commands:

```
sudo fail2ban-client status ihsoy-limit-req     # current bans
sudo fail2ban-client set ihsoy-limit-req unbanip 1.2.3.4
sudo grep "limiting requests" /var/log/nginx/error.log | tail
```
