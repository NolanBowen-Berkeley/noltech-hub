// ─── Manifest item enrichment ───────────────────────────────────────────────
// Combines category + condition detection + model extraction into a single
// shape used by every downstream consumer (analysis pipeline, BrowseLotsView,
// per-item display). Replaces the 4 hand-synced enrichManifestItem copies
// from the legacy workers.

import { detectCategory } from './category.js';
import { detectItemCondition } from './condition.js';

const MODEL_PATTERNS = [
  // GPU: "RTX 4060", "GTX 1660 Super", "RX 6700 XT"
  /\b(rtx\s+\d{3,4}\s*\w*|gtx\s+\d{3,4}\s*\w*|rx\s+\d{3,4}\s*\w*|radeon\s+\w+\s+\d+)/i,
  // CPU: "i7-12700K", "Ryzen 7 5800X", "Xeon E5-2670"
  /\b(i[3579][-\s]?\d{4,5}[a-z]?|ryzen\s+\d\s+\d{4}\w*|xeon\s+[ew]?\d+[-\s]?\d*[a-z]?)/i,
  // RAM: "16GB DDR4", "32GB DDR5-5600"
  /\b(\d+\s*gb\s+ddr[345](?:[-\s]\d+)?)/i,
  // Storage: "512GB NVMe", "2TB SSD"
  /\b(\d+\s*(?:tb|gb)\s+(?:ssd|nvme|hdd))/i,
  // Motherboard: "X870E GODLIKE", "Z890 AORUS MASTER", "B860M"
  /\b((?:x|z|b)\d{3}(?:e|m)?\s+\w+(?:\s+\w+)?)/i,
  // Desktop form-factor models
  /\b(optiplex\s+\w+|prodesk\s+\w+|elitedesk\s+\w+|thinkcentre\s+\w+)/i,
];

export function extractModel(title) {
  if (!title) return null;
  for (const re of MODEL_PATTERNS) {
    const m = title.match(re);
    if (m) return m[1].replace(/\s+/g, ' ').trim();
  }
  return null;
}

/**
 * Enrich a raw manifest item. Returns a NEW object — does not mutate input.
 *
 * Output shape (snake_case to match Supabase column names):
 *   {
 *     title, description, brand, upc, qty, msrp,
 *     category_refined, condition, model_guess, condition_raw,
 *     ...any other passthrough fields
 *   }
 */
export function enrichManifestItem(rawItem, context = {}) {
  const title = String(rawItem.title || rawItem.description || '').trim();
  const itemConditionRaw = rawItem.conditionRaw
    || rawItem.condition_raw
    || rawItem.condition
    || '';
  const lotTitle     = String(context.lotTitle     || '');
  const lotCondition = String(context.lotCondition || '');

  return {
    ...rawItem,
    category_refined: detectCategory(title),
    condition:        detectItemCondition(itemConditionRaw, lotCondition, lotTitle),
    model_guess:      extractModel(title),
    condition_raw:    itemConditionRaw || null,
  };
}

/**
 * Enrich a whole manifest's worth of items with a shared lot context.
 */
export function enrichManifest(items, lot = {}) {
  const context = {
    lotTitle:     lot.title     || '',
    lotCondition: lot.condition || '',
  };
  return items.map((it) => enrichManifestItem(it, context));
}
