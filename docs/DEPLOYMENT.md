# Running HUEREX on the factory network

The whole system is one Node process and one SQLite file. There is no database
server to install, no message queue, no Redis, and nothing that phones home.
Unplug the internet and everything still works — the fonts are in the
repository, the icons are drawn in code, and no page loads anything from a CDN.

---

## 1. What you need

One machine on the factory LAN that stays on. Anything from a ₹25,000 mini PC
upwards is plenty; the whole dataset for a year is a few hundred megabytes.

- **Node.js 20 or newer** — `node --version` to check
- **A folder for backups that is not on the same disk** — a NAS mount, a
  USB disk, or a synced folder. A backup on the same disk is not a backup.

Windows, macOS and Linux all work. The instructions below are for Linux
because that is what a small always-on box usually runs.

---

## 2. First install

```bash
git clone <your repository> /opt/huerex
cd /opt/huerex

npm install
npm run build          # builds the web app and compiles the server
npm run seed           # creates the database, roles and the first admin
```

The seed prints a one-time password for the `admin` account. Write it down —
it is not stored anywhere in the clear, and you will be asked to change it the
moment you sign in.

```bash
npm start
```

Open `http://<the machine's LAN address>:4000` from any other machine on the
network.

### Seeding with your own data

`npm run seed` loads the V5.1 workbook from `server/seed/workbook.json` — the
sixteen orders, their routes, the size breakdowns and every transaction that
was in the spreadsheet. It only does this when the database has no orders in
it, so re-running the command on a live installation is safe: it refreshes the
roles and the master lists and leaves the factory's data alone.

To start completely empty instead, delete `server/seed/workbook.json` before
seeding, or point `SEED_FILE` at a different file.

---

## 3. Settings

Everything is an environment variable, and every one has a sensible default.
Put them in `/etc/huerex.env`:

```ini
# --- where things live -------------------------------------------------------
DB_PATH=/var/lib/huerex/huerex.sqlite
BACKUP_DIR=/mnt/nas/huerex-backups

# --- the network -------------------------------------------------------------
HOST=0.0.0.0
PORT=4000

# On a plain-HTTP LAN this must be false, or the session cookie is never sent
# and nobody can sign in. Set it to true the moment you put TLS in front.
COOKIE_SECURE=false

# --- sessions ----------------------------------------------------------------
SESSION_TTL_HOURS=12          # a shift, so nobody is signed out mid-afternoon
SESSION_IDLE_MINUTES=240      # an unattended floor terminal locks itself
MAX_LOGIN_ATTEMPTS=8
LOCKOUT_MINUTES=15

# --- backup ------------------------------------------------------------------
BACKUP_ENABLED=true
BACKUP_CRON=02:30             # local time, once a night
BACKUP_KEEP_DAILY=14
BACKUP_KEEP_WEEKLY=8
BACKUP_KEEP_MONTHLY=12
```

---

## 4. Keeping it running

### systemd (Linux)

`/etc/systemd/system/huerex.service`:

```ini
[Unit]
Description=HUEREX Factory Execution
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=huerex
WorkingDirectory=/opt/huerex
EnvironmentFile=/etc/huerex.env
ExecStart=/usr/bin/node server/dist/index.js
Restart=always
RestartSec=5

# The process needs to write the database and the backups, and nothing else.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/huerex /mnt/nas/huerex-backups

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --home /var/lib/huerex --create-home huerex
sudo chown -R huerex:huerex /opt/huerex /var/lib/huerex
sudo systemctl enable --now huerex
sudo systemctl status huerex
journalctl -u huerex -f          # the log
```

### Docker

```bash
docker compose up -d
docker compose exec app npm run seed     # first time only
```

`docker-compose.yml` in the repository root mounts `./data` and `./backups`
from the host, so the database survives rebuilding the image. Point the
backup volume at real off-machine storage before you rely on it.

---

## 5. Reaching it from outside the factory

### On the LAN

Nothing to do. Everyone on the network reaches `http://<ip>:4000`. Give the
machine a fixed address in the router, and add a name in the router's DNS —
`huerex.local` reads better than an IP on a tablet at the cutting table.

### From home, or from a phone on mobile data — Tailscale

**Tailscale is the right answer here**, and it is worth being clear about why
rather than just listing steps:

- It puts the machine on a private network only your devices can see. Nothing
  is exposed to the public internet, so there is no port to scan and no login
  page for the world to hammer.
- It gives you HTTPS with a real certificate, for free, on a
  `huerex.<your-tailnet>.ts.net` name, with no certificate to renew.
- It costs nothing for a team this size and needs no firewall changes, no
  static IP and no port forwarding on the factory router.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# HTTPS on the tailnet, forwarding to the app
sudo tailscale cert "$(tailscale status --json | jq -r .Self.DNSName | sed 's/\.$//')"
sudo tailscale serve --bg 4000
```

Then set `COOKIE_SECURE=true` and `TRUST_PROXY=true` in `/etc/huerex.env` and
restart. The address becomes `https://huerex.<tailnet>.ts.net`.

**The alternatives, and why not:**

| Option | Verdict |
| --- | --- |
| Tailscale / WireGuard | What to use. Private, encrypted, free, no ports open. |
| Cloudflare Tunnel | Also good, and public-facing if you genuinely need that. More moving parts, and your traffic goes through a third party. |
| Port forwarding + dynamic DNS | Don't. It puts a login page carrying your costing data on the open internet. |
| A cloud VPS | Works — the app is written to move — but it means the factory floor stops working when the internet does. |

### If you do put it on the public internet

Turn on two-factor sign-in for every account that can see cost or margin
(Account → Two-factor sign-in), set `COOKIE_SECURE=true`, and put a reverse
proxy with TLS in front. The app sets a strict Content-Security-Policy,
`SameSite=Lax` cookies, and refuses cross-site writes, but none of that
substitutes for not being reachable in the first place.

---

## 6. Backups, and getting data back

A copy is written every night at `BACKUP_CRON` into `BACKUP_DIR`, using
SQLite's `VACUUM INTO`. That produces a complete, consistent database file
while the app keeps running — no stopping the factory, no half-copied file.

Retention keeps every backup for two weeks, then one a week for two months,
then one a month for a year. So a mistake noticed in March can still be
undone from January.

Check it is working on **Settings → Backup**, which shows the folder, the
newest copy, and the last error if there was one.

### Restoring

```bash
sudo systemctl stop huerex
cp /var/lib/huerex/huerex.sqlite /var/lib/huerex/huerex.sqlite.before-restore
cp /mnt/nas/huerex-backups/huerex-20260901-0230-nightly.sqlite \
   /var/lib/huerex/huerex.sqlite
sudo chown huerex:huerex /var/lib/huerex/huerex.sqlite
sudo systemctl start huerex
```

Keep the file you replaced until you have confirmed the restore is what you
wanted.

### Taking a copy by hand

```bash
npm run backup
```

---

## 7. Upgrading

```bash
cd /opt/huerex
npm run backup            # always, before anything else
git pull
npm install
npm run build
npm run seed              # refreshes roles and master lists; leaves data alone
sudo systemctl restart huerex
```

Migrations run automatically at startup and are applied once each, in order.

---

## 8. Moving to a real server later

The application is written to move. Everything the server does goes through a
thin data layer, dates are stored as plain ISO text, and no SQLite-specific
feature leaks into the business logic. Moving to PostgreSQL means porting the
three migration files and the handful of queries that use SQLite's
`julianday`, and nothing else.

That said: SQLite on a local disk will serve a factory of this size for years.
It handles hundreds of writes a second, the whole database is one file you can
copy, and there is no second service to keep alive at two in the morning.
Move when you have a reason, not before.

---

## 9. When something is wrong

| Symptom | Where to look |
| --- | --- |
| Nobody can sign in | `COOKIE_SECURE=true` on plain HTTP. Set it to false, or put TLS in front. |
| "Too many attempts" | The account is locked for `LOCKOUT_MINUTES`. An administrator can unlock it on Users. |
| Numbers look wrong | **Data audit** first, then **Reconciliation**. They will name the entry that contradicts another one. |
| A screen is missing from the menu | The role does not include it. Users → Roles → Review access. |
| A figure shows as "Restricted" | Deliberate. The value never left the server; the role does not include that field. |
| The app is slow | Check the database size and `journalctl -u huerex`. WIP is recomputed per request by design; if that ever becomes the bottleneck it is one function to cache. |
