// ─── Deterministic sample data ───────────────────────────────────────────────
// Everything the pipeline needs to run end to end without contacting any
// marketplace: lot listings, lot manifests, lot state, and sold comparables.
//
// This is the data the public build ships with. The original private build
// obtained the same shapes by scraping auction sites; that code is not part
// of this repository (see docs/DATA-SOURCES.md). Keeping a full fixture set
// means the Hub, the crons, and the scoring model are all exercisable — and
// reviewable — without an account anywhere.
//
// Everything here is seeded, so repeated calls return identical results.
// That matters for screenshots, UI diffing, and tests.

// ─── PRNG ────────────────────────────────────────────────────────────────────
// mulberry32 — small, fast, and stable across Node versions. Math.random()
// would make every fixture call return something different.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Stable 32-bit hash of a string, used to derive a per-query seed so the same
// query always produces the same comps.
export function seedFromString(s) {
  let h = 2166136261 >>> 0;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// ─── Catalog ─────────────────────────────────────────────────────────────────

const TITLES = [
  ['NVIDIA GeForce RTX 4070 Ti GPUs - Customer Returns - $18K Est. Retail', 'gpu',        18000],
  ['Dell OptiPlex 7090 Micro Desktops - Tested Working - $12K Est. Retail', 'desktop',    12000],
  ['Lenovo ThinkPad T14 Gen 3 Laptops - Salvage - $24K Est. Retail',        'laptop',     24000],
  ['Apple iPhone 13 / 14 Mixed Grade - Untested - $31K Est. Retail',        'phone',      31000],
  ['Cisco Catalyst 9300 Switches - Refurbished - $47K Est. Retail',         'networking', 47000],
  ['Samsung 980 PRO NVMe SSDs 1TB - New Open Box - $8K Est. Retail',        'storage',     8000],
  ['Corsair RM850x PSUs + AIO Coolers Mixed - Returns - $6K Est. Retail',   'cooling',     6000],
  ['Sony WH-1000XM5 Headphones - Customer Returns - $9K Est. Retail',       'audio',       9000],
];

const CONDITIONS = ['Customer Returns', 'Salvage', 'New Open Box', 'Refurbished', 'Untested Returns'];
const LOCATIONS  = ['Ontario, CA', 'Dallas, TX', 'Atlanta, GA', 'Edison, NJ', 'Plainfield, IN'];

// Per-category manifest line items. Keeps generated manifests plausible:
// a GPU lot is full of GPUs, not a random walk through the catalog.
const MANIFEST_ITEMS = {
  gpu: [
    ['NVIDIA', 'GeForce RTX 4070 Ti 12GB GDDR6X Graphics Card',          799],
    ['NVIDIA', 'GeForce RTX 4060 8GB Dual Fan Graphics Card',            329],
    ['AMD',    'Radeon RX 7800 XT 16GB Graphics Card',                   519],
    ['NVIDIA', 'GeForce RTX 3060 Ti 8GB LHR Graphics Card',              289],
  ],
  desktop: [
    ['Dell',   'OptiPlex 7090 Micro i7-11700T 16GB 512GB NVMe',          749],
    ['Dell',   'OptiPlex 5090 SFF i5-11500 8GB 256GB SSD',               529],
    ['HP',     'ProDesk 600 G6 Mini i5-10500T 16GB 512GB',               589],
    ['Lenovo', 'ThinkCentre M75q Gen 2 Ryzen 5 PRO 16GB 512GB',          499],
  ],
  laptop: [
    ['Lenovo', 'ThinkPad T14 Gen 3 i7-1265U 16GB 512GB',                1399],
    ['Lenovo', 'ThinkPad X1 Carbon Gen 10 i7 16GB 1TB',                 1799],
    ['Dell',   'Latitude 5430 i5-1245U 16GB 256GB',                     1099],
    ['HP',     'EliteBook 840 G9 i5-1245U 16GB 512GB',                  1249],
  ],
  phone: [
    ['Apple',  'iPhone 13 128GB Unlocked',                               599],
    ['Apple',  'iPhone 14 128GB Unlocked',                               729],
    ['Apple',  'iPhone 13 Pro 256GB Unlocked',                           899],
    ['Samsung','Galaxy S22 128GB Unlocked',                              649],
  ],
  networking: [
    ['Cisco',  'Catalyst 9300 48-Port PoE+ Switch C9300-48P',           4995],
    ['Cisco',  'Catalyst 9300 24-Port Switch C9300-24T',                3295],
    ['Ubiquiti','UniFi Switch Pro 48 PoE',                              1099],
    ['Aruba',  '2930F 48G PoE+ 4SFP Switch',                            2199],
  ],
  storage: [
    ['Samsung','980 PRO 1TB PCIe 4.0 NVMe M.2 SSD',                      129],
    ['Samsung','990 EVO 2TB NVMe M.2 SSD',                               179],
    ['WD',     'Black SN850X 1TB NVMe M.2 SSD',                          139],
    ['Crucial','P3 Plus 2TB NVMe M.2 SSD',                               129],
  ],
  cooling: [
    ['Corsair','RM850x 850W 80+ Gold Fully Modular PSU',                 159],
    ['Corsair','iCUE H150i ELITE CAPELLIX 360mm AIO Cooler',             189],
    ['NZXT',   'Kraken X63 280mm AIO Liquid Cooler',                     149],
    ['be quiet!','Dark Rock Pro 4 CPU Air Cooler',                        89],
  ],
  audio: [
    ['Sony',   'WH-1000XM5 Wireless Noise Cancelling Headphones',        399],
    ['Bose',   'QuietComfort Ultra Wireless Headphones',                 429],
    ['Apple',  'AirPods Pro 2nd Generation USB-C',                       249],
    ['Sennheiser','Momentum 4 Wireless Headphones',                      349],
  ],
};

const ITEM_CONDITIONS = ['New', 'Open Box', 'Used - Good', 'For Parts', 'Refurbished'];

// ─── Lot listings ────────────────────────────────────────────────────────────

/**
 * Generate a page of sample lots in the shape the Hub's browse view expects.
 *
 * @param {object}  opts
 * @param {number} [opts.count=24]      lots to generate
 * @param {number} [opts.page=1]        page number (offsets the seed)
 * @param {number} [opts.seed=20260813] base seed
 * @param {string} [opts.source]        value for each lot's `source` field
 */
export function sampleLots({ count = 24, page = 1, seed = 20260813, source = 'sample' } = {}) {
  const n = Math.min(60, Math.max(1, count));
  const pageSeed = (seed + page * 7919) >>> 0;
  const rand = mulberry32(pageSeed);
  const generatedAt = new Date().toISOString();
  const lots = [];

  for (let i = 0; i < n; i++) {
    const [title, category, msrp] = TITLES[i % TITLES.length];
    const lotId = String(90000000 + (page - 1) * 10000 + i * 137 + (seed % 1000));

    // Bid lands between 6% and 40% of estimated retail — roughly the close
    // ratio band this kind of auction actually clears at.
    const ratio    = 0.06 + rand() * 0.34;
    const price    = Math.round(msrp * ratio);
    const closesIn = Math.round(rand() * 72 * 3600 * 1000);
    const endsAt   = new Date(Date.now() + closesIn).toISOString();
    const hours    = Math.floor(closesIn / 3600000);

    lots.push({
      lotId,
      id:          `sample-${lotId}`,
      source,
      seller:      'Sample_Seller',
      title:       `${title} [SAMPLE]`,
      url:         `https://example.invalid/lots/${lotId}`,
      image:       null,
      category,
      price,
      numBids:     Math.floor(rand() * 25),
      condition:   CONDITIONS[Math.floor(rand() * CONDITIONS.length)],
      quantity:    String(Math.floor(rand() * 400) + 10),
      location:    LOCATIONS[Math.floor(rand() * LOCATIONS.length)],
      numPallets:  Math.floor(rand() * 6) + 1,
      numPackages: Math.floor(rand() * 40) + 1,
      status:      'open',
      timeLeft:    hours < 1 ? 'Closing in minutes' : `Closing in ${hours}h`,
      endsAt,
      msrp,
      scrapedAt:   generatedAt,
    });
  }
  return lots;
}

// The category a generated lot id belongs to. Derived from the id so a
// manifest request for a lot we handed out earlier stays consistent with the
// listing, even though nothing is stored between calls.
function categoryForLotId(lotId) {
  const idx = seedFromString(lotId) % TITLES.length;
  return TITLES[idx][1];
}

// ─── Manifests ───────────────────────────────────────────────────────────────

/**
 * Generate a sample manifest as a raw header/row table — the same shape a
 * provider parsing a real manifest file would return.
 *
 * @returns {{ headers: string[], rows: string[][] }}
 */
export function sampleManifestTable(lotId, { rows: rowCount = 0 } = {}) {
  const seed = seedFromString(`manifest:${lotId}`);
  const rand = mulberry32(seed);
  const category = categoryForLotId(lotId);
  const catalog  = MANIFEST_ITEMS[category] || MANIFEST_ITEMS.gpu;

  const n = rowCount > 0 ? rowCount : 8 + Math.floor(rand() * 25);
  const headers = ['Line', 'Brand', 'Description', 'UPC', 'Quantity', 'MSRP', 'Condition'];
  const rows = [];

  for (let i = 0; i < n; i++) {
    const [brand, description, msrp] = catalog[Math.floor(rand() * catalog.length)];
    // A synthetic but check-digit-shaped 12-digit UPC. Deliberately in the
    // 0999... range, which is not an assigned GS1 prefix, so these can never
    // collide with a real product code.
    const upc = '0999' + String(Math.floor(rand() * 1e8)).padStart(8, '0');
    const qty = 1 + Math.floor(rand() * 4);
    rows.push([
      String(i + 1),
      brand,
      description,
      upc,
      String(qty),
      msrp.toFixed(2),
      ITEM_CONDITIONS[Math.floor(rand() * ITEM_CONDITIONS.length)],
    ]);
  }
  return { headers, rows };
}

// ─── Lot state ───────────────────────────────────────────────────────────────

/**
 * Current auction state for a lot. Deterministic per lot id: roughly a third
 * of lots read as ended, so refresh/alert crons exercise both branches.
 */
export function sampleLotState(lotId) {
  const rand  = mulberry32(seedFromString(`state:${lotId}`));
  const roll  = rand();
  const ended = roll < 0.34;
  const category = categoryForLotId(lotId);
  const msrp  = (TITLES.find((t) => t[1] === category) || TITLES[0])[2];
  const price = Math.round(msrp * (0.06 + rand() * 0.34));

  if (!ended) {
    return {
      ok: true,
      ended: false,
      status: 'still_active',
      currentPrice: price,
      finalBid: null,
      endsAt: new Date(Date.now() + Math.round(rand() * 48 * 3600 * 1000)).toISOString(),
    };
  }
  // A small slice of ended auctions close with no winning bid.
  const noSale = rand() < 0.15;
  return {
    ok: true,
    ended: true,
    status: noSale ? 'no_sale' : 'sold',
    currentPrice: noSale ? null : price,
    finalBid:     noSale ? null : price,
    endsAt: new Date(Date.now() - Math.round(rand() * 48 * 3600 * 1000)).toISOString(),
  };
}

// ─── Placeholder image ───────────────────────────────────────────────────────

// A 1x1 transparent PNG. The lot-image route needs to return *something*
// image-shaped so <img> tags in the Hub resolve instead of showing a broken
// icon; the sample provider has no real photography to serve.
const TRANSPARENT_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk' +
  'YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export function samplePlaceholderImage() {
  return {
    ok: true,
    bytes: Buffer.from(TRANSPARENT_PNG_BASE64, 'base64'),
    contentType: 'image/png',
  };
}

// ─── Sold comparables ────────────────────────────────────────────────────────

/**
 * Generate sold-comparable samples for a query, in the shape the scoring code
 * consumes. Prices cluster log-normally around a base derived from the query
 * text, which produces a realistic spread — including the occasional outlier
 * the filter stage is there to remove.
 *
 * @returns {{ items: object[], total: number }}
 */
export function sampleSoldComps(query, { maxResults = 60, soldDays = 90, condition = 'any' } = {}) {
  const q = String(query || '').trim();
  if (!q) return { items: [], total: 0 };

  const seed = seedFromString(`comps:${q}|${condition}|${soldDays}`);
  const rand = mulberry32(seed);

  // ~8% of queries return nothing, so the empty-result path stays exercised.
  if (rand() < 0.08) return { items: [], total: 0 };

  // Base price from the query hash, 25-900 USD, nudged by condition.
  let base = 25 + (seed % 875);
  if (condition === 'for_parts') base *= 0.35;

  const count = Math.min(maxResults, 6 + Math.floor(rand() * 40));
  const items = [];

  for (let i = 0; i < count; i++) {
    // Box-Muller for a normal deviate, then exponentiate for a log-normal
    // price spread (real sold prices are right-skewed, not symmetric).
    const u1 = Math.max(rand(), 1e-9);
    const u2 = rand();
    const z  = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const price = round2(Math.max(1, base * Math.exp(z * 0.22)));

    const shippingCost = rand() < 0.55 ? round2(rand() * 24) : 0;
    const daysAgo = Math.floor(rand() * soldDays);

    items.push({
      itemId:         `sample-${seed.toString(36)}-${i}`,
      title:          `${q} (sample comparable ${i + 1})`,
      conditionLabel: condition === 'for_parts' ? 'For parts or not working' : 'Used',
      price,
      currency:       'USD',
      shippingCost,
      totalPrice:     round2(price + shippingCost),
      soldAt:         new Date(Date.now() - daysAgo * 86400000).toISOString(),
      imageUrl:       null,
      itemUrl:        null,
    });
  }
  return { items, total: items.length };
}

function round2(n) { return Math.round(n * 100) / 100; }
