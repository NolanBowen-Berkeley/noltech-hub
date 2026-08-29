import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  PackagePlus,
  CheckCircle2,
  Trophy,
  Package,
  AlertTriangle,
  Loader2,
  ExternalLink,
  FileText,
  XCircle,
  X,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import eventBus from '../../services/eventBus';
import { fmt, formatDate, parseQuantity } from '../../utils/formatters';

// ─── Constants ──────────────────────────────────────────────────────────────

const KEY_BROWSE    = 'noltech:arbitrage:browse-lots';
const KEY_BIDS      = 'noltech:arbitrage:bids';
const KEY_IMPORTED  = 'noltech:arbitrage:imported-lots';

// ─── Helpers ────────────────────────────────────────────────────────────────

// ─── Skeleton ───────────────────────────────────────────────────────────────

function Skeleton({ className = '' }) {
  return <div className={`animate-pulse bg-muted rounded ${className}`} />;
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function WonLotImporter() {
  const { dispatch } = useApp();

  const [bids, setBids] = useState([]);
  const [browseLots, setBrowseLots] = useState([]);
  const [enrichments, setEnrichments] = useState({});
  const [importedLotIds, setImportedLotIds] = useState(new Set());
  const [wonManifests, setWonManifests] = useState({}); // permanent manifest backup
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [importing, setImporting] = useState(null); // bid id currently importing

  // ── Load data ───────────────────────────────────────────────────────────

  useEffect(() => {
    (async () => {
      try {
        const [bidData, browseData, importedData, savedManifests] = await Promise.all([
          window.storage.get(KEY_BIDS),
          window.storage.get(KEY_BROWSE),
          window.storage.get(KEY_IMPORTED),
          window.storage.get('noltech:arbitrage:won-manifests'),
        ]);

        setBids(Array.isArray(bidData) ? bidData : []);

        if (browseData?.lots) {
          setBrowseLots(browseData.lots);
          setEnrichments(browseData.enrichments || {});
        }

        if (Array.isArray(importedData)) {
          setImportedLotIds(new Set(importedData));
        }

        if (savedManifests && typeof savedManifests === 'object') {
          setWonManifests(savedManifests);
        }
      } catch (err) {
        console.error('WonLotImporter load error:', err);
        setError("Couldn't load data. Refresh and try again.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // ── Won bids with manifest data ─────────────────────────────────────────

  const wonBidsWithManifest = useMemo(() => {
    const wonBids = bids.filter(b => b.status === 'won');

    return wonBids.map(bid => {
      // Match bid to a browse lot — strict matching only
      let lot = null;
      let enrichment = null;

      // 1. Exact lotId match (from quick bid button)
      if (bid.lotId) {
        lot = browseLots.find(l => l.id === bid.lotId);
      }

      // 2. Exact URL match (most reliable fallback)
      if (!lot && bid.lotUrl) {
        lot = browseLots.find(l => l.url && l.url === bid.lotUrl);
      }

      // 3. Strict title match — must match at least 80% of the title
      if (!lot) {
        const bidTitle = (bid.lotTitle || '').toLowerCase().trim();
        if (bidTitle.length > 20) {
          lot = browseLots.find(l => {
            const lt = (l.title || '').toLowerCase().trim();
            if (!lt || lt.length < 15) return false;
            // Exact match
            if (lt === bidTitle) return true;
            // One fully contains the other AND they share at least 80% length
            const shorter = Math.min(lt.length, bidTitle.length);
            const longer = Math.max(lt.length, bidTitle.length);
            if (shorter / longer < 0.8) return false;
            return lt.includes(bidTitle) || bidTitle.includes(lt);
          });
        }
      }

      if (lot) {
        enrichment = enrichments[lot.id] || null;
      }

      // 4. Fallback: check permanently saved won-manifests (survives rescrapes)
      if (!enrichment && bid.lotId && wonManifests[bid.lotId]) {
        const saved = wonManifests[bid.lotId];
        enrichment = saved.enrichment || null;
        if (!lot && saved.lot) lot = saved.lot;
      }

      const manifestItems = enrichment?.status === 'done' ? (enrichment.manifestItems || []) : [];
      const hasManifest = manifestItems.length > 0;
      const isImported = importedLotIds.has(bid.id);

      return { bid, lot, enrichment, manifestItems, hasManifest, isImported };
    }).sort((a, b) => {
      // Importable first, then already imported, then no manifest
      if (a.hasManifest && !a.isImported && !(b.hasManifest && !b.isImported)) return -1;
      if (b.hasManifest && !b.isImported && !(a.hasManifest && !a.isImported)) return 1;
      if (a.isImported && !b.isImported) return 1;
      if (b.isImported && !a.isImported) return -1;
      return new Date(b.bid.bidDate) - new Date(a.bid.bidDate);
    });
  }, [bids, browseLots, enrichments, importedLotIds]);

  // ── Import handler ──────────────────────────────────────────────────────

  const handleImport = useCallback(async (entry) => {
    const { bid, manifestItems } = entry;
    const lot = entry.lot;
    setImporting(bid.id);

    try {
      const lotId = crypto.randomUUID();
      const source = (bid.source || lot?.source || '').toLowerCase();
      const sourceType = source.includes('techliq') ? 'techliquidators' : source.includes('liquidation') ? 'liquidation.com' : 'other';
      const wonPrice = bid.wonPrice || bid.bidAmount || 0;
      const hasManifest = manifestItems && manifestItems.length > 0;
      const totalManifestItems = hasManifest ? manifestItems.reduce((n, item) => n + (item.qty || 1), 0) : (parseQuantity(lot?.quantity) || 1);

      // Create the inventory lot
      const inventoryLot = {
        id: lotId,
        source: sourceType,
        sourceName: bid.source || lot?.source || sourceType,
        purchaseDate: (bid.bidDate || new Date().toISOString()).slice(0, 10),
        cost: wonPrice,
        itemCount: totalManifestItems,
        status: 'received',
        notes: `Imported from Arbitrage Scanner — ${bid.lotTitle}${!hasManifest ? ' (no manifest — add items manually)' : ''}`,
        manifest: '',
        items: [],
      };

      // Tag the dispatch so useEventBridge can label the auto-created
       // Cost of Goods (Lots) bookkeeping row as "from Won Lot Importer".
       dispatch({ type: 'ADD_LOT', lot: inventoryLot, _origin: 'won_importer' });

      if (hasManifest) {
        // Create inventory items from manifest
        const costPerItem = totalManifestItems > 0 ? wonPrice / totalManifestItems : 0;

        for (const mItem of manifestItems) {
          const qty = mItem.qty || 1;
          for (let q = 0; q < qty; q++) {
            const item = {
              id: crypto.randomUUID(),
              lotId,
              brand: mItem.brand || '',
              model: mItem.ebayTitle || mItem.title || '',
              category: 'other',
              serialNumber: '',
              upc: mItem.upc || '',
              conditionOnArrival: null,
              conditionGrade: null,
              status: 'received',
              disposition: null,
              testResults: [],
              repairDecision: null,
              listing: null,
              sale: null,
              photos: [],
              notes: '',
              listingPrice: mItem.avgPrice || 0,
              costBasis: costPerItem,
              estimatedValue: mItem.avgPrice || 0,
              priceSource: mItem.priceSource || '',
            };
            dispatch({ type: 'ADD_ITEM', item });
          }
        }
      }

      // Track as imported
      const next = new Set(importedLotIds);
      next.add(bid.id);
      setImportedLotIds(next);
      await window.storage.set(KEY_IMPORTED, [...next]);

      // Emit event after successful import
      eventBus.emit('lot:imported', { lotId, bidId: bid.id, itemCount: totalManifestItems, cost: wonPrice });
    } catch (err) {
      console.error('Import error:', err);
      setError(`Couldn't import "${bid.lotTitle}". Try again.`);
    } finally {
      setImporting(null);
    }
  }, [dispatch, importedLotIds]);

  // ── Loading skeleton ────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64 rounded-lg" />
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  // ── Error state ─────────────────────────────────────────────────────────

  if (error && wonBidsWithManifest.length === 0) {
    return (
      <div className="bg-danger-subtle border border-danger/30 rounded-xl p-6 text-center">
        <XCircle className="mx-auto mb-2 text-danger" size={32} />
        <p className="text-danger font-semibold">{error}</p>
        <button
          onClick={() => window.location.reload()}
          className="mt-3 px-4 py-2 bg-danger text-white rounded-lg text-sm hover:opacity-90"
        >
          Refresh
        </button>
      </div>
    );
  }

  // ── Stats ───────────────────────────────────────────────────────────────

  const totalWon = wonBidsWithManifest.length;
  const withManifest = wonBidsWithManifest.filter(e => e.hasManifest).length;
  const alreadyImported = wonBidsWithManifest.filter(e => e.isImported).length;
  const readyToImport = wonBidsWithManifest.filter(e => e.hasManifest && !e.isImported).length;

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      {/* Inline error banner */}
      {error && (
        <div className="flex items-center gap-2 bg-danger-subtle border border-danger/30 text-danger rounded-lg px-4 py-2 text-sm">
          <XCircle size={16} /> {error}
          <button onClick={() => setError(null)} className="ml-auto"><X size={14} /></button>
        </div>
      )}

      {/* Header */}
      <div>
        <h3 className="text-lg font-bold text-fg flex items-center gap-2">
          <PackagePlus size={20} className="text-primary" />
          Import Won Lots to Inventory
        </h3>
        <p className="text-sm text-fg-muted mt-1">
          One-click import of won auction lots with manifest data into the Inventory system.
        </p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={Trophy} label="Won Bids" value={totalWon} />
        <StatCard icon={FileText} label="With Manifest" value={withManifest} />
        <StatCard icon={PackagePlus} label="Ready to Import" value={readyToImport} color="text-secondary" />
        <StatCard icon={CheckCircle2} label="Already Imported" value={alreadyImported} color="text-success" />
      </div>

      {/* Won bids list */}
      {wonBidsWithManifest.length === 0 ? (
        <div className="bg-surface rounded-xl border border-border shadow-sm p-12 text-center">
          <Trophy className="mx-auto mb-3 text-border-strong" size={48} />
          <p className="text-fg font-semibold text-lg mb-1">No won bids found</p>
          <p className="text-fg-muted text-sm">
            Win some auctions in the Bid Tracker first, then come back here to import them.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {wonBidsWithManifest.map(entry => {
            const { bid, lot, manifestItems, hasManifest, isImported } = entry;
            const isImporting = importing === bid.id;
            const totalItems = manifestItems.reduce((n, item) => n + (item.qty || 1), 0);
            const estResale = entry.enrichment?.totals?.estResale || 0;

            return (
              <div
                key={bid.id}
                className={`bg-surface rounded-xl border shadow-sm p-4 sm:p-5 transition-colors ${
                  isImported ? 'border-success/30 bg-success-subtle/30' : 'border-border'
                }`}
              >
                <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                  {/* Lot info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h4 className="font-semibold text-fg text-sm truncate">
                        {bid.lotTitle}
                      </h4>
                      {bid.lotUrl && (
                        <a
                          href={bid.lotUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-fg-muted hover:text-secondary flex-shrink-0"
                        >
                          <ExternalLink size={14} />
                        </a>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
                      <span className="inline-flex items-center px-2 py-0.5 rounded bg-muted text-fg-muted font-medium">
                        {bid.source}
                      </span>
                      <span>Won: <span className="font-mono font-semibold text-fg">{fmt(bid.wonPrice)}</span></span>
                      <span>Date: {formatDate(bid.bidDate)}</span>
                      {hasManifest && (
                        <>
                          <span className="flex items-center gap-1">
                            <Package size={12} />
                            {totalItems} item{totalItems !== 1 ? 's' : ''}
                          </span>
                          {estResale > 0 && (
                            <span>
                              Est. Resale: <span className="font-mono font-semibold text-success">{fmt(estResale)}</span>
                            </span>
                          )}
                        </>
                      )}
                    </div>

                    {!hasManifest && (
                      <p className="text-xs text-warning flex items-center gap-1 mt-1.5">
                        <AlertTriangle size={12} />
                        No manifest data — lot will be imported empty (add items manually in Inventory)
                      </p>
                    )}
                  </div>

                  {/* Action button */}
                  <div className="flex-shrink-0">
                    {isImported ? (
                      <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-success-subtle text-success">
                        <CheckCircle2 size={14} />
                        Imported
                      </span>
                    ) : (
                      <button
                        onClick={() => handleImport(entry)}
                        disabled={isImporting}
                        className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${
                          hasManifest
                            ? 'bg-primary text-white hover:bg-primary/90'
                            : 'border border-border text-fg-muted hover:bg-muted/40'
                        }`}
                      >
                        {isImporting ? (
                          <>
                            <Loader2 size={14} className="animate-spin" />
                            Importing...
                          </>
                        ) : (
                          <>
                            <PackagePlus size={14} />
                            {hasManifest ? 'Import to Inventory' : 'Import (Empty Lot)'}
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>

                {/* Manifest preview for importable lots */}
                {hasManifest && !isImported && manifestItems.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-border-subtle">
                    <p className="text-[10px] font-semibold text-fg-muted uppercase tracking-wide mb-1.5">
                      Manifest Preview ({totalItems} items)
                    </p>
                    <div className="max-h-28 overflow-y-auto rounded-lg border border-border-subtle divide-y divide-border bg-surface text-[11px]">
                      {manifestItems.slice(0, 10).map((item, i) => (
                        <div key={`${item.upc}-${i}`} className="flex items-center gap-2 px-2.5 py-1.5">
                          <span className="font-mono text-fg-muted w-[80px] shrink-0 truncate" title={item.upc}>
                            {item.upc || '\u2014'}
                          </span>
                          <span className="flex-1 truncate text-fg">
                            {item.ebayTitle || item.title || <span className="italic text-fg-muted">Unknown</span>}
                          </span>
                          {item.qty > 1 && <span className="text-fg-muted shrink-0">&times;{item.qty}</span>}
                          {item.avgPrice != null ? (
                            <span className="font-mono font-semibold text-success shrink-0">
                              ${item.avgPrice.toFixed(2)}
                            </span>
                          ) : (
                            <span className="text-fg-muted italic shrink-0">N/A</span>
                          )}
                        </div>
                      ))}
                      {manifestItems.length > 10 && (
                        <div className="px-2.5 py-1 text-fg-muted text-center italic">
                          +{manifestItems.length - 10} more items
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, color = 'text-fg' }) {
  return (
    <div className="bg-surface rounded-xl border border-border shadow-sm p-4">
      <div className="flex items-center gap-2 text-fg-muted text-xs font-medium mb-1">
        <Icon size={14} />
        {label}
      </div>
      <div className={`text-lg font-bold ${color}`}>{value}</div>
    </div>
  );
}
