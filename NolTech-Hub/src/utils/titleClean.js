// ─── eBay listing title cleaner ────────────────────────────────────────────────
// Strips marketing fluff, ALL-CAPS exclamations, emojis, and repeat punctuation
// out of noisy eBay titles so they read like a normal NolTech listing title.
//
// Two layers:
//   1. cleanEbayTitle()  — pure regex, instant, no API key required.
//   2. cleanTitles()     — Gemini-powered (in src/services/gemini.js), batched,
//                          higher quality, only runs if user has set a key.
//
// The regex pass always runs first so something useful displays even when
// Gemini isn't configured.

// Marketing/fluff phrases that add no value to a clean listing title.
// Stripped case-insensitively, whole-word. Keep this list conservative —
// over-stripping breaks legitimate model names (e.g. "Mint" is a hotel, but
// also a real product line for some brands; we accept that trade-off).
const FLUFF_PHRASES = [
  'brand new', 'brand-new', 'new in box', 'new sealed', 'sealed in box',
  'factory sealed', 'genuine', 'authentic', '100% authentic', '100% genuine',
  'oem genuine', 'authentic oem', 'fast shipping', 'free shipping',
  'fast free shipping', 'ships fast', 'ships today', 'same day shipping',
  'must see', 'must-see', 'l@@k', 'wow', 'rare find', 'mint condition',
  'read description', 'see photos', 'see pics', 'as pictured',
  'tested working', 'tested & working', 'tested and working',
  'works great', 'works perfect', 'works like new',
  'great deal', 'best deal', 'top rated', 'top-rated', 'hot item',
  'limited time', 'us seller', 'usa seller',
  'great condition', 'excellent condition', 'good condition',
  'in great shape', 'in good shape', 'beautiful',
  'super fast', 'super clean',
  // eBay scraper accessibility / suffix junk
  'opens in a new window or tab',
  'opens in new window or tab',
  'opens in a new window',
  'opens in new window',
];

// Strip leading/trailing star/exclamation borders like "*** WOW ***"
const STAR_BURST = /^[\s*!?★☆✨🔥]+|[\s*!?★☆✨🔥]+$/g;

// Strip multi-word ALL-CAPS exclamation phrases like "MUST SEE!" or "BRAND NEW!!!"
// Only strip if the phrase ends with one or more "!" — leaves real model names
// like "GAMING PC" or "DDR4" alone.
const ALL_CAPS_EXCLAIM = /\b[A-Z][A-Z\s]{2,}!+/g;

// Repeated punctuation: "----", "....", "!!!", "***"
const REPEAT_PUNCT = /([\-_=*.!?])\1{2,}/g;

// Basic emoji ranges (covers the most common ones eBay sellers use)
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/gu;

function escapeRegex(s) {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

const FLUFF_RE = new RegExp(
  '\\b(' + FLUFF_PHRASES.map(escapeRegex).join('|') + ')\\b',
  'gi',
);

// Heuristic title-casing — preserves anything that looks like a model number,
// abbreviation, or unit (i5, 256GB, 14", DDR4, USB-C, RTX, Win10, etc.)
function smartTitleCase(s) {
  if (!s) return s;
  // If the whole string is screaming, lowercase everything first then case-up.
  const screaming = s === s.toUpperCase() && /[A-Z]{4,}/.test(s);
  if (!screaming) return s;
  return s
    .toLowerCase()
    .replace(/\b([a-z])([a-z]*)/g, (_, first, rest) => first.toUpperCase() + rest)
    // Re-uppercase common tech abbreviations
    .replace(/\b(GB|TB|MB|KB|RAM|SSD|HDD|HD|UHD|FHD|QHD|CPU|GPU|MPN|SKU|UPC|USB|HDMI|DVI|VGA|VR|AR|TV|PC|OS|RGB|RTX|GTX|GT|GTS|RX|DDR\d?|PCIe|NVMe|SATA|UEFI|BIOS|EFI|EU|US|UK|CA|JP|CN|UV|IR|UV-C|LED|LCD|OLED|AMOLED|IPS|TFT|QLED|HDR|4K|8K|2K|1080p|720p|1440p)\b/gi, (m) => m.toUpperCase())
    // Lowercase common stop words mid-title
    .replace(/\b(For|And|Or|With|The|A|An|Of|To|In|On|At)\b/g, (m) => m.toLowerCase())
    // Always capitalize the first word
    .replace(/^./, (m) => m.toUpperCase());
}

/**
 * Clean a single noisy eBay title to a normal listing title.
 *
 *   "BRAND NEW! Apple iPhone 13 128GB Unlocked Smartphone - FAST SHIPPING - GENUINE"
 *   →  "Apple iPhone 13 128GB Unlocked Smartphone"
 *
 * @param {string} rawTitle
 * @param {{ maxLen?: number }} [options]
 * @returns {string}
 */
export function cleanEbayTitle(rawTitle, options = {}) {
  if (!rawTitle) return '';
  const { maxLen = 80 } = options;

  let s = String(rawTitle);

  s = s.replace(EMOJI_RE, '');
  s = s.replace(STAR_BURST, '');
  s = s.replace(ALL_CAPS_EXCLAIM, '');
  // eBay scraper bug — accessibility text concatenated to the end of the
  // title with no space ("CoverOpens in a new window or tab"). Detect the
  // lowercase→uppercase O boundary so we keep "Cover" but drop "Opens…".
  s = s.replace(/([a-z])Opens in (?:a )?new window(?: or tab)?/g, '$1');
  // And the spaced version ("Cover Opens in a new window or tab")
  s = s.replace(/\bOpens in (?:a )?new window(?: or tab)?/gi, '');
  s = s.replace(FLUFF_RE, '');
  s = s.replace(REPEAT_PUNCT, '$1');

  // Collapse whitespace and dangling punctuation
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^[\s,.\-–—:|·•]+|[\s,.\-–—:|·•]+$/g, '');
  // Collapse "  -  " style separators that get orphaned after stripping
  s = s.replace(/\s+[-–—|·•]\s+[-–—|·•]\s+/g, ' - ');
  s = s.replace(/\s+[-–—|·•]\s*$/g, '');

  s = smartTitleCase(s);

  if (s.length > maxLen) s = s.slice(0, maxLen - 1).trimEnd() + '…';

  return s;
}

/**
 * Clean a batch of titles via the regex layer. Returns same shape as the
 * Gemini batch — useful as a fallback when Gemini isn't configured.
 *
 * @param {Array<{ upc?: string, rawTitle: string }>} items
 * @returns {Array<{ upc: string, cleanTitle: string }>}
 */
export function cleanTitlesRegex(items) {
  if (!Array.isArray(items)) return [];
  return items.map((it) => ({
    upc: it?.upc || '',
    cleanTitle: cleanEbayTitle(it?.rawTitle || '', { maxLen: 80 }),
  }));
}
