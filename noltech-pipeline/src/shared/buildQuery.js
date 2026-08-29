// ─── Single source of truth: eBay search query construction ────────────────
// Used by the sold-comps lookup and the analysis pipeline. Replaces the
// duplicated buildQuery in auto-analyze-worker/pipeline.js.

const MAX_QUERY_LEN = 80;
const MIN_QUERY_LEN = 4;

/**
 * Build the eBay sold-comps search query from a manifest item.
 *
 * Priority order:
 *   1. model_guess (extracted clean model number — best signal)
 *   2. brand + description (when both populated)
 *   3. description alone
 *   4. brand alone (last resort — brand-only queries return broad results)
 *
 * Returns null when nothing usable can be built. The caller MUST handle null
 * (typically by setting the item to priced=false with reason='no_query').
 *
 * NOTE: UPC fallback is intentionally NOT included. Liquidation.com manifests
 * don't carry real UPCs — the numeric values that DO appear in the upc
 * column are usually Liq internal SKU IDs that don't match anything on
 * eBay. Querying them produces zero results and pollutes the sample pool.
 */
export function buildQuery(item) {
  if (item.model_guess) {
    const q = String(item.model_guess).trim();
    if (q.length >= MIN_QUERY_LEN) return q.slice(0, MAX_QUERY_LEN);
  }
  const brand = String(item.brand || '').trim();
  const desc  = String(item.description || '').trim();
  if (brand && desc) {
    const combined = `${brand} ${desc}`;
    if (combined.length >= MIN_QUERY_LEN) return combined.slice(0, MAX_QUERY_LEN);
  }
  if (desc.length >= MIN_QUERY_LEN) return desc.slice(0, MAX_QUERY_LEN);
  if (brand.length >= MIN_QUERY_LEN) return brand.slice(0, MAX_QUERY_LEN);
  return null;
}

/**
 * Normalize a query string into a deterministic cache key fragment. Words
 * are lowercased, punctuation stripped, sorted alphabetically. Same input
 * → same cache key, regardless of word order.
 */
export function normalizeQuery(query) {
  if (typeof query !== 'string') return '';
  const stripped = query
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return '';
  return stripped.split(' ').sort().join(' ');
}

/**
 * Full cache key — normalized query + soldDays + condition + category +
 * parser version. Different conditions / categories / versions produce
 * different keys so they don't collide on the same Supabase row.
 */
export function buildCacheKey(query, { soldDays, condition, category, parserVersion }) {
  return `${normalizeQuery(query)}:${soldDays}|${condition}|${category}|${parserVersion}`;
}
