// ─── Single source of truth: item category detection ────────────────────────
// Used by:
//   - manifest parser (categorize each item)
//   - sold-comps lookup (route to category-specific filters)
//   - scoring (shipping cost lookup)
//
// Replaces FOUR previously-duplicated copies:
//   - NolTech-Hub/src/services/manifestParser.js
//   - lots-discovery-worker/src/enrichment.js
//   - scraper-worker/src/textUtils.js
//   - NolTech-Hub/scraper/utils/categoryClassifier.js

const PATTERNS = [
  { cat: 'gpu',         re: /\b(rtx|gtx|radeon|geforce|quadro|tesla|firepro|rx\s?\d{3,}|gpu\b|graphics\s+card)\b/i },
  { cat: 'cpu',         re: /\b(intel\s+(?:core\s+)?i[3579][-\s]?\d{4,5}[a-z]?|xeon\b|amd\s+ryzen\b|epyc\b|threadripper\b|\bcpu\b|\bprocessor\b)/i },
  { cat: 'ram',         re: /\b(\d+\s*gb\s+(?:ddr[345]|ram|memory|dimm|sodimm|udimm|rdimm)|\bddr[345]\s+\d+gb\b)/i },
  { cat: 'storage',     re: /\b(\d+\s*(?:tb|gb)\s+(?:ssd|nvme|m\.?2|hdd|hard\s+drive)|\bnvme\b|\bsata\s+ssd\b)/i },
  { cat: 'motherboard', re: /\b(motherboard|mainboard|\bmobo\b|x870[a-z]?|x670[a-z]?|b860[a-z]?|b850[a-z]?|b760[a-z]?|b660[a-z]?|z890|z790|z690|tuf\s+gaming.+(?:atx|wifi|motherboard)|rog\s+(?:strix|maximus|crosshair).+(?:atx|wifi|motherboard)|aorus.+(?:atx|wifi|motherboard))/i },
  { cat: 'psu',         re: /\b(power\s+supply|\bpsu\b|\d{3,4}\s*w\s+(?:gold|bronze|platinum|titanium|atx|psu|modular)|seasonic\s+\w+|corsair\s+rm\d+|evga\s+supernova)\b/i },
  { cat: 'monitor',     re: /\b(monitor\b|\bdisplay\b|\blcd\b|\b\d{2}["']?\s*(?:gaming|curved|ips|qhd|uhd|4k|fhd|hdr)\b|ultrawide)/i },
  { cat: 'laptop',      re: /\b(laptop|notebook|thinkpad|elitebook|latitude|inspiron|surface\s+(?:pro|laptop|book)|ideapad|chromebook|macbook)\b/i },
  { cat: 'desktop',     re: /\b(optiplex|prodesk|elitedesk|thinkcentre|workstation\b|small\s+form\s+factor|sff\b|tower\s+pc|desktop\s+(?:pc|computer)|\bmini\s+pc\b|gaming\s+pc|prebuilt)\b/i },
  { cat: 'keyboard',    re: /\b(keyboard\b|mechanical\s+keys?|\btkl\b|tenkeyless|hot[-\s]?swap(?:pable)?)\b/i },
  { cat: 'mouse',       re: /\b(gaming\s+mouse|wireless\s+mouse|\bmouse\b)/i },
  { cat: 'phone',       re: /\b(iphone|galaxy\s*s\d|pixel\s*\d|smartphone)\b/i },
  { cat: 'tablet',      re: /\b(ipad|tablet|galaxy\s*tab)\b/i },
  { cat: 'networking',  re: /\b(networking|switch|router|firewall|rackmount|access\s*point)\b/i },
  { cat: 'audio',       re: /\b(headset|headphone|earbud|speaker|soundbar|microphone)\b/i },
  { cat: 'accessories', re: /\b(cable|adapter|charger|cover|stand|protector)\b/i },
];

export const CATEGORIES = [
  'gpu', 'cpu', 'ram', 'storage', 'motherboard', 'psu', 'monitor',
  'laptop', 'desktop', 'keyboard', 'mouse', 'phone', 'tablet',
  'networking', 'audio', 'accessories', 'other',
];

export function detectCategory(text) {
  if (!text || typeof text !== 'string') return 'other';
  for (const { cat, re } of PATTERNS) {
    if (re.test(text)) return cat;
  }
  return 'other';
}
