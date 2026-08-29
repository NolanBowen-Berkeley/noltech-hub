// ─── Text + classification helpers ───────────────────────────────────────────
// Direct ports of the local scraper's behavior so the cloud-enriched lots
// look byte-identical to the locally-enriched ones in BrowseLotsView.

// Strip control chars + literal `\uXXXX` escape sequences from display text.
// Mirrors cleanDisplay() in scraper/server.js. Keep these regexes synced.
const CONTROL_CHAR_RE = new RegExp('[' +
  '\\u0000-\\u001F' +
  '\\u007F-\\u009F' +
  '\\u200B-\\u200F' +
  '\\u2028-\\u202F' +
  '\\uFEFF\\uFFFD' +
']', 'g');
const UU_LITERAL_RE = /\\u[\da-fA-F]{4}/g;

export function cleanDisplay(s) {
  if (typeof s !== 'string') return s;
  return s.replace(CONTROL_CHAR_RE, '').replace(UU_LITERAL_RE, '').trim();
}

// djb2-style hash → base36. Used for non-UPC pricing cache keys.
export function simpleHash(s) {
  let h = 5381;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) h = (h * 33) ^ str.charCodeAt(i);
  return Math.abs(h >>> 0).toString(36);
}

// Lot condition free text → Lambda condition param.
export function mapConditionForLambda(raw) {
  const s = (typeof raw === 'string' ? raw : '').toLowerCase();
  if (!s) return 'any';
  // Explicit pass-through for the three Lambda-accepted values. The Hub
  // now sends 'any' by default; without this, regex fallthrough would
  // silently rewrite it to 'working' and narrow the search again.
  if (s === 'any' || s === 'working' || s === 'for_parts') return s;
  if (/(for[\s-]?parts|salvage|broken|untested|as[\s-]?is|defective|returns?\b)/.test(s)) return 'for_parts';
  if (/(working|tested|certified|refurbished|new|sealed)/.test(s)) return 'working';
  return 'any';
}

// Map a manifest title into the category enum the sold-comps Lambda accepts.
const CATEGORY_RULES = [
  { cat: 'gpu',         re: /\b(rtx|gtx|radeon|geforce|quadro|tesla|firepro|graphics\s+card|gpu)\b/i },
  { cat: 'laptop',      re: /\b(laptop|notebook|macbook|ultrabook|chromebook)\b/i },
  { cat: 'desktop',     re: /\b(optiplex|prodesk|elitedesk|thinkcentre|workstation|small\s+form\s+factor|sff|tower\s+pc|desktop\s+(?:pc|computer)|mini\s+pc)\b/i },
  { cat: 'phone',       re: /\b(iphone|galaxy|pixel|smartphone)\b/i },
  { cat: 'tablet',      re: /\b(ipad|tablet)\b/i },
  { cat: 'networking',  re: /\b(router|switch|access\s+point|firewall|modem|networking)\b/i },
  { cat: 'cooling',     re: /\b(cooler|fan|heatsink|aio|liquid\s+cooler)\b/i },
  { cat: 'components',  re: /\b(motherboard|mobo|psu|power\s+supply|cpu|processor|intel\s+core|amd\s+ryzen|epyc|xeon)\b/i },
  { cat: 'storage',     re: /\b(ssd|nvme|hdd|hard\s+drive|m\.2)\b/i },
  { cat: 'audio',       re: /\b(speaker|headphone|earbud|microphone|soundbar)\b/i },
  { cat: 'appliance',   re: /\b(refrigerator|microwave|oven|dishwasher|vacuum)\b/i },
  { cat: 'accessories', re: /\b(cable|charger|adapter|case|protector|stand|mount)\b/i },
];

export function classifyCategory(text) {
  const s = String(text || '');
  for (const { cat, re } of CATEGORY_RULES) {
    if (re.test(s)) return cat;
  }
  return 'other';
}

// Build a keyword query from brand + title. Strip noise terms that pollute
// eBay searches. Caps at 80 chars to keep the query URL sane.
const NOISE_WORDS_RE = /(geek\s+squad|amazon\s+renewed|apple\s+certified\s+pre-?owned|certified\s+refurbished|brand\s+new|open\s+box|in\s+stock|free\s+shipping|wholesale|liquidation|surplus|salvage|pallet|case\s+of)/gi;

export function cleanKeyword(brand, title) {
  const t = stripSellerJunk(title || '');
  const b = (brand || '').trim();
  const blended = (b ? `${b} ${t}` : t).replace(NOISE_WORDS_RE, '').replace(/\s+/g, ' ').trim();
  return blended.slice(0, 80);
}

export function stripSellerJunk(title) {
  if (typeof title !== 'string') return title;
  return title
    .replace(/Opens in a new window or tab/gi, '')
    .replace(/\s+[-–—]\s+[^-–—]*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}
