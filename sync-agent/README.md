# NolTech Sync Agent

Always-on background sync service for the NolTech Hub electronics-resale
workflow. Runs on a Raspberry Pi (or any small Linux box), pulls eBay
listings, orders, and finances on a schedule, and writes them to Supabase.
The desktop Electron app subscribes to Supabase realtime, so once this
agent is running you can quit the desktop app entirely and your data still
keeps syncing in the background.

This is a companion process to the `noltech-pipeline` service (sibling
directory `noltech-pipeline/`); the two are designed to run side-by-side on
the same Pi.

---

## Overview

```
       ┌────────────────────┐         ┌─────────────────┐
eBay ◄─┤   sync-agent (Pi)  ├────────►│    Supabase     │
       │  - listings hourly │         │  (workspace DB) │
       │  - orders 15 min   │         └────────┬────────┘
       │  - finances 15 min │                  │
       │  - heartbeat 1 min │                  │ realtime
       └─────────┬──────────┘                  ▼
                 │              ┌──────────────────────────┐
                 ▼              │  NolTech Hub desktop app │
       ┌────────────────────┐   │  (read-only consumer of  │
       │ pipeline (same Pi) │   │   the synced data)       │
       │   localhost:3001   │   └──────────────────────────┘
       └────────────────────┘
```

- **What it syncs**: live eBay listings, recent orders, payout/fees from the
  Sell Finances API.
- **What it doesn't do**: it does not push changes back to eBay (the desktop
  app still owns write/edit). It is read-only against eBay and write-only
  against Supabase.
- **Why**: so you don't need to keep the desktop app running for inventory,
  order status, and dashboards to stay current.

---

## Prerequisites

- Raspberry Pi 4 with **2 GB RAM or more**, or any Linux box with Node.js 20+.
  Neither the agent nor the pipeline runs a browser, so this is genuinely
  modest hardware.
- Network access to:
  - `api.ebay.com` (eBay Trading + Sell Finances)
  - your Supabase project URL
  - the pipeline, typically `http://localhost:3001` on the same Pi
- An existing Supabase workspace, created via the desktop app's first-time
  cloud setup wizard.
- eBay developer credentials: App ID, Cert ID, Dev ID, and an OAuth refresh
  token (the long string starting `v^1.1#i^1#...`).

---

## One-time setup

1. **Get the code onto the Pi.** Either:
   ```bash
   git clone <your-git-remote> ~/sync-agent
   cd ~/sync-agent
   ```
   or `scp -r sync-agent/ pi@<pi-host>:~/`.

2. **Run the installer:**
   ```bash
   bash scripts/install.sh
   ```
   This installs Node 20, npm dependencies, and the systemd unit.
   It is idempotent — safe to re-run after updates. It will **not**
   auto-start the service; you need to fill in `.env` first.

3. **Edit `.env`** with your secrets:
   ```bash
   nano .env
   ```

   | Variable | Where to find it |
   |---|---|
   | `SUPABASE_URL` | Supabase dashboard → Project Settings → API → "Project URL" |
   | `SUPABASE_SERVICE_KEY` | Same page → "service_role" key. **This bypasses RLS — never commit it.** |
   | `WORKSPACE_ID` | Supabase SQL editor: `SELECT id FROM workspaces WHERE created_by = '<your-user-id>';` |
   | `EBAY_APP_ID` | Desktop app → Settings → eBay Credentials |
   | `EBAY_CERT_ID` | Same panel |
   | `EBAY_DEV_ID` | Same panel |
   | `EBAY_REFRESH_TOKEN` | Same panel — long string starting `v^1.1#i^1#...` |
   | `PIPELINE_URL` | `http://localhost:3001` if the pipeline runs on the same Pi |
   | `PIPELINE_AUTH_SECRET` | Only if the pipeline sets `SHARED_AUTH_SECRET` |

4. **Start the service:**
   ```bash
   sudo systemctl start sync-agent
   ```

5. **Verify it's running:**
   ```bash
   journalctl -u sync-agent -f
   ```
   You should see logs streaming: a startup banner, then heartbeats every
   minute and a listings sync within the first hour.

---

## Running the pipeline alongside this agent

The sync-agent calls the `noltech-pipeline` service for anything the eBay APIs
don't cover: lot listings, manifest pricing, and closing prices. That service
lives in the sibling directory `noltech-pipeline/` and is a separate Node
package with its own README.

Quick start (foreground, for testing):
```bash
cp -r noltech-pipeline ~/pipeline
cd ~/pipeline
npm install
cp .env.example .env    # optional — it boots with sample data as-is
npm start
```

For production, set it up as a sibling systemd service. Create
`/etc/systemd/system/noltech-pipeline.service` modeled on
`scripts/sync-agent.service`, swapping `WorkingDirectory`, `ExecStart`
(`/usr/bin/node src/server.js`), and `Description`. Then:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now noltech-pipeline
```

Set `PIPELINE_URL=http://localhost:3001` in this agent's `.env`.

**If the pipeline enforces auth** (it sets `SHARED_AUTH_SECRET`, which you
should whenever it binds anything other than `127.0.0.1`), set the matching
`PIPELINE_AUTH_SECRET` here too — otherwise every call returns 401. A
loopback-only pipeline typically runs without a secret and needs nothing here.

**Note on cron overlap.** The pipeline runs its own discovery/analysis/refresh
crons. If you also enable this agent's browse-lots and manifest-pricer jobs,
both drive the same provider. Pick one owner per job, or you'll pay for the
same lookups twice.

**Note on sample data.** If the pipeline is still on its default `sample`
provider, this agent will refuse to persist the lots it returns — generated
auctions in a live `browse_lots` table would put fake numbers in front of real
bidding decisions. Configure a real provider first; see
`../docs/DATA-SOURCES.md`.

---

## Operations

| Task | Command |
|---|---|
| View live logs | `journalctl -u sync-agent -f` |
| View last 100 log lines | `journalctl -u sync-agent -n 100 --no-pager` |
| Restart | `sudo systemctl restart sync-agent` |
| Stop | `sudo systemctl stop sync-agent` |
| Disable on boot | `sudo systemctl disable sync-agent` |
| Re-enable on boot | `sudo systemctl enable sync-agent` |
| Status summary | `sudo systemctl status sync-agent` |
| Manual run (foreground, for debugging) | `cd ~/sync-agent && node src/index.js` |
| Update the agent | `cd ~/sync-agent && git pull && npm install --omit=dev && sudo systemctl restart sync-agent` |
| Inspect heartbeat in Supabase | `SELECT * FROM agent_heartbeats ORDER BY updated_at DESC LIMIT 5;` |
| Tail file logs | `tail -f ~/sync-agent/logs/stdout.log` |

---

## Schedule

Defaults are baked into `src/index.js` and overridable via `.env`:

| Job | Default cadence | Env override |
|---|---|---|
| Listings sync | hourly | `SYNC_LISTINGS_CRON` |
| Orders sync | every 15 min | `SYNC_ORDERS_CRON` |
| Finances sync | every 15 min | `SYNC_FINANCES_CRON` |
| Heartbeat | every minute | `HEARTBEAT_CRON` |

Use standard 5-field cron expressions for overrides
(e.g. `*/30 * * * *` for every 30 minutes).

---

## Troubleshooting

- **Agent fails to start.** Check
  `journalctl -u sync-agent -n 100 --no-pager`. The most common cause is a
  missing or malformed `.env` — `src/config.js` fails fast with a clear
  message naming the missing variable.

- **eBay 401 / `invalid_grant` errors.** The refresh token has expired or
  been revoked. In the desktop app go to Settings → eBay → "Authorize
  fresh OAuth token", complete the consent flow, copy the new refresh token
  (starts `v^1.1#i^1#...`) into `.env`, then
  `sudo systemctl restart sync-agent`.

- **Supabase RLS / "row violates policy" errors.** The agent must use the
  `service_role` key, not the `anon` key. The service key bypasses RLS;
  the anon key does not. Re-copy from Supabase dashboard → Project
  Settings → API and make sure you grabbed the one labeled `service_role`.

- **Pi runs out of memory.** Unlikely — nothing here runs a browser. If it
  still happens, lower `ANALYSIS_PER_LOT_CONCURRENCY` in the pipeline's `.env`.

- **System Health card in the desktop app shows the agent as "offline."**
  Confirm `WORKSPACE_ID` in `.env` matches the workspace the desktop app is
  connected to (Settings → Workspace shows the active workspace ID). A
  mismatched workspace ID will cause heartbeats to write to the right table
  but to a workspace the desktop app isn't reading from.

- **`EADDRNOTAVAIL` or DNS errors on boot.** The unit waits for
  `network-online.target`, but on flaky networks the eBay TLS handshake can
  still race. The service auto-restarts on failure (`Restart=on-failure`,
  `RestartSec=10s`), so transient errors clear themselves. If it loops
  forever, check `ping api.ebay.com` and your DNS resolver.

- **Logs growing too large.** `logs/stdout.log` and `logs/stderr.log` are
  append-only. Add a logrotate config at `/etc/logrotate.d/sync-agent`:
  ```
  /home/pi/sync-agent/logs/*.log {
      weekly
      rotate 4
      compress
      missingok
      notifempty
      copytruncate
  }
  ```

---

## Security notes

- **`.env` contains your service-role key.** Anyone with this key can read,
  write, or delete **all** workspace data, bypassing RLS entirely. Never
  commit it. The installer sets `chmod 600 .env`; keep it that way.
- The Pi should sit on a trusted network — your home LAN behind NAT, a
  Tailscale tailnet, or similar. Do not port-forward `3001` (the pipeline)
  to the public internet. It authenticates only if `SHARED_AUTH_SECRET` is
  set, and its lot routes spend whatever the configured provider costs.
- Use firewall rules (`ufw`) to restrict the pipeline port to your LAN:
  ```bash
  sudo ufw allow from 192.168.0.0/16 to any port 3001
  ```
- Rotate the eBay OAuth refresh token if you suspect the Pi has been
  accessed by anyone other than you.

---

## Architecture

- `src/index.js` — entrypoint. Loads config, opens the Supabase client,
  starts heartbeat + cron jobs, handles graceful shutdown.
- `src/config.js` — reads and validates `.env`. Fails fast on missing keys.
- `src/logger.js` — structured logging (JSON to file, pretty to stdout).
- `src/supabaseClient.js` — singleton Supabase client wired with the
  service-role key.
- `src/heartbeat.js` — writes a row to `agent_heartbeats` every minute so
  the desktop System Health card knows the agent is alive.
- `src/ebayAuth.js` — exchanges the refresh token for short-lived access
  tokens; caches in memory until expiry.
- `src/sync/listings.js` — pulls active listings via the Trading API,
  upserts them into Supabase.
- `src/sync/orders.js` — pulls recent orders via the Fulfillment API.
- `src/sync/finances.js` — pulls payouts + fees via the Sell Finances API.
- `src/lib/` — **pinned copies** of helpers from `NolTech-Hub` (item
  mapping, fee math, `localDateStr`). These are intentionally not symlinked
  — they're snapshotted so a bug in the desktop app can't take down the
  agent. If you change those helpers in NolTech-Hub, copy the updated
  version here and bump the agent's `package.json` version.

---

## Updating

The desktop app (`NolTech-Hub`) is the canonical source for sync logic.
When you change behavior in any of:

- `NolTech-Hub/src/hooks/useSyncAll.js`
- `NolTech-Hub/src/hooks/useEventBridge.js`
- `NolTech-Hub/src/services/syncEngine.js`
- `NolTech-Hub/src/lib/itemMapping.js`
- `NolTech-Hub/src/lib/fees.js`

mirror the change in the corresponding file under `sync-agent/src/sync/` or
`sync-agent/src/lib/`, bump the version in `package.json`, then on the Pi:

```bash
cd ~/sync-agent
git pull
npm install --omit=dev
sudo systemctl restart sync-agent
```

The Supabase migration `011_agent_heartbeats.sql` (in
`NolTech-Hub/supabase/migrations/`) creates the `agent_heartbeats` table
this agent writes to. Apply it before first run if you haven't already.
