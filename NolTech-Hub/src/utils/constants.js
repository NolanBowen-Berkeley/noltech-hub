export const SOURCES = [
  { value: 'liquidation.com', label: 'Liquidation.com' },
  { value: 'techliquidators', label: 'TechLiquidators' },
  { value: 'local', label: 'Local' },
  { value: 'other', label: 'Other' },
];

export const CONDITIONS = [
  { value: 'new',      label: 'New' },
  { value: 'like_new', label: 'Like New' },
  { value: 'good',     label: 'Good' },
  { value: 'fair',     label: 'Fair' },
  { value: 'poor',     label: 'Poor' },
  { value: 'broken',   label: 'Broken' },
];

export const GRADES = ['A', 'B', 'C', 'D', 'F'];

export const DEFAULT_CATEGORIES = [
  { value: 'laptop',      label: 'Laptop' },
  { value: 'desktop',     label: 'Desktop' },
  { value: 'gpu',         label: 'GPU' },
  { value: 'cpu',         label: 'CPU' },
  { value: 'ram',         label: 'RAM' },
  { value: 'ssd',         label: 'SSD / HDD' },
  { value: 'motherboard', label: 'Motherboard' },
  { value: 'psu',         label: 'PSU' },
  { value: 'monitor',     label: 'Monitor' },
  { value: 'phone',       label: 'Phone' },
  { value: 'tablet',      label: 'Tablet' },
  { value: 'networking',  label: 'Networking' },
  { value: 'server',      label: 'Server' },
  { value: 'peripheral',  label: 'Peripheral' },
  { value: 'other',       label: 'Other' },
];

// Mutable categories — updated at runtime via settings
let _categories = [...DEFAULT_CATEGORIES];

export function getCategories() { return _categories; }
export function setCategories(cats) { _categories = cats; CATEGORIES.length = 0; cats.forEach(c => CATEGORIES.push(c)); }

export async function loadCategories() {
  try {
    const saved = await window.storage.get('noltech:settings:categories');
    if (Array.isArray(saved) && saved.length > 0) {
      setCategories(saved);
    }
  } catch (e) {
    console.error('Failed to load custom categories:', e);
  }
}

// Backward-compatible mutable export — same array reference, mutated in place by setCategories
export const CATEGORIES = [...DEFAULT_CATEGORIES];

export const PLATFORMS = [
  { value: 'ebay',     label: 'eBay' },
  { value: 'mercari',  label: 'Mercari' },
  { value: 'facebook', label: 'FB Marketplace' },
  { value: 'local',    label: 'Local' },
  { value: 'other',    label: 'Other' },
];

export const ITEM_STATUSES = [
  { value: 'received',   label: 'Received' },
  { value: 'testing',    label: 'Testing' },
  { value: 'listed',     label: 'Listed' },
  { value: 'sold',       label: 'Sold' },
  { value: 'parted_out', label: 'Parted Out' },
  { value: 'recycled',   label: 'Recycled' },
];

// Terminal status is 'listed' — the LotProcessor auto-promotes lots to
// 'listed' once every item lands in a terminal item state. A previously
// declared 'completed' value was unreachable (no writer set it) so it was
// removed; any historic lot row carrying status='completed' will still
// render via its raw value, but no UI emits it going forward.
export const LOT_STATUSES = [
  { value: 'received',   label: 'Received' },
  { value: 'processing', label: 'Processing' },
  { value: 'listed',     label: 'Listed' },
];

// Storage keys
export const STORAGE_KEY               = 'noltech:inventory:lots';
export const ANALYZER_STORAGE_KEY      = 'lotlister:lots';
export const SETTINGS_KEY              = 'noltech:settings';
export const API_KEY_STORAGE           = 'noltech:apikey';
export const PIN_KEY                   = 'noltech:pin';
export const ARBITRAGE_COMPONENTS_KEY  = 'noltech:arbitrage:components';
export const ARBITRAGE_HISTORY_KEY     = 'noltech:arbitrage:history';
export const EBAY_TOKEN_KEY            = 'noltech:ebay:token';
export const EBAY_SYNC_LOT_ID          = 'noltech-ebay-sync-lot';
export const PIPELINE_BASE              = 'http://localhost:3001';

// agent_id written to Supabase agent_heartbeats by the noltech-pipeline
// eBay sync cron. SystemHealthCard reads heartbeats keyed by this exact
// string. KEEP IN SYNC with EBAY_SYNC_AGENT_ID at the top of
// noltech-pipeline/src/services/ebay/persist.js — renaming in only one
// repo will silently break the eBay Sync tile (it'll never find a
// matching heartbeat row).
export const EBAY_SYNC_AGENT_ID        = 'ebay-sync-worker';

// ─── Local pipeline (noltech-pipeline Node service) ──────────────────────────
// The pipeline serves the lot routes plus the background crons. Electron
// starts it automatically on PIPELINE_BASE; these keys only need setting if you
// run it somewhere else (a Pi on the LAN, a different port).
//
//   PIPELINE_BASE_KEY  — override URL. Empty ⇒ PIPELINE_BASE.
//   PIPELINE_TOKEN_KEY — bearer token, stored encrypted. Only needed when the
//                        service binds a non-loopback address.
//
// Set both via Settings → Local Pipeline. See src/services/pipelineFetch.js.
export const PIPELINE_BASE_KEY  = 'noltech:settings:pipeline-base';
export const PIPELINE_TOKEN_KEY = 'noltech:settings:pipeline-token';

// Superseded by the two keys above when the Cloudflare Worker was retired.
// Referenced only by the one-time migration in src/utils/pipelineMigration.js,
// which salvages a custom host/token and discards dead *.workers.dev URLs.
export const LEGACY_CLOUD_SCRAPER_BASE_KEY  = 'noltech:settings:cloud-scraper-base';
export const LEGACY_CLOUD_SCRAPER_TOKEN_KEY = 'noltech:settings:cloud-scraper-token';

// ─── Business Defaults ───────────────────────────────────────────────────────
// Your shop's identity. These feed listing copy, packing slips, and shipping
// estimates, so set them before generating anything a buyer will see.
// TODO: surface these in Settings rather than requiring a code edit.
export const BUSINESS_DEFAULTS = {
  name: 'Your Shop Name',
  location: 'Your City, ST',
  zipCode: '00000',
  defaultShippingCost: 15,
  experienceYears: '5+',
};

