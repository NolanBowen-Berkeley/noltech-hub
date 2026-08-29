// ─── BrowseLotsCategoryGrid ──────────────────────────────────────────────────
// "Pick a category" landing grid that shows on Source page when no category
// filter is active. Each tile is a visually rich card with icon, count, top
// brands, best deal-grade indicator, and total potential value.
//
// Click a tile → applies the category filter (same behavior as the pill in
// BrowseLotsSummary, just more discoverable for new visits to the page).
// Once a filter is picked, the grid hides and the lot list reflows. A
// "← All categories" button on the parent lets the user reopen the grid.

import { useMemo } from 'react';
import {
  Laptop, Smartphone, Tablet, Monitor, Cpu, HardDrive, Gamepad2, Headphones,
  Camera, Watch, Speaker, Server, Printer, Network, Plug, Tv, Mouse, Keyboard,
  CircuitBoard, Package, ChevronRight, TrendingUp, ArrowLeft,
} from 'lucide-react';
import { fmt } from '../../utils/formatters';
import { cn } from '../../components/ui/cn';

// Pick a Lucide icon based on category keyword. Fallback to Package.
function iconForCategory(name) {
  const n = String(name || '').toLowerCase();
  if (/laptop|notebook|chromebook/.test(n))                            return Laptop;
  if (/desktop|tower|workstation|all[\s-]?in[\s-]?one/.test(n))         return Cpu;
  if (/phone|smartphone|cellphone|mobile/.test(n))                      return Smartphone;
  if (/tablet|ipad|kindle|e[\s-]?reader/.test(n))                       return Tablet;
  if (/monitor|display/.test(n))                                        return Monitor;
  if (/tv|television/.test(n))                                          return Tv;
  if (/gpu|graphics|video card/.test(n))                                return CircuitBoard;
  if (/storage|ssd|hdd|drive|nvme/.test(n))                             return HardDrive;
  if (/gaming|game|console|playstation|xbox|nintendo/.test(n))          return Gamepad2;
  if (/headphone|earbud|earphone|airpod|headset/.test(n))               return Headphones;
  if (/speaker|audio|sound/.test(n))                                    return Speaker;
  if (/camera|webcam|gopro|lens/.test(n))                               return Camera;
  if (/watch|smartwatch|fitness/.test(n))                               return Watch;
  if (/server|rack|enterprise/.test(n))                                 return Server;
  if (/printer|scanner|copier/.test(n))                                 return Printer;
  if (/network|router|switch|access point|firewall/.test(n))            return Network;
  if (/cable|adapter|charger|power/.test(n))                            return Plug;
  if (/keyboard/.test(n))                                                return Keyboard;
  if (/mouse|pointer|trackpad/.test(n))                                  return Mouse;
  if (/component|cpu|processor|ram|memory|motherboard/.test(n))         return CircuitBoard;
  if (/accessor/.test(n))                                                return Package;
  return Package;
}

// Smart-title-case a TL category string. Keeps known abbreviations uppercase.
function titleCase(s) {
  if (!s) return s;
  return String(s)
    .toLowerCase()
    .replace(/\b(\w)/g, (m) => m.toUpperCase())
    .replace(/\b(Tv|Gpu|Ram|Ssd|Hdd|Pc|Lcd|Led|Usb|Hdmi|Vr|Iv|Vi|Iii|Ii|Os)\b/gi, (m) => m.toUpperCase());
}

// Subtle accent color/gradient per signal tier — used to tint the card
// border + corner glow when there's at least one strong-grade lot.
const TIER_ACCENT = {
  god_tier:   { ring: 'border-accent/30', tagBg: 'bg-accent-subtle text-accent', tagLabel: 'God Tier' },
  steal:      { ring: 'border-success/40',                            tagBg: 'bg-success-subtle text-success',                                              tagLabel: 'Steal' },
  strong_buy: { ring: 'border-success/30',                            tagBg: 'bg-success-subtle text-success',                              tagLabel: 'Strong Buy' },
  buy:        { ring: 'border-info/30',                               tagBg: 'bg-info-subtle text-info',                                                    tagLabel: 'Buy' },
};

// SIGNAL_RANK lower = better (matches the sort order elsewhere).
const SIGNAL_RANK = { god_tier: 0, steal: 1, strong_buy: 2, buy: 3, watch: 4, pass: 5, dumpster: 6 };

export default function BrowseLotsCategoryGrid({ lots, onPickCategory, currentCategory }) {
  const categories = useMemo(() => {
    const map = new Map();   // lowerKey → { display, count, brands:Map, bestSignal, totalCeiling, lotsEndingSoon }
    const fourHourMs = 4 * 3600000;
    const now = Date.now();

    for (const l of lots) {
      const rawCats = String(l.topCategories || l.estimation?.category || '').split(',').map((s) => s.trim()).filter(Boolean);
      const ceiling = l.metrics?.bidCeiling || l.metrics?.maxBid || 0;
      const sig = l.metrics?.signal;
      const sigRank = SIGNAL_RANK[sig] ?? 99;
      const endsAt = l.auction?.endsAt;
      const endingSoon = endsAt && (new Date(endsAt).getTime() - now) > 0 && (new Date(endsAt).getTime() - now) < fourHourMs;
      const brandRaw = String(l.topBrands || '').split(',').map((s) => s.trim()).filter(Boolean);

      for (const cat of rawCats) {
        const key = cat.toLowerCase();
        let entry = map.get(key);
        if (!entry) {
          entry = {
            display: titleCase(cat),
            keyLower: key,
            count: 0,
            totalCeiling: 0,
            brandTally: new Map(),
            bestSignal: null,
            bestSignalRank: 99,
            endingSoonCount: 0,
          };
          map.set(key, entry);
        }
        entry.count++;
        entry.totalCeiling += ceiling;
        if (endingSoon) entry.endingSoonCount++;
        if (sigRank < entry.bestSignalRank) {
          entry.bestSignalRank = sigRank;
          entry.bestSignal = sig;
        }
        for (const b of brandRaw) {
          entry.brandTally.set(b, (entry.brandTally.get(b) || 0) + 1);
        }
      }
    }

    // Convert to sortable array; pull top 3 brands per category for display
    return [...map.values()]
      .map((c) => ({
        ...c,
        topBrands: [...c.brandTally.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([brand]) => brand),
      }))
      .sort((a, b) => {
        // Sort by best signal first (Strong Buy categories rise to top),
        // then by lot count as a tiebreaker.
        if (a.bestSignalRank !== b.bestSignalRank) return a.bestSignalRank - b.bestSignalRank;
        return b.count - a.count;
      });
  }, [lots]);

  if (!categories.length) return null;

  // When a specific category is selected, hide the grid entirely — the user
  // doesn't need to see the picker again until they clear the filter.
  const isFiltered = currentCategory && currentCategory !== 'all';
  if (isFiltered) {
    return (
      <div className="flex items-center gap-2">
        <button
          onClick={() => onPickCategory('all')}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-fg-muted hover:text-fg bg-surface border border-border hover:border-primary/40 hover:bg-muted transition-colors"
        >
          <ArrowLeft size={13} />
          All categories
        </button>
        <span className="text-xs text-fg-muted">
          Showing <span className="font-medium text-fg capitalize">{titleCase(currentCategory)}</span> lots
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-fg">Browse by Category</h3>
        <span className="text-xs text-fg-muted">{categories.length} categories · click to filter</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2.5">
        {categories.map((cat) => {
          const Icon = iconForCategory(cat.display);
          const accent = TIER_ACCENT[cat.bestSignal];
          return (
            <button
              key={cat.keyLower}
              onClick={() => onPickCategory(cat.keyLower)}
              className={cn(
                'group relative text-left rounded-xl border bg-surface p-3 transition-all duration-150 overflow-hidden',
                'hover:shadow-md hover:-translate-y-0.5 hover:border-primary/40',
                accent ? accent.ring : 'border-border',
              )}
              title={`Filter to ${cat.display}`}
            >
              {/* Best-signal corner tag — top-right, only renders for the
                  top three signal tiers so the grid stays calm. */}
              {accent && (
                <span className={cn(
                  'absolute top-1.5 right-1.5 inline-flex items-center text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full leading-none',
                  accent.tagBg,
                )}>
                  {accent.tagLabel}
                </span>
              )}

              {/* Icon + count */}
              <div className="flex items-center justify-between mb-2">
                <div className="size-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0 group-hover:bg-primary group-hover:text-white transition-colors">
                  <Icon size={18} />
                </div>
                <span className="text-xl font-semibold text-fg tabular-nums leading-none">
                  {cat.count}
                </span>
              </div>

              {/* Category name */}
              <div className="text-sm font-medium text-fg leading-tight line-clamp-2 min-h-[2.4em] mb-1.5">
                {cat.display}
              </div>

              {/* Top brands as tiny chips */}
              {cat.topBrands.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-1.5">
                  {cat.topBrands.map((b) => (
                    <span key={b} className="inline-block text-[10px] text-fg-muted bg-muted/60 px-1.5 py-0.5 rounded">
                      {b}
                    </span>
                  ))}
                </div>
              )}

              {/* Bottom row: ROI ceiling + ending-soon hint + chevron */}
              <div className="flex items-center justify-between gap-1 text-[11px] mt-1">
                <div className="flex items-center gap-1 min-w-0">
                  {cat.totalCeiling > 0 && (
                    <span className="font-mono tabular-nums text-success font-medium truncate">
                      {fmt(cat.totalCeiling)}
                    </span>
                  )}
                  {cat.endingSoonCount > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-warning font-medium ml-1">
                      <TrendingUp size={9} />
                      {cat.endingSoonCount} soon
                    </span>
                  )}
                </div>
                <ChevronRight size={12} className="text-fg-subtle group-hover:text-primary transition-colors shrink-0" />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
