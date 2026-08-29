// ─── Buyer History ───────────────────────────────────────────────────────────
// Aggregates sales by buyer username. Surfaces repeat customers, big spenders,
// and recent buyers — useful for prioritizing shipping (loyal repeat buyers
// = low return risk = ship fast) and spotting buyers worth a thank-you note.

import { useMemo, useState } from 'react';
import { Users, Search, Star, TrendingUp, Calendar, ExternalLink, ArrowUpDown } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { fmt, formatDate } from '../../utils/formatters';
import EmptyState from '../../components/EmptyState';

function daysSince(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

export default function BuyerHistory() {
  const { state } = useApp();
  const [search,  setSearch]  = useState('');
  const [sortBy,  setSortBy]  = useState('totalSpent'); // totalSpent | orderCount | lastPurchase
  const [sortDir, setSortDir] = useState('desc');

  const buyers = useMemo(() => {
    const map = new Map();
    for (const lot of (state.lots || [])) {
      for (const item of (lot.items || [])) {
        const sale = item.sale;
        if (!sale || !sale.buyerName) continue;
        const name = sale.buyerName.trim();
        if (!name) continue;
        const key = name.toLowerCase();
        const entry = map.get(key) || {
          name,
          orderCount: 0,
          totalSpent: 0,
          totalProfit: 0,
          firstPurchase: null,
          lastPurchase: null,
          platforms: new Set(),
          orders: [],
        };
        const salePrice = parseFloat(sale.salePrice) || 0;
        const profit    = parseFloat(sale.profit)    || 0;
        entry.orderCount += 1;
        entry.totalSpent += salePrice;
        entry.totalProfit += profit;
        if (sale.platform) entry.platforms.add(sale.platform);
        const soldAt = sale.soldAt || null;
        if (soldAt) {
          if (!entry.firstPurchase || soldAt < entry.firstPurchase) entry.firstPurchase = soldAt;
          if (!entry.lastPurchase  || soldAt > entry.lastPurchase)  entry.lastPurchase  = soldAt;
        }
        entry.orders.push({
          itemId: item.id,
          name: `${item.brand || ''} ${item.model || ''}`.trim() || item.sku || 'Item',
          salePrice,
          profit,
          soldAt,
          platform: sale.platform,
          orderId: sale.id,
        });
        map.set(key, entry);
      }
    }
    return Array.from(map.values()).map((b) => ({
      ...b,
      platforms: Array.from(b.platforms),
      avgOrder: b.orderCount > 0 ? b.totalSpent / b.orderCount : 0,
      daysSinceLast: daysSince(b.lastPurchase),
    }));
  }, [state.lots]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = q ? buyers.filter((b) => b.name.toLowerCase().includes(q)) : buyers;
    const valOf = (b) => {
      if (sortBy === 'totalSpent')   return b.totalSpent;
      if (sortBy === 'orderCount')   return b.orderCount;
      if (sortBy === 'avgOrder')     return b.avgOrder;
      if (sortBy === 'lastPurchase') return b.lastPurchase ? new Date(b.lastPurchase).getTime() : 0;
      return 0;
    };
    rows = [...rows].sort((a, b) => sortDir === 'desc' ? valOf(b) - valOf(a) : valOf(a) - valOf(b));
    return rows;
  }, [buyers, search, sortBy, sortDir]);

  const repeatCount = buyers.filter((b) => b.orderCount >= 2).length;
  const bigSpenderCount = buyers.filter((b) => b.totalSpent >= 500).length;
  const totalRevenue = buyers.reduce((s, b) => s + b.totalSpent, 0);

  const handleSort = (col) => {
    if (sortBy === col) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setSortBy(col); setSortDir('desc'); }
  };

  const SortHeader = ({ label, col, align = 'left' }) => (
    <button
      type="button"
      onClick={() => handleSort(col)}
      className={`flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted hover:text-fg transition-colors ${align === 'right' ? 'ml-auto' : ''}`}
    >
      {label}
      {sortBy === col ? <span>{sortDir === 'desc' ? '↓' : '↑'}</span> : <ArrowUpDown size={10} className="opacity-40" />}
    </button>
  );

  return (
    <div className="space-y-4">
      {/* Summary tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-surface border border-border rounded-lg p-3">
          <p className="text-[10px] uppercase tracking-wide text-fg-muted">Unique buyers</p>
          <p className="text-2xl font-bold font-mono text-fg">{buyers.length}</p>
        </div>
        <div className="bg-surface border border-border rounded-lg p-3">
          <p className="text-[10px] uppercase tracking-wide text-fg-muted flex items-center gap-1"><TrendingUp size={10} /> Repeat customers</p>
          <p className="text-2xl font-bold font-mono text-success">{repeatCount}</p>
          <p className="text-[10px] text-fg-subtle mt-0.5">≥2 orders</p>
        </div>
        <div className="bg-surface border border-border rounded-lg p-3">
          <p className="text-[10px] uppercase tracking-wide text-fg-muted flex items-center gap-1"><Star size={10} /> Big spenders</p>
          <p className="text-2xl font-bold font-mono text-accent">{bigSpenderCount}</p>
          <p className="text-[10px] text-fg-subtle mt-0.5">≥{fmt(500)} lifetime</p>
        </div>
        <div className="bg-surface border border-border rounded-lg p-3">
          <p className="text-[10px] uppercase tracking-wide text-fg-muted">Total revenue</p>
          <p className="text-2xl font-bold font-mono text-fg">{fmt(totalRevenue)}</p>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-muted" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search buyer username…"
          className="w-full pl-8 pr-3 py-2 text-sm border border-border rounded-lg bg-surface text-fg focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
      </div>

      {/* Buyer table */}
      {filtered.length === 0 ? (
        <EmptyState
          icon={Users}
          title={buyers.length === 0 ? 'No buyer data yet' : 'No buyers match your search'}
          description={buyers.length === 0
            ? 'Buyer usernames are captured automatically when sales sync from eBay.'
            : 'Try a different search term.'}
        />
      ) : (
        <div className="bg-surface rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 border-b border-border">
                <tr>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-fg-muted">Buyer</th>
                  <th className="px-3 py-2 text-right"><SortHeader label="Orders" col="orderCount" align="right" /></th>
                  <th className="px-3 py-2 text-right"><SortHeader label="Total spent" col="totalSpent" align="right" /></th>
                  <th className="px-3 py-2 text-right"><SortHeader label="Avg order" col="avgOrder" align="right" /></th>
                  <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-fg-muted">Profit</th>
                  <th className="px-3 py-2 text-left"><SortHeader label="Last purchase" col="lastPurchase" /></th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-fg-muted">Platform</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.slice(0, 200).map((b) => {
                  const isRepeat  = b.orderCount >= 2;
                  const isBig     = b.totalSpent >= 500;
                  const isRecent  = b.daysSinceLast != null && b.daysSinceLast <= 30;
                  return (
                    <tr key={b.name} className="hover:bg-muted/20">
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-fg">{b.name}</span>
                          {isRepeat && <span title="Repeat customer" className="text-[10px] px-1.5 py-0.5 rounded-full bg-success/10 text-success font-semibold">{b.orderCount}×</span>}
                          {isBig    && <span title="Big spender" className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent/10 text-accent font-semibold">VIP</span>}
                          {isRecent && <span title="Recent buyer" className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-semibold">recent</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{b.orderCount}</td>
                      <td className="px-3 py-2 text-right font-mono font-semibold text-fg">{fmt(b.totalSpent)}</td>
                      <td className="px-3 py-2 text-right font-mono text-fg-muted">{fmt(b.avgOrder)}</td>
                      <td className={`px-3 py-2 text-right font-mono ${b.totalProfit > 0 ? 'text-success' : b.totalProfit < 0 ? 'text-danger' : 'text-fg-muted'}`}>
                        {fmt(b.totalProfit)}
                      </td>
                      <td className="px-3 py-2 text-fg-muted whitespace-nowrap">
                        {b.lastPurchase ? `${formatDate(b.lastPurchase)}${b.daysSinceLast != null ? ` · ${b.daysSinceLast}d ago` : ''}` : '—'}
                      </td>
                      <td className="px-3 py-2 text-fg-muted text-[11px]">
                        {b.platforms.join(', ') || '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {filtered.length > 200 && (
            <div className="px-3 py-2 text-[11px] text-fg-muted text-center bg-muted/20 border-t border-border">
              Showing first 200 of {filtered.length} — narrow with search to see more.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
