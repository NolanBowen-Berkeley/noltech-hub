# NolTech Hub

A desktop operations app for a small electronics resale business: buy pallets
of returned or salvage inventory, work out what's in them, price the parts,
list them, and keep the books straight.

Three pieces:

| | What it is | Runs as |
| --- | --- | --- |
| **`NolTech-Hub/`** | The desktop app — React + Electron | On your machine |
| **`noltech-pipeline/`** | Local HTTP service: lot data, manifest parsing, pricing, background jobs | `localhost:3001`, started by the Hub |
| **`sync-agent/`** | Headless eBay ⇄ Supabase sync, meant for an always-on box | A Pi, a VM, a spare laptop |

State lives in Supabase (Postgres + auth + realtime), so the Hub on a laptop
and an agent on a Pi see the same data.

---

## Quick start

```bash
cd noltech-pipeline && npm install && npm start
```

That's the whole first step. The pipeline boots with **no configuration** —
it ships with a sample data provider, so there's nothing to sign up for
before you can see it work. Check it:

```bash
curl localhost:3001/health
curl localhost:3001/diag/providers
curl "localhost:3001/api/lots/all" | head -c 400
```

Then the Hub:

```bash
cd NolTech-Hub && npm install && cp .env.example .env
# fill in your Supabase URL + anon key, then:
npm run electron:dev
```

The Hub needs a Supabase project for auth and storage. Apply the migrations in
`NolTech-Hub/supabase/migrations/` in numeric order.

---

## About the data

**This build ships with generated sample data, not a live market feed.**

The private version this was derived from got its lot listings and sold-price
comparables by scraping auction sites through a bot-detection-evading proxy.
That code isn't here — it violated those sites' terms of service, and it broke
every time their markup changed, silently.

What's here instead is a **provider interface**. Everything the pipeline knows
about the outside world comes through one of two small contracts, and swapping
the implementation is a config change:

```bash
# noltech-pipeline/.env
COMPS_PROVIDER=ebay-browse      # real prices via eBay's official API
LOT_PROVIDER=custom             # your own supplier feed, CSV drop, whatever
LOT_PROVIDER_MODULE=/path/to/my-provider.js
```

The default `sample` provider generates plausible lots, manifests, and price
comparables so a fresh clone runs end to end — the browse UI populates, the
analysis queue drains, the scoring model produces numbers. **It tells you
nothing true about the market.** Responses are flagged `sample: true`,
`/health` reports `usingSampleData`, the Hub labels the view, and the sync
agent refuses to write sample lots into your database.

Read [docs/DATA-SOURCES.md](docs/DATA-SOURCES.md) before you point this at a
real buying decision. It covers the built-in eBay Browse provider (and why
asking prices aren't sold prices), how to write your own, and where to source
data you're actually allowed to use.

---

## What it does

**Sourcing and analysis** — pull in candidate lots, parse their manifests into
line items, categorize and condition-tag each one, price them against
comparables, and score the lot against a bid ceiling. Track bids, get alerted
when an auction you're watching is closing, and record what it actually closed
at so the model gets better.

**Inventory** — receive won lots, break them into SKUs, run a testing
checklist, manage photos, track bin locations, generate listing drafts.

**Selling** — eBay listing creation, price reduction rules, best-offer
handling, relisting aged inventory, returns.

**Books** — order and payout reconciliation against eBay Finances, cost-of-
goods allocation across a lot, sales tax reports, 1099-K reconciliation, tax
export.

---

## Architecture notes

The pipeline's route handlers use the Web Fetch signature —
`(Request, env, ctx, log) → Response` — with a small `node:http` adapter at
the edge. That's a leftover from a serverless deployment, kept because it
means the handlers are portable and trivially testable: a route is a function
from a Request to a Response, with no framework in between.

Manifest parsing is deliberately split from manifest fetching.
`src/shared/manifestTable.js` takes a header/row table and produces enriched,
categorized items — it doesn't know or care whether that table came from an
API, a CSV, or a saved HTML page. That split is what let the scrapers be
removed without touching any of the column-mapping, condition-inference, or
scoring logic.

Both the HTTP routes and the cron jobs call the same functions. There is no
second code path for background work.

---

## Security

Read [SECURITY.md](SECURITY.md) before pointing this at anything real. The
short version: the Supabase anon key is public by design and safe only because
row-level security is enforced — review the policies in
`NolTech-Hub/supabase/migrations/` yourself. The service-role key bypasses RLS
entirely and belongs only in `noltech-pipeline/.env` and `sync-agent/.env`,
never in the Hub. Never commit `dist/` — Vite inlines `VITE_*` variables into
the bundle at build time.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). One rule worth stating up front: no
scrapers. If you need a data source that isn't supported, write a provider.

## License

MIT — see [LICENSE](LICENSE).
