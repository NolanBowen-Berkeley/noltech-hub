// ─── Sync Summary Modal ──────────────────────────────────────────────────────
// Opens when the user clicks the post-Sync All notification toast. Shows
// per-category lists of everything that changed in the most recent sync run.

import { motion } from 'framer-motion';
import {
  X, Plus, RefreshCw, ShoppingCart, RotateCw, Sparkles, AlertTriangle,
} from 'lucide-react';
import { fmt } from '../utils/formatters';

const SECTIONS = [
  { key: 'newListings',     label: 'New listings',         Icon: Plus,        tint: 'text-success' },
  { key: 'updatedListings', label: 'Listings updated',     Icon: RefreshCw,   tint: 'text-secondary' },
  { key: 'newSales',        label: 'New sales',            Icon: ShoppingCart, tint: 'text-success' },
  { key: 'refreshedSales',  label: 'Sales refreshed',      Icon: RotateCw,    tint: 'text-fg-muted' },
  { key: 'autoCreated',     label: 'Auto-created stubs',   Icon: Sparkles,    tint: 'text-accent' },
  { key: 'skipped',         label: 'Skipped',              Icon: AlertTriangle, tint: 'text-warning' },
];

export default function SyncSummaryModal({ summary, onClose }) {
  if (!summary) return null;

  const counts = summary.counts || {};
  const totalRows = SECTIONS.reduce((s, sec) => s + (counts[sec.key] || 0), 0);
  const syncedAt = summary.syncedAt ? new Date(summary.syncedAt) : null;

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        onClick={(e) => e.stopPropagation()}
        className="glossy-elevated w-full max-w-3xl max-h-[85vh] overflow-y-auto"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-border sticky top-0 bg-surface/95 backdrop-blur-sm z-10">
          <div className="min-w-0 flex-1">
            <p className="text-base font-semibold text-fg">Sync All — Summary</p>
            <p className="text-xs text-fg-muted mt-0.5">
              {totalRows} change{totalRows !== 1 ? 's' : ''}
              {syncedAt && ` · ${syncedAt.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-fg-subtle hover:text-fg hover:bg-muted transition-colors shrink-0"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Top stats grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-4 border-b border-border-subtle">
          {SECTIONS.map(({ key, label, Icon, tint }) => {
            const count = counts[key] || 0;
            return (
              <div
                key={key}
                className={`bg-white border ${count > 0 ? 'border-border' : 'border-border-subtle opacity-50'} rounded-lg px-3 py-2`}
              >
                <div className={`flex items-center gap-1.5 ${tint}`}>
                  <Icon size={12} />
                  <p className="text-[10px] uppercase tracking-wide font-semibold">{label}</p>
                </div>
                <p className="text-xl font-bold font-mono mt-0.5 text-fg">{count}</p>
              </div>
            );
          })}
        </div>

        {/* Detail sections */}
        <div className="p-4 space-y-4">
          {SECTIONS.map(({ key, label, Icon, tint }) => {
            const items = summary[key] || [];
            if (!items.length) return null;
            return (
              <Section key={key} label={label} Icon={Icon} tint={tint} items={items} kind={key} />
            );
          })}
          {totalRows === 0 && (
            <div className="text-center py-8 text-sm text-fg-muted">
              Nothing changed since the last sync.
            </div>
          )}
        </div>

        {/* Finances tail */}
        {(counts.adFeeUpdates > 0 || counts.labelUpdates > 0) && (
          <div className="px-4 pb-4">
            <div className="bg-info-subtle border border-info/30 rounded-lg px-3 py-2 text-[11px] text-info">
              Finances API:
              {counts.adFeeUpdates > 0 && ` ${counts.adFeeUpdates} ad-fee row${counts.adFeeUpdates !== 1 ? 's' : ''} refreshed`}
              {counts.adFeeUpdates > 0 && counts.labelUpdates > 0 && ' · '}
              {counts.labelUpdates > 0 && `${counts.labelUpdates} label-cost row${counts.labelUpdates !== 1 ? 's' : ''} refreshed`}
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}

function Section({ label, Icon, tint, items, kind }) {
  return (
    <div>
      <div className={`flex items-center gap-1.5 mb-1.5 ${tint}`}>
        <Icon size={13} />
        <p className="text-[11px] uppercase tracking-wide font-semibold">{label} ({items.length})</p>
      </div>
      <div className="border border-border-subtle rounded-lg overflow-hidden bg-white">
        <div className="max-h-64 overflow-auto divide-y divide-border-subtle">
          {items.map((item, i) => (
            <Row key={i} item={item} kind={kind} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Row({ item, kind }) {
  // Per-kind row layout — each list has slightly different shape.
  if (kind === 'newListings' || kind === 'updatedListings') {
    return (
      <div className="grid items-center gap-2 px-3 py-1.5 text-[12px]" style={{ gridTemplateColumns: '1fr 110px 80px' }}>
        <span className="truncate text-fg" title={item.title}>{item.title || '—'}</span>
        <span className="font-mono text-[10px] text-fg-muted truncate">{item.sku || '—'}</span>
        <span className="text-right font-mono">{fmt(item.price)}</span>
      </div>
    );
  }
  if (kind === 'newSales' || kind === 'autoCreated') {
    return (
      <div className="grid items-center gap-2 px-3 py-1.5 text-[12px]" style={{ gridTemplateColumns: '110px 1fr 110px 80px' }}>
        <span className="font-mono text-[10px] text-fg-muted truncate" title={item.orderId}>{item.orderId || '—'}</span>
        <span className="truncate text-fg" title={item.title}>{item.title || '—'}</span>
        <span className="font-mono text-[10px] text-fg-muted truncate">{item.sku || '—'}</span>
        <span className="text-right font-mono text-success">+{fmt(item.gross)}</span>
      </div>
    );
  }
  if (kind === 'refreshedSales') {
    return (
      <div className="grid items-center gap-2 px-3 py-1.5 text-[12px]" style={{ gridTemplateColumns: '110px 1fr 1fr' }}>
        <span className="font-mono text-[10px] text-fg-muted truncate" title={item.orderId}>{item.orderId || '—'}</span>
        <span className="truncate text-fg" title={item.title}>{item.title || '—'}</span>
        <span className="text-[11px] text-fg-muted truncate">
          {item.fields?.length ? `Updated: ${item.fields.join(', ')}` : 'Updated'}
        </span>
      </div>
    );
  }
  if (kind === 'skipped') {
    return (
      <div className="grid items-center gap-2 px-3 py-1.5 text-[12px]" style={{ gridTemplateColumns: '110px 1fr 1fr' }}>
        <span className="font-mono text-[10px] text-fg-muted truncate" title={item.orderId}>{item.orderId || '—'}</span>
        <span className="truncate text-fg" title={item.title}>{item.title || '—'}</span>
        <span className="text-[11px] text-warning truncate" title={item.reason}>{item.reason || '—'}</span>
      </div>
    );
  }
  return null;
}
