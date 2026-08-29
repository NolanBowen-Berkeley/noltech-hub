// ─── 1099-K thresholds + tax-rate constants ──────────────────────────────────
// Single source of truth for the federal 1099-K reporting thresholds + the
// self-employment tax base/rate the Bookkeeping module uses. Lives outside
// the module so a yearly threshold update is a one-line change here.
//
// The One Big Beautiful Bill Act (signed July 4, 2025) permanently restored
// the federal 1099-K threshold to $20,000 AND >200 transactions, killing the
// previously announced $5,000 / $2,500 phase-in. Threshold applies retro-
// actively for tax years 2022 onward.

export const THRESHOLDS_1099K = {
  2022: { gross: 20000, txn: 200 },
  2023: { gross: 20000, txn: 200 },
  2024: { gross: 20000, txn: 200 },
  2025: { gross: 20000, txn: 200 },
  2026: { gross: 20000, txn: 200 },
};

// State-level conformance map. CA conforms to the federal threshold for
// general sellers. MA/VT/NJ historically had lower thresholds — populate
// here if the user's home state changes.
export const STATE_THRESHOLDS = {
  CA: { gross: 20000, txn: 200, note: 'conforms to federal' },
};

// Federal SE tax — 15.3% on 92.35% of net earnings from self-employment.
export const SE_TAX_RATE = 0.153;
export const SE_TAX_BASE_PCT = 0.9235;

export const SOURCE_LINKS = [
  { label: 'IRS — Understanding Form 1099-K', url: 'https://www.irs.gov/businesses/understanding-your-form-1099-k' },
  { label: 'IRS — 1099-K FAQ', url: 'https://www.irs.gov/newsroom/irs-revises-and-updates-frequently-asked-questions-about-form-1099-k' },
  { label: 'eBay — Form 1099-K seller help', url: 'https://www.ebay.com/help/selling/fees-credits-invoices/ebay-form-1099k?id=4794' },
  { label: 'eBay — Threshold change announcement', url: 'https://community.ebay.com/t5/Announcements/1099-K-threshold-reverts-to-prior-level/ba-p/35224253' },
];

// Federal income tax brackets (single filer). Each entry is [width, rate]
// where `width` is the span of taxable income taxed at `rate` before
// moving to the next row. Lives here so the Bookkeeping estimateTax()
// helper can call into a single shared source.
export const TAX_TABLES = {
  2024: {
    stdDeduction: 14600,
    brackets: [[11600,0.10],[35550,0.12],[53375,0.22],[91950,0.24],[175950,0.32],[243225,0.35],[Infinity,0.37]],
  },
  2025: {
    stdDeduction: 15000,
    brackets: [[11925,0.10],[36550,0.12],[54875,0.22],[93950,0.24],[53225,0.32],[375825,0.35],[Infinity,0.37]],
  },
  2026: {
    stdDeduction: 15750,
    brackets: [[12400,0.10],[38000,0.12],[55300,0.22],[96075,0.24],[54450,0.32],[384375,0.35],[Infinity,0.37]],
  },
};

// Return the active threshold for a tax year. Defaults to the most recent
// known year for forward-dated lookups so the UI doesn't break the day the
// calendar rolls over Jan 1 of an unfilled year.
export function getThreshold1099K(year) {
  if (THRESHOLDS_1099K[year]) return THRESHOLDS_1099K[year];
  const known = Object.keys(THRESHOLDS_1099K).map(Number).sort();
  return THRESHOLDS_1099K[known[known.length - 1]];
}

export function getTaxTable(year) {
  if (TAX_TABLES[year]) return TAX_TABLES[year];
  const known = Object.keys(TAX_TABLES).map(Number).sort();
  return TAX_TABLES[known[known.length - 1]];
}

// SE + federal income tax estimate. `year` controls which bracket table +
// std deduction to use. Returns rounded integer dollars.
export function estimateTax(netProfit, year = new Date().getFullYear()) {
  if (netProfit <= 0) return { seTax: 0, incomeTax: 0, total: 0, quarterly: 0, year };
  const table = getTaxTable(year);
  const seTax = Math.max(0, netProfit * SE_TAX_BASE_PCT * SE_TAX_RATE);
  const deduction = seTax / 2;
  const taxableIncome = Math.max(0, netProfit - deduction - table.stdDeduction);
  let incomeTax = 0;
  let remaining = taxableIncome;
  for (const [size, rate] of table.brackets) {
    if (remaining <= 0) break;
    incomeTax += Math.min(remaining, size) * rate;
    remaining -= size;
  }
  const total = seTax + incomeTax;
  return {
    seTax:     Math.round(seTax),
    incomeTax: Math.round(incomeTax),
    total:     Math.round(total),
    quarterly: Math.round(total / 4),
    year,
  };
}
