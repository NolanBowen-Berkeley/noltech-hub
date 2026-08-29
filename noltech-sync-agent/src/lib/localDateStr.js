// Convert a date input to a local-time YYYY-MM-DD string.
//
// eBay's Trading API returns sale timestamps in UTC. Slicing with
// `.slice(0, 10)` takes the UTC date, which is off-by-one for sellers in
// Pacific/Mountain time when the sale happens late evening (e.g. UTC
// midnight = ~5pm PDT the previous day). eBay's seller UI displays
// seller-local time, so use this helper everywhere we want our calendar
// date to match what eBay shows.
//
// The Pi inherits its locale from the host TZ; deploy with `TZ=America/Los_Angeles`
// in the systemd unit (or pi system tz) so this matches Nolan's books.
//
// Accepts:
//   - YYYY-MM-DD strings (returned as-is — already a date-only value)
//   - Full ISO timestamps (converted to local-time YYYY-MM-DD)
//   - Date objects
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

export default localDateStr;
