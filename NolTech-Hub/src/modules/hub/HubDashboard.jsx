import { useMemo, useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  Package, List, BarChart2, ScanSearch,
  DollarSign, ShoppingCart, Archive, Zap, TrendingUp, TrendingDown,
  BookOpen, RefreshCw, Clock, ArrowUpRight, X as XIcon, ArrowRight,
  Inbox, Receipt, LayoutGrid,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { formatCurrency, formatDate } from '../../utils/formatters';
import { calcItemProfit, getItemCostBasis } from '../../utils/fees';
import { useSyncAll } from '../../hooks/useSyncAll';
import useRecents from '../../hooks/useRecents';
import { Button, Stat, TrendDelta, cn } from '../../components/ui';
import EmptyState from '../../components/EmptyState';
import SystemHealthCard from '../../components/SystemHealthCard';
import ListingAgingAlert from '../../components/ListingAgingAlert';
import PreListCheckCard from '../../components/PreListCheckCard';
import InboundShipmentsCard from '../../components/InboundShipmentsCard';
import CashFlowCard from '../../components/CashFlowCard';

// ─── Quick-jump module cards ─────────────────────────────────────────────────
const MODULE_CARDS = [
  { id: 'lots',      label: 'Lots',         desc: 'Liquidation lot purchases',                icon: Package    },
  { id: 'inventory', label: 'Inventory',    desc: 'Items, sales, profits',                    icon: List       },
  { id: 'analytics', label: 'Analytics',    desc: 'Charts & performance',                     icon: BarChart2  },
  { id: 'arbitrage', label: 'Arbitrage',    desc: 'Find underpriced finds',                   icon: ScanSearch },
  { id: 'lotprofit', label: 'Lot P&L',      desc: 'Match sales to lots',                      icon: DollarSign },
  { id: 'books',     label: 'Bookkeeping',  desc: 'Income, expenses, imports',                icon: BookOpen   },
];

// ─── Time-of-day greeting ────────────────────────────────────────────────────
function greeting() {
  const h = new Date().getHours();
  if (h < 5)  return 'Working late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function timeAgo(iso) {
  if (!iso) return null;
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60)   return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function timeAgoShort(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ─── Bento tile shell ────────────────────────────────────────────────────────
// All grid children pass through here to keep card chrome consistent.
function Tile({ children, className, span = 'col-span-12', featured = false, padding = 'p-6' }) {
  return (
    <div
      className={cn(
        'glossy-card relative overflow-hidden',
        featured && 'brand-accent-top',
        span,
        padding,
        className,
      )}
    >
      {children}
    </div>
  );
}

// ─── Hero KPI Tile ───────────────────────────────────────────────────────────
function KpiTile({ k, index, featured, span }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay: index * 0.05, ease: [0.16, 1, 0.3, 1] }}
      className={span}
    >
      <Tile span="" featured={featured} className="h-full" padding="p-6">
        <Stat
          label={k.label}
          value={k.value}
          sub={k.sub}
          icon={k.icon}
          intent={k.intent}
          size="lg"
          sparkline={k.sparkline}
        />
        {k.progress && (
          <div className="mt-5">
            <div className="flex items-center justify-between text-[11px] mb-1.5">
              <span className="text-fg-muted">
                Goal: {k.progress.goal < 1000 ? `$${k.progress.goal}` : `$${(k.progress.goal / 1000).toFixed(1)}k`}
              </span>
              <span className={cn(
                'font-semibold',
                (k.progress.current / k.progress.goal * 100) >= 100 ? 'text-success' : 'text-fg',
              )}>
                {Math.min((k.progress.current / k.progress.goal) * 100, 999).toFixed(0)}%
              </span>
            </div>
            <div className="h-1.5 bg-muted rounded-full overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${Math.min((k.progress.current / k.progress.goal) * 100, 100)}%` }}
                transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1], delay: 0.3 + index * 0.04 }}
                className={cn(
                  'h-full rounded-full',
                  (k.progress.current / k.progress.goal * 100) >= 100 ? 'bg-success-gradient' : 'bg-accent-gradient',
                )}
              />
            </div>
          </div>
        )}
      </Tile>
    </motion.div>
  );
}

// ─── Cross-module storage data ───────────────────────────────────────────────
function useCrossModuleData() {
  const [pnlSales,   setPnlSales]   = useState([]);
  const [bookTx,     setBookTx]     = useState([]);
  const [profitGoal, setProfitGoal] = useState(0);

  useEffect(() => {
    Promise.all([
      window.storage.get('noltech:lotprofit:sales'),
      window.storage.get('noltech:books:transactions'),
      window.storage.get('noltech:settings'),
    ]).then(([sales, txs, settings]) => {
      setPnlSales(Array.isArray(sales) ? sales : []);
      setBookTx(Array.isArray(txs)   ? txs   : []);
      setProfitGoal(settings?.monthlyProfitGoal || 0);
    }).catch(e => console.error('[HubDashboard] cross-module data load failed:', e));
  }, []);

  return { pnlSales, bookTx, profitGoal };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Main Dashboard
// ═══════════════════════════════════════════════════════════════════════════
export default function HubDashboard({ setView }) {
  const { state } = useApp();
  const { pnlSales, bookTx, profitGoal } = useCrossModuleData();
  const { syncAll, syncing, status, lastSyncedAt, lastSyncSource } = useSyncAll();

  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!lastSyncedAt) return;
    const id = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, [lastSyncedAt]);

  // `now` is memoized on the current UTC day so dependent useMemos (notably
  // the 30-day sparklines) don't recompute every render. Crosses a day
  // boundary correctly when the dep flips at midnight. tick (from the 30s
  // interval above) keeps thisMonth / thisYear fresh after extended sessions.
  const dayKey = Math.floor(Date.now() / 86400000);
  const now = useMemo(() => new Date(), [dayKey, tick]);
  const thisYear  = now.getFullYear();
  const thisMonth = now.getMonth();

  const allItems = useMemo(
    () => state.lots.flatMap((l) => (l.items || []).map((i) => ({ ...i, _lot: l }))),
    [state.lots],
  );

  // ── Inventory stats ──────────────────────────────────────────────────────
  const listedItems = useMemo(() => allItems.filter((i) => i.status === 'listed'), [allItems]);
  const pipelineItems = useMemo(
    () => allItems.filter((i) => !['sold', 'listed', 'recycled', 'parted_out'].includes(i.status)),
    [allItems],
  );

  const [ebayActiveSnapshot, setEbayActiveSnapshot] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => window.storage.get('noltech:ebay:active-listings-snapshot')
      .then(v => { if (alive && v && typeof v === 'object') setEbayActiveSnapshot(v); })
      .catch(e => console.error('[hub dashboard] storage error:', e));
    load();
    // [lastSyncedAt] dep already triggers a reload after Sync All; the native
    // window 'storage' event only fires cross-tab on localStorage (we use
    // IndexedDB) so it would never fire — dead listener removed.
    return () => { alive = false; };
  }, [lastSyncedAt]);

  const nonEbayListed = useMemo(
    () => listedItems.filter((i) => !i.ebayItemId),
    [listedItems],
  );
  const nonEbayListedCount = nonEbayListed.length;
  const nonEbayUnits = useMemo(
    () => nonEbayListed.reduce((s, i) => s + Math.max(1, parseInt(i.listingQuantity) || 1), 0),
    [nonEbayListed],
  );
  const nonEbayValue = useMemo(
    () => nonEbayListed.reduce((s, i) => {
      const price = i.listingPrice || i.listing?.price || 0;
      const qty = Math.max(1, parseInt(i.listingQuantity) || 1);
      return s + price * qty;
    }, 0),
    [nonEbayListed],
  );

  const activeListingsCount = ebayActiveSnapshot?.count != null
    ? (ebayActiveSnapshot.count + nonEbayListedCount)
    : listedItems.length;
  const activeListingUnits = ebayActiveSnapshot?.totalUnits != null
    ? (ebayActiveSnapshot.totalUnits + nonEbayUnits)
    : listedItems.reduce((sum, i) => sum + Math.max(1, parseInt(i.listingQuantity) || 1), 0);
  const activeListingValue = ebayActiveSnapshot?.totalValue != null
    ? (ebayActiveSnapshot.totalValue + nonEbayValue)
    : listedItems.reduce((sum, i) => {
        const price = i.listingPrice || i.listing?.price || 0;
        const qty = Math.max(1, parseInt(i.listingQuantity) || 1);
        return sum + price * qty;
      }, 0);

  // ── P&L sales — this month ──────────────────────────────────────────────
  const pnlThisMonth = useMemo(() =>
    pnlSales.filter((s) => {
      if (!s.date) return false;
      const d = new Date(s.date.includes('T') ? s.date : s.date + 'T00:00:00');
      return d.getFullYear() === thisYear && d.getMonth() === thisMonth;
    }),
  [pnlSales, thisYear, thisMonth]);

  const pnlMonthRevenue = useMemo(
    () => pnlThisMonth.reduce((sum, s) => sum + (s.totalRevenue || 0), 0),
    [pnlThisMonth],
  );
  const pnlMonthNet = useMemo(
    () => pnlThisMonth.reduce((sum, s) => sum + (s.netPayout || 0), 0),
    [pnlThisMonth],
  );
  const pnlMonthFees = useMemo(
    () => pnlThisMonth.reduce((sum, s) => sum + (s.ebayFees || 0), 0),
    [pnlThisMonth],
  );

  // ── Bookkeeping — this month ────────────────────────────────────────────
  const bookThisMonth = useMemo(() =>
    bookTx.filter((t) => {
      if (!t.date) return false;
      const d = new Date(t.date.includes('T') ? t.date : t.date + 'T00:00:00');
      return d.getFullYear() === thisYear && d.getMonth() === thisMonth;
    }),
  [bookTx, thisYear, thisMonth]);

  const bookMonthIncome   = useMemo(() => bookThisMonth.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0), [bookThisMonth]);
  const bookMonthExpenses = useMemo(() => bookThisMonth.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0), [bookThisMonth]);

  // ── Inventory-derived sold items (P&L fallback) ─────────────────────────
  const invSoldThisMonth = useMemo(() =>
    allItems.filter((i) => {
      if (i.status !== 'sold' || !i.sale?.soldAt) return false;
      const d = new Date(i.sale.soldAt);
      return d.getFullYear() === thisYear && d.getMonth() === thisMonth;
    }),
  [allItems, thisYear, thisMonth]);

  const invMonthRevenue = useMemo(
    () => invSoldThisMonth.reduce((sum, i) => sum + (i.sale?.salePrice || 0), 0),
    [invSoldThisMonth],
  );
  const invMonthProfit = useMemo(
    () => invSoldThisMonth.reduce((sum, i) => sum + (calcItemProfit(i, i._lot)?.profit || 0), 0),
    [invSoldThisMonth],
  );

  // ── Combined revenue/profit — prefer P&L if data exists ────────────────
  const usePnL         = pnlSales.length > 0;
  const monthRevenue   = usePnL ? pnlMonthRevenue  : invMonthRevenue + bookMonthIncome;
  const monthNet       = usePnL ? pnlMonthNet       : invMonthProfit;
  const monthExpenses  = usePnL ? bookMonthExpenses : 0;
  const monthProfit    = monthNet - monthExpenses;
  const salesCount     = usePnL ? pnlThisMonth.length : invSoldThisMonth.length;

  // ── Previous month for delta badges ─────────────────────────────────────
  const prevMonth = useMemo(() => {
    const prevMonthIdx = thisMonth === 0 ? 11 : thisMonth - 1;
    const prevYear = thisMonth === 0 ? thisYear - 1 : thisYear;
    const inPrev = (iso) => {
      if (!iso) return false;
      const d = new Date(iso.includes('T') ? iso : iso + 'T00:00:00');
      return d.getFullYear() === prevYear && d.getMonth() === prevMonthIdx;
    };
    let revenue = 0, profit = 0;
    if (usePnL) {
      pnlSales.forEach((s) => {
        if (inPrev(s.date)) {
          revenue += s.totalRevenue || 0;
          profit  += s.netPayout || 0;
        }
      });
    } else {
      allItems.forEach((i) => {
        if (i.status === 'sold' && inPrev(i.sale?.soldAt)) {
          revenue += i.sale?.salePrice || 0;
          profit  += calcItemProfit(i, i._lot)?.profit || 0;
        }
      });
    }
    return { revenue, profit };
  }, [pnlSales, allItems, usePnL, thisYear, thisMonth]);

  // ── All-time stats ──────────────────────────────────────────────────────
  const allTimePnLNet = useMemo(
    () => pnlSales.reduce((sum, s) => sum + (s.netPayout || 0), 0),
    [pnlSales],
  );
  const allTimeInvProfit = useMemo(
    () => allItems
      .filter((i) => i.status === 'sold')
      .reduce((sum, i) => sum + (calcItemProfit(i, i._lot)?.profit || 0), 0),
    [allItems],
  );
  const allTimeNet = usePnL ? allTimePnLNet : allTimeInvProfit;

  const allTimeCost = useMemo(
    () => usePnL
      ? 0
      : allItems.filter((i) => i.status === 'sold').reduce((sum, i) => sum + getItemCostBasis(i, i._lot), 0),
    [allItems, usePnL],
  );
  const monthRoi = useMemo(() => {
    if (usePnL) return null;
    return allTimeCost > 0 ? (monthProfit / allTimeCost) * 100 : null;
  }, [usePnL, allTimeCost, monthProfit]);

  // ── Recent sales ────────────────────────────────────────────────────────
  const recentPnLSales = useMemo(() =>
    [...pnlSales]
      .filter((s) => s.date)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 6),
  [pnlSales]);

  const recentInvSales = useMemo(() =>
    [...allItems]
      .filter((i) => i.status === 'sold' && i.sale?.soldAt)
      .sort((a, b) => new Date(b.sale.soldAt) - new Date(a.sale.soldAt))
      .slice(0, 6),
  [allItems]);

  const monthLabel = now.toLocaleString('en-US', { month: 'long' });

  // ── 30-day sparkline data ───────────────────────────────────────────────
  const sparklines = useMemo(() => {
    const days = 30;
    const msPerDay = 86400000;
    const startMs = now.getTime() - (days - 1) * msPerDay;
    const startOfDay = (d) => {
      const x = new Date(d);
      x.setHours(0, 0, 0, 0);
      return x.getTime();
    };

    const revByDay = new Array(days).fill(0);
    const profitByDay = new Array(days).fill(0);
    const listedByDay = new Array(days).fill(0);

    if (usePnL) {
      pnlSales.forEach((s) => {
        if (!s.date) return;
        const d = startOfDay(s.date.includes('T') ? s.date : s.date + 'T00:00:00');
        const idx = Math.floor((d - startOfDay(startMs)) / msPerDay);
        if (idx >= 0 && idx < days) {
          revByDay[idx] += s.totalRevenue || 0;
          profitByDay[idx] += s.netPayout || 0;
        }
      });
    } else {
      allItems.filter((i) => i.status === 'sold' && i.sale?.soldAt).forEach((item) => {
        const d = startOfDay(item.sale.soldAt);
        const idx = Math.floor((d - startOfDay(startMs)) / msPerDay);
        if (idx >= 0 && idx < days) {
          revByDay[idx] += item.sale.salePrice || 0;
          profitByDay[idx] += calcItemProfit(item, item._lot)?.profit || 0;
        }
      });
    }

    for (let i = 0; i < days; i++) {
      const dayEnd = startOfDay(startMs) + i * msPerDay + (msPerDay - 1);
      listedByDay[i] = allItems.filter((it) => {
        if (it.status !== 'listed') return false;
        const listedAt = it.dateAdded || it._lot?.purchaseDate;
        if (!listedAt) return true;
        return new Date(listedAt).getTime() <= dayEnd;
      }).length;
    }

    return {
      revenue:  revByDay,
      profit:   profitByDay,
      listings: listedByDay,
      pipeline: pipelineItems.length ? new Array(days).fill(pipelineItems.length) : [],
    };
  }, [allItems, pipelineItems, pnlSales, usePnL, now]);

  // ── KPI tile config ─────────────────────────────────────────────────────
  const kpis = [
    {
      label: 'Active Listings',
      value: activeListingsCount,
      sub: activeListingsCount
        ? `${activeListingUnits} unit${activeListingUnits !== 1 ? 's' : ''} · ${formatCurrency(activeListingValue)}`
        : 'No items listed',
      icon: Zap,
      intent: 'accent',
      sparkline: sparklines.listings,
    },
    {
      label: 'Pipeline',
      value: pipelineItems.length,
      sub: `${state.lots.length} lot${state.lots.length !== 1 ? 's' : ''} · ${allItems.length} items`,
      icon: Archive,
      intent: 'neutral',
    },
    {
      label: `${monthLabel} Revenue`,
      value: formatCurrency(monthRevenue),
      sub: (
        <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
          <TrendDelta current={monthRevenue} previous={prevMonth.revenue} />
          <span>{salesCount} sale{salesCount !== 1 ? 's' : ''}{pnlMonthFees ? ` · ${formatCurrency(pnlMonthFees)} fees` : ''}</span>
        </span>
      ),
      icon: ShoppingCart,
      intent: 'success',
      sparkline: sparklines.revenue,
    },
    {
      label: `${monthLabel} Profit`,
      value: formatCurrency(monthProfit),
      sub: (
        <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
          <TrendDelta current={monthProfit} previous={prevMonth.profit} />
          <span>
            {monthExpenses > 0
              ? `${formatCurrency(monthExpenses)} expenses`
              : monthRoi != null
                ? `${monthRoi.toFixed(1)}% ROI`
                : `${formatCurrency(allTimeNet)} all-time`}
          </span>
        </span>
      ),
      icon: DollarSign,
      intent: monthProfit >= 0 ? 'warning' : 'danger',
      progress: profitGoal > 0 ? { current: monthProfit, goal: profitGoal } : undefined,
      sparkline: sparklines.profit,
    },
  ];

  // ── Pipeline stages config ──────────────────────────────────────────────
  const pipelineStages = [
    { label: 'Lots',         count: allItems.length > 0 ? state.lots.length : 0, intent: 'accent',  view: 'inventory' },
    { label: 'Processing',   count: allItems.filter(i => ['received', 'testing'].includes(i.status)).length, intent: 'neutral', view: 'inventory' },
    { label: 'Listed',       count: listedItems.length, intent: 'warning', view: 'sell'      },
    { label: 'Sold (month)', count: salesCount,         intent: 'success', view: 'finance'   },
  ];

  return (
    <div className="relative max-w-screen-2xl mx-auto pb-12">
      {/* ═══ HERO ZONE ════════════════════════════════════════════════════ */}
      <div className="relative overflow-hidden">
        <div className="hero-mesh" aria-hidden="true" />

        <div className="relative flex flex-col md:flex-row md:items-end md:justify-between gap-6 pt-10 pb-12">
          <div className="min-w-0 max-w-2xl">
            <p className="ui-eyebrow text-fg-subtle mb-3">Dashboard</p>
            <h1 className="h-display-md text-fg leading-[1.05]">
              {greeting()}, <span className="gradient-text">Nolan</span>
            </h1>
            <p className="mt-3 text-[15px] text-fg-muted leading-relaxed max-w-xl">
              {monthLabel} at a glance — listings, sales, and profit across every channel.
              Tap any tile to drill in.
            </p>
          </div>

          <div className="flex flex-col md:items-end gap-1.5 shrink-0">
            <Button variant="accent" onClick={syncAll} loading={syncing}>
              {!syncing && <RefreshCw className="size-4" />}
              {syncing ? 'Syncing…' : 'Sync All'}
            </Button>
            {status ? (
              <p className="text-[11px] text-fg-muted max-w-[280px] md:text-right">{status}</p>
            ) : lastSyncedAt && (
              <p
                className="text-[11px] text-fg-muted md:text-right"
                title={lastSyncSource === 'auto'
                  ? 'Most recent sync was performed automatically by the AWS Sync Agent'
                  : 'Most recent sync was a manual Sync All from this device'}
              >
                Last synced {timeAgo(lastSyncedAt)}
                {lastSyncSource === 'auto' && (
                  <span className="ml-1 text-fg-subtle">· auto (AWS)</span>
                )}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ═══ KPI BENTO ROW ═══════════════════════════════════════════════ */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-12 gap-4 mb-6">
        {kpis.map((k, i) => (
          <KpiTile
            key={k.label}
            k={k}
            index={i}
            featured={i === 3}
            span="md:col-span-3"
          />
        ))}
      </div>

      {/* ═══ ALERTS / OPS CARDS — preserved verbatim ═══════════════════════ */}
      <SystemHealthCard setView={setView} />
      <ListingAgingAlert setView={setView} />
      <CashFlowCard />
      <InboundShipmentsCard setView={setView} />
      <PreListCheckCard setView={setView} />

      {/* ═══ RECENT ACTIVITY STRIP ═══════════════════════════════════════ */}
      <RecentActivityStrip setView={setView} />

      {/* ═══ PIPELINE + MODULES BENTO ROW ════════════════════════════════ */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-4 mb-6">
        {/* Pipeline — 8 cols */}
        <Tile span="md:col-span-8" padding="p-6">
          <div className="flex items-center justify-between mb-5">
            <div>
              <p className="ui-eyebrow text-fg-subtle">Pipeline</p>
              <h2 className="h-section text-fg mt-0.5">From lot to sold</h2>
            </div>
            <span className="text-[11px] text-fg-subtle">Click a stage to jump</span>
          </div>
          <PipelineBars stages={pipelineStages} setView={setView} />
        </Tile>

        {/* Quick-jump modules — 4 cols */}
        <Tile span="md:col-span-4" padding="p-6">
          <div className="flex items-center gap-2 mb-4">
            <LayoutGrid className="size-3.5 text-fg-subtle" />
            <p className="ui-eyebrow text-fg-subtle">Jump to module</p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {MODULE_CARDS.map((card) => (
              <ModuleChip key={card.id} {...card} onClick={() => setView(card.id)} />
            ))}
          </div>
        </Tile>
      </div>

      {/* ═══ SALES + EXPENSES BENTO ROW ═══════════════════════════════════ */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
        {/* Recent Sales — 6 cols */}
        <Tile span="md:col-span-6" padding="p-6">
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2">
              <TrendingUp size={15} className="text-success" />
              <h2 className="h-section text-fg">Recent Sales</h2>
            </div>
            <button
              onClick={() => setView(usePnL ? 'lotprofit' : 'inventory')}
              className="text-xs text-accent hover:underline font-medium inline-flex items-center gap-0.5"
            >
              View all <ArrowRight className="size-3" />
            </button>
          </div>

          {usePnL && recentPnLSales.length > 0 && (
            <SalesList
              items={recentPnLSales.map((s) => ({
                key: s.id,
                title: s.title || s.sku || 'eBay Sale',
                meta: s.date ? formatDate(s.date) : '—',
                price: s.totalRevenue || 0,
                profit: s.netPayout || 0,
                profitLabel: 'net',
              }))}
            />
          )}

          {!usePnL && recentInvSales.length > 0 && (
            <SalesList
              items={recentInvSales.map((item) => {
                const p = calcItemProfit(item, item._lot);
                return {
                  key: item.id,
                  title: item.model || item.brand || 'Unknown item',
                  meta: formatDate(item.sale?.soldAt),
                  price: item.sale?.salePrice || 0,
                  profit: p?.profit ?? null,
                };
              })}
            />
          )}

          {recentPnLSales.length === 0 && recentInvSales.length === 0 && (
            <EmptyState
              icon={Receipt}
              size="sm"
              title="No sales yet"
              description="When you record a sale or sync eBay orders, the most recent ones will land here."
              action={() => setView('inventory')}
              actionLabel="Open Inventory"
            />
          )}
        </Tile>

        {/* Expenses — 6 cols */}
        <Tile span="md:col-span-6" padding="p-6">
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2">
              <TrendingDown size={15} className="text-danger" />
              <h2 className="h-section text-fg">{monthLabel} Expenses</h2>
            </div>
            <button
              onClick={() => setView('books')}
              className="text-xs text-accent hover:underline font-medium inline-flex items-center gap-0.5"
            >
              View all <ArrowRight className="size-3" />
            </button>
          </div>

          {bookThisMonth.length === 0 ? (
            <EmptyState
              icon={Inbox}
              size="sm"
              title="No transactions this month"
              description="Bookkeeping entries you log will roll up here for a quick category view."
              action={() => setView('books')}
              actionLabel="Open Bookkeeping"
            />
          ) : (
            <>
              <div className="space-y-2 mb-3">
                {Object.entries(
                  bookThisMonth.reduce((acc, t) => {
                    const cat = t.category || 'Uncategorized';
                    if (!acc[cat]) acc[cat] = { income: 0, expense: 0 };
                    if (t.type === 'income')  acc[cat].income  += t.amount;
                    else                       acc[cat].expense += t.amount;
                    return acc;
                  }, {})
                ).slice(0, 6).map(([cat, { income, expense }]) => (
                  <div key={cat} className="flex items-center justify-between text-xs">
                    <span className="text-fg-muted truncate max-w-[180px]">{cat}</span>
                    <span className={cn(
                      'font-mono font-semibold',
                      expense > 0 ? 'text-danger' : 'text-success',
                    )}>
                      {expense > 0 ? `-${formatCurrency(expense)}` : `+${formatCurrency(income)}`}
                    </span>
                  </div>
                ))}
              </div>
              <div className="border-t border-border-subtle pt-3 flex justify-between text-xs font-semibold">
                <span className="text-fg-muted">Net</span>
                <span className={cn(
                  'mono',
                  bookMonthIncome - bookMonthExpenses >= 0 ? 'text-success' : 'text-danger',
                )}>
                  {formatCurrency(bookMonthIncome - bookMonthExpenses)}
                </span>
              </div>
            </>
          )}
        </Tile>
      </div>
    </div>
  );
}

// ─── PipelineBars ────────────────────────────────────────────────────────────
function PipelineBars({ stages, setView }) {
  const maxCount = Math.max(...stages.map(s => s.count), 1);
  const intentColor = {
    accent:  'var(--accent)',
    neutral: 'var(--fg-muted)',
    warning: 'var(--warning)',
    success: 'var(--success)',
  };
  const intentBg = {
    accent:  'bg-accent-gradient',
    neutral: 'bg-fg-muted',
    warning: 'bg-warning',
    success: 'bg-success-gradient',
  };

  return (
    <div className="flex items-end gap-3">
      {stages.map((stage, i) => (
        <div key={stage.label} className="flex-1 flex flex-col items-stretch relative">
          <button
            onClick={() => setView?.(stage.view)}
            className="group flex flex-col items-center gap-2 w-full transition-transform hover:-translate-y-0.5"
            title={`${stage.count} ${stage.label}`}
          >
            <span
              className="font-mono font-bold text-base"
              style={{ color: intentColor[stage.intent] }}
            >
              {stage.count}
            </span>
            <div className="w-full bg-recessed rounded-lg overflow-hidden flex items-end" style={{ height: '64px' }}>
              <motion.div
                initial={{ height: 0 }}
                animate={{ height: `${Math.max(12, (stage.count / maxCount) * 100)}%` }}
                transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1], delay: i * 0.06 }}
                className={cn('w-full rounded-lg', intentBg[stage.intent])}
              />
            </div>
            <span className="text-[11px] text-fg-muted font-medium">{stage.label}</span>
          </button>
          {i < stages.length - 1 && (
            <ArrowRight
              className="absolute -right-2.5 top-[28px] size-3.5 text-fg-subtle"
              aria-hidden="true"
            />
          )}
        </div>
      ))}
    </div>
  );
}

// ─── ModuleChip ──────────────────────────────────────────────────────────────
function ModuleChip({ id, label, desc, icon: Icon, onClick }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'group relative rounded-xl border border-border-subtle bg-surface',
        'p-3 text-left transition-all duration-150',
        'hover:border-accent/40 hover:bg-elevated hover:-translate-y-0.5',
      )}
    >
      <div className="flex items-center gap-2 mb-1">
        <div className="size-7 rounded-lg bg-accent-subtle flex items-center justify-center">
          <Icon className="size-3.5 text-accent" />
        </div>
        <p className="font-semibold text-fg text-[13px] tracking-subheading">{label}</p>
      </div>
      <p className="text-[11px] text-fg-subtle leading-snug line-clamp-2">{desc}</p>
      <ArrowUpRight className="absolute top-2.5 right-2.5 size-3 text-fg-subtle opacity-0 group-hover:opacity-100 transition-opacity" />
    </button>
  );
}

// ─── SalesList ───────────────────────────────────────────────────────────────
function SalesList({ items }) {
  return (
    <div className="space-y-3">
      {items.map((row) => (
        <div key={row.key} className="flex items-start justify-between gap-2 text-sm">
          <div className="min-w-0">
            <p className="font-medium text-fg text-xs leading-snug line-clamp-1">{row.title}</p>
            <p className="text-[11px] text-fg-muted">{row.meta}</p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-xs font-semibold text-fg mono">{formatCurrency(row.price)}</p>
            {row.profit != null && (
              <p className={cn(
                'text-[11px] font-medium mono',
                row.profit >= 0 ? 'text-success' : 'text-danger',
              )}>
                {row.profit >= 0 ? '+' : ''}{formatCurrency(row.profit)}
                {row.profitLabel ? ` ${row.profitLabel}` : ''}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Recent Activity Strip ───────────────────────────────────────────────────
function RecentActivityStrip({ setView }) {
  const { recents, clearRecents } = useRecents();
  if (!recents || recents.length === 0) return null;

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-2">
        <p className="ui-eyebrow text-fg-subtle inline-flex items-center gap-1.5">
          <Clock className="size-3" /> Recent
        </p>
        <button
          onClick={clearRecents}
          className="text-[10px] text-fg-subtle hover:text-fg-muted transition-colors inline-flex items-center gap-1"
          title="Clear recent activity"
        >
          <XIcon className="size-3" /> Clear
        </button>
      </div>
      <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-thin pb-1">
        {recents.slice(0, 8).map((r) => (
          <button
            key={`${r.type}-${r.id}`}
            onClick={() => r.view && setView?.(r.view)}
            className={cn(
              'group shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg',
              'border border-border-subtle bg-surface hover:border-accent/40 hover:bg-accent-subtle/20',
              'transition-colors max-w-[220px]',
            )}
            title={`${r.label} · ${timeAgoShort(r.ts)}`}
          >
            <span className="text-[11px] font-medium text-fg truncate">{r.label}</span>
            <span className="text-[10px] text-fg-subtle shrink-0">{timeAgoShort(r.ts)}</span>
            <ArrowUpRight className="size-3 text-fg-subtle group-hover:text-accent shrink-0 transition-colors" />
          </button>
        ))}
      </div>
    </div>
  );
}
