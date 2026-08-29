# CLAUDE.md -- NolTech Hub

## What This App Is

NolTech Hub is a desktop app (Electron + React + Vite) for running an electronics resale business. It covers the full loop: sourcing lots, pricing manifests via UPC lookup, tracking bids, importing won lots to inventory, testing items, listing them, tracking sales, and bookkeeping.

This is a working tool, not a demo. Every change must be correct -- broken profit calculations or lost data are worse than ugly UI.

Lot and pricing data comes from pluggable providers in `../noltech-pipeline/src/providers/`, defaulting to generated sample data. See `docs/DATA-SOURCES.md`.

## Tech Stack

- **Frontend**: React 18 + Vite 5 + Tailwind CSS
- **Desktop**: Electron 41 (sandbox: true, contextIsolation: true)
- **State**: React Context + useReducer (`src/context/AppContext.jsx`) for inventory. useState for everything else.
- **Storage**: `window.storage` (IndexedDB-backed key-value via Electron preload). **NEVER use localStorage or sessionStorage.**
- **Backend**: the `noltech-pipeline` Node service on `localhost:3001` (sibling directory `../noltech-pipeline`), auto-started by the Electron main process via `electron/pipeline.cjs`. Serves lot data through its configured provider and runs the background discovery/analysis/refresh/alerts/eBay-sync crons.
- **Charts**: Recharts
- **Icons**: Lucide React
- **AI**: Anthropic API (claude-sonnet-4-20250514, max_tokens: 1000) via `src/services/ai.js`
- **Encryption**: AES-256-GCM via Web Crypto API (`src/services/crypto.js`)
- **Cloud Sync**: Supabase (Postgres + Realtime + Auth). Optional — app works offline-only if user skips login. See Cloud Sync section below.

## Architecture

```
noltech-hub/
  electron/
    main.cjs                  -- Electron main process, starts pipeline, creates window
    pipeline.cjs              -- spawns/supervises the local pipeline service
  (../noltech-pipeline/)      -- the backend service, its own package. See its README.
  src/
    App.jsx                   -- Root: PinLock -> ErrorBoundary -> AppProvider -> Shell
    context/AppContext.jsx     -- Global state (lots/items), event-emitting dispatch
    services/
      ai.js                   -- Anthropic API wrapper
      arbitrage.js            -- Lot fetch/enrichment client + bid math helpers
      crypto.js               -- AES-256-GCM encrypt/decrypt for secrets
      ebayAuth.js             -- eBay OAuth token exchange + refresh
      enrichmentService.js    -- Manifest UPC pricing pipeline
      eventBus.js             -- Pub/sub for cross-module communication
      lotHistory.js           -- Historical lot/UPC trend storage
      storage.js              -- window.storage wrapper helpers
      supabase.js             -- Supabase client + auth/workspace/invite helpers
      syncEngine.js           -- Cloud sync (outbound writes, realtime subs, retry)
      tiers.js                -- Scout/Pro/Business tier gating
    hooks/
      useEventBridge.js       -- Listens to events, auto-dispatches (sale->bookkeeping, bid->budget)
      useAutoSync.js          -- Background timers for lot refresh, pricing, eBay order sync
      useSyncAll.js           -- Manual full sync (lots + price + eBay orders)
      usePagination.js        -- Generic pagination hook
    utils/
      constants.js            -- PIPELINE_BASE, storage keys, categories, sources, BUSINESS_DEFAULTS
      fees.js                 -- eBay/Mercari/FB fee calculators, profit math
      formatters.js           -- fmt(), formatDate(), formatDateTime(), formatPct()
      fetchWithRetry.js       -- Fetch with retries, linear backoff, timeout
      safeStorage.js          -- safeSet/safeGet with error logging + notifications
    components/               -- Shared: Sidebar, ErrorBoundary, EmptyState, PinLock, etc.
    modules/                  -- Feature modules
      hub/                    -- HubHome, HubDashboard (top-level dashboard + tabs)
      inventory/              -- InventoryHub, OperationsHub, EbayOrderSync, ItemManager, etc.
      bidding/                -- BiddingHub (bid tracking + budget + won-lot importer)
      sourcing/               -- SourceHub (browse lots, watchlist, deal analyzer)
      selling/                -- SellingHub (PriceReductor, ListingPerformance, AutoRelist)
      finance/                -- FinanceHub (ROIChart, TaxExport, SeasonalInsights)
      bookkeeping/            -- Bookkeeping (income/expense tracking, charts)
      lot-profit/             -- LotProfitTracker (per-lot P&L)
      price-reductor/         -- PriceReductor (automated price reduction rules)
      tickets/                -- TicketHub for the secondary ticket-resale niche
      settings/               -- Settings, DataBackup, SourceManager, CategoryManager
      arbitrage/              -- Shared component library (see note below)
```

**Note on `modules/arbitrage/`**: This is no longer a feature module of its own. It is a shared-component library (BidTracker, BrowseLotsView, ComponentDB, DealAnalyzer, ListingGenerator, LotCard, LotHistoryViewer, Watchlist, WonLotImporter, componentData) consumed by the Bidding, Selling, and Sourcing hubs. There is no `ArbitrageScanner` page; treat these as primitives.

## Critical Rules

### Storage
- ALL persistence uses `window.storage.get(key)` / `window.storage.set(key, value)`
- ALWAYS wrap in try/catch. Use `safeSet`/`safeGet` from `src/utils/safeStorage.js` for critical writes.
- Keys follow pattern: `noltech:{module}:{entity}` (e.g., `noltech:arbitrage:bids`)
- The primary data store is `noltech:inventory:lots` -- an array of Lot objects with embedded Item arrays
- When adding new storage keys, also add them to `BACKUP_KEYS` in `src/utils/backupKeys.js` (single source of truth for manual export + daily snapshots)

### URLs
- The pipeline URL is `PIPELINE_BASE` exported from `src/utils/constants.js`. NEVER hardcode `localhost:3001`.

### Events
- Cross-module communication uses `eventBus` from `src/services/eventBus.js`
- Key events: `item:added`, `item:updated`, `item:deleted`, `item:status-changed`, `sale:recorded`, `lot:deleted`, `bid:status-changed`, `lot:imported`, `lots:fetched`, `ebay:orders-synced`, `price:changed`
- `useEventBridge.js` auto-handles: sale->bookkeeping transaction, sale->sales history, bid won->budget entry, bid won->manifest backup
- Uses `serialWrite()` for concurrent-safe storage updates

### Formatting
- Import `fmt`, `formatDate`, `formatDateTime`, `formatPct` from `src/utils/formatters.js`. NEVER define local formatting functions.
- Currency: always `fmt(n)` which returns `$X.XX` or `$--` for null
- Dates: `formatDate` (date only), `formatDateTime` (date + time), `formatDateShort` (no year)

### Fees
- Use `getEbayFeeRate()` from `src/utils/fees.js` (user-configurable, default 9.35%)
- Platform fee calculators: `calcPlatformFees(platform, price, shipping)`
- Profit math: `calcItemProfit(item, lot)` returns `{ costBasis, netRevenue, profit, roi, margin }`

### Code Style
- Functional components only, hooks for state
- Tailwind classes inline (no CSS files)
- Design system colors: primary `#1A5276`, secondary `#2E86C1`, accent `#F39C12`, success `#27AE60`, danger `#E74C3C`
- Cards: `bg-white rounded-xl border border-slate-200 shadow-sm p-5`
- Profit in green, losses in red, break-even in amber
- Loading states: skeleton screens (`animate-pulse`), never spinners (exception: inline loaders use `Loader2` from lucide)
- Empty states: use `<EmptyState>` from `src/components/EmptyState.jsx`
- Hub modules use React.lazy + Suspense for code splitting
- Tab bars: `bg-white border border-slate-200 rounded-xl p-1 shadow-sm` with active tab `bg-primary text-white`

### Security
- Secrets (API keys, eBay tokens) encrypted with AES-256-GCM via `src/services/crypto.js`
- PIN uses PBKDF2 (100k iterations) with random salt
- CSP split by env in `electron/main.cjs` (prod removes `unsafe-eval`)
- Electron: sandbox true, contextIsolation true, nodeIntegration false

## Cloud Sync

Supabase-backed real-time sync for multi-device workspaces. **Optional** — app runs offline-only if user skips login.

### Key files
- `src/services/supabase.js` — Client + auth/workspace/invite helpers
- `src/services/syncEngine.js` — Outbound writes, inbound subscriptions, retry logic, conflict detection
- `src/components/LoginScreen.jsx` — Auth UI (sign up, sign in, workspace picker, join by invite code)
- `src/components/InitialSyncScreen.jsx` — First-time download on new device
- `src/components/SyncStatusIndicator.jsx` — Cloud icon in sidebar (idle/syncing/synced/offline/error)
- `src/modules/settings/WorkspaceSettings.jsx` — Upload/download, invite codes, member management
- `src/modules/settings/AuditLogViewer.jsx` — Change history with who/what/when
- `supabase/migrations/*.sql` — Schema, RLS policies, triggers

### How it works
1. **Local-first**: IndexedDB remains source of truth. Cloud sync is a background layer.
2. **Dispatch interception**: `AppContext` calls `syncEngine.onAction(action)` after every dispatch. Sync engine mirrors ADD/UPDATE/DELETE to Supabase.
3. **Storage interception**: `storage.set()` calls a sync hook for synced keys (bids, transactions, user prefs, settings). Diffs against last-known state and pushes only changed rows.
4. **Realtime subscriptions**: `supabase.channel(workspace)` subscribes to postgres_changes on lots, items, bids, transactions, sales_history, workspace_settings, user_preferences. On inbound change, dispatches action with `_fromSync: true` to avoid echo.
5. **Echo prevention**: Each local write marked in `_recentLocalWrites`. Incoming changes for recent writes are ignored.
6. **Retry**: Failed writes queued with exponential backoff (2s → 5s → 15s → 30s → 60s, max 5 attempts).

### What syncs vs what doesn't
**Synced** (cloud-shared): inventory lots+items, bids, transactions, sales history, workspace settings (condition multipliers, categories, fee rate, auto-sync, price rules), user preferences (watchlist, notes, saved searches, alerts).

**Device-local only**: `noltech:arbitrage:upc-cache`, `noltech:arbitrage:browse-lots`, eBay token, API key, PIN, dark mode, notifications, onboarding flag.

### When adding a new feature that writes data
- **If it uses `dispatch()` (lots/items)**: Sync happens automatically via `syncEngine.onAction()`. No changes needed.
- **If it writes to `window.storage.set()` with a new key that should sync**: Add the key to `ARRAY_SYNC_CONFIG` (array-based) or `OBJECT_SYNC_CONFIG` (object-based) in `syncEngine.js`. Also add the matching column to `workspace_settings` or `user_preferences` in a SQL migration.
- **If the table is new**: Add migration SQL to `supabase/migrations/`, add table to `supabase_realtime` publication, add RLS policies, add to `uploadLocalData()` and `downloadWorkspace()`, subscribe in `subscribeRealtime()`.

### Key events
- `sync:array-updated` — fired when inbound cloud change updates a synced array. UI components should listen and reload.
- `sync:object-updated` — same, for object-based keys.
- `sync:conflict` — fired when a teammate's edit overrides your view. ToastContainer shows warning.
- `notification:push` — generic toast (used by retry failure, sync complete, etc.)

### Auth flow gates in App.jsx
1. PIN lock (local)
2. Cloud auth check: if enabled and session missing → LoginScreen
3. If logged in but local data empty → InitialSyncScreen
4. Then AppProvider (starts sync engine) + Shell

## Self-Improvement Guide

When asked to improve the app, follow this process:

### 1. Audit Before Acting
- Run `npx vite build` to check current bundle size and warnings
- Grep for anti-patterns: `grep -r "localhost:3001" src/` (should only be in constants.js)
- Grep for silent catches: `grep -rn "catch.*{}" src/` -- these hide bugs
- Check `src/utils/backupKeys.js` BACKUP_KEYS vs actual storage keys used in codebase
- Look for local `fmt`/`formatDate` definitions that should import from formatters.js

### 2. Priority Order for Improvements
1. **Data integrity** -- backup completeness, storage write safety, race conditions
2. **Bug fixes** -- broken features, wrong calculations, silent failures
3. **Error visibility** -- replace `.catch(() => {})` with user-visible errors
4. **Performance** -- code splitting, memoization, pagination for large lists
5. **UI consistency** -- empty states, consistent headers, loading skeletons
6. **New features** -- only after the above are clean

### 3. Where to Look for Issues

**Common problem spots:**
- `src/hooks/useAutoSync.js` -- background timers, API calls, error handling
- `src/hooks/useSyncAll.js` -- full sync logic, eBay credential decryption
- `src/hooks/useEventBridge.js` -- cross-module event reactions, storage writes
- `src/modules/sourcing/SourceHub.jsx` and `src/modules/bidding/BiddingHub.jsx` -- consume the shared `arbitrage/` component library; complex cross-module state
- `src/modules/arbitrage/BrowseLotsView.jsx`, `BidTracker.jsx`, `DealAnalyzer.jsx` -- heaviest shared components
- `src/utils/backupKeys.js` -- canonical BACKUP_KEYS list (was previously in DataBackup.jsx)
- `../noltech-pipeline/src/routes/` -- API endpoints, caching, rate limiting

**Check these patterns:**
- Every `fetch()` call should use `fetchWithRetry` or at minimum have `AbortSignal.timeout()`
- Every storage write in event handlers should use `serialWrite()` or `safeSet()`
- Every new storage key needs to be added to `src/utils/backupKeys.js` BACKUP_KEYS
- Every hub module should have: title + subtitle, loading skeleton, error boundary coverage
- List views with potentially unbounded data should use `usePagination`
- Expensive `.map()` renders should use `React.memo` on extracted row components

### 4. How to Add a New Module
1. Create directory in `src/modules/{name}/`
2. Create main component, export default
3. Lazy-load in parent hub or `App.jsx`: `const MyModule = lazy(() => import('./modules/{name}/MyModule'))`
4. Add to Sidebar (`src/components/Sidebar.jsx`) with icon and section
5. Add route in `App.jsx` Shell: `{view === 'mymodule' && <MyModule />}`
6. Add any new storage keys to `src/utils/backupKeys.js` BACKUP_KEYS
7. Emit relevant events via `eventBus` for cross-module integration
8. Wire into `useEventBridge.js` if other modules need to react

### 5. How to Add a New Data Source
Sources are providers, not scrapers. Do NOT add code that fetches and parses a
site's HTML to get around its terms of service.

1. Write a module exporting `lotProvider` and/or `compsProvider` — the full
   interface is in `../docs/DATA-SOURCES.md`
2. Point the pipeline at it: `LOT_PROVIDER=custom` +
   `LOT_PROVIDER_MODULE=/path/to/it` in `../noltech-pipeline/.env`
3. Add your source IDs to `LOT_SOURCES` so the fan-out includes them
4. Add the source to `src/utils/constants.js` SOURCES array
5. Add it to `src/modules/settings/SourceManager.jsx` built-in list

### 6. Testing Changes
- `npx vite build` -- must compile with no errors
- Check the dev server: `npx vite` -- navigate through all tabs
- Verify backup: Settings > Data Backup > Export -- inspect JSON for new keys
- If touching shared `arbitrage/` components: test BrowseLotsView via SourceHub, BidTracker via BiddingHub
- If touching fees/profit: verify calculations match `fees.js` formulas exactly

### 7. What NOT to Do
- Don't add localStorage/sessionStorage -- always window.storage
- Don't hardcode `localhost:3001` -- use `PIPELINE_BASE` from constants
- Don't define local formatting functions -- import from formatters.js
- Don't add npm dependencies without strong justification (bundle size matters)
- Don't create new CSS files -- Tailwind only
- Don't add features that don't connect to the existing data flow
- Don't add a scraper. Add a provider -- see `../docs/DATA-SOURCES.md`
- Don't commit a `.env`, a `dist/`, or any real business data
- Don't break the event bus chain -- modules depend on events flowing correctly
- Don't store secrets in plain text -- use crypto.js encrypt/decrypt

## Current Storage Keys Reference

Canonical list lives in `src/utils/backupKeys.js`. Highlights below — consult that file for the authoritative set when adding/removing keys.

```
Inventory:    noltech:inventory:{lots, bundles, scheduled-listings}
Arbitrage:    noltech:arbitrage:{browse-lots, bids, watchlist, components,
              upc-cache, lot-notes, imported-lots, won-manifests, history,
              saved-searches, ai-summaries, lot-history, show-comparables,
              browse-view-mode}
Hub/UI:       noltech:hub:cash-flow-cache, noltech:ui:{recents, sidebar-collapsed,
              active-niche}, noltech:settings:listing-aging-days,
              noltech:backup:daily-snapshots, noltech:ebay:active-listings-snapshot
Bookkeeping:  noltech:books:transactions, noltech:sales:history,
              noltech:lotprofit:{sales, lots, overlay}
eBay:         noltech:ebay:{token, synced-orders, oauth-cache}
Selling:      noltech:pricereductor:{rules, originals, log, auto},
              noltech:autorelist:{config, skipped, log},
              noltech:offers:{rules, log}, noltech:marketrepricer:cache,
              noltech:returns:cases, noltech:shipping:settings
Settings:     noltech:settings (general), noltech:settings:{darkmode, sources,
              auto-sync, categories, condition-multipliers, ebay-fee-rate,
              resale-realization-rate, active-ask-buffer, ebay-condition-haircuts,
              auction-fee-rates, bstock-marketplaces}
Sales tax:    noltech:sales-tax:{quarter, year, home-state, last-reminded}
Auth:         noltech:apikey, noltech:pin, noltech:account:{tier, trial}
Tickets:      noltech:tickets:{events, lots, listings, sales, transfers,
              watchlist, presale-codes, settings, alerts, auto, offers}
Cloud sync:   noltech:cloud:{active-workspace, skipped},
              noltech:sync:{lastSyncedAt, skipped-orders, last-summary}
Misc:         noltech:testing:checklists, noltech:photos, noltech:locations,
              noltech:price-history, noltech:sku:counter, noltech:labels:skus,
              noltech:notifications, noltech:repair:{history, parts-orders, queue},
              noltech:messages:templates, noltech:onboarding:completed
```
