// ─── Browse Lots Status Strip ─────────────────────────────────────────────
// Consolidates server health, manifest pricing progress, and data freshness
// into a single horizontal pill row. The kebab on the right opens a
// Settings popover (eBay call counter + toggles + bulk-select switch).
//
// When the server is offline this expands into a full-width red error
// banner — error states are allowed to dominate.

import { useState } from 'react';
import {
  Globe, WifiOff, Loader2, RefreshCw, MoreHorizontal,
  CheckCircle2, Database, Zap, X, Gavel,
} from 'lucide-react';

function Divider() {
  return <div className="border-l border-border mx-3 h-5" />;
}

function BrowseLotsStatusStrip({
  // server health
  serverOnline,
  hasLots,
  loading,
  onLoadMock,
  onFetchLive,
  // active bids commitment
  activeBidCount = 0,
  activeBidCeiling = 0,
  // manifest pricing
  showManifestSegment,
  enrichLoading,
  enrichDone,
  enrichErrors,
  enrichTotal,
  enrichableCount,
  unenriched,
  totalPriced,
  totalItems,
  onPrice,
  onRerun,
  onCancel,
  // freshness
  scrapedAt,
  // refresh
  onRefresh,
  // settings popover state
  ebayCallStats,
  keywordSearchEnabled,
  setKeywordSearchEnabled,
  forceFreshMode,
  setForceFreshMode,
  showComparables,
  setShowComparables,
  selectMode,
  setSelectMode,
  selectedCount,
  onClearSelection,
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);

  // ── Offline: full-width red error banner ────────────────────────────
  if (serverOnline === false) {
    return (
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 rounded-xl border bg-danger-subtle border-danger/30 text-danger text-sm mb-3">
        <WifiOff size={16} className="shrink-0" />
        <span className="font-medium">
          Cloud scraper unreachable — check Settings → Cloud Scraper URL + Token
        </span>
        <button
          onClick={onLoadMock}
          className="ml-auto text-xs font-semibold bg-surface border border-danger/30 text-danger px-3 py-1.5 rounded-lg hover:bg-danger-subtle transition-colors"
        >
          Load Mock Data
        </button>
      </div>
    );
  }

  // Freshness label
  let freshnessLabel = null;
  let freshnessStale = false;
  if (scrapedAt) {
    const minutes = Math.round((Date.now() - new Date(scrapedAt).getTime()) / 60000);
    const hours = minutes / 60;
    freshnessStale = hours >= 4;
    if (minutes < 60) freshnessLabel = `${Math.max(1, minutes)}m ago`;
    else if (hours < 24) freshnessLabel = `${Math.floor(hours)}h ago`;
    else freshnessLabel = `${Math.floor(hours / 24)}d ${Math.floor(hours % 24)}h ago`;
  }

  const isRunning = enrichLoading > 0;
  const progressPct = enrichTotal > 0 ? Math.round((enrichDone / enrichTotal) * 100) : 0;

  // ── Online or checking: pill row ────────────────────────────────────
  return (
    <div className="bg-surface rounded-xl border border-border shadow-sm px-4 py-2 mb-3 flex flex-wrap items-center gap-y-2">
      {/* Segment A — Server */}
      <div className="flex items-center gap-2 text-xs text-fg">
        {serverOnline === null && (
          <>
            <span className="w-2 h-2 rounded-full bg-warning animate-pulse" />
            <span className="text-fg-muted">Connecting…</span>
          </>
        )}
        {serverOnline === true && (
          <>
            <span className="w-2 h-2 rounded-full bg-success" />
            <span className="text-fg-muted">Server online</span>
            {!hasLots && !loading && (
              <button
                onClick={onFetchLive}
                className="ml-2 inline-flex items-center gap-1 text-xs font-semibold bg-success text-white px-2.5 py-1 rounded-lg hover:brightness-110 transition-colors"
              >
                <Globe size={11} />
                Fetch Live Lots
              </button>
            )}
          </>
        )}
      </div>

      {/* Segment B — Manifest pricing */}
      {showManifestSegment && (
        <>
          <Divider />
          <div className="flex items-center gap-2 text-xs min-w-0">
            {isRunning ? (
              <>
                <Loader2 size={13} className="animate-spin shrink-0 text-primary" />
                <span className="text-fg whitespace-nowrap">
                  Pricing manifests
                  <span className="ml-1 font-mono font-semibold text-primary">
                    {enrichDone}/{enrichTotal}
                  </span>
                </span>
                <div className="w-20 h-[1.5px] rounded-full bg-primary/15 overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
                <button
                  onClick={onCancel}
                  className="inline-flex items-center gap-1 text-xs border border-danger/30 text-danger px-2 py-0.5 rounded-md hover:bg-danger-subtle transition-colors"
                >
                  <X size={11} />
                  Cancel
                </button>
              </>
            ) : enrichDone > 0 ? (
              <>
                <CheckCircle2 size={13} className="shrink-0 text-success" />
                <span className="text-fg whitespace-nowrap">
                  Manifest pricing —{' '}
                  <span className="font-mono font-semibold">{enrichDone}</span> done
                  {totalItems > 0 && (
                    <>
                      , <span className="font-mono font-semibold">{totalPriced}/{totalItems}</span> priced
                    </>
                  )}
                  {enrichErrors > 0 && (
                    <span className="text-warning"> · {enrichErrors} failed</span>
                  )}
                </span>
                {unenriched > 0 && (
                  <button
                    onClick={onPrice}
                    className="inline-flex items-center gap-1 text-xs font-semibold bg-primary text-white px-2.5 py-1 rounded-lg hover:bg-primary/90 transition-colors"
                  >
                    <Zap size={11} />
                    Price {unenriched} Remaining
                  </button>
                )}
                <button
                  onClick={onRerun}
                  className="inline-flex items-center gap-1 text-xs border border-border text-fg-muted px-2 py-1 rounded-lg hover:bg-muted/40 transition-colors"
                >
                  <RefreshCw size={11} />
                  Re-run
                </button>
              </>
            ) : (
              <>
                <Database size={13} className="shrink-0 text-fg-muted" />
                <span className="text-fg whitespace-nowrap">
                  <span className="font-semibold">{enrichableCount}</span> lots not yet priced
                </span>
                <button
                  onClick={onPrice}
                  className="inline-flex items-center gap-1 text-xs font-semibold bg-primary text-white px-2.5 py-1 rounded-lg hover:bg-primary/90 transition-colors"
                >
                  <Zap size={11} />
                  Price Manifests
                </button>
              </>
            )}
          </div>
        </>
      )}

      {/* Segment C — Data freshness */}
      {freshnessLabel && (
        <>
          <Divider />
          <div className="flex items-center gap-2 text-xs">
            {freshnessStale && <span className="w-2 h-2 rounded-full bg-warning" />}
            <span className={freshnessStale ? 'text-warning' : 'text-fg-muted'}>
              {freshnessStale ? 'Stale — ' : 'Scraped '}
              {freshnessLabel}
            </span>
          </div>
        </>
      )}

      {/* Segment D — Active bid commitment (sums ceilings of all active bids) */}
      {activeBidCount > 0 && (
        <>
          <Divider />
          <div
            className="flex items-center gap-1.5 text-xs"
            title={`${activeBidCount} active bid${activeBidCount !== 1 ? 's' : ''}. Total exposure if every bid hit its ceiling.`}
          >
            <Gavel size={12} className="shrink-0 text-primary" />
            <span className="text-fg-muted">
              <span className="font-mono font-semibold text-fg">
                ${activeBidCeiling.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </span>
              {' '}max if all win
              <span className="text-fg-subtle"> · {activeBidCount} active</span>
            </span>
          </div>
        </>
      )}

      {/* Right edge — Refresh + kebab */}
      <div className="ml-auto flex items-center gap-2 relative">
        {hasLots && (
          <button
            onClick={onRefresh}
            className="inline-flex items-center gap-1 text-xs border border-border px-2.5 py-1 rounded-lg bg-surface text-fg-muted hover:bg-muted/40 transition-colors"
          >
            <RefreshCw size={11} />
            Refresh
          </button>
        )}
        <button
          onClick={() => setSettingsOpen((o) => !o)}
          className={`inline-flex items-center justify-center w-7 h-7 rounded-lg border transition-colors ${
            settingsOpen
              ? 'border-primary/40 bg-primary/10 text-primary'
              : 'border-border bg-surface text-fg-muted hover:bg-muted/40'
          }`}
          title="Settings"
        >
          <MoreHorizontal size={14} />
        </button>

        {settingsOpen && (
          <div className="absolute right-0 top-full mt-1 z-30 w-[280px] bg-surface rounded-xl border border-border shadow-lg p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-subtle mb-3">
              Pricing Settings
            </p>
            <div className="flex flex-col gap-3">
              {/* eBay call counter */}
              {ebayCallStats && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-fg-muted">eBay API calls today</span>
                  <span
                    className={`text-sm font-mono font-semibold ${
                      ebayCallStats.remaining < 500
                        ? 'text-danger'
                        : ebayCallStats.remaining < 2000
                          ? 'text-warning'
                          : 'text-fg'
                    }`}
                    title={`Resets midnight PT · ${ebayCallStats.date}`}
                  >
                    {ebayCallStats.calls.toLocaleString()}/{ebayCallStats.limit.toLocaleString()}
                  </span>
                </div>
              )}

              {/* Keyword search toggle */}
              <label className="flex items-center justify-between cursor-pointer select-none">
                <span className="text-xs text-fg">Keyword search</span>
                <input
                  type="checkbox"
                  checked={keywordSearchEnabled}
                  onChange={(e) => setKeywordSearchEnabled(e.target.checked)}
                  className="rounded border-border-strong text-primary focus:ring-primary/30 w-4 h-4"
                />
              </label>

              {/* Force-fresh mode toggle */}
              <label
                className="flex items-center justify-between cursor-pointer select-none"
                title="Bypass every cache layer — KV UPC cache, Supabase sold_comps, browse_lots polling, and lot_analyses hydration. Every fetch hits Bright Data live. Slow + expensive; use for verifying scraper fixes."
              >
                <span className={`text-xs ${forceFreshMode ? 'text-warning font-semibold' : 'text-fg'}`}>
                  Force fresh (skip cache)
                </span>
                <input
                  type="checkbox"
                  checked={!!forceFreshMode}
                  onChange={(e) => setForceFreshMode(e.target.checked)}
                  className="rounded border-border-strong text-warning focus:ring-warning/30 w-4 h-4"
                />
              </label>

              {/* Comparable closes toggle */}
              <label
                className="flex items-center justify-between cursor-pointer select-none"
                title="Show 'comparable closes' on each TL lot card — what similar past lots actually closed at."
              >
                <span className="text-xs text-fg">Comparable closes</span>
                <input
                  type="checkbox"
                  checked={showComparables}
                  onChange={(e) => setShowComparables(e.target.checked)}
                  className="rounded border-border-strong text-primary focus:ring-primary/30 w-4 h-4"
                />
              </label>

              {/* Bulk select toggle */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-fg">Bulk select mode</span>
                <button
                  type="button"
                  onClick={() => {
                    setSelectMode(!selectMode);
                    if (selectMode) onClearSelection?.();
                  }}
                  className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${
                    selectMode
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-fg-muted hover:bg-muted/40'
                  }`}
                >
                  {selectMode ? `On (${selectedCount})` : 'Off'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default BrowseLotsStatusStrip;
