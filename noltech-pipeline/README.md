# noltech-pipeline

The local HTTP service the Hub talks to. It owns everything between "a lot
exists somewhere" and "the Hub shows a scored, priced manifest for it."

- **Lot data** — search, manifests, images, and closing prices, all sourced
  through a pluggable provider (see [Data providers](#data-providers))
- **Manifest parsing** — a raw header/row table becomes categorized,
  condition-tagged, model-identified line items
- **Pricing** — sold-comparable lookup with a two-tier cache (Supabase for
  aggregates, disk KV for per-UPC results)
- **Scoring** — bid ceilings from manifest value, condition mix, and fees
- **Background jobs** — discovery, analysis, refresh, bid alerts, eBay sync

Node 20+. No build step.

---

## Quick start

```bash
npm install
npm start
```

There is deliberately nothing to configure first. The default providers
generate sample data, so the service is useful the moment it boots:

```bash
curl localhost:3001/health
curl localhost:3001/diag/providers
curl "localhost:3001/api/lots/all" | head -c 400
```

Copy `.env.example` to `.env` when you're ready to add Supabase, eBay, or a
real data provider. Every variable is optional; the service warns at startup
about which features are dark rather than refusing to boot.

```bash
npm start                  # serve HTTP + run crons
npm run serve-only         # HTTP only, no crons
npm run run-once discovery # run one cron task, print the result, exit
npm run health             # pretty-print /health
```

The Hub talks to `PIPELINE_BASE` (`http://localhost:3001`, in
`noltech-hub/src/utils/constants.js`) and starts this service automatically —
see `noltech-hub/electron/pipeline.cjs`. If something is already listening on
the port, the Hub attaches to it instead of spawning a second copy.

---

## Data providers

Every piece of outside-world data arrives through one of two provider
interfaces in `src/providers/`. Nothing else in this codebase fetches lot or
pricing data directly.

| Variable | Options | Default |
| --- | --- | --- |
| `LOT_PROVIDER` | `sample`, `custom` | `sample` |
| `COMPS_PROVIDER` | `sample`, `ebay-browse`, `custom` | `sample` |
| `LOT_SOURCES` | comma-separated source IDs | `sample` |

**`sample`** generates deterministic lots, manifests, lot states, and price
comparables offline. It exists so a fresh clone runs end to end — and it tells
you nothing true about the market. Responses carry `sample: true`, `/health`
reports `usingSampleData`, and the sync agent refuses to persist sample lots.

**`ebay-browse`** is real: eBay's official Browse API with your own developer
credentials. Note that Browse returns *active* listings — asking prices, not
sold prices. Treat the numbers as an upper bound.

**`custom`** loads any module exporting `lotProvider` / `compsProvider`:

```bash
COMPS_PROVIDER=custom
COMPS_PROVIDER_MODULE=/absolute/path/to/my-provider.js
```

Full interface reference, plus guidance on sourcing data you're authorized to
use: **[../docs/DATA-SOURCES.md](../docs/DATA-SOURCES.md)**.

---

## Configuration

Nothing is hard-required. At boot the service prints one warning per
capability it can't provide:

```json
{"level":"warn","event":"env_gap","feature":"discovery / analysis / refresh / alerts crons",
 "missing":["SUPABASE_URL","SUPABASE_SERVICE_KEY","WORKSPACE_ID"],
 "impact":"background jobs error out; HTTP lot routes still work"}
```

| Capability | Needs | Without it |
| --- | --- | --- |
| Crons | `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `WORKSPACE_ID` | Background jobs error; lot routes still work |
| `/comps/lookup` | Same | Returns 500 — the sold-comps cache is a Supabase table |
| Real pricing | `EBAY_APP_ID`, `EBAY_CERT_ID` + `COMPS_PROVIDER=ebay-browse` | Falls back to generated comps |
| eBay order sync | Above plus `EBAY_REFRESH_TOKEN` | `ebay-sync` cron fails |
| AI part-out | `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` | Part-out estimates unavailable |

### Binding and auth

`PIPELINE_BIND_HOST` defaults to `127.0.0.1` and runs without auth there —
the right default for a desktop install.

> **Binding a LAN address requires `SHARED_AUTH_SECRET`.** The lot routes will
> spend whatever your configured provider costs on behalf of anyone who can
> reach the port. `/health`, `/diag/providers`, and `/lots/image` stay public
> even with a secret set; the image proxy has to be, because browsers can't
> attach an `Authorization` header to an `<img src>`.

Everything else expects `Authorization: Bearer <secret>`.

### Crons

| Task | Default | Override |
| --- | --- | --- |
| `analysis` | every 5 min | `CRON_ANALYSIS` |
| `alerts` | every 5 min | `CRON_ALERTS` |
| `refresh` | every 15 min | `CRON_REFRESH` |
| `discovery` | every 30 min | `CRON_DISCOVERY` |
| `ebay-sync` | every 30 min | `CRON_EBAY_SYNC` |

Set any to `off` to disable it, or `CRONS_ENABLED=false` for all. A task never
runs twice concurrently — if a pass is still going when the next tick fires,
that tick is skipped and logged as `cron_overlap_skipped`.

Run one on demand:

```bash
npm run run-once -- discovery
curl -X POST localhost:3001/run -H 'content-type: application/json' -d '{"task":"discovery"}'
```

---

## Storage

Two disk-backed stores under `.data/` (override with `PIPELINE_DATA_DIR`):

| Path | Holds |
| --- | --- |
| `.data/kv/` | Search results, manifests, UPC pricing, eBay call counts |
| `.data/images/` | Proxied lot images |

`src/runtime/kv.js` and `src/runtime/r2.js` implement a Workers-KV / R2-shaped
API (`get`/`put`/`delete`/`list` with TTLs and cursors). Both are pure cache —
safe to delete while stopped. Wipe them from the Hub (Settings → Data Backup)
or directly:

```bash
curl -X POST localhost:3001/admin/flush-caches -H 'content-type: application/json' -d '{}'
```

Supabase is the pipeline's work queue and the Hub's multi-device sync layer.

---

## Routes

Both `/api/...` and bare `/...` forms are accepted.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Status, provider identity, live cron state. Public. |
| GET | `/diag/providers` | Which providers are configured and what they support. Public. |
| GET | `/lots/all` | Fan-out across `LOT_SOURCES` |
| GET | `/lots/all/stream` | Same, as SSE with per-source progress |
| GET | `/lots/sample` | Generated fixtures, bypassing the provider |
| GET | `/lots/manifest` | Manifest table by `?lotId=` or `?lotUrl=` |
| GET | `/lots/image` | Image proxy. Public. |
| POST | `/lots/closing-price` | Final bid / auction state |
| POST | `/lots/enrich` | Manifest fetch + per-item pricing |
| POST | `/comps/lookup` | Sold-comparable lookup |
| GET | `/upc-cache` | Full UPC pricing cache; the Hub merges it locally |
| GET | `/ebay/call-stats` | Browse API quota usage for today |
| GET/POST | `/lots/discover` | Discovery pass |
| GET | `/lots/:id/manifest` | Enriched manifest items by path param |
| POST | `/lots/:id/analyze` | Score one lot |
| POST | `/lots/:id/refresh` | Refresh one lot |
| POST | `/ebay/sync` | eBay sync, manual trigger |
| POST | `/run` | Run a cron task by name |
| POST | `/admin/flush-caches` | Clear disk caches |

---

## Running headless

The Hub starting the pipeline means crons only run while the Hub is open. To
keep discovery and alerts running around the clock, run it as a service — the
Hub detects the already-listening port and attaches instead of spawning a
second copy.

**Linux (systemd)** — model it on `noltech-sync-agent/scripts/sync-agent.service`,
swapping `WorkingDirectory` and `ExecStart=/usr/bin/node src/server.js`.

**Windows (Task Scheduler)** — trigger "At log on", action `node.exe`,
arguments `src\server.js`, "Start in" the pipeline directory.

Running it on a different machine than the Hub means setting
`PIPELINE_BIND_HOST=0.0.0.0` **and** `SHARED_AUTH_SECRET`, then pointing the
Hub at it under Settings → Local Pipeline. `noltech-sync-agent` reads the same secret
from `PIPELINE_AUTH_SECRET`.

---

## Architecture

```
src/
  server.js              entrypoint — HTTP server, graceful shutdown, CLI flags
  index.js               route table + cron dispatch
  providers/             ← the only thing that talks to the outside world
    index.js             registry, resolution, capability probing
    sample.js            generated lots + comps (default)
    ebayBrowse.js        eBay Browse API comps
    fixtures.js          deterministic data generators
  runtime/
    env.js               builds `env` from .env + binds the disk stores
    kv.js / r2.js        disk-backed KV + blob stores
    ctx.js               ExecutionContext shim (waitUntil)
    httpAdapter.js       node:http ↔ Web Request/Response
    scheduler.js         node-cron driver, overlap guard
    cronRegistry.js      task names, schedules, live run-state
  routes/                HTTP handlers — (Request, env, ctx, log) → Response
  services/              Supabase, eBay, Gemini, pricing internals
  shared/                manifest table parsing, scoring, classification
```

Route handlers use the Web Fetch signature and `runtime/httpAdapter.js`
translates `node:http` at the edge. A route is a function from a Request to a
Response with no framework in between — which makes them portable and testable
without spinning up a server.

`shared/manifestTable.js` is deliberately transport-agnostic: it takes a
header/row table, not a URL. Keeping the parse separate from the fetch is what
let the data source become pluggable without touching column mapping,
condition inference, or scoring.

---

## Troubleshooting

**"Not running" in the Hub's System Health card.** The child process died or
never started. Run `npm start` here and read the error — most often
`npm install` hasn't been run.

**Port 3001 already in use.** Another copy is running; the Hub attaches to it.
Find it with `lsof -i :3001` (macOS/Linux) or
`netstat -ano | findstr :3001` (Windows).

**Everything returns generated data.** That's the default. `curl
localhost:3001/diag/providers` — if `usingSampleData` is true, configure a real
provider ([../docs/DATA-SOURCES.md](../docs/DATA-SOURCES.md)).

**A route returns 501.** The configured provider doesn't implement that method.
`/diag/providers` lists what each one supports. Partial providers are
supported by design.

**Crons log `SUPABASE_URL or SUPABASE_SERVICE_KEY missing`.** Expected with no
Supabase configured. Only background jobs need it; HTTP routes still work.

**Images don't render in the Hub.** In a packaged build this is usually the
CSP: `electron/main.cjs` must list the pipeline origin in both `img-src` and
`connect-src`.

---

## Known gaps

- **Condition multipliers** (Hub → Settings) have no consumer. They fed a
  since-deleted MSRP estimator; the pipeline derives condition via
  `shared/condition.js` without a per-condition multiplier. The setting is
  still stored and synced, so wiring it back in is a scorer change.
- **Packaged builds** need `noltech-pipeline/` (with `node_modules`) shipped
  under `resources/`. `electron/pipeline.cjs` looks there, but the packager
  config doesn't copy it yet — so a packaged Hub currently relies on the repo
  checkout being present.
