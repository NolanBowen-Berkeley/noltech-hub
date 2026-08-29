// ─── BrowseLotsSummary ───────────────────────────────────────────────────────
// At-a-glance summary strip for the Source page. Shows two clickable tiers:
//
//   1. Stat tiles  — Strong Buy / Ending soon / High ROI / Total value
//   2. Category pills with live counts — one-click filter to that category
//
// Computed off the FULL lots list (not the filtered view), so the user can
// always see the size of categories they aren't currently looking at.
// Clicking a tile or pill applies a filter; clicking it again clears.

import { useMemo, useState } from 'react';
import { TrendingUp, Clock, Zap, DollarSign, Package, Tag, Hash, BarChart3, ChevronDown, ChevronUp } from 'lucide-react';
import { fmt } from '../../utils/formatters';
import { cn } from '../../components/ui/cn';

// Map signal slugs → display label + accent color. Matches LotCard's badge.
const SIGNAL_META = {
  god_tier:   { label: 'God Tier',   tone: 'text-accent bg-accent-subtle' },
  steal:      { label: 'Steal',      tone: 'text-success bg-success-subtle' },
  strong_buy: { label: 'Strong Buy', tone: 'text-success bg-success-subtle' },
  buy:        { label: 'Buy',        tone: 'text-info    bg-info-subtle' },
  watch:      { label: 'Watch',      tone: 'text-warning bg-warning-subtle' },
  pass:       { label: 'Pass',       tone: 'text-fg-muted bg-muted' },
  dumpster:   { label: 'Dumpster',   tone: 'text-danger  bg-danger-subtle' },
};

const SIGNAL_ORDER = ['god_tier', 'steal', 'strong_buy', 'buy', 'watch', 'pass', 'dumpster'];

// Smart-case TL category strings. They come back in variable casing
// ("Cell Phone Accessories", "tablets", "VIDEO GAMES"). Preserve hyphens,
// uppercase abbreviations (TV, GPU, RAM, SSD), title-case the rest.
function smartTitleCase(s) {
  if (!s) return s;
  return String(s)
    .toLowerCase()
    .replace(/\b(\w)/g, (m) => m.toUpperCase())
    .replace(/\b(Tv|Gpu|Ram|Ssd|Hdd|Pc|Lcd|Led|Usb|Hdmi|Vr|Iv|Vi|Iii|Ii|Os)\b/gi, (m) => m.toUpperCase());
}

function StatTile({ icon: Icon, label, value, sub, active, onClick, intent = 'neutral' }) {
  const intentClasses = {
    neutral: 'border-border bg-surface',
    success: 'border-success/30 bg-success-subtle',
    warning: 'border-warning/30 bg-warning-subtle',
    accent:  'border-primary/30 bg-primary/5',
  }[intent] || 'border-border bg-surface';
  const iconColor = {
    neutral: 'text-fg-muted',
    success: 'text-success',
    warning: 'text-warning',
    accent:  'text-primary',
  }[intent] || 'text-fg-muted';

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'relative flex-1 min-w-[140px] text-left rounded-xl border px-3 py-2.5 transition-all duration-150',
        intentClasses,
        active
          ? 'ring-2 ring-primary/40 shadow-sm'
          : 'hover:border-primary/50 hover:shadow-sm cursor-pointer',
      )}
      title={onClick ? `Click to ${active ? 'clear filter' : 'filter to ' + label}` : undefined}
    >
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
        <Icon size={11} className={iconColor} />
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold text-fg tabular-nums leading-none">
        {value}
      </div>
      {sub && <div className="mt-1 text-[10px] text-fg-muted truncate">{sub}</div>}
    </button>
  );
}

// `tone` (optional) is a Tailwind class string applied to the inactive state
// for signal pills — e.g., 'text-success bg-success-subtle'.
// Active state always uses the primary brand color so the active pill is
// unambiguous regardless of which row it's in.
function CategoryPill({ label, count, active, onClick, tone }) {
  const inactive = tone || 'bg-surface text-fg-muted border-border hover:border-primary/40 hover:text-fg hover:bg-muted';
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors whitespace-nowrap border',
        active
          ? 'bg-primary text-white border-primary shadow-sm'
          : cn(tone ? 'border-transparent' : 'border-border', inactive),
      )}
    >
      <span>{label}</span>
      <span className={cn(
        'inline-flex items-center justify-center min-w-[20px] h-4 px-1 rounded-full text-[10px] font-mono tabular-nums',
        active ? 'bg-white/20' : 'bg-black/10 dark:bg-white/10',
      )}>
        {count}
      </span>
    </button>
  );
}

export default function BrowseLotsSummary({
  lots,
  signalFilter,
  endingSoonFilter,
  categoryFilter,
  brandFilter,
  onToggleSignal,
  onToggleEndingSoon,
  onSetCategory,
  onSetBrand,
}) {
  // Per-section "show all" toggles. By default we show the top N to keep the
  // strip from dominating the page, with an "+ X more" expander for each.
  const [showAllCategories, setShowAllCategories] = useState(false);
  const [showAllBrands, setShowAllBrands] = useState(false);

  const stats = useMemo(() => {
    const now = Date.now();
    const fourHourMs = 4 * 3600000;

    // Group by signal — value tracking for top-tier signals
    const bySignal = {};
    let strongBuyValue = 0;
    let endingSoonCount = 0;
    let endingSoonValue = 0;
    let highRoiCount = 0;
    let totalMaxValue = 0;
    let activeAuctions = 0;

    // Group by category & brand. Keys are case-INSENSITIVE merged (so
    // "Tablets" and "tablets" combine), values keep the original-cased
    // version of whichever variant we saw first for display.
    const byCategory = new Map();   // lowerKey → { display, count }
    const byBrand    = new Map();
    const bySource   = new Map();

    const addToMap = (map, raw) => {
      const trimmed = String(raw || '').trim();
      if (!trimmed) return;
      const key = trimmed.toLowerCase();
      const existing = map.get(key);
      if (existing) existing.count += 1;
      else map.set(key, { display: smartTitleCase(trimmed), count: 1 });
    };

    for (const l of lots) {
      const signal = l.metrics?.signal;
      if (signal) bySignal[signal] = (bySignal[signal] || 0) + 1;

      const roi = l.metrics?.roi || 0;
      const ceiling = l.metrics?.bidCeiling || l.metrics?.maxBid || 0;
      if (signal === 'strong_buy' || signal === 'steal' || signal === 'god_tier') {
        strongBuyValue += ceiling;
      }
      if (roi >= 100) highRoiCount++;
      totalMaxValue += ceiling;

      const endsAt = l.auction?.endsAt;
      if (endsAt) {
        const diff = new Date(endsAt).getTime() - now;
        if (diff > 0) {
          activeAuctions++;
          if (diff < fourHourMs) {
            endingSoonCount++;
            endingSoonValue += ceiling;
          }
        }
      }

      // CATEGORIES — TL returns comma-separated topCategories like
      // "Cell Phone Accessories, Headphones". Index every one so a lot
      // with 2 categories shows up under both pills.
      const rawCats = String(l.topCategories || l.estimation?.category || '');
      for (const c of rawCats.split(',').map((s) => s.trim()).filter(Boolean)) {
        addToMap(byCategory, c);
      }

      // BRANDS — TL returns "Samsung, Poly" / "Apple" in topBrands. Index
      // each brand so a lot with multiple brands counts toward each pill.
      const rawBrands = String(l.topBrands || '');
      for (const b of rawBrands.split(',').map((s) => s.trim()).filter(Boolean)) {
        addToMap(byBrand, b);
      }

      // SOURCES (small map, used for color-coding)
      if (l.source) addToMap(bySource, l.source);
    }

    const strongBuyCount =
      (bySignal.strong_buy || 0) + (bySignal.steal || 0) + (bySignal.god_tier || 0);

    const categories = [...byCategory.values()]
      .sort((a, b) => b.count - a.count);
    const brands = [...byBrand.values()]
      .sort((a, b) => b.count - a.count);

    // Build signal pills in fixed display order, dropping zero-count signals
    const signalPills = SIGNAL_ORDER
      .filter((s) => bySignal[s] > 0)
      .map((s) => ({ slug: s, count: bySignal[s], ...SIGNAL_META[s] }));

    return {
      strongBuyCount,
      strongBuyValue,
      endingSoonCount,
      endingSoonValue,
      highRoiCount,
      totalMaxValue,
      activeAuctions,
      bySignal,
      signalPills,
      categories,
      brands,
    };
  }, [lots]);

  if (!lots.length) return null;

  const hasStrongBuy = stats.strongBuyCount > 0;
  const hasEndingSoon = stats.endingSoonCount > 0;

  return (
    <div className="space-y-2.5">
      {/* Stat tiles row */}
      <div className="flex items-stretch gap-2 overflow-x-auto pb-1">
        <StatTile
          icon={Package}
          label="Total Lots"
          value={lots.length}
          sub={`${stats.activeAuctions} active auctions`}
          intent="neutral"
        />
        {hasStrongBuy && (
          <StatTile
            icon={TrendingUp}
            label="Strong Buy +"
            value={stats.strongBuyCount}
            sub={`up to ${fmt(stats.strongBuyValue)} ceiling`}
            intent="success"
            active={signalFilter === 'strong_buy'}
            onClick={() => onToggleSignal('strong_buy')}
          />
        )}
        {hasEndingSoon && (
          <StatTile
            icon={Clock}
            label="Ending < 4h"
            value={stats.endingSoonCount}
            sub={`up to ${fmt(stats.endingSoonValue)} ceiling`}
            intent="warning"
            active={endingSoonFilter}
            onClick={onToggleEndingSoon}
          />
        )}
        <StatTile
          icon={Zap}
          label="High ROI (≥100%)"
          value={stats.highRoiCount}
          sub="200%+ profit potential"
          intent="accent"
        />
        <StatTile
          icon={DollarSign}
          label="Max if all win"
          value={fmt(stats.totalMaxValue)}
          sub="Sum of bid ceilings"
          intent="neutral"
        />
      </div>

      {/* Signal grade pills — quickly filter by deal grade. Only renders
          if there's actual variety in signals (skip if everything's the
          same grade). */}
      {stats.signalPills.length > 1 && (
        <PillRow
          icon={BarChart3}
          label="By Grade"
          pills={[
            { label: 'All', count: lots.length, active: !signalFilter, onClick: () => signalFilter && onToggleSignal(signalFilter) },
            ...stats.signalPills.map((s) => ({
              label: s.label,
              count: s.count,
              active: signalFilter === s.slug,
              tone: s.tone,
              onClick: () => onToggleSignal(s.slug),
            })),
          ]}
        />
      )}

      {/* Categories — TL's verbatim category names (e.g., "Cell Phone
          Accessories", "Tablets"), title-cased. Top 12 visible by default,
          "Show all" reveals the rest for diverse lot mixes. */}
      {stats.categories.length > 0 && (
        <PillRow
          icon={Tag}
          label="By Category"
          pills={[
            { label: 'All', count: lots.length, active: !categoryFilter || categoryFilter === 'all', onClick: () => onSetCategory('all') },
            ...stats.categories
              .slice(0, showAllCategories ? stats.categories.length : 12)
              .map((c) => ({
                label: c.display,
                count: c.count,
                active: (categoryFilter || '').toLowerCase() === c.display.toLowerCase(),
                onClick: () => onSetCategory(
                  (categoryFilter || '').toLowerCase() === c.display.toLowerCase()
                    ? 'all'
                    : c.display.toLowerCase(),
                ),
              })),
          ]}
          extra={stats.categories.length > 12 && (
            <button
              onClick={() => setShowAllCategories((v) => !v)}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:text-primary-dark px-2 py-1 rounded-full hover:bg-primary/10 transition-colors whitespace-nowrap"
            >
              {showAllCategories
                ? <>Show fewer <ChevronUp size={11} /></>
                : <>+ {stats.categories.length - 12} more <ChevronDown size={11} /></>}
            </button>
          )}
        />
      )}

      {/* Brands — TL's topBrands like "Apple, Samsung". Same expand pattern
          as categories. Only shown if at least 2 brands appear. */}
      {stats.brands.length > 1 && onSetBrand && (
        <PillRow
          icon={Hash}
          label="By Brand"
          pills={[
            { label: 'All', count: lots.length, active: !brandFilter || brandFilter === 'all', onClick: () => onSetBrand('all') },
            ...stats.brands
              .slice(0, showAllBrands ? stats.brands.length : 12)
              .map((b) => ({
                label: b.display,
                count: b.count,
                active: (brandFilter || '').toLowerCase() === b.display.toLowerCase(),
                onClick: () => onSetBrand(
                  (brandFilter || '').toLowerCase() === b.display.toLowerCase()
                    ? 'all'
                    : b.display.toLowerCase(),
                ),
              })),
          ]}
          extra={stats.brands.length > 12 && (
            <button
              onClick={() => setShowAllBrands((v) => !v)}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:text-primary-dark px-2 py-1 rounded-full hover:bg-primary/10 transition-colors whitespace-nowrap"
            >
              {showAllBrands
                ? <>Show fewer <ChevronUp size={11} /></>
                : <>+ {stats.brands.length - 12} more <ChevronDown size={11} /></>}
            </button>
          )}
        />
      )}
    </div>
  );
}

// Generic horizontal pill row with a leading label icon. Centralized so all
// three sections (signal/category/brand) share spacing, overflow behavior,
// and the optional trailing "extra" slot for show-more buttons.
function PillRow({ icon: Icon, label, pills, extra }) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-1">
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-fg-subtle shrink-0 mr-1">
        <Icon size={11} />
        {label}
      </span>
      {pills.map((p, i) => (
        <CategoryPill
          key={`${p.label}-${i}`}
          label={p.label}
          count={p.count}
          active={p.active}
          onClick={p.onClick}
          tone={p.tone}
        />
      ))}
      {extra}
    </div>
  );
}
