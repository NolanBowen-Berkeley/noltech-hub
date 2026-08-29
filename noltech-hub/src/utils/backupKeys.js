// ─── Shared backup-key registry ───────────────────────────────────────────────
// Single source of truth for which storage keys get included in:
//   - Manual export from Settings → Data Backup
//   - Daily IndexedDB snapshots (useDailyBackup.js)
//   - Diagnostic export sanitization
//
// When adding a new storage key the app needs to persist long-term, add it
// here. Both the manual exporter and the daily snapshotter pull from this
// list, so they can never drift out of sync.

export const BACKUP_KEYS = [
  // Inventory
  'noltech:inventory:lots',
  'noltech:inventory:bundles',
  'noltech:inventory:scheduled-listings',
  // Arbitrage / sourcing
  'noltech:arbitrage:browse-lots',
  'noltech:arbitrage:bids',
  'noltech:arbitrage:watchlist',
  'noltech:arbitrage:components',
  'noltech:arbitrage:upc-cache',
  'noltech:arbitrage:upc-cache-pruned-at',
  'noltech:arbitrage:lot-notes',
  'noltech:arbitrage:imported-lots',
  'noltech:arbitrage:won-manifests',
  'noltech:arbitrage:history',
  'noltech:arbitrage:saved-searches',
  'noltech:arbitrage:ai-summaries',
  'noltech:arbitrage:lot-history',
  'noltech:arbitrage:liq-close-ratios',
  'noltech:arbitrage:show-comparables',
  // Hub UI / dashboard caches
  'noltech:settings:listing-aging-days',
  'noltech:settings:aging-alert-dismissed-until',
  'noltech:sales-tax:last-reminded',
  'noltech:hub:cash-flow-cache',
  'noltech:backup:daily-snapshots',
  'noltech:ebay:active-listings-snapshot',
  // Settings & auth
  'noltech:settings',
  'noltech:apikey',
  'noltech:pin',
  'noltech:ebay:token',
  'noltech:ebay:policies',
  'noltech:settings:darkmode',
  'noltech:sales-tax:quarter',
  'noltech:sales-tax:year',
  'noltech:sales-tax:home-state',
  'noltech:settings:sources',
  'noltech:settings:auto-sync',
  'noltech:settings:categories',
  'noltech:settings:condition-multipliers',
  'noltech:settings:ebay-fee-rate',
  'noltech:settings:resale-realization-rate',
  'noltech:settings:active-ask-buffer',
  'noltech:settings:ebay-condition-haircuts',
  'noltech:settings:auction-fee-rates',
  'noltech:settings:bstock-marketplaces',
  'noltech:settings:theme-mode',
  // Gemini AI service (encrypted key — without this, a restore loses the
  // Gemini key and the desktop part-out + title cleaner stop working).
  'noltech:gemini:apikey',
  'noltech:gemini:tier',
  // Operations module UI state
  'noltech:operations:hidden-lots',
  // Phone push webhook (ntfy.sh / Discord / custom) for bid alerts
  'noltech:settings:phone-webhook',
  // Inventory → Listing drafts (Gemini-generated, pending review/edit)
  'noltech:inventory:item-listing-drafts',
  // Testing, photos, locations
  'noltech:testing:checklists',
  'noltech:photos',
  'noltech:locations',
  'noltech:price-history',
  // SKU & labels
  'noltech:sku:counter',
  'noltech:labels:skus',
  // Notifications & repair
  'noltech:notifications',
  'noltech:repair:history',
  'noltech:repair:parts-orders',
  // Bookkeeping & sales
  'noltech:books:transactions',
  'noltech:books:locked-months',
  'noltech:books:custom-categories',
  'noltech:sales:history',
  'noltech:lotprofit:sales',
  // eBay sync
  'noltech:ebay:synced-orders',
  'noltech:ebay:refunds-emitted',
  'noltech:ebay:finances-events',
  // 1099-K reconciliation (user-entered Box 1a + Box 4 per year)
  'noltech:tax:1099k',
  'noltech:tax:set-aside',
  // Price reductor
  'noltech:pricereductor:rules',
  'noltech:pricereductor:originals',
  'noltech:pricereductor:log',
  'noltech:pricereductor:auto',
  // Auto relist
  'noltech:autorelist:config',
  'noltech:autorelist:skipped',
  'noltech:autorelist:log',
  // Returns + market repricer + shipping
  'noltech:returns:cases',
  'noltech:marketrepricer:cache',
  'noltech:shipping:settings',
  // Account & sync
  'noltech:account:tier',
  'noltech:account:trial',
  'noltech:sync:lastSyncedAt',
  'noltech:sync:skipped-orders',
  'noltech:sync:last-summary',
  'noltech:onboarding:completed',
  'noltech:errors:recent',
  'noltech:cloud:active-workspace',
  'noltech:cloud:skipped',
  'noltech:ebay:oauth-cache',
  // Repair queue + lot profit
  'noltech:repair:queue',
  'noltech:lotprofit:lots',
  'noltech:lotprofit:overlay',
  // UI state + user-defined content
  'noltech:arbitrage:browse-view-mode',
  'noltech:ui:recents',
  'noltech:ui:sidebar-collapsed',
  'noltech:messages:templates',
  // Offer management
  'noltech:offers:rules',
  'noltech:offers:log',
  'noltech:offers:auto-stats',
  // Sold-Comps Service (Lambda URL/secret + last-success timestamp)
  'noltech:soldcomps:lambda-url',
  'noltech:soldcomps:auth-secret',
  'noltech:soldcomps:last-success',
  'noltech:soldcomps:last-pull-at',
];
