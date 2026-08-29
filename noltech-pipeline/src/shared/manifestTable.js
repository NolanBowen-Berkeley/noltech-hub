// ─── Manifest table → items ─────────────────────────────────────────────────
// Turns a manifest's raw header/row table into enriched, scoreable items.
//
// This is deliberately transport-agnostic: it takes a table, not a URL. Where
// that table came from — a provider's API, a spreadsheet the user exported, a
// saved HTML file — is the provider's problem (see src/providers/). Keeping
// the parse separate from the fetch is what let the auction-site scrapers be
// removed without touching any of the column-mapping or scoring logic.
//
// Two hardening rules from the original audit are preserved:
//
//   1. pickBestTable REJECTS tables without a description column. Scoring
//      hasDesc*1000 but still letting a description-less table win on row
//      count is how corrupt manifests (empty descriptions, bogus UPCs) got
//      into the analysis queue.
//
//   2. parseNumber averages range strings ("100-200" → 150) rather than
//      taking the low bound, which silently under-estimated MSRP.

import { stripTags, parseNumber, normalizeUpc } from './htmlUtils.js';
import { enrichManifestItem } from './enrichManifest.js';

const MIN_DESC_LEN = 2;

// ─── HTML table extraction ─────────────────────────────────────────────────
// Used by providers that hand back a manifest as an HTML document (a saved
// page, an export, a file the user supplied) rather than structured rows.

export function extractTables(html) {
  const out = [];
  const re = /<table[\s\S]*?<\/table>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push(m[0]);
    if (out.length > 100) break;
  }
  return out;
}

export function parseOneTable(tableHtml) {
  const rowMatches = [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  if (rowMatches.length === 0) return { headers: [], rows: [] };

  function cells(rowHtml, tag) {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    const out = [];
    let m;
    while ((m = re.exec(rowHtml)) !== null) out.push(stripTags(m[1]));
    return out;
  }

  let headerIdx = -1;
  let headers = [];
  for (let i = 0; i < rowMatches.length; i++) {
    const th = cells(rowMatches[i][1], 'th');
    if (th.length > 0) { headerIdx = i; headers = th; break; }
  }
  if (headerIdx === -1) {
    headerIdx = 0;
    headers = cells(rowMatches[0][1], 'td');
  }

  const rows = [];
  for (let i = headerIdx + 1; i < rowMatches.length; i++) {
    const tds = cells(rowMatches[i][1], 'td');
    if (tds.length === 0) continue;
    rows.push(tds);
  }
  return { headers, rows };
}

/**
 * Pull the best manifest table out of an HTML document.
 * @returns {{headers: string[], rows: string[][]} | null}
 */
export function pickTableFromHtml(html) {
  const tables = extractTables(String(html || ''));
  if (tables.length === 0) return null;
  return pickBestTable(tables);
}

// ─── Column scoring ────────────────────────────────────────────────────────

export function scoreHeader(h) {
  const lc = String(h).toLowerCase();
  const s = { upc: 0, description: 0, qty: 0, msrp: 0, brand: 0, condition: 0, model: 0 };

  if (/\bupc\b/.test(lc))                          s.upc = 10;
  else if (/\b(barcode|ean|gtin|sku)\b/.test(lc))  s.upc = 6;

  if (/\bdescription\b/.test(lc))                  s.description = 10;
  else if (/\b(product|item)\s*name\b/.test(lc))   s.description = 9;
  else if (/\b(name|title|item)\b/.test(lc))       s.description = 6;

  if (/\b(quantity|qty)\b/.test(lc))               s.qty = 10;
  else if (/\b(count|units?)\b/.test(lc))          s.qty = 5;

  if (/\bmsrp\b/.test(lc))                                s.msrp = 10;
  else if (/\bestimated\s+retail/.test(lc))               s.msrp = 9;
  else if (/\bretail\s+(value|price)\b/.test(lc))         s.msrp = 8;
  else if (/\bunit\s+(msrp|retail)\b/.test(lc))           s.msrp = 7;
  // Anti-signals — these columns are NEVER MSRP.
  if (/\b(salvage|book|liquidation|wholesale|adjustment|discount|cost)\b/.test(lc)) {
    s.msrp = 0;
  }

  if (/\b(brand|manufacturer)\b/.test(lc))                s.brand = 10;
  else if (/\bmake\b/.test(lc))                           s.brand = 8;
  if (/\b(condition|grade)\b/.test(lc))                   s.condition = 10;
  if (/\b(model|part\s*#|part\s+number|mfr\s*#)\b/.test(lc)) s.model = 10;

  return s;
}

export function mapColumns(headerCells) {
  const map  = { upc: -1, description: -1, qty: -1, msrp: -1, brand: -1, condition: -1, model: -1 };
  const best = { upc: 0,  description: 0,  qty: 0,  msrp: 0,  brand: 0,  condition: 0,  model: 0 };
  for (let i = 0; i < headerCells.length; i++) {
    const s = scoreHeader(headerCells[i]);
    for (const role of Object.keys(map)) {
      if (s[role] > best[role]) {
        best[role] = s[role];
        map[role] = i;
      }
    }
  }
  return map;
}

/**
 * Choose the manifest table among several candidates. Returns null when no
 * table has a mappable description column — treated as a manifest failure at
 * the source rather than silently producing empty-description rows.
 */
export function pickBestTable(tables) {
  let best = null;
  let bestScore = -1;
  for (const t of tables) {
    const parsed = typeof t === 'string' ? parseOneTable(t) : t;
    if (!parsed || parsed.rows.length === 0) continue;
    const cols = mapColumns(parsed.headers);
    if (cols.description === -1) continue;       // HARD requirement
    const goodCols = (cols.upc !== -1 ? 1 : 0) + (cols.qty !== -1 ? 1 : 0) + (cols.msrp !== -1 ? 1 : 0);
    const score = goodCols * 100 + parsed.rows.length;
    if (score > bestScore) { bestScore = score; best = parsed; }
  }
  return best;
}

// ─── Table → enriched items ────────────────────────────────────────────────

/**
 * Map a header/row table into enriched manifest items.
 *
 * @param {string[]}   headers
 * @param {string[][]} rows
 * @param {object}    [lotContext]  { title, condition } — used to infer a
 *                                  per-item condition when the manifest
 *                                  doesn't state one.
 * @returns {{ok: true, items, summary} | {ok: false, error, items: []}}
 */
export function buildManifestItems(headers, rows, lotContext = {}) {
  if (!Array.isArray(headers) || !Array.isArray(rows)) {
    return { ok: false, error: 'invalid_table', items: [] };
  }
  if (rows.length === 0) return { ok: false, error: 'no_rows', items: [] };

  const colMap = mapColumns(headers);
  if (colMap.description === -1) {
    return { ok: false, error: 'no_table_with_description_column', items: [] };
  }
  const context = { lotTitle: lotContext.title, lotCondition: lotContext.condition };

  const items = rows
    .map((row) => {
      const description  = colMap.description !== -1 ? row[colMap.description] : '';
      const upcRaw       = colMap.upc         !== -1 ? row[colMap.upc]         : null;
      const qty          = colMap.qty         !== -1 ? parseNumber(row[colMap.qty])  : null;
      const msrpRaw      = colMap.msrp        !== -1 ? parseNumber(row[colMap.msrp]) : null;
      const brand        = colMap.brand       !== -1 ? row[colMap.brand]       : null;
      const conditionRaw = colMap.condition   !== -1 ? row[colMap.condition]   : null;
      return {
        title:       description || '',
        description: description || '',
        brand:       brand || null,
        upc:         normalizeUpc(upcRaw),
        qty:         qty != null && qty > 0 ? qty : 1,
        // MSRP must be > 0; reject negative / zero values from credit columns.
        msrp:        Number.isFinite(msrpRaw) && msrpRaw > 0 ? msrpRaw : null,
        conditionRaw,
      };
    })
    // Description must contain at least one letter — rejects rows where the
    // description column landed on a numeric price cell ("$579.99") or a bare
    // quantity ("1234"), which would otherwise be sent to the comps provider
    // as a garbage search query.
    .filter((it) => it.description && it.description.length > MIN_DESC_LEN && /[a-zA-Z]/.test(it.description))
    .map((raw, idx) => ({ ...enrichManifestItem(raw, context), item_index: idx }));

  if (items.length === 0) return { ok: false, error: 'empty_after_filter', items: [] };

  return { ok: true, items, summary: summarize(items) };
}

// ─── Summary (used by the auto-analyze pre-filter) ────────────────────────

export function summarize(items) {
  const stats = {
    totalItems: items.length,
    totalQty: 0,
    totalMsrp: 0,
    byCategory: { gpu: 0, cpu: 0, ram: 0, storage: 0, motherboard: 0, psu: 0, monitor: 0, laptop: 0, desktop: 0, keyboard: 0, mouse: 0, other: 0 },
    forPartsCount: 0,
    workingCount: 0,
    unknownCount: 0,
    hasDesktops: false,
    hasGpus: false,
    forPartsRatio: 0,
  };
  for (const it of items) {
    stats.totalQty  += Number(it.qty)  || 1;
    stats.totalMsrp += Number(it.msrp) || 0;
    const cat = it.category_refined || 'other';
    if (stats.byCategory[cat] != null) stats.byCategory[cat] += Number(it.qty) || 1;
    if      (it.condition === 'for_parts') stats.forPartsCount += 1;
    else if (it.condition === 'working')   stats.workingCount  += 1;
    else                                   stats.unknownCount  += 1;
  }
  stats.hasDesktops   = stats.byCategory.desktop > 0;
  stats.hasGpus       = stats.byCategory.gpu > 0;
  stats.forPartsRatio = stats.totalItems > 0 ? stats.forPartsCount / stats.totalItems : 0;
  return stats;
}
