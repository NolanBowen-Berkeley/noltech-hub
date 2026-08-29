// ─── Listing Aging Alert ──────────────────────────────────────────────────────
// Surfaces an actionable banner on the Hub when too many listings have been
// sitting unsold for over the user-configured threshold. Tied directly to
// cash velocity — stale listings don't earn money.

import { useState, useEffect, useMemo } from 'react';
import { AlertCircle, TrendingDown, ArrowRight, X } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { fmt } from '../utils/formatters';

const KEY_THRESHOLD = 'noltech:settings:listing-aging-days';
const KEY_DISMISSED = 'noltech:settings:aging-alert-dismissed-until';
const DEFAULT_THRESHOLD_DAYS = 45;

export default function ListingAgingAlert({ setView }) {
  const { state } = useApp();
  const [thresholdDays, setThresholdDays] = useState(DEFAULT_THRESHOLD_DAYS);
  const [dismissedUntil, setDismissedUntil] = useState(null);

  useEffect(() => {
    window.storage.get(KEY_THRESHOLD)
      .then((v) => { if (typeof v === 'number' && v > 0) setThresholdDays(v); })
      .catch(e => console.error('[listing aging alert] storage error:', e));
    window.storage.get(KEY_DISMISSED)
      .then((v) => { if (v) setDismissedUntil(v); })
      .catch(e => console.error('[listing aging alert] storage error:', e));
  }, []);

  const aging = useMemo(() => {
    const now = Date.now();
    const cutoff = now - thresholdDays * 86400 * 1000;
    const items = [];
    for (const lot of (state.lots || [])) {
      for (const item of (lot.items || [])) {
        if (item.status !== 'listed') continue;
        if (!item.listingPrice) continue;
        const listedAt = new Date(item.dateAdded || lot.purchaseDate || 0).getTime();
        if (!Number.isFinite(listedAt) || listedAt === 0) continue;
        if (listedAt > cutoff) continue; // not aged yet
        const daysOld = Math.floor((now - listedAt) / 86400000);
        items.push({
          id: item.id,
          name: `${item.brand || ''} ${item.model || ''}`.trim() || item.sku || 'Item',
          listingPrice: parseFloat(item.listingPrice) || 0,
          daysOld,
          ebayItemId: item.ebayItemId,
        });
      }
    }
    items.sort((a, b) => b.daysOld - a.daysOld);
    const totalValue = items.reduce((s, i) => s + i.listingPrice, 0);
    return { items, totalValue };
  }, [state.lots, thresholdDays]);

  const dismissed = dismissedUntil && new Date(dismissedUntil).getTime() > Date.now();
  const handleDismiss = async () => {
    // Snooze for 7 days
    const until = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
    await window.storage.set(KEY_DISMISSED, until);
    setDismissedUntil(until);
  };

  if (dismissed || aging.items.length === 0) return null;

  // Severity buckets — drive border color and tone
  const severity = aging.items.length >= 10 ? 'high' : aging.items.length >= 3 ? 'medium' : 'low';
  const cls = severity === 'high'
    ? 'border-danger/40 bg-danger-subtle'
    : severity === 'medium'
      ? 'border-warning/40 bg-warning-subtle'
      : 'border-warning/30 bg-warning-subtle';
  const tone = severity === 'high' ? 'text-danger' : 'text-warning';

  // Top 3 oldest for the inline preview
  const preview = aging.items.slice(0, 3);

  return (
    <div className={`rounded-xl border shadow-sm p-4 mb-3 ${cls}`}>
      <div className="flex items-start gap-3">
        <div className={`shrink-0 ${tone}`}>
          {severity === 'high' ? <TrendingDown size={18} /> : <AlertCircle size={18} />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className={`text-sm font-semibold ${tone}`}>
              {aging.items.length} listing{aging.items.length !== 1 ? 's' : ''} unsold for {thresholdDays}+ days
              <span className="text-fg-muted font-normal"> · {fmt(aging.totalValue)} tied up</span>
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setView?.('selling')}
                className={`flex items-center gap-1 text-xs font-semibold ${tone} hover:underline`}
              >
                Review & reprice <ArrowRight size={12} />
              </button>
              <button
                type="button"
                onClick={handleDismiss}
                title="Snooze for 7 days"
                className="text-fg-muted hover:text-fg p-1 rounded transition-colors"
              >
                <X size={13} />
              </button>
            </div>
          </div>

          {/* Top 3 oldest as inline preview */}
          <ul className="mt-2 space-y-0.5">
            {preview.map((it) => (
              <li key={it.id} className="text-[11px] text-fg-muted flex items-center justify-between gap-2">
                <span className="truncate">
                  <span className="font-mono text-fg-subtle">{it.daysOld}d</span>
                  <span className="ml-2">{it.name.slice(0, 60)}</span>
                </span>
                <span className="font-mono text-fg shrink-0">{fmt(it.listingPrice)}</span>
              </li>
            ))}
            {aging.items.length > preview.length && (
              <li className="text-[11px] text-fg-subtle italic">
                +{aging.items.length - preview.length} more older than {thresholdDays}d
              </li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}
