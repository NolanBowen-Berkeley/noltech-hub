// ─── Shared HTML / numeric utility helpers ──────────────────────────────────

export function stripTags(html) {
  // Decode AFTER tag removal so "&amp;" → "&" and "&#8230;" → "…" in the
  // resulting text. Decoded angle brackets land in a plain string (never
  // re-parsed as HTML), so this is injection-safe.
  return decodeEntities(
    String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  );
}

export function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      return Number.isFinite(code) && code < 0x110000 ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      const code = parseInt(n, 16);
      return Number.isFinite(code) && code < 0x110000 ? String.fromCodePoint(code) : '';
    });
}

/**
 * Parse a numeric value from a string. HARDENED from the legacy version:
 *
 *   1. Ranges like "100-200" or "1,000-2,000" now return the AVERAGE.
 *      Previously the regex matched only the first number, silently
 *      under-estimating MSRP whenever a manifest column carried a range.
 *   2. Em-dash and en-dash range separators are also recognized.
 *   3. Negative values (credit / adjustment columns) are still parsed
 *      correctly; the caller is responsible for rejecting them when not
 *      semantically appropriate (e.g. MSRP > 0).
 */
export function parseNumber(s) {
  if (s == null) return null;
  const str = String(s);

  // Range first — "low - high" returns average.
  const rangeRe = /(-?\d+(?:,\d{3})*(?:\.\d+)?)\s*[-–—]\s*(-?\d+(?:,\d{3})*(?:\.\d+)?)/;
  const rangeMatch = str.match(rangeRe);
  if (rangeMatch) {
    const a = parseFloat(rangeMatch[1].replace(/,/g, ''));
    const b = parseFloat(rangeMatch[2].replace(/,/g, ''));
    if (Number.isFinite(a) && Number.isFinite(b)) {
      return (a + b) / 2;
    }
  }

  const m = str.match(/-?\d+(?:,\d{3})*(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize a UPC-like string. Accepts 8 (UPC-E), 12 (UPC-A), 13 (EAN-13)
 * digit codes. Check-digit validation is intentionally not performed —
 * Liquidation.com manifests sometimes carry SKU-like numeric strings in
 * the "UPC" column and we prefer permissiveness here to dropping them.
 */
export function normalizeUpc(raw) {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 8 || digits.length === 12 || digits.length === 13) {
    return digits;
  }
  return null;
}

/**
 * Sanitize a TEXT field destined for Postgres. Strips null bytes (Postgres
 * rejects them) and caps length so a runaway scraped string can't blow
 * a row size.
 */
export function sanitizeText(s, maxLen = 2000) {
  if (s == null) return null;
  let out = String(s).replace(/\0/g, '');
  if (out.length > maxLen) out = out.slice(0, maxLen);
  return out || null;
}

/**
 * Validate a Liquidation.com lot URL. Defense against javascript:/data:/
 * cross-domain URLs that a tampered scrape could slip through.
 */
export function isValidLotUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return /^https:\/\/(www\.)?liquidation\.com\/auction\//i.test(url);
}
