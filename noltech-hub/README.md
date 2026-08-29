# NolTech Hub (desktop app)

The Electron + React front end. See the [root README](../README.md) for how
the three packages fit together.

## Setup

```bash
npm install
cp .env.example .env      # add your Supabase URL + anon key
npm run electron:dev
```

`electron:dev` runs Vite and Electron together and starts the
`noltech-pipeline` service in the background. If a pipeline is already
listening on port 3001, the Hub attaches to it rather than spawning a second
copy — two processes on one data directory would fight over the cache.

Browser-only development works too (`npm run dev`), with one catch:
`window.storage` is provided by the Electron preload, so anything that reads
or writes local state will fail. Use it for pure layout work.

## Supabase

The Hub needs a Supabase project for auth and multi-device sync. Apply the
migrations in `supabase/migrations/` in numeric order — they create the schema
*and* the row-level security policies. The anon key that ships in the bundle is
safe only because those policies are enforced; read them before pointing this
at real data.

## Scripts

| | |
| --- | --- |
| `npm run dev` | Vite dev server, browser only |
| `npm run electron:dev` | Vite + Electron + pipeline, the normal way to work |
| `npm run build` | Production bundle to `dist/` |
| `npm run test:build` | Build, then check bundle-size budgets |
| `npm run package` | Package a Windows build to `release/` |

## Layout

```
electron/
  main.cjs         main process, window creation, CSP
  pipeline.cjs     spawns and supervises the pipeline service
src/
  components/      shared UI + app chrome
  components/ui/   the design-system primitives — reach for these first
  context/         AppContext (inventory state), AnalyzerContext
  hooks/           sync timers, keyboard shortcuts, alerts
  modules/         one directory per feature area
  services/        pipeline client, Supabase, eBay auth, crypto, AI
  utils/           fees, formatters, tax, constants
supabase/
  migrations/      schema + RLS, applied in numeric order
```

`CLAUDE.md` in this directory is the detailed architecture and conventions
reference — read it before making structural changes.

## Conventions worth knowing before you start

- **Storage is `window.storage`**, an IndexedDB-backed key-value store from the
  Electron preload. Never `localStorage` or `sessionStorage`.
- **The pipeline URL is `PIPELINE_BASE`** from `src/utils/constants.js`. Never
  hardcode `localhost:3001`.
- **Tailwind only.** No new CSS files.
- **New storage keys go in `src/utils/backupKeys.js`**, or they'll be silently
  missing from user backups.

## A note on the data

Out of the box the pipeline serves generated sample data. The browse view will
say "Using sample data" and the numbers are fabricated. See
[docs/DATA-SOURCES.md](../docs/DATA-SOURCES.md) to connect a real source.
