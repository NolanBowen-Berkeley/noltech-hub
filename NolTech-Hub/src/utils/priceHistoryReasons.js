// ─── Price-history reason taxonomy ──────────────────────────────────────────
// One source of truth for the `reason` field of every entry in
// noltech:price-history. Every writer imports PRICE_REASON; every reader
// uses the direction-semantic helpers (isMarkdown, isMarkup) instead of
// equality on the raw string.
//
// The previous codebase had ~5 different reason literals scattered across
// writers (BatchUpdater wrote 'markdown'/'markup'/'batch', useAutoSync
// wrote 'auto_markdown', useEventBridge defaulted to 'manual') and exactly
// one reader (useAutoSync's 7-day cooldown) that filtered on the literal
// 'auto_markdown' only — so a user's manual batch markdown the day before
// did not block the next auto-markdown run, defeating the cooldown's intent.
//
// Contract:
//   - WRITERS: import PRICE_REASON and pass one of its values. When the
//     reason depends on the direction of the price change, use
//     classifyByDirection(oldPrice, newPrice). Use appendHistoryRow to keep
//     the date format consistent (full ISO).
//   - READERS: NEVER compare row.reason === '<string>'. Use isMarkdown /
//     isMarkup / isAutomated. They run normalize() internally, so legacy
//     rows (case variants, removed reasons) Just Work without a one-shot
//     storage migration.

export const PRICE_REASON = Object.freeze({
  AUTO_MARKDOWN: 'auto_markdown', // Background scheduler lowered price (always a decrease)
  MARKDOWN:      'markdown',      // User-initiated decrease
  MARKUP:        'markup',        // User-initiated increase
  BATCH:         'batch',         // Batch op with no net change (newPrice === oldPrice)
  MANUAL:        'manual',        // Direction-unknown fallback (legacy emits without reason)
  UNKNOWN:       'unknown',       // Reason string not recognized by normalize()
});

// Historical aliases → canonical value. Anything not in the map and not
// already in PRICE_REASON returns 'unknown'. Add entries here when a new
// writer ships with a non-canonical literal (rare — appendHistoryRow throws
// in dev when given a non-canonical value, so most regressions get caught
// at the writer site before reaching normalize()).
const ALIAS_MAP = Object.freeze({
  // auto-markdown variants
  'auto_markdown':  PRICE_REASON.AUTO_MARKDOWN,
  'auto-markdown':  PRICE_REASON.AUTO_MARKDOWN,
  'automarkdown':   PRICE_REASON.AUTO_MARKDOWN,
  'AUTO_MARKDOWN':  PRICE_REASON.AUTO_MARKDOWN,
  // markdown variants
  'markdown':       PRICE_REASON.MARKDOWN,
  'price_drop':     PRICE_REASON.MARKDOWN,
  'price-drop':     PRICE_REASON.MARKDOWN,
  'reduction':      PRICE_REASON.MARKDOWN,
  'decrease':       PRICE_REASON.MARKDOWN,
  // markup variants
  'markup':         PRICE_REASON.MARKUP,
  'price_bump':     PRICE_REASON.MARKUP,
  'increase':       PRICE_REASON.MARKUP,
  // batch / manual
  'batch':          PRICE_REASON.BATCH,
  'manual':         PRICE_REASON.MANUAL,
});

// Lazy normalize-on-read. Accepts a raw history row or a bare reason string.
// When called with a row + oldPrice/newPrice context (or row.price + ctx.oldPrice),
// a MANUAL/UNKNOWN reason is promoted to MARKDOWN/MARKUP/BATCH based on the
// direction of the price change. Pure function — never mutates the input.
export function normalize(entryOrReason, ctx = {}) {
  let reason, oldPrice, newPrice;
  if (typeof entryOrReason === 'string' || entryOrReason == null) {
    reason   = entryOrReason || '';
    oldPrice = ctx.oldPrice;
    newPrice = ctx.newPrice;
  } else {
    reason   = entryOrReason.reason || '';
    oldPrice = ctx.oldPrice !== undefined ? ctx.oldPrice : entryOrReason.oldPrice;
    newPrice = ctx.newPrice !== undefined ? ctx.newPrice : entryOrReason.price;
  }

  // Empty / null / undefined → MANUAL (then maybe direction-promoted below)
  if (!reason) reason = PRICE_REASON.MANUAL;

  // Canonical or known alias
  const canonical = ALIAS_MAP[reason] || (Object.values(PRICE_REASON).includes(reason) ? reason : PRICE_REASON.UNKNOWN);

  // Direction promotion: MANUAL or UNKNOWN with usable old/new can be
  // recovered into a direction-bearing reason. AUTO_MARKDOWN/MARKDOWN/MARKUP/
  // BATCH stay as-is — the writer already declared the intent.
  if ((canonical === PRICE_REASON.MANUAL || canonical === PRICE_REASON.UNKNOWN)
      && Number.isFinite(oldPrice) && Number.isFinite(newPrice)) {
    if (newPrice < oldPrice) return PRICE_REASON.MARKDOWN;
    if (newPrice > oldPrice) return PRICE_REASON.MARKUP;
    return PRICE_REASON.BATCH;
  }

  return canonical;
}

// Single source of truth for direction → reason mapping at WRITE time.
// `opts.auto = true` forces AUTO_MARKDOWN for the background scheduler.
export function classifyByDirection(oldPrice, newPrice, opts = {}) {
  if (opts.auto) return PRICE_REASON.AUTO_MARKDOWN;
  if (!Number.isFinite(oldPrice) || !Number.isFinite(newPrice)) return PRICE_REASON.MANUAL;
  if (newPrice < oldPrice) return PRICE_REASON.MARKDOWN;
  if (newPrice > oldPrice) return PRICE_REASON.MARKUP;
  return PRICE_REASON.BATCH;
}

// Direction-semantic test. Returns true for AUTO_MARKDOWN, MARKDOWN, and
// any legacy/MANUAL row that normalize() can promote to a decrease.
// Cooldown logic MUST use this — never equality on a single reason string.
export function isMarkdown(entry, ctx) {
  const r = normalize(entry, ctx);
  return r === PRICE_REASON.AUTO_MARKDOWN || r === PRICE_REASON.MARKDOWN;
}

// Symmetric to isMarkdown for any future markup-frequency analysis.
export function isMarkup(entry, ctx) {
  const r = normalize(entry, ctx);
  return r === PRICE_REASON.MARKUP;
}

// True ONLY for AUTO_MARKDOWN. Use sparingly — most callers want isMarkdown.
// Reserved for "how many times did the scheduler touch this item?" analytics
// where conflating with user markdowns would be wrong.
export function isAutomated(entry, ctx) {
  return normalize(entry, ctx) === PRICE_REASON.AUTO_MARKDOWN;
}

// Constructs a history row with a stable shape. Logs a console.error in
// dev when given a reason outside the taxonomy so the omission gets caught
// at the writer site; always falls back to MANUAL so a typo can't lose
// the audit row. Uses import.meta.env.DEV (Vite-native and statically
// replaced at build time, unlike process.env.NODE_ENV).
export function appendHistoryRow(existing, { price, reason, oldPrice }) {
  let safeReason = reason;
  if (!Object.values(PRICE_REASON).includes(safeReason)) {
    if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) {
      console.error('[priceHistoryReasons] non-canonical reason passed to appendHistoryRow:', safeReason);
    }
    safeReason = PRICE_REASON.MANUAL;
  }
  const row = {
    price,
    reason: safeReason,
    date: new Date().toISOString(),
  };
  if (Number.isFinite(oldPrice)) row.oldPrice = oldPrice;
  return [...(existing || []), row];
}
