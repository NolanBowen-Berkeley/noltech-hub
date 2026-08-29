import { useState, useEffect, useMemo } from 'react';
import {
  FileText,
  Download,
  Printer,
  DollarSign,
  TrendingUp,
  TrendingDown,
  AlertCircle,
  ChevronDown,
  Receipt,
  Calculator,
  Calendar,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { fmt, formatDate } from '../../utils/formatters';

// ─── Constants ────────────────────────────────────────────────────────────────

const QUARTERS = [
  { key: 'Q1', label: 'Q1 (Jan\u2013Mar)', months: [0, 1, 2] },
  { key: 'Q2', label: 'Q2 (Apr\u2013Jun)', months: [3, 4, 5] },
  { key: 'Q3', label: 'Q3 (Jul\u2013Sep)', months: [6, 7, 8] },
  { key: 'Q4', label: 'Q4 (Oct\u2013Dec)', months: [9, 10, 11] },
];

// Schedule C line mapping
const SCHEDULE_C_LINES = [
  { line: 'Line 1',  label: 'Gross receipts or sales',           key: 'grossReceipts' },
  { line: 'Line 4',  label: 'Cost of goods sold',                key: 'cogs' },
  { line: 'Line 7',  label: 'Gross income (Line 1 minus Line 4)',key: 'grossIncome' },
  { line: 'Line 10', label: 'Commissions and fees',              key: 'commissions' },
  { line: 'Line 18', label: 'Office expense',                    key: 'office' },
  { line: 'Line 22', label: 'Supplies (shipping materials)',      key: 'supplies' },
  { line: 'Line 27a',label: 'Other expenses',                    key: 'other' },
  { line: 'Line 28', label: 'Total expenses (10+18+22+27a)',     key: 'totalExpenses' },
  { line: 'Line 31', label: 'Net profit or (loss)',              key: 'netProfit' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function profitCls(n) {
  if (!n && n !== 0) return 'text-fg-muted';
  return n > 0 ? 'text-success' : n < 0 ? 'text-danger' : 'text-warning';
}

function escapeCsv(val) {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function downloadCsv(filename, csvContent) {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function currentYear() {
  return new Date().getFullYear();
}

function currentQuarter() {
  const m = new Date().getMonth();
  if (m <= 2) return 'Q1';
  if (m <= 5) return 'Q2';
  if (m <= 8) return 'Q3';
  return 'Q4';
}

function isInQuarter(dateStr, quarter, year) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (d.getFullYear() !== year) return false;
  const q = QUARTERS.find(q => q.key === quarter);
  return q ? q.months.includes(d.getMonth()) : false;
}

function isInYear(dateStr, year) {
  if (!dateStr) return false;
  return new Date(dateStr).getFullYear() === year;
}

// ─── Summary Card ─────────────────────────────────────────────────────────────

function SummaryCard({ icon: Icon, label, value, color, sub }) {
  return (
    <div className="bg-surface rounded-xl border border-border shadow-sm px-4 py-3">
      <div className="flex items-center gap-2 mb-1">
        <div className="p-1.5 rounded-lg" style={{ backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)` }}>
          <Icon size={14} style={{ color }} />
        </div>
        <span className="text-[10px] font-semibold text-fg-muted uppercase tracking-wide">{label}</span>
      </div>
      <p className={`text-xl font-bold font-mono mt-0.5 ${value.startsWith('-') ? 'text-danger' : 'text-fg'}`}>
        {value}
      </p>
      {sub && <p className="text-[10px] text-fg-muted mt-0.5">{sub}</p>}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

const TRANSACTIONS_KEY = 'noltech:books:transactions';

export default function TaxExport() {
  const { state } = useApp();
  const [quarter, setQuarter] = useState(currentQuarter());
  const [year, setYear] = useState(currentYear());
  const [bookkeepingTxns, setBookkeepingTxns] = useState([]);

  // ── Load bookkeeping transactions from storage ─────────────────────────

  useEffect(() => {
    window.storage.get(TRANSACTIONS_KEY)
      .then((data) => { if (Array.isArray(data)) setBookkeepingTxns(data); })
      .catch((err) => console.error('Failed to load bookkeeping transactions:', err));
  }, []);

  // ── Available years ────────────────────────────────────────────────────

  const availableYears = useMemo(() => {
    const years = new Set();
    for (const lot of (state.lots || [])) {
      if (lot.purchaseDate) years.add(new Date(lot.purchaseDate).getFullYear());
      if (lot.dateAdded) years.add(new Date(lot.dateAdded).getFullYear());
      for (const item of (lot.items || [])) {
        if (item.sale?.soldAt) years.add(new Date(item.sale.soldAt).getFullYear());
      }
    }
    const cur = currentYear();
    years.add(cur);
    years.add(cur - 1);
    return [...years].sort((a, b) => b - a);
  }, [state.lots]);

  // ── Purchases in quarter ───────────────────────────────────────────────

  const purchases = useMemo(() => {
    return (state.lots || [])
      .filter(lot => {
        const d = lot.purchaseDate || lot.dateAdded;
        return isInQuarter(d, quarter, year);
      })
      .map(lot => ({
        id: lot.id,
        date: lot.purchaseDate || lot.dateAdded,
        source: lot.sourceName || lot.source || '\u2014',
        title: lot.name || lot.title || `Lot ${lot.id?.slice(0, 8)}`,
        cost: lot.cost || lot.totalCost || 0,
      }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));
  }, [state.lots, quarter, year]);

  // ── Sales in quarter ───────────────────────────────────────────────────

  const sales = useMemo(() => {
    const result = [];
    for (const lot of (state.lots || [])) {
      for (const item of (lot.items || [])) {
        const sale = item.sale;
        if (!sale?.soldAt || !isInQuarter(sale.soldAt, quarter, year)) continue;
        result.push({
          id: item.id,
          date: sale.soldAt,
          item: `${item.brand || ''} ${item.model || ''}`.trim() || 'Unknown Item',
          platform: sale.platform || item.listing?.platform || 'other',
          salePrice: sale.salePrice || 0,
          platformFees: sale.platformFees || 0,
          shippingCost: sale.shippingCost || 0,
          net: (sale.salePrice || 0) - (sale.platformFees || 0) - (sale.shippingCost || 0),
          profit: sale.profit ?? ((sale.salePrice || 0) - (sale.platformFees || 0) - (sale.shippingCost || 0) - (item.costBasis || 0)),
          costBasis: item.costBasis || 0,
        });
      }
    }
    return result.sort((a, b) => new Date(a.date) - new Date(b.date));
  }, [state.lots, quarter, year]);

  // ── Bookkeeping expenses in quarter ─────────────────────────────────────

  const bookkeepingExpenses = useMemo(() => {
    return bookkeepingTxns
      .filter(txn => {
        const isExpense = txn.type === 'expense' || txn.category === 'expense' || (txn.amount && txn.amount < 0);
        const dateRef = txn.date || txn.createdAt;
        return isExpense && isInQuarter(dateRef, quarter, year);
      })
      .map(txn => ({
        id: txn.id || crypto.randomUUID?.() || Math.random().toString(36).slice(2),
        date: txn.date || txn.createdAt,
        description: txn.description || txn.memo || txn.note || 'Expense',
        category: txn.expenseCategory || txn.category || 'other',
        amount: Math.abs(txn.amount || 0),
      }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));
  }, [bookkeepingTxns, quarter, year]);

  const totalBookkeepingExpenses = useMemo(() => {
    return bookkeepingExpenses.reduce((s, e) => s + e.amount, 0);
  }, [bookkeepingExpenses]);

  // ── Totals ─────────────────────────────────────────────────────────────

  const totals = useMemo(() => {
    const totalPurchases = purchases.reduce((s, p) => s + p.cost, 0);
    const totalSales = sales.reduce((s, x) => s + x.salePrice, 0);
    const totalFees = sales.reduce((s, x) => s + x.platformFees, 0);
    const totalShipping = sales.reduce((s, x) => s + x.shippingCost, 0);
    const netProfit = totalSales - totalPurchases - totalFees - totalShipping - totalBookkeepingExpenses;
    const effectiveTaxRate = netProfit > 0 ? 15.3 : 0; // Self-employment tax estimate
    const estTax = netProfit > 0 ? netProfit * 0.153 : 0;
    return { totalPurchases, totalSales, totalFees, totalShipping, totalBookkeepingExpenses, netProfit, effectiveTaxRate, estTax };
  }, [purchases, sales, totalBookkeepingExpenses]);

  // ── Fee breakdown by platform ──────────────────────────────────────────

  const feeBreakdown = useMemo(() => {
    const byPlatform = {};
    for (const s of sales) {
      const p = s.platform || 'other';
      if (!byPlatform[p]) byPlatform[p] = { platform: p, fees: 0, shipping: 0, count: 0 };
      byPlatform[p].fees += s.platformFees;
      byPlatform[p].shipping += s.shippingCost;
      byPlatform[p].count++;
    }
    return Object.values(byPlatform).sort((a, b) => b.fees - a.fees);
  }, [sales]);

  // ── Schedule C data ────────────────────────────────────────────────────

  const scheduleC = useMemo(() => {
    const otherExpenses = totalBookkeepingExpenses;
    const totalExp = totals.totalFees + totals.totalShipping + otherExpenses;
    const data = {
      grossReceipts: totals.totalSales,
      cogs: totals.totalPurchases,
      grossIncome: totals.totalSales - totals.totalPurchases,
      commissions: totals.totalFees,
      office: 0,        // User can adjust
      supplies: totals.totalShipping,
      other: otherExpenses,
      totalExpenses: totalExp,
      netProfit: totals.totalSales - totals.totalPurchases - totalExp,
    };
    return data;
  }, [totals, totalBookkeepingExpenses]);

  // ── YTD totals ─────────────────────────────────────────────────────────

  const ytd = useMemo(() => {
    let ytdPurchases = 0;
    let ytdSales = 0;
    let ytdFees = 0;
    let ytdShipping = 0;

    for (const lot of (state.lots || [])) {
      const d = lot.purchaseDate || lot.dateAdded;
      if (isInYear(d, year)) {
        ytdPurchases += lot.cost || lot.totalCost || 0;
      }
      for (const item of (lot.items || [])) {
        const sale = item.sale;
        if (!sale?.soldAt || !isInYear(sale.soldAt, year)) continue;
        ytdSales += sale.salePrice || 0;
        ytdFees += sale.platformFees || 0;
        ytdShipping += sale.shippingCost || 0;
      }
    }
    return {
      purchases: ytdPurchases,
      sales: ytdSales,
      fees: ytdFees,
      shipping: ytdShipping,
      net: ytdSales - ytdPurchases - ytdFees - ytdShipping,
    };
  }, [state.lots, year]);

  // ── CSV export ─────────────────────────────────────────────────────────

  function handleCsvExport() {
    const lines = [];

    // Purchases section
    lines.push('--- PURCHASES ---');
    lines.push('Date,Source,Description,Cost');
    for (const p of purchases) {
      lines.push([formatDate(p.date), escapeCsv(p.source), escapeCsv(p.title), p.cost.toFixed(2)].join(','));
    }
    lines.push(`,,Total Purchases,${totals.totalPurchases.toFixed(2)}`);
    lines.push('');

    // Sales section
    lines.push('--- SALES ---');
    lines.push('Date,Item,Platform,Sale Price,Platform Fees,Shipping,Net Revenue,Profit');
    for (const s of sales) {
      lines.push([
        formatDate(s.date), escapeCsv(s.item), escapeCsv(s.platform),
        s.salePrice.toFixed(2), s.platformFees.toFixed(2), s.shippingCost.toFixed(2),
        s.net.toFixed(2), s.profit.toFixed(2),
      ].join(','));
    }
    lines.push(`,,Total Sales,${totals.totalSales.toFixed(2)},${totals.totalFees.toFixed(2)},${totals.totalShipping.toFixed(2)},,`);
    lines.push('');

    // Bookkeeping expenses section
    if (bookkeepingExpenses.length > 0) {
      lines.push('--- BOOKKEEPING EXPENSES ---');
      lines.push('Date,Description,Category,Amount');
      for (const e of bookkeepingExpenses) {
        lines.push([formatDate(e.date), escapeCsv(e.description), escapeCsv(e.category), e.amount.toFixed(2)].join(','));
      }
      lines.push(`,,Total Expenses,${totalBookkeepingExpenses.toFixed(2)}`);
      lines.push('');
    }

    // Summary
    lines.push('--- SUMMARY ---');
    lines.push(`Total Purchases,${totals.totalPurchases.toFixed(2)}`);
    lines.push(`Total Sales Revenue,${totals.totalSales.toFixed(2)}`);
    lines.push(`Total Platform Fees,${totals.totalFees.toFixed(2)}`);
    lines.push(`Total Shipping,${totals.totalShipping.toFixed(2)}`);
    lines.push(`Total Other Expenses (Bookkeeping),${totalBookkeepingExpenses.toFixed(2)}`);
    lines.push(`Net Profit,${totals.netProfit.toFixed(2)}`);

    const csv = lines.join('\r\n');
    downloadCsv(`noltech-tax-${quarter}-${year}.csv`, csv);
  }

  // ── Print summary ──────────────────────────────────────────────────────

  function handlePrint() {
    window.print();
  }

  // ── Loading ────────────────────────────────────────────────────────────

  if (state.loading) {
    return (
      <div className="space-y-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="bg-surface rounded-xl border border-border h-16 animate-pulse" />
        ))}
      </div>
    );
  }

  // ── Error ──────────────────────────────────────────────────────────────

  if (state.error) {
    return (
      <div className="flex items-start gap-3 bg-danger-subtle border border-danger/30 rounded-xl px-5 py-4 text-sm text-danger">
        <AlertCircle size={16} className="shrink-0 mt-0.5" />
        <div>
          <p className="font-semibold">Couldn't load data</p>
          <p className="text-xs mt-0.5">{state.error}</p>
        </div>
      </div>
    );
  }

  const platformLabel = (p) => {
    const map = { ebay: 'eBay', mercari: 'Mercari', facebook: 'FB Marketplace', local: 'Local' };
    return map[p] || p || 'Other';
  };

  return (
    <div className="space-y-5 print:space-y-3">

      {/* Header */}
      <div className="bg-info-subtle border border-info/30 rounded-xl px-4 py-3 text-sm text-info print:hidden">
        <p className="font-semibold mb-0.5 flex items-center gap-1.5">
          <Receipt size={14} /> Tax Export &amp; Schedule C Helper
        </p>
        <p className="text-xs leading-relaxed">
          Quarterly summary of all purchases, sales, fees, and profit. Export as CSV or print a summary for tax filing.
        </p>
      </div>

      {/* Controls row */}
      <div className="flex flex-wrap items-end gap-4 print:hidden">
        {/* Quarter selector */}
        <div>
          <label className="block text-xs font-semibold text-fg mb-1.5">Quarter</label>
          <div className="flex gap-1">
            {QUARTERS.map(q => (
              <button
                key={q.key}
                onClick={() => setQuarter(q.key)}
                className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                  quarter === q.key
                    ? 'bg-accent text-white'
                    : 'bg-surface border border-border text-fg-muted hover:bg-muted/40 hover:text-fg'
                }`}
              >
                {q.key}
              </button>
            ))}
          </div>
        </div>

        {/* Year selector */}
        <div>
          <label className="block text-xs font-semibold text-fg mb-1.5">Year</label>
          <div className="relative">
            <select
              value={year}
              onChange={e => setYear(Number(e.target.value))}
              className="appearance-none border border-border rounded-xl px-4 py-2 pr-9 text-sm text-fg bg-surface focus:outline-none focus:ring-2 focus:ring-primary/30 cursor-pointer"
            >
              {availableYears.map(y => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
            <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none" />
          </div>
        </div>

        {/* Export buttons */}
        <div className="flex items-center gap-2 ml-auto">
          <button
            onClick={handleCsvExport}
            className="flex items-center gap-1.5 px-4 py-2 bg-accent text-white rounded-xl text-sm font-medium hover:bg-accent-hover transition-colors"
          >
            <Download size={14} /> CSV Export
          </button>
          <button
            onClick={handlePrint}
            className="flex items-center gap-1.5 px-4 py-2 border border-border rounded-xl text-sm font-medium text-fg-muted hover:bg-muted/40 hover:text-fg transition-colors"
          >
            <Printer size={14} /> Print Summary
          </button>
        </div>
      </div>

      {/* Print header (visible only when printing) */}
      <div className="hidden print:block text-center mb-4">
        <h1 className="text-lg font-bold text-fg">NolTech Tax Summary</h1>
        <p className="text-sm text-fg-muted">{quarter} {year}</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <SummaryCard icon={DollarSign} label="Total Purchases" value={fmt(totals.totalPurchases)} color="var(--warning)" sub={`${purchases.length} lots`} />
        <SummaryCard icon={DollarSign} label="Sales Revenue" value={fmt(totals.totalSales)} color="var(--accent)" sub={`${sales.length} items`} />
        <SummaryCard icon={Receipt} label="Platform Fees" value={fmt(totals.totalFees)} color="var(--danger)" />
        <SummaryCard icon={Receipt} label="Shipping Costs" value={fmt(totals.totalShipping)} color="var(--accent-hover)" />
        <SummaryCard icon={totals.netProfit >= 0 ? TrendingUp : TrendingDown} label="Net Profit" value={fmt(totals.netProfit)} color={totals.netProfit >= 0 ? 'var(--success)' : 'var(--danger)'} />
        <SummaryCard icon={Calculator} label="Est. SE Tax (15.3%)" value={fmt(totals.estTax)} color="var(--fg-muted)" sub={totals.netProfit > 0 ? `${totals.effectiveTaxRate}% rate` : 'N/A'} />
      </div>

      {/* Purchases table */}
      <div className="bg-surface rounded-xl border border-border shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
          <h3 className="text-sm font-semibold text-fg flex items-center gap-1.5">
            <DollarSign size={13} className="text-warning" /> Purchases
          </h3>
          <span className="text-xs text-fg-muted">{purchases.length} lot{purchases.length !== 1 ? 's' : ''}</span>
        </div>
        {purchases.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/40 border-b border-border">
                  <th className="text-left px-4 py-2.5 font-semibold text-fg text-xs">Date</th>
                  <th className="text-left px-4 py-2.5 font-semibold text-fg text-xs">Source</th>
                  <th className="text-left px-4 py-2.5 font-semibold text-fg text-xs">Description</th>
                  <th className="text-right px-4 py-2.5 font-semibold text-fg text-xs">Cost</th>
                </tr>
              </thead>
              <tbody>
                {purchases.map((p, i) => (
                  <tr key={p.id} className={`border-b border-border-subtle last:border-0 ${i % 2 ? 'bg-muted/40/50' : ''}`}>
                    <td className="px-4 py-2.5 text-xs text-fg-muted whitespace-nowrap">{formatDate(p.date)}</td>
                    <td className="px-4 py-2.5 text-xs text-fg">{p.source}</td>
                    <td className="px-4 py-2.5 text-xs text-fg max-w-xs truncate">{p.title}</td>
                    <td className="px-4 py-2.5 text-xs font-mono font-semibold text-fg text-right">{fmt(p.cost)}</td>
                  </tr>
                ))}
                <tr className="bg-muted/40 border-t border-border">
                  <td colSpan={3} className="px-4 py-2.5 text-xs font-semibold text-fg text-right">Total Purchases</td>
                  <td className="px-4 py-2.5 text-sm font-mono font-bold text-fg text-right">{fmt(totals.totalPurchases)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-8 text-fg-muted text-sm">No purchases in {quarter} {year}</div>
        )}
      </div>

      {/* Sales table */}
      <div className="bg-surface rounded-xl border border-border shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
          <h3 className="text-sm font-semibold text-fg flex items-center gap-1.5">
            <TrendingUp size={13} className="text-accent" /> Sales
          </h3>
          <span className="text-xs text-fg-muted">{sales.length} item{sales.length !== 1 ? 's' : ''}</span>
        </div>
        {sales.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[700px]">
              <thead>
                <tr className="bg-muted/40 border-b border-border">
                  <th className="text-left px-4 py-2.5 font-semibold text-fg text-xs">Date</th>
                  <th className="text-left px-4 py-2.5 font-semibold text-fg text-xs">Item</th>
                  <th className="text-center px-4 py-2.5 font-semibold text-fg text-xs">Platform</th>
                  <th className="text-right px-4 py-2.5 font-semibold text-fg text-xs">Sale Price</th>
                  <th className="text-right px-4 py-2.5 font-semibold text-fg text-xs">Fees</th>
                  <th className="text-right px-4 py-2.5 font-semibold text-fg text-xs">Shipping</th>
                  <th className="text-right px-4 py-2.5 font-semibold text-fg text-xs">Net</th>
                </tr>
              </thead>
              <tbody>
                {sales.map((s, i) => (
                  <tr key={s.id} className={`border-b border-border-subtle last:border-0 ${i % 2 ? 'bg-muted/40/50' : ''}`}>
                    <td className="px-4 py-2.5 text-xs text-fg-muted whitespace-nowrap">{formatDate(s.date)}</td>
                    <td className="px-4 py-2.5 text-xs text-fg max-w-[180px] truncate">{s.item}</td>
                    <td className="px-4 py-2.5 text-xs text-fg-muted text-center">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-muted text-[10px] font-medium">
                        {platformLabel(s.platform)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-fg text-right">{fmt(s.salePrice)}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-danger text-right">{fmt(s.platformFees)}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-fg-muted text-right">{fmt(s.shippingCost)}</td>
                    <td className="px-4 py-2.5 font-mono text-xs font-semibold text-right">
                      <span className={profitCls(s.net)}>{fmt(s.net)}</span>
                    </td>
                  </tr>
                ))}
                <tr className="bg-muted/40 border-t border-border">
                  <td colSpan={3} className="px-4 py-2.5 text-xs font-semibold text-fg text-right">Totals</td>
                  <td className="px-4 py-2.5 font-mono text-xs font-bold text-fg text-right">{fmt(totals.totalSales)}</td>
                  <td className="px-4 py-2.5 font-mono text-xs font-bold text-danger text-right">{fmt(totals.totalFees)}</td>
                  <td className="px-4 py-2.5 font-mono text-xs font-bold text-fg-muted text-right">{fmt(totals.totalShipping)}</td>
                  <td className="px-4 py-2.5 font-mono text-xs font-bold text-right">
                    <span className={profitCls(totals.totalSales - totals.totalFees - totals.totalShipping)}>
                      {fmt(totals.totalSales - totals.totalFees - totals.totalShipping)}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-8 text-fg-muted text-sm">No sales in {quarter} {year}</div>
        )}
      </div>

      {/* Bookkeeping Expenses table */}
      {bookkeepingExpenses.length > 0 && (
        <div className="bg-surface rounded-xl border border-border shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
            <h3 className="text-sm font-semibold text-fg flex items-center gap-1.5">
              <Receipt size={13} className="text-accent-hover" /> Expenses (Bookkeeping)
            </h3>
            <span className="text-xs text-fg-muted">{bookkeepingExpenses.length} transaction{bookkeepingExpenses.length !== 1 ? 's' : ''}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/40 border-b border-border">
                  <th className="text-left px-4 py-2.5 font-semibold text-fg text-xs">Date</th>
                  <th className="text-left px-4 py-2.5 font-semibold text-fg text-xs">Description</th>
                  <th className="text-center px-4 py-2.5 font-semibold text-fg text-xs">Category</th>
                  <th className="text-right px-4 py-2.5 font-semibold text-fg text-xs">Amount</th>
                </tr>
              </thead>
              <tbody>
                {bookkeepingExpenses.map((e, i) => (
                  <tr key={e.id} className={`border-b border-border-subtle last:border-0 ${i % 2 ? 'bg-muted/40/50' : ''}`}>
                    <td className="px-4 py-2.5 text-xs text-fg-muted whitespace-nowrap">{formatDate(e.date)}</td>
                    <td className="px-4 py-2.5 text-xs text-fg max-w-xs truncate">{e.description}</td>
                    <td className="px-4 py-2.5 text-xs text-fg-muted text-center">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-muted text-[10px] font-medium">
                        {e.category}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs font-mono font-semibold text-danger text-right">{fmt(e.amount)}</td>
                  </tr>
                ))}
                <tr className="bg-muted/40 border-t border-border">
                  <td colSpan={3} className="px-4 py-2.5 text-xs font-semibold text-fg text-right">Total Expenses</td>
                  <td className="px-4 py-2.5 text-sm font-mono font-bold text-danger text-right">{fmt(totalBookkeepingExpenses)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Fee breakdown & Schedule C side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

        {/* Fee summary by platform */}
        <div className="bg-surface rounded-xl border border-border shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-border-subtle">
            <h3 className="text-sm font-semibold text-fg flex items-center gap-1.5">
              <Receipt size={13} className="text-danger" /> Fee Summary by Platform
            </h3>
          </div>
          {feeBreakdown.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/40 border-b border-border">
                    <th className="text-left px-4 py-2.5 font-semibold text-fg text-xs">Platform</th>
                    <th className="text-center px-4 py-2.5 font-semibold text-fg text-xs">Sales</th>
                    <th className="text-right px-4 py-2.5 font-semibold text-fg text-xs">Fees</th>
                    <th className="text-right px-4 py-2.5 font-semibold text-fg text-xs">Shipping</th>
                  </tr>
                </thead>
                <tbody>
                  {feeBreakdown.map((row, i) => (
                    <tr key={row.platform} className={`border-b border-border-subtle last:border-0 ${i % 2 ? 'bg-muted/40/50' : ''}`}>
                      <td className="px-4 py-2.5 text-xs text-fg font-medium">{platformLabel(row.platform)}</td>
                      <td className="px-4 py-2.5 text-xs text-fg-muted text-center">{row.count}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-danger text-right">{fmt(row.fees)}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-fg-muted text-right">{fmt(row.shipping)}</td>
                    </tr>
                  ))}
                  <tr className="bg-muted/40 border-t border-border">
                    <td className="px-4 py-2.5 text-xs font-semibold text-fg">Total</td>
                    <td className="px-4 py-2.5 text-xs font-semibold text-fg text-center">{sales.length}</td>
                    <td className="px-4 py-2.5 font-mono text-xs font-bold text-danger text-right">{fmt(totals.totalFees)}</td>
                    <td className="px-4 py-2.5 font-mono text-xs font-bold text-fg-muted text-right">{fmt(totals.totalShipping)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-center py-8 text-fg-muted text-sm">No fee data</div>
          )}
        </div>

        {/* Schedule C helper */}
        <div className="bg-surface rounded-xl border border-border shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-border-subtle">
            <h3 className="text-sm font-semibold text-fg flex items-center gap-1.5">
              <Calculator size={13} className="text-accent" /> Schedule C Helper
            </h3>
            <p className="text-[10px] text-fg-muted mt-0.5">Approximate mapping to IRS Schedule C line items</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/40 border-b border-border">
                  <th className="text-left px-4 py-2.5 font-semibold text-fg text-xs">Line</th>
                  <th className="text-left px-4 py-2.5 font-semibold text-fg text-xs">Description</th>
                  <th className="text-right px-4 py-2.5 font-semibold text-fg text-xs">Amount</th>
                </tr>
              </thead>
              <tbody>
                {SCHEDULE_C_LINES.map((row, i) => {
                  const val = scheduleC[row.key] || 0;
                  const isTotal = row.key === 'netProfit' || row.key === 'totalExpenses' || row.key === 'grossIncome';
                  return (
                    <tr key={row.key} className={`border-b border-border-subtle last:border-0 ${isTotal ? 'bg-muted/40 font-semibold' : i % 2 ? 'bg-muted/40/30' : ''}`}>
                      <td className="px-4 py-2 text-xs text-fg-muted font-mono whitespace-nowrap">{row.line}</td>
                      <td className="px-4 py-2 text-xs text-fg">{row.label}</td>
                      <td className={`px-4 py-2 font-mono text-xs text-right ${isTotal ? 'font-bold' : 'font-semibold'} ${row.key === 'netProfit' ? profitCls(val) : 'text-fg'}`}>
                        {fmt(val)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-2.5 border-t border-border-subtle bg-warning-subtle">
            <p className="text-[10px] text-warning flex items-center gap-1">
              <AlertCircle size={10} />
              This is an estimate. Consult a tax professional for actual filing.
            </p>
          </div>
        </div>
      </div>

      {/* Year-to-date running total */}
      <div className="bg-surface rounded-xl border border-border shadow-sm px-5 py-4">
        <h3 className="text-sm font-semibold text-fg flex items-center gap-1.5 mb-3">
          <Calendar size={13} className="text-accent" /> Year-to-Date ({year})
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
          <div>
            <p className="text-[10px] font-semibold text-fg-muted uppercase tracking-wide">YTD Purchases</p>
            <p className="font-mono text-base font-bold text-fg mt-0.5">{fmt(ytd.purchases)}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold text-fg-muted uppercase tracking-wide">YTD Sales</p>
            <p className="font-mono text-base font-bold text-fg mt-0.5">{fmt(ytd.sales)}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold text-fg-muted uppercase tracking-wide">YTD Fees</p>
            <p className="font-mono text-base font-bold text-danger mt-0.5">{fmt(ytd.fees)}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold text-fg-muted uppercase tracking-wide">YTD Shipping</p>
            <p className="font-mono text-base font-bold text-fg-muted mt-0.5">{fmt(ytd.shipping)}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold text-fg-muted uppercase tracking-wide">YTD Net Profit</p>
            <p className={`font-mono text-base font-bold mt-0.5 ${profitCls(ytd.net)}`}>{fmt(ytd.net)}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
