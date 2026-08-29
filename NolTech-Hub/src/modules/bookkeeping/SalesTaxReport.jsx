// ─── Sales Tax Return Helper ─────────────────────────────────────────────────
// Computes the line items needed to file a quarterly sales-tax return
// (CA CDTFA-401-A by default; numbers translate to most state forms).
//
// How it categorizes:
//   • Marketplace-facilitator sales (eBay, Mercari, Facebook Marketplace) —
//     these platforms are required to collect and remit sales tax for the
//     seller in CA + most states. Sellers DEDUCT these from the taxable
//     amount on their return because the marketplace already handled the tax.
//   • Direct sales (local / cash / other) — seller is responsible for
//     collecting and remitting tax on these IF buyer is in the seller's
//     home state (or any state where the seller has economic nexus).
//
// Core line items (CDTFA-401-A names; other states have similar):
//   1. Total (gross) sales = sum of all sale prices for the period
//   2. Deductions:
//      - Sales for resale       (B2B, normally 0 for retail)
//      - Out-of-state sales     (ship-to outside seller's home state)
//      - Marketplace facilitator (eBay/Mercari/FB)
//   3. Net taxable sales       = Line 1 − all deductions
//   4. Tax due                 = Net taxable × statewide rate (district rates extra)
//
// The seller's "home state" is configurable; the report also surfaces a
// per-state breakdown for nexus tracking.

import { useState, useEffect, useMemo } from 'react';
import { Receipt, Download, AlertCircle, Info, Copy, Check } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { fmt } from '../../utils/formatters';

const QUARTER_KEY = 'noltech:sales-tax:quarter';
const YEAR_KEY    = 'noltech:sales-tax:year';
const STATE_KEY   = 'noltech:sales-tax:home-state';

const QUARTERS = [
  { id: 'Q1', label: 'Q1 (Jan–Mar)', months: [0, 1, 2] },
  { id: 'Q2', label: 'Q2 (Apr–Jun)', months: [3, 4, 5] },
  { id: 'Q3', label: 'Q3 (Jul–Sep)', months: [6, 7, 8] },
  { id: 'Q4', label: 'Q4 (Oct–Dec)', months: [9, 10, 11] },
  { id: 'Y',  label: 'Full year',    months: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
];

// Default sales-tax rate per state (statewide minimum — districts add more).
// User can override the rate in the form. Numbers are accurate as of 2024–2026
// general filings; verify against your state's current rate before submitting.
const STATE_RATES = {
  CA: 0.0725, NY: 0.04,  TX: 0.0625, FL: 0.06,  WA: 0.065,
  IL: 0.0625, PA: 0.06,  OH: 0.0575, GA: 0.04,  NC: 0.0475,
  AZ: 0.056,  CO: 0.029, MA: 0.0625, MI: 0.06,  NJ: 0.06625,
  VA: 0.043,  MD: 0.06,  IN: 0.07,   TN: 0.07,  WI: 0.05,
};

const MARKETPLACE_PLATFORMS = new Set(['ebay', 'mercari', 'facebook']);

function inMonthRange(dateStr, year, months) {
  if (!dateStr) return false;
  const d = new Date(dateStr.includes('T') ? dateStr : dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return false;
  return d.getFullYear() === year && months.includes(d.getMonth());
}

function downloadCSV(filename, rows) {
  const csv = rows.map((r) => r.map((c) => {
    const s = c == null ? '' : String(c);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

export default function SalesTaxReport() {
  const { state: appState } = useApp();
  const now = new Date();
  const [quarter,   setQuarter]   = useState('Q' + (Math.floor(now.getMonth() / 3) + 1));
  const [year,      setYear]      = useState(now.getFullYear());
  const [homeState, setHomeState] = useState('CA');
  const [rate,      setRate]      = useState(STATE_RATES.CA);
  const [rateOverridden, setRateOverridden] = useState(false);
  const [copied,    setCopied]    = useState(false);

  // Hydrate persisted preferences
  useEffect(() => {
    Promise.all([
      window.storage.get(QUARTER_KEY).catch(e => { console.error('[sales tax report] storage error:', e); return null; }),
      window.storage.get(YEAR_KEY).catch(e => { console.error('[sales tax report] storage error:', e); return null; }),
      window.storage.get(STATE_KEY).catch(e => { console.error('[sales tax report] storage error:', e); return null; }),
    ]).then(([q, y, s]) => {
      if (q) setQuarter(q);
      if (y) setYear(parseInt(y, 10));
      if (s) {
        setHomeState(s);
        if (!rateOverridden && STATE_RATES[s]) setRate(STATE_RATES[s]);
      }
    });
  }, []);

  useEffect(() => { window.storage.set(QUARTER_KEY, quarter).catch(e => console.error('[sales tax report] storage error:', e)); }, [quarter]);
  useEffect(() => { window.storage.set(YEAR_KEY, year).catch(e => console.error('[sales tax report] storage error:', e)); }, [year]);
  useEffect(() => {
    window.storage.set(STATE_KEY, homeState).catch(e => console.error('[sales tax report] storage error:', e));
    if (!rateOverridden && STATE_RATES[homeState]) setRate(STATE_RATES[homeState]);
  }, [homeState, rateOverridden]);

  const months = (QUARTERS.find((q) => q.id === quarter) || QUARTERS[0]).months;

  // Pull every sold item that falls in the period
  const sales = useMemo(() => {
    const out = [];
    for (const lot of (appState.lots || [])) {
      for (const item of (lot.items || [])) {
        const sale = item.sale;
        if (!sale?.soldAt) continue;
        if (!inMonthRange(sale.soldAt, year, months)) continue;
        const platform = (sale.platform || 'other').toLowerCase();
        const shipState = (sale.shipTo?.state || sale.buyerState || '').toUpperCase().trim();
        const salePrice    = parseFloat(sale.salePrice)    || 0;
        const buyerShipping= parseFloat(sale.buyerShipping)|| 0;
        const grossReceipt = salePrice; // includes buyer-paid shipping
        const taxRemitted  = parseFloat(sale.salesTax) || 0;
        out.push({
          itemId:   item.id,
          soldAt:   sale.soldAt,
          name:     `${item.brand || ''} ${item.model || ''}`.trim() || item.sku || 'Item',
          platform,
          isMarketplace: MARKETPLACE_PLATFORMS.has(platform),
          shipState,
          inHomeState: shipState && shipState === homeState,
          gross: grossReceipt,
          buyerShipping,
          taxRemitted,
        });
      }
    }
    return out;
  }, [appState.lots, year, months, homeState]);

  // Roll up the line items
  const summary = useMemo(() => {
    let totalSales = 0;
    let marketplaceSales = 0;
    let directSales = 0;
    let directInState = 0;
    let directOutOfState = 0;
    let marketplaceTaxRemitted = 0;
    const byState = {};
    const byPlatform = {};

    for (const s of sales) {
      totalSales += s.gross;
      if (s.isMarketplace) {
        marketplaceSales += s.gross;
        marketplaceTaxRemitted += s.taxRemitted;
      } else {
        directSales += s.gross;
        if (s.inHomeState) directInState += s.gross;
        else               directOutOfState += s.gross;
      }
      const stateKey = s.shipState || '(unknown)';
      byState[stateKey] = (byState[stateKey] || 0) + s.gross;
      byPlatform[s.platform] = (byPlatform[s.platform] || 0) + s.gross;
    }

    // CA CDTFA-401-A: Net taxable = direct sales to in-state buyers (the
    // seller's actual tax obligation). Out-of-state direct sales typically
    // aren't taxable in your home state (and may or may not be taxable in
    // the destination state — depends on nexus there).
    const netTaxable = Math.round(directInState * 100) / 100;
    const taxDue     = Math.round(netTaxable * rate * 100) / 100;

    return {
      totalSales:           Math.round(totalSales * 100) / 100,
      marketplaceSales:     Math.round(marketplaceSales * 100) / 100,
      directSales:          Math.round(directSales * 100) / 100,
      directInState:        Math.round(directInState * 100) / 100,
      directOutOfState:     Math.round(directOutOfState * 100) / 100,
      marketplaceTaxRemitted: Math.round(marketplaceTaxRemitted * 100) / 100,
      netTaxable,
      taxDue,
      byState,
      byPlatform,
      saleCount: sales.length,
    };
  }, [sales, rate]);

  const periodLabel = quarter === 'Y' ? `${year}` : `${quarter} ${year}`;

  // Per-month breakdown for verification (so the user can sanity-check the
  // total against eBay's per-month payout statements before filing)
  const monthlyBreakdown = useMemo(() => {
    const buckets = {};
    for (const s of sales) {
      const d = new Date(s.soldAt.includes('T') ? s.soldAt : s.soldAt + 'T00:00:00');
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!buckets[key]) buckets[key] = { month: key, gross: 0, marketplace: 0, count: 0 };
      buckets[key].gross += s.gross;
      if (s.isMarketplace) buckets[key].marketplace += s.gross;
      buckets[key].count += 1;
    }
    return Object.values(buckets).sort((a, b) => a.month.localeCompare(b.month)).map((b) => ({
      ...b,
      gross: Math.round(b.gross * 100) / 100,
      marketplace: Math.round(b.marketplace * 100) / 100,
    }));
  }, [sales]);

  const copyTotal = async () => {
    const value = summary.totalSales.toFixed(2);
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); setCopied(true); setTimeout(() => setCopied(false), 1500); }
      catch {}
      document.body.removeChild(ta);
    }
  };

  // True if the user is 100% marketplace — the "easy filing" case where
  // the same number goes in gross sales AND marketplace deduction, netting
  // to $0 taxable.
  const allMarketplace = summary.directSales < 0.01;

  const exportCSV = () => {
    const rows = [
      ['Sales Tax Return Worksheet', `${periodLabel} • Filer state: ${homeState} • Rate: ${(rate * 100).toFixed(3)}%`],
      [],
      ['Line', 'Description', 'Amount'],
      ['1',   'Total (gross) sales — all platforms',                 summary.totalSales.toFixed(2)],
      ['—',   'Deductions:',                                         ''],
      ['2a',  'Marketplace-facilitator sales (eBay/Mercari/FB)',     summary.marketplaceSales.toFixed(2)],
      ['2b',  `Direct sales shipped outside ${homeState}`,           summary.directOutOfState.toFixed(2)],
      ['3',   `Net taxable sales (direct, in-${homeState}, retail)`, summary.netTaxable.toFixed(2)],
      ['4',   `Tax due @ ${(rate * 100).toFixed(3)}%`,               summary.taxDue.toFixed(2)],
      [],
      ['Reference', 'Marketplace tax already remitted (informational)', summary.marketplaceTaxRemitted.toFixed(2)],
      ['Reference', 'Total sales count',                                summary.saleCount.toString()],
      [],
      ['By state', '', ''],
      ['State', 'Gross sales', ''],
      ...Object.entries(summary.byState).sort((a, b) => b[1] - a[1]).map(([s, v]) => [s, v.toFixed(2), '']),
      [],
      ['By platform', '', ''],
      ['Platform', 'Gross sales', ''],
      ...Object.entries(summary.byPlatform).sort((a, b) => b[1] - a[1]).map(([p, v]) => [p, v.toFixed(2), '']),
    ];
    downloadCSV(`sales-tax-${periodLabel.replace(/\s/g, '-')}-${homeState}.csv`, rows);
  };

  const yearOptions = [];
  for (let y = now.getFullYear(); y >= now.getFullYear() - 4; y--) yearOptions.push(y);

  return (
    <div className="space-y-4">
      {/* ── Header + period controls ─────────────────────────────────── */}
      <div className="bg-surface rounded-xl border border-border shadow-sm p-5">
        <div className="flex items-center gap-2 mb-1">
          <Receipt size={16} className="text-fg-muted" />
          <h3 className="text-sm font-semibold text-fg">Sales Tax Return Worksheet</h3>
        </div>
        <p className="text-xs text-fg-muted mb-4 leading-relaxed">
          Pulls your total marketplace gross sales for the period — the one number you'll
          plug into your state's sales tax return (CA CDTFA-401-A or equivalent).
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-[11px] font-semibold text-fg-muted uppercase tracking-wide mb-1">Period</label>
            <select value={quarter} onChange={(e) => setQuarter(e.target.value)}
              className="border border-border rounded-lg px-2.5 py-1.5 text-sm bg-surface">
              {QUARTERS.map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-fg-muted uppercase tracking-wide mb-1">Year</label>
            <select value={year} onChange={(e) => setYear(parseInt(e.target.value, 10))}
              className="border border-border rounded-lg px-2.5 py-1.5 text-sm bg-surface">
              {yearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-fg-muted uppercase tracking-wide mb-1">Home state</label>
            <select value={homeState} onChange={(e) => { setHomeState(e.target.value); setRateOverridden(false); }}
              className="border border-border rounded-lg px-2.5 py-1.5 text-sm bg-surface">
              {Object.keys(STATE_RATES).sort().map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <button type="button" onClick={exportCSV}
            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border border-border bg-muted hover:bg-muted transition-colors">
            <Download size={14} /> Export CSV
          </button>
        </div>
      </div>

      {/* ── Hero: the one number to file ──────────────────────────────── */}
      <div className={`rounded-xl border-2 p-6 ${allMarketplace
        ? 'bg-gradient-to-br from-success/5 to-primary/5 border-success/30'
        : 'bg-gradient-to-br from-warning-subtle to-warning-subtle border-warning/30'}`}>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted mb-1">
          {allMarketplace ? 'The number you need' : 'Marketplace sales subtotal'} · {periodLabel}
        </p>
        <div className="flex items-baseline gap-3 flex-wrap">
          <span className="text-4xl md:text-5xl font-bold font-mono text-fg tracking-tight">
            {fmt(summary.totalSales)}
          </span>
          <button
            type="button"
            onClick={copyTotal}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
              copied
                ? 'bg-success text-white'
                : 'bg-primary text-white hover:bg-primary-dark'
            }`}
          >
            {copied ? <><Check size={14} /> Copied!</> : <><Copy size={14} /> Copy amount</>}
          </button>
          <span className="text-xs text-fg-muted">
            {summary.saleCount} sale{summary.saleCount !== 1 ? 's' : ''} {quarter === 'Y' ? `in ${year}` : `in ${quarter} ${year}`}
          </span>
        </div>

        {allMarketplace ? (
          <div className="mt-5 bg-surface rounded-lg border border-success/20 p-4">
            <p className="text-sm font-semibold text-fg mb-2">How to file (CA CDTFA-401-A):</p>
            <ol className="list-decimal list-inside space-y-1.5 text-sm text-fg leading-relaxed">
              <li>
                Enter <span className="font-mono font-bold text-primary">{fmt(summary.totalSales)}</span> on
                the <strong>Total (gross) sales</strong> line.
              </li>
              <li>
                Enter the <strong>same amount</strong> <span className="font-mono font-bold text-primary">{fmt(summary.totalSales)}</span> on
                the <strong>"Sales facilitated through a marketplace facilitator"</strong> deduction line.
              </li>
              <li>
                Net taxable sales: <span className="font-mono font-bold text-success">$0.00</span>.
                Tax due: <span className="font-mono font-bold text-success">$0.00</span>.
              </li>
              <li>Sign and submit. You're done.</li>
            </ol>
            <p className="text-[11px] text-fg-muted mt-3 leading-relaxed">
              All your sales are through marketplace facilitators (eBay, Mercari, Facebook) — they
              already collected and remitted the sales tax to the state. You file a $0 return to
              stay in good standing with the state, but you don't owe anything.
            </p>
          </div>
        ) : (
          <div className="mt-5 bg-surface rounded-lg border border-warning/30 p-4">
            <p className="text-sm font-semibold text-fg mb-2">⚠ You have direct (non-marketplace) sales</p>
            <p className="text-sm text-fg-muted mb-3 leading-relaxed">
              {fmt(summary.directSales)} of your sales were direct (local / cash / other) — not
              through a marketplace facilitator. You may owe sales tax on the in-state portion.
              See the worksheet below for the full line-by-line breakdown.
            </p>
          </div>
        )}
      </div>

      {/* ── Monthly verification breakdown ────────────────────────────── */}
      {monthlyBreakdown.length > 0 && (
        <div className="bg-surface rounded-xl border border-border shadow-sm p-5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted mb-3">
            Per-month breakdown — sanity-check against your eBay payout statements
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] text-fg-muted uppercase tracking-wide border-b border-border">
                <th className="text-left py-2 font-semibold">Month</th>
                <th className="text-right py-2 font-semibold">Sales</th>
                <th className="text-right py-2 font-semibold">Gross</th>
                <th className="text-right py-2 font-semibold">Marketplace</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {monthlyBreakdown.map((m) => {
                const [y, mo] = m.month.split('-');
                const dt = new Date(parseInt(y), parseInt(mo) - 1, 1);
                const label = dt.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
                return (
                  <tr key={m.month}>
                    <td className="py-2 text-fg">{label}</td>
                    <td className="py-2 text-right font-mono text-fg-muted">{m.count}</td>
                    <td className="py-2 text-right font-mono text-fg">{fmt(m.gross)}</td>
                    <td className="py-2 text-right font-mono text-fg-muted">{fmt(m.marketplace)}</td>
                  </tr>
                );
              })}
              <tr className="font-semibold bg-muted/30">
                <td className="py-2 text-fg">Total</td>
                <td className="py-2 text-right font-mono text-fg">{summary.saleCount}</td>
                <td className="py-2 text-right font-mono text-fg">{fmt(summary.totalSales)}</td>
                <td className="py-2 text-right font-mono text-fg">{fmt(summary.marketplaceSales)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* ── Full worksheet (collapsed for the simple case, but always visible) ─ */}
      <div className="bg-surface rounded-xl border border-border shadow-sm p-5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted mb-3">
          Full worksheet · {homeState} · CDTFA-401-A line items
        </p>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-border">
            <tr>
              <td className="py-2 text-fg-muted font-mono w-12">1</td>
              <td className="py-2 text-fg">Total (gross) sales — all platforms</td>
              <td className="py-2 text-right font-mono font-semibold text-fg">{fmt(summary.totalSales)}</td>
            </tr>
            <tr>
              <td className="py-2 text-fg-muted font-mono">2a</td>
              <td className="py-2 text-fg-muted">Less: marketplace-facilitator sales <span className="text-fg-subtle">(eBay/Mercari/FB)</span></td>
              <td className="py-2 text-right font-mono text-danger">−{fmt(summary.marketplaceSales)}</td>
            </tr>
            <tr>
              <td className="py-2 text-fg-muted font-mono">2b</td>
              <td className="py-2 text-fg-muted">Less: direct sales shipped outside {homeState}</td>
              <td className="py-2 text-right font-mono text-danger">−{fmt(summary.directOutOfState)}</td>
            </tr>
            <tr className="bg-primary/5">
              <td className="py-2.5 text-fg-muted font-mono font-semibold">3</td>
              <td className="py-2.5 text-fg font-semibold">Net taxable sales</td>
              <td className="py-2.5 text-right font-mono font-bold text-primary">{fmt(summary.netTaxable)}</td>
            </tr>
            <tr className="bg-accent/5">
              <td className="py-2.5 text-fg-muted font-mono font-semibold">4</td>
              <td className="py-2.5 text-fg font-semibold">
                Tax due @ <span className="font-mono">{(rate * 100).toFixed(3)}%</span>
              </td>
              <td className="py-2.5 text-right font-mono font-bold text-accent">{fmt(summary.taxDue)}</td>
            </tr>
          </tbody>
        </table>
        <div className="mt-3 flex items-center gap-3 text-[11px] text-fg-muted">
          <span>Marketplace tax already remitted by platforms: <span className="font-mono font-semibold text-fg">{fmt(summary.marketplaceTaxRemitted)}</span></span>
          <span className="text-fg-subtle">·</span>
          <button
            type="button"
            onClick={() => { setRate((parseFloat(prompt('Enter tax rate %', (rate * 100).toFixed(3))) || 0) / 100); setRateOverridden(true); }}
            className="text-primary hover:underline"
          >
            Override rate ({(rate * 100).toFixed(3)}%)
          </button>
        </div>
      </div>

      {/* ── Per-state nexus tracking ──────────────────────────────────── */}
      {Object.keys(summary.byState).length > 0 && (
        <div className="bg-surface rounded-xl border border-border shadow-sm p-5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted mb-2 flex items-center gap-1.5">
            <Info size={11} />
            By ship-to state — track for economic nexus thresholds (typically $100k or 200 transactions/yr)
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-2 text-xs">
            {Object.entries(summary.byState).sort((a, b) => b[1] - a[1]).map(([s, v]) => (
              <div key={s} className={`px-2 py-1.5 rounded border ${
                v >= 100000 ? 'border-danger bg-danger-subtle' :
                v >= 50000 ? 'border-accent bg-warning-subtle' : 'border-border bg-muted/40'
              }`}>
                <div className="font-mono font-semibold text-fg">{s}</div>
                <div className="font-mono text-fg-muted">{fmt(v)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Caveats ───────────────────────────────────────────────────── */}
      <div className="bg-warning-subtle border border-warning/30 rounded-lg p-3 text-[11px] text-warning leading-relaxed flex items-start gap-2">
        <AlertCircle size={14} className="shrink-0 mt-0.5" />
        <div>
          <strong>Before filing:</strong> these numbers come straight from your inventory's sale
          records — run Sync All first so they include the latest orders. Marketplace facilitator
          rules apply in CA + most states (eBay/Mercari/FB collect+remit on your behalf since
          2019). Districts beyond the statewide rate aren't included.
        </div>
      </div>
    </div>
  );
}
