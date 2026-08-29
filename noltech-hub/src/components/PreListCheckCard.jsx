// ─── Pre-list Completeness Check ──────────────────────────────────────────────
// Surfaces inventory items that are progressing toward "ready to list" but
// missing the data needed to actually publish a listing. Lists the top items
// with a checkbox-style summary of what they're missing, so the user can
// jump in and fill the gaps.

import { useMemo } from 'react';
import { ListChecks, ArrowRight, Image as ImageIcon, FileText, DollarSign, Tag } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { fmt } from '../utils/formatters';

// Items in these statuses are candidates for being listed soon
const READY_STATUSES = new Set(['received', 'testing', 'repair', 'listing']);

// An item is only "actionable" in the pre-list check if it has SOMETHING to
// identify it (brand, model, SKU, serial, or eBay ID). Pure-phantom rows
// — placeholders auto-created from manifests with no parsed names — clutter
// the card and aren't actually fixable from inventory in any meaningful way.
function isActionable(item) {
  return !!(item.brand || item.model || item.sku || item.serialNumber || item.ebayItemId);
}

function checklistFor(item) {
  const issues = [];
  if (!item.brand && !item.model)         issues.push({ key: 'name',      label: 'brand/model', Icon: Tag });
  if (!item.conditionGrade)               issues.push({ key: 'condition', label: 'condition grade', Icon: FileText });
  if (!item.listingPrice || parseFloat(item.listingPrice) <= 0) issues.push({ key: 'price', label: 'listing price', Icon: DollarSign });
  if (!Array.isArray(item.photos) || item.photos.length === 0)  issues.push({ key: 'photos', label: 'photos', Icon: ImageIcon });
  return issues;
}

export default function PreListCheckCard({ setView }) {
  const { state } = useApp();

  const summary = useMemo(() => {
    const incomplete = [];
    for (const lot of (state.lots || [])) {
      for (const item of (lot.items || [])) {
        if (!READY_STATUSES.has(item.status)) continue;
        if (!isActionable(item)) continue;  // skip phantom rows with no ID
        const missing = checklistFor(item);
        if (missing.length === 0) continue;
        incomplete.push({
          id: item.id,
          name: `${item.brand || ''} ${item.model || ''}`.trim() || item.sku || 'Item',
          status: item.status,
          missing,
          missingCount: missing.length,
          lotName: lot.sourceName || lot.source || '',
        });
      }
    }
    // Show worst-case items first (most missing fields)
    incomplete.sort((a, b) => b.missingCount - a.missingCount);
    // Aggregate counts across the whole pipeline
    const totalMissingByKey = {};
    for (const it of incomplete) {
      for (const m of it.missing) {
        totalMissingByKey[m.key] = (totalMissingByKey[m.key] || 0) + 1;
      }
    }
    return { incomplete, totalMissingByKey };
  }, [state.lots]);

  if (summary.incomplete.length === 0) return null;
  const top = summary.incomplete.slice(0, 5);
  const remaining = summary.incomplete.length - top.length;

  // Build a one-line aggregate of "5 missing photos · 3 missing price · …"
  const aggLabels = {
    name: 'brand/model', condition: 'condition', price: 'price', photos: 'photos',
  };
  const aggParts = Object.entries(summary.totalMissingByKey)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n} missing ${aggLabels[k] || k}`);

  return (
    <div className="rounded-xl border border-border bg-surface shadow-sm p-4 mb-3">
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <ListChecks size={16} className="text-fg-muted" />
          <p className="text-sm font-semibold text-fg">
            {summary.incomplete.length} item{summary.incomplete.length !== 1 ? 's' : ''} not yet ready to list
          </p>
        </div>
        <button
          type="button"
          onClick={() => setView?.('inventory')}
          className="flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
        >
          Fix in Inventory <ArrowRight size={12} />
        </button>
      </div>

      <p className="text-[11px] text-fg-muted mb-3">{aggParts.join(' · ')}</p>

      <ul className="space-y-1.5">
        {top.map((it) => (
          <li
            key={it.id}
            className="flex items-center justify-between gap-3 text-xs px-2 py-1.5 rounded-md bg-muted/30 border border-border-subtle"
          >
            <div className="flex-1 min-w-0">
              <p className="font-medium text-fg truncate">{it.name}</p>
              <p className="text-[10px] text-fg-muted truncate">
                <span className="font-mono">{it.status}</span>
                {it.lotName && <span className="text-fg-subtle"> · {it.lotName}</span>}
              </p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {it.missing.map((m) => {
                const Icon = m.Icon;
                return (
                  <span
                    key={m.key}
                    title={`Missing: ${m.label}`}
                    className="inline-flex items-center justify-center w-5 h-5 rounded bg-warning-subtle text-warning"
                  >
                    <Icon size={10} />
                  </span>
                );
              })}
            </div>
          </li>
        ))}
        {remaining > 0 && (
          <li className="text-[11px] text-fg-subtle italic px-2">
            +{remaining} more item{remaining !== 1 ? 's' : ''} with gaps — open Inventory to see all
          </li>
        )}
      </ul>
    </div>
  );
}
