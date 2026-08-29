// ─── Motherboard repair-cost estimator ────────────────────────────────────────
// Liquidation motherboards almost always arrive with bent pins. This module
// scans a priced manifest for real motherboard line items, classifies each
// one's CPU socket, and produces a per-socket shopping list at $5/socket
// (replacement cost). Surfaced on the lot card so you can size the repair
// budget at a glance.

export const COST_PER_SOCKET = 5;

// Stable display order for the per-socket grid. Newer/more common sockets
// first so the most-likely buckets bubble to the top.
export const SOCKET_LABEL_ORDER = [
  'AM5', 'AM4', 'AM3+',
  'sTRX4', 'sTR4',
  'LGA1851', 'LGA1700', 'LGA1200',
  'LGA1151', 'LGA1150',
  'LGA2066', 'LGA2011-3', 'LGA2011',
];

// ── Classification ──────────────────────────────────────────────────────────
// A manifest line counts as a motherboard when its title clearly says so OR
// when a chipset + form-factor pair appear together. Bare components / cables
// / cases / coolers are excluded.

const MOBO_WORD = /\b(motherboard|mainboard|mobo|m\.b\.)\b/i;
const FORM_FACTOR = /\b(?:micro[\s-]*atx|mini[\s-]*itx|m[\s-]*atx|\bmatx\b|\bitx\b|\batx\b)\b/i;
const CHIPSET_TOKEN = /\b(?:A|B|H|Q|W|X|Z)\d{2,3}[A-Za-z]?\b/;
const NEGATIVE = /\b(cable|mount|bracket|tray|backplate|i\/?o\s*shield|power\s*supply|\bpsu\b|case\s*fan|cpu\s*cooler|liquid\s*cool|aio|chassis|computer\s*case|standoff)\b/i;

export function isMotherboardItem(item) {
  if (!item) return false;
  // Exclude OEM motherboards that the desktop part-out path inferred — those
  // aren't real items in the lot, they're synthesized for the part-out scenario.
  if (item._isPart && item._partType === 'motherboard') return false;
  const t = `${item.ebayTitle || ''} ${item.title || ''}`;
  if (!t.trim()) return false;
  if (NEGATIVE.test(t)) return false;
  if (MOBO_WORD.test(t)) return true;
  // Without the explicit word, require chipset + form factor in the same line.
  if (CHIPSET_TOKEN.test(t) && FORM_FACTOR.test(t)) return true;
  return false;
}

// ── Socket detection ────────────────────────────────────────────────────────
// Two signals: explicit socket token in the title, or chipset→socket lookup.
// Returns the socket name (matching SOCKET_LABEL_ORDER) or null for unknown.

const SOCKET_TOKEN = /\b(AM5|AM4|AM3\+?|sTRX4|sTR4|LGA[\s-]?1851|LGA[\s-]?1700|LGA[\s-]?1200|LGA[\s-]?1151|LGA[\s-]?1150|LGA[\s-]?2011[\s-]?3|LGA[\s-]?2011|LGA[\s-]?2066)\b/i;

const CHIPSET_TO_SOCKET = Object.freeze({
  // AMD AM5 (Ryzen 7000 / 8000 / 9000)
  A620: 'AM5', B650: 'AM5', X670: 'AM5', B850: 'AM5', X870: 'AM5',
  // AMD AM4 (Ryzen 1000–5000)
  A320: 'AM4', A520: 'AM4', B350: 'AM4', B450: 'AM4', B550: 'AM4',
  X370: 'AM4', X470: 'AM4', X570: 'AM4',
  // Intel LGA1851 (Core Ultra Series 2 / "15th gen")
  H810: 'LGA1851', B860: 'LGA1851', Q870: 'LGA1851', W880: 'LGA1851', Z890: 'LGA1851',
  // Intel LGA1700 (12th–14th gen)
  H610: 'LGA1700', B660: 'LGA1700', Q670: 'LGA1700', H670: 'LGA1700',
  Z690: 'LGA1700', B760: 'LGA1700', H770: 'LGA1700', Z790: 'LGA1700',
  // Intel LGA1200 (10th–11th gen)
  H410: 'LGA1200', B460: 'LGA1200', H470: 'LGA1200', W480: 'LGA1200',
  Z490: 'LGA1200', H510: 'LGA1200', B560: 'LGA1200', H570: 'LGA1200', Z590: 'LGA1200',
  // Intel LGA1151 (6th–9th gen — same physical socket)
  H110: 'LGA1151', B150: 'LGA1151', H170: 'LGA1151', Q150: 'LGA1151', Q170: 'LGA1151',
  Z170: 'LGA1151', B250: 'LGA1151', H270: 'LGA1151', Z270: 'LGA1151',
  H310: 'LGA1151', B360: 'LGA1151', B365: 'LGA1151', H370: 'LGA1151', Q370: 'LGA1151',
  Z370: 'LGA1151', Z390: 'LGA1151',
  // Intel LGA1150 (4th–5th gen)
  H81: 'LGA1150', B85: 'LGA1150', H87: 'LGA1150', Q85: 'LGA1150', Q87: 'LGA1150',
  Z87: 'LGA1150', H97: 'LGA1150', Z97: 'LGA1150',
  // HEDT / server
  X299: 'LGA2066',
  X99: 'LGA2011-3',
  X79: 'LGA2011',
  // Threadripper
  TRX40: 'sTRX4', WRX80: 'sTRX4',
  X399: 'sTR4',
});

function normalizeSocketToken(raw) {
  let s = raw.toUpperCase().replace(/[\s-]/g, '');
  if (s === 'LGA20113') s = 'LGA2011-3';
  if (s === 'AM3') s = 'AM3+';  // safety; AM3+ regex covers both
  return s;
}

export function detectSocket(title) {
  if (!title) return null;
  const t = String(title);
  // 1. Explicit socket token wins.
  const m = t.match(SOCKET_TOKEN);
  if (m) return normalizeSocketToken(m[1]);
  // 2. Chipset → socket fallback. Strip trailing letter (B850M → B850).
  const c = t.match(CHIPSET_TOKEN);
  if (c) {
    const chip = c[0].toUpperCase().replace(/[A-Z]$/, '');
    if (CHIPSET_TO_SOCKET[chip]) return CHIPSET_TO_SOCKET[chip];
  }
  return null;
}

// ── Aggregate per-lot ───────────────────────────────────────────────────────
// Walks a priced manifest, buckets known sockets together, and emits unknowns
// as individual `1×` entries (one row per board) so the user can eyeball the
// title and classify manually if needed.

export function summarizeRepairs(manifestItems, { costPerSocket = COST_PER_SOCKET } = {}) {
  const empty = { totalBoards: 0, totalCost: 0, bySocket: [], unknowns: [] };
  if (!Array.isArray(manifestItems)) return empty;
  const boards = manifestItems.filter(isMotherboardItem);
  if (boards.length === 0) return empty;

  const known = {};      // socket → count
  const unknowns = [];   // [{ title }] per individual board (qty-expanded)
  let totalBoards = 0;

  for (const item of boards) {
    const rawQty = parseInt(item.qty, 10);
    const qty = Number.isFinite(rawQty) && rawQty > 0 ? rawQty : 1;
    totalBoards += qty;
    const socket = detectSocket(item.ebayTitle || item.title);
    if (socket) {
      known[socket] = (known[socket] || 0) + qty;
    } else {
      // User wants unknowns surfaced as individual 1× lines so each board is
      // visible (vs. lumped into one "unknown" bucket). Expand by qty.
      const titleSnippet = (item.ebayTitle || item.title || '').slice(0, 60);
      for (let i = 0; i < qty; i++) unknowns.push({ title: titleSnippet });
    }
  }

  const bySocket = Object.entries(known)
    .map(([socket, count]) => ({ socket, count, cost: count * costPerSocket }))
    .sort((a, b) => {
      const ai = SOCKET_LABEL_ORDER.indexOf(a.socket);
      const bi = SOCKET_LABEL_ORDER.indexOf(b.socket);
      // Unknown-ordered sockets sink to the end (after the known list).
      const av = ai < 0 ? 999 : ai;
      const bv = bi < 0 ? 999 : bi;
      return av - bv;
    });

  return {
    totalBoards,
    totalCost: totalBoards * costPerSocket,
    bySocket,
    unknowns,
  };
}
