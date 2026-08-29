// ─── Item-mapping utilities ──────────────────────────────────────────────────
// Single source of truth for parsing brands from titles, mapping eBay
// category names to internal category enums, and mapping eBay condition
// IDs to internal condition enums. Previously duplicated in
// useSyncAll.js and ItemManager.jsx — kept slightly out of sync with each
// other. Consolidated here so changes propagate.
//
// NOT extracted: findLotBySku / matchSalesToLots — those involve overlay
// state and inventory traversal and don't belong in a pure-utils module.
// Also NOT extracted: ListingGenerator.jsx's mapCondition — that function
// has a different signature (internal-string → eBay-{id,label} object)
// and is the inverse direction of this module's mapCondition.

// Union of brand lists from both prior copies. useSyncAll had the broader
// list (added Nikon, Cisco, Netgear, TP-Link, Ubiquiti, Supermicro, IBM,
// Hewlett); ItemManager had the shorter set. Taking the union here.
export const KNOWN_BRANDS = [
  'Apple','Dell','HP','Lenovo','Asus','Acer','Microsoft','Samsung','LG','Sony',
  'Toshiba','Razer','MSI','Gigabyte','Nvidia','AMD','Intel','Corsair','Kingston',
  'Crucial','Western Digital','Seagate','EVGA','Zotac','Logitech','Bose','Canon',
  'Nikon','Cisco','Netgear','TP-Link','Ubiquiti','Supermicro','IBM','Hewlett',
];

// Find the first known brand mentioned in a title. Falls back to the
// first whitespace-delimited token if nothing matches (mirrors the
// ItemManager fallback — better than returning empty for inventory items
// that legitimately have a non-listed brand). Null/empty title is safe.
export function parseBrand(title) {
  if (!title) return '';
  const t = title.toLowerCase();
  for (const b of KNOWN_BRANDS) {
    if (t.includes(b.toLowerCase())) return b;
  }
  return title.split(' ')[0] || 'Unknown';
}

// Map an eBay (or eBay-like) category display name to the internal
// category enum used across the app. Uses ItemManager's broader rule
// set — adds cpu, motherboard, psu, networking, server, and peripheral
// detection that useSyncAll's version was missing.
export function mapCategory(categoryName) {
  const c = (categoryName || '').toLowerCase();
  if (c.includes('laptop') || c.includes('notebook') || c.includes('2-in-1'))  return 'laptop';
  if (c.includes('tablet') || c.includes('ipad'))                              return 'tablet';
  if (c.includes('desktop') || c.includes('tower') || c.includes('all-in-one') || c.includes('all in one')) return 'desktop';
  if (c.includes('video graphic') || c.includes('graphics card') || c.includes('gpu') || c.includes('video card') || c.includes('graphics')) return 'gpu';
  if (c.includes('processor') || c.includes('cpu'))                            return 'cpu';
  if (c.includes('memory') || c.includes(' ram') || c.includes('ddr'))         return 'ram';
  if (c.includes('solid state') || c.includes('ssd') || c.includes('hard drive') || c.includes('hdd') || c.includes('nvme') || c.includes('storage')) return 'ssd';
  if (c.includes('motherboard'))                                                return 'motherboard';
  if (c.includes('power supply') || c.includes(' psu'))                         return 'psu';
  if (c.includes('monitor') || c.includes('display') || c.includes('screen'))   return 'monitor';
  if (c.includes('phone') || c.includes('smartphone'))                          return 'phone';
  if (c.includes('network') || c.includes('router') || c.includes('switch') || c.includes('access point')) return 'networking';
  if (c.includes('server'))                                                     return 'server';
  if (c.includes('mice') || c.includes('mouse') || c.includes('keyboard') || c.includes('webcam') || c.includes('headset') || c.includes('headphone') || c.includes('speaker') || c.includes('printer')) return 'peripheral';
  return 'other';
}

// Map eBay condition ID (and optional display name fallback) to the
// internal condition enum.
// https://developer.ebay.com/devzone/finding/callref/enums/conditionIdList.html
// Uses ItemManager's signature: takes (conditionId, conditionName) so the
// display name can serve as a fallback when the numeric ID isn't recognized.
// useSyncAll previously only passed conditionId — that still works here;
// the conditionName arg is just undefined and the name-based fallback
// loop short-circuits.
export function mapCondition(conditionId, conditionName) {
  const id = parseInt(conditionId) || 0;
  if (id === 1000)                   return 'new';        // New
  if (id === 1500)                   return 'new';        // New other
  if (id === 1750)                   return 'like_new';   // New with defects
  if (id === 2000)                   return 'like_new';   // Certified Refurbished
  if (id === 2010)                   return 'like_new';   // Excellent Refurbished
  if (id === 2020)                   return 'good';       // Very Good Refurbished
  if (id === 2030)                   return 'good';       // Good Refurbished
  if (id === 2500)                   return 'good';       // Seller Refurbished
  if (id === 2750)                   return 'good';       // Graded
  if (id === 3000)                   return 'good';       // Used
  if (id === 4000)                   return 'fair';       // Ungraded
  if (id === 5000 || id === 7000)    return 'broken';     // For parts or not working
  if (id === 6000)                   return 'poor';       // Not specified
  // Fallback: parse the display name when present
  const n = (conditionName || '').toLowerCase();
  if (n.includes('new'))                                return 'new';
  if (n.includes('like new') || n.includes('excellent')) return 'like_new';
  if (n.includes('very good') || n.includes('refurb'))  return 'good';
  if (n.includes('good'))                               return 'good';
  if (n.includes('acceptable') || n.includes('fair'))   return 'fair';
  if (n.includes('poor'))                               return 'poor';
  if (n.includes('part') || n.includes('not working'))  return 'broken';
  return 'good';
}
