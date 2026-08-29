// ─── Manifest classification layer (Tier 39) ──────────────────────────────────
// The pipeline does the heavy lifting: its lot provider returns a manifest
// table, and `shared/manifestTable.js` maps it to items shaped as
// { title, brand, upc, qty, msrp, category }.
//
// This module adds the Tier 39 enrichment layer on top:
//   - `condition`: 'working' | 'for_parts' | 'unknown'
//        Derived from the manifest's free-text condition column (when present)
//        AND/OR from the lot title (which often says "Customer Returns" etc.).
//   - `categoryRefined`: 'gpu' | 'cpu' | 'ram' | 'desktop' | 'storage' | 'other'
//        Keyword-based detection on the item title. The scraper's `category`
//        field is Liquidation.com's category column (often generic / blank),
//        so we classify locally for the sold-comps Lambda routing.
//   - `modelGuess`: extracted model number from title when matchable.
//        Used by downstream pricing.
//
// Pure module: no I/O, no network. Safe to call from any layer.

// ── Category detection ────────────────────────────────────────────────────────

const CATEGORY_PATTERNS = [
  // Order matters — more specific patterns first
  {
    cat: 'gpu',
    re: /\b(rtx|gtx|radeon|geforce|quadro|tesla|firepro|rx\s?\d{3,}|gpu\b|graphics\s+card)\b/i,
  },
  {
    cat: 'cpu',
    re: /\b(intel\s+(?:core\s+)?i[3579][-\s]?\d{4,5}[a-z]?|xeon\b|amd\s+ryzen\b|epyc\b|threadripper\b|\bcpu\b|\bprocessor\b)/i,
  },
  {
    cat: 'ram',
    re: /\b(\d+\s*gb\s+(?:ddr[345]|ram|memory|dimm|sodimm|udimm|rdimm)|\bddr[345]\s+\d+gb\b)/i,
  },
  {
    cat: 'storage',
    re: /\b(\d+\s*(?:tb|gb)\s+(?:ssd|nvme|m\.?2|hdd|hard\s+drive)|\bnvme\b|\bsata\s+ssd\b)/i,
  },
  {
    cat: 'motherboard',
    re: /\b(motherboard|mainboard|\bmobo\b|x870[a-z]?|x670[a-z]?|b860[a-z]?|b850[a-z]?|b760[a-z]?|b660[a-z]?|z890|z790|z690|tuf\s+gaming.+(?:atx|wifi|motherboard)|rog\s+(?:strix|maximus|crosshair).+(?:atx|wifi|motherboard)|aorus.+(?:atx|wifi|motherboard))/i,
  },
  {
    cat: 'psu',
    re: /\b(power\s+supply|\bpsu\b|\d{3,4}\s*w\s+(?:gold|bronze|platinum|titanium|atx|psu|modular)|seasonic\s+\w+|corsair\s+rm\d+|evga\s+supernova)\b/i,
  },
  {
    cat: 'monitor',
    re: /\b(monitor\b|\bdisplay\b|\blcd\b|\b\d{2}["']?\s*(?:gaming|curved|ips|qhd|uhd|4k|fhd|hdr)\b|ultrawide)/i,
  },
  {
    cat: 'keyboard',
    re: /\b(keyboard\b|mechanical\s+keys?|\btkl\b|tenkeyless|hot[-\s]?swap(?:pable)?)\b/i,
  },
  {
    cat: 'mouse',
    re: /\b(gaming\s+mouse|wireless\s+mouse|\bmouse\b)/i,
  },
  {
    cat: 'laptop',
    re: /\b(laptop|notebook|thinkpad|elitebook|latitude|inspiron|surface\s+(?:pro|laptop|book)|ideapad|chromebook|macbook)\b/i,
  },
  {
    cat: 'desktop',
    // Form factor / brand keywords that strongly imply a prebuilt
    re: /\b(optiplex|prodesk|elitedesk|thinkcentre|workstation\b|small\s+form\s+factor|sff\b|tower\s+pc|desktop\s+(?:pc|computer)|\bmini\s+pc\b)/i,
  },
];

/**
 * Classify an item title into one of our 6 canonical categories.
 * Returns 'other' for ambiguous / unrecognized.
 */
export function detectCategory(title) {
  if (!title || typeof title !== 'string') return 'other';
  for (const { cat, re } of CATEGORY_PATTERNS) {
    if (re.test(title)) return cat;
  }
  return 'other';
}

// ── Condition detection ───────────────────────────────────────────────────────

// Tightened from /\breturn(?:s|ed)?\b/i — the broad "return" pattern
// matched phrases like "return policy", "high return value", "fast returns"
// in non-condition text. We now require "customer returns" specifically.
const FOR_PARTS_KEYWORDS = [
  /\bcustomer\s+returns?\b/i,
  /\buntested\b/i,
  /\bdamaged\b/i,
  /\bdefective\b/i,
  /\bas[-\s]?is\b/i,
  /\bfor\s+parts\b/i,
  /\bnot\s+working\b/i,
  /\bnon[-\s]?functional\b/i,
  /\bsalvage\b/i,
  /\bbroken\b/i,
];

const WORKING_KEYWORDS = [
  /\bnew\b/i,
  /\bsealed\b/i,
  /\btested\b/i,
  /\bworking\b/i,
  /\bverified\b/i,
  /\brefurbished?\b/i,
  /\bcertified\b/i,
  /\bopen\s+box\b/i,
];

/**
 * Derive condition. CRITICAL — item-level text is checked FIRST. Lot-level
 * context (lot.condition, lot.title) is only consulted when the item itself
 * makes no claim. This prevents Liquidation.com's lot.condition='Customer
 * Returns' (set at the auction level, regardless of individual items)
 * from blanket-tagging every item as for_parts, halving the MSRP multiplier
 * even on items the manifest explicitly says are tested/working.
 *
 * Signature accepts (itemText, lotCondition, lotTitle) for the canonical
 * 3-arg call. Extra positional args are folded into the item-level blob
 * for back-compat with legacy callers that passed multiple item fields.
 *
 * @param {string} itemText — the item's own condition field (manifest cell)
 * @param {string} lotCondition — auction-level condition (often 'Customer Returns')
 * @param {string} lotTitle — auction title (occasionally contains condition hints)
 */
export function detectCondition(itemText, lotCondition, lotTitle) {
  const extras = Array.from(arguments).slice(3).filter(Boolean);
  const itemBlob = [itemText, ...extras].filter(Boolean).join(' ').toLowerCase();
  if (itemBlob) {
    for (const re of FOR_PARTS_KEYWORDS) if (re.test(itemBlob)) return 'for_parts';
    for (const re of WORKING_KEYWORDS)   if (re.test(itemBlob)) return 'working';
  }
  const lotBlob = [lotCondition, lotTitle].filter(Boolean).join(' ').toLowerCase();
  if (lotBlob) {
    for (const re of FOR_PARTS_KEYWORDS) if (re.test(lotBlob)) return 'for_parts';
    for (const re of WORKING_KEYWORDS)   if (re.test(lotBlob)) return 'working';
  }
  return 'unknown';
}

// ── Model extraction ──────────────────────────────────────────────────────────

const MODEL_PATTERNS = [
  // GPU model: "RTX 4060", "GTX 1660 Super", "RX 6700 XT"
  /\b(rtx\s+\d{3,4}\s*\w*|gtx\s+\d{3,4}\s*\w*|rx\s+\d{3,4}\s*\w*|radeon\s+\w+\s+\d+)/i,
  // CPU model: "i7-12700K", "Ryzen 7 5800X", "Xeon E5-2670"
  /\b(i[3579][-\s]?\d{4,5}[a-z]?|ryzen\s+\d\s+\d{4}\w*|xeon\s+[ew]?\d+[-\s]?\d*[a-z]?)/i,
  // RAM: "16GB DDR4", "32GB DDR5-5600"
  /\b(\d+\s*gb\s+ddr[345](?:[-\s]\d+)?)/i,
  // Storage: "512GB NVMe", "2TB SSD"
  /\b(\d+\s*(?:tb|gb)\s+(?:ssd|nvme|hdd))/i,
  // Desktop form factor: "OptiPlex 7090", "ThinkCentre M720q"
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

// ── Top-level enrichment ──────────────────────────────────────────────────────

/**
 * Enrich a raw manifest item (as returned by `fetchLiqManifest`) with Tier 39
 * classifications. Returns a NEW item object — does not mutate input.
 *
 * @param {object} rawItem - { title, brand, upc, qty, msrp, category }
 * @param {object} [context] - additional context for condition derivation
 * @param {string} [context.lotTitle] - the parent lot title (often includes
 *                                       "Customer Returns" / similar)
 * @param {string} [context.lotCondition] - the lot-level condition string
 *                                          (from the search-grid auction
 *                                          details, e.g. "Customer Returns")
 */
export function enrichManifestItem(rawItem, context = {}) {
  const title = (rawItem.title || '').trim();
  const itemConditionRaw = rawItem.conditionRaw || rawItem.condition_raw || rawItem.condition || '';
  const lotTitle = context.lotTitle || '';
  const lotCondition = context.lotCondition || '';

  const categoryRefined = detectCategory(title);
  const condition = detectCondition(itemConditionRaw, lotCondition, lotTitle);
  const modelGuess = extractModel(title);

  return {
    ...rawItem,
    categoryRefined,
    condition,
    modelGuess,
    conditionRaw: itemConditionRaw || null,
  };
}

/**
 * Enrich a whole manifest at once. Same as mapping `enrichManifestItem` but
 * resolves context per-item from the lot.
 *
 * @param {Array} items - raw items from fetchLiqManifest
 * @param {object} lot - the parent lot object (title, condition, etc.)
 */
export function enrichManifest(items, lot = {}) {
  const context = {
    lotTitle: lot.title || '',
    lotCondition: lot.condition || '',
  };
  return items.map((it) => enrichManifestItem(it, context));
}

// ── Summary stats for a manifest (used by auto-analyze pre-filter) ───────────

/**
 * Compute quick summary stats for a manifest so the auto-analyze pre-filter
 * can skip uninteresting lots without invoking the sold-comps pipeline.
 *
 * Returns: { totalItems, totalQty, totalMsrp, byCategory: { gpu, cpu, ram, ... },
 *            forPartsRatio, hasDesktops, hasGpus }
 */
export function summarizeManifest(enrichedItems) {
  const stats = {
    totalItems: enrichedItems.length,
    totalQty: 0,
    totalMsrp: 0,
    byCategory: { gpu: 0, cpu: 0, ram: 0, desktop: 0, storage: 0, motherboard: 0, psu: 0, monitor: 0, keyboard: 0, mouse: 0, laptop: 0, other: 0 },
    forPartsCount: 0,
    workingCount: 0,
    unknownCount: 0,
    hasDesktops: false,
    hasGpus: false,
  };
  for (const it of enrichedItems) {
    stats.totalQty += Number(it.qty) || 1;
    stats.totalMsrp += Number(it.msrp) || 0;
    const cat = it.categoryRefined || 'other';
    if (stats.byCategory[cat] != null) {
      stats.byCategory[cat] += Number(it.qty) || 1;
    }
    if (it.condition === 'for_parts') stats.forPartsCount += 1;
    else if (it.condition === 'working') stats.workingCount += 1;
    else stats.unknownCount += 1;
  }
  stats.hasDesktops = stats.byCategory.desktop > 0;
  stats.hasGpus = stats.byCategory.gpu > 0;
  stats.forPartsRatio = stats.totalItems > 0 ? stats.forPartsCount / stats.totalItems : 0;
  return stats;
}
