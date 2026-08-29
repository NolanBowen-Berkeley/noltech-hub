export const formatCurrency = (n) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0);

/** Null-safe currency formatter returning $— for bad values, $X.XX otherwise */
export function fmt(n) {
  if (n === null || n === undefined || n === '' || isNaN(n)) return '$\u2014';
  const num = Number(n);
  const abs = Math.abs(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (num < 0 ? '-$' : '$') + abs;
}

export const formatPct = (n, decimals = 1) => {
  if (n === null || n === undefined || isNaN(n) || !isFinite(n)) return '\u2014';
  return Number(n).toFixed(decimals) + '%';
};

// Scraper APIs return lot.quantity as a display string ("Qty: 14",
// "14 units", "1,500"). parseInt fails on the "Qty:" prefix \u2014 extract
// the first integer instead. Numbers pass through unchanged; null/empty
// returns 0 so callers can `parseQuantity(x) > 0` safely.
export function parseQuantity(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (raw == null) return 0;
  const m = String(raw).match(/\d[\d,]*/);
  if (!m) return 0;
  return parseInt(m[0].replace(/,/g, ''), 10) || 0;
}

export const today = () => new Date().toISOString().split('T')[0];

/**
 * Convert a date input to a local-time YYYY-MM-DD string.
 *
 * eBay's Trading API returns sale timestamps in UTC. Slicing with
 * `.slice(0, 10)` takes the UTC date, which is off-by-one for sellers in
 * Pacific/Mountain time when the sale happens late evening (e.g. UTC midnight
 * = ~5pm PDT the previous day). eBay's seller UI displays seller-local time,
 * so use this helper everywhere we want our calendar date to match what eBay
 * shows.
 *
 * Accepts:
 *   - YYYY-MM-DD strings (returned as-is — already a date-only value)
 *   - Full ISO timestamps (converted to local-time YYYY-MM-DD)
 *   - Date objects
 */
export function localDateStr(input) {
  if (!input) return null;
  if (input instanceof Date) {
    if (isNaN(input.getTime())) return null;
    return `${input.getFullYear()}-${String(input.getMonth() + 1).padStart(2, '0')}-${String(input.getDate()).padStart(2, '0')}`;
  }
  const s = String(input);
  // Already a date-only string — preserve it (the caller has already decided
  // the timezone interpretation upstream).
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const formatDate = (iso) => {
  if (!iso) return '\u2014';
  const d = iso.includes('T') ? new Date(iso) : new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return '\u2014';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

/** Date + time (e.g. "Jan 5, 2025, 3:42 PM") */
export const formatDateTime = (iso) => {
  if (!iso) return '\u2014';
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    }).format(new Date(iso));
  } catch { return iso; }
};

/** Short date + time without year (e.g. "Jan 5, 3:42 PM") */
export const formatDateShort = (iso) => {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(new Date(iso));
  } catch { return iso; }
};

export const formatShortDate = (isoString) => {
  if (!isoString) return '\u2014';
  return new Date(isoString).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
};
