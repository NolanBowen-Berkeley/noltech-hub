import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Search, X, Package, List, Barcode, Gavel, ShoppingCart, BookOpen,
  CornerDownLeft, ArrowUp, ArrowDown,
} from 'lucide-react';
import { useApp } from '../context/AppContext';

const MAX_PER_CATEGORY = 5;

const CATEGORY_META = {
  items:        { label: 'Items',        icon: List,         color: 'var(--accent)' },
  lots:         { label: 'Lots',         icon: Package,      color: 'var(--accent)' },
  upcs:         { label: 'UPCs',         icon: Barcode,      color: 'var(--accent-hover)' },
  bids:         { label: 'Bids',         icon: Gavel,        color: 'var(--warning)' },
  browseLots:   { label: 'Browse Lots',  icon: ShoppingCart,  color: 'var(--success)' },
  transactions: { label: 'Transactions', icon: BookOpen,      color: 'var(--danger)' },
};

// Navigation targets by result type
const NAV_MAP = {
  items:        'inventory',
  lots:         'inventory',
  upcs:         'source',
  bids:         'bidding',
  browseLots:   'source',
  transactions: 'finance',
};

// ── Load external storage data ──────────────────────────────────────────────
function useSearchData() {
  const { state } = useApp();
  const [upcCache, setUpcCache] = useState({});
  const [bids, setBids] = useState([]);
  const [lotNotes, setLotNotes] = useState({});
  const [browseLots, setBrowseLots] = useState([]);
  const [transactions, setTransactions] = useState([]);

  useEffect(() => {
    Promise.all([
      window.storage.get('noltech:arbitrage:upc-cache').catch(() => ({})),
      window.storage.get('noltech:arbitrage:bids').catch(() => []),
      window.storage.get('noltech:arbitrage:lot-notes').catch(() => ({})),
      window.storage.get('noltech:arbitrage:browse-lots').catch(() => null),
      window.storage.get('noltech:books:transactions').catch(() => []),
    ]).then(([upc, b, notes, bl, txns]) => {
      setUpcCache(upc && typeof upc === 'object' && !Array.isArray(upc) ? upc : {});
      setBids(Array.isArray(b) ? b : []);
      setLotNotes(notes && typeof notes === 'object' ? notes : {});
      const lots = bl && typeof bl === 'object' && Array.isArray(bl.lots) ? bl.lots : (Array.isArray(bl) ? bl : []);
      setBrowseLots(lots);
      setTransactions(Array.isArray(txns) ? txns : []);
    });
  }, []);

  return { lots: state.lots, upcCache, bids, lotNotes, browseLots, transactions };
}

// ── Search engine ───────────────────────────────────────────────────────────
function searchAll(query, data) {
  if (!query || query.trim().length === 0) return {};
  const q = query.toLowerCase().trim();
  const results = {};

  // Items: match by model, brand, serialNumber, sku, eBay order ID, buyer name
  const allItems = data.lots.flatMap((l) =>
    (l.items || []).map((i) => ({ ...i, _lotName: l.sourceName || l.source || l.id })),
  );
  const matchedItems = allItems.filter((i) =>
    [i.model, i.brand, i.serialNumber, i.sku, i.notes, i.sale?.id, i.sale?.buyerName].some(
      (f) => f && String(f).toLowerCase().includes(q),
    ),
  );
  if (matchedItems.length > 0) {
    results.items = {
      total: matchedItems.length,
      results: matchedItems.slice(0, MAX_PER_CATEGORY).map((i) => {
        // When the query matches a sale's order ID or buyer, show that in the
        // subtitle so the result is unambiguous (otherwise an order-ID search
        // looks identical to a model-name search).
        const matchedOrder = i.sale?.id && String(i.sale.id).toLowerCase().includes(q);
        const matchedBuyer = i.sale?.buyerName && i.sale.buyerName.toLowerCase().includes(q);
        const saleSuffix = matchedOrder
          ? ` · order ${i.sale.id}`
          : matchedBuyer
            ? ` · sold to ${i.sale.buyerName}`
            : '';
        return {
          id: i.id,
          title: [i.brand, i.model].filter(Boolean).join(' ') || i.sku || 'Unknown Item',
          subtitle: `${i._lotName} · ${i.status || 'unknown'}${saleSuffix}`,
          context: { itemId: i.id, lotId: i.lotId },
        };
      }),
    };
  }

  // Lots: match by sourceName, source, id
  const matchedLots = data.lots.filter((l) =>
    [l.sourceName, l.source, l.id, l.notes].some(
      (f) => f && f.toLowerCase().includes(q),
    ),
  );
  if (matchedLots.length > 0) {
    results.lots = {
      total: matchedLots.length,
      results: matchedLots.slice(0, MAX_PER_CATEGORY).map((l) => ({
        id: l.id,
        title: l.sourceName || l.source || l.id,
        subtitle: `${l.status || ''} · ${(l.items || []).length} items · $${(l.cost || 0).toFixed(2)}`,
        context: { lotId: l.id },
      })),
    };
  }

  // UPCs: match by UPC code or title
  const upcEntries = Object.entries(data.upcCache);
  const matchedUpcs = upcEntries.filter(([code, val]) => {
    const title = typeof val === 'object' ? (val.title || val.name || '') : String(val);
    return code.toLowerCase().includes(q) || title.toLowerCase().includes(q);
  });
  if (matchedUpcs.length > 0) {
    results.upcs = {
      total: matchedUpcs.length,
      results: matchedUpcs.slice(0, MAX_PER_CATEGORY).map(([code, val]) => {
        const title = typeof val === 'object' ? (val.title || val.name || code) : code;
        const price = typeof val === 'object' ? (val.price || val.avgPrice) : val;
        return {
          id: code,
          title: title,
          subtitle: price != null ? `UPC: ${code} · $${Number(price).toFixed(2)}` : `UPC: ${code}`,
          context: { upc: code },
        };
      }),
    };
  }

  // Bids: match by lotTitle
  const matchedBids = data.bids.filter((b) =>
    [b.lotTitle, b.title, b.source, b.notes].some(
      (f) => f && f.toLowerCase().includes(q),
    ),
  );
  if (matchedBids.length > 0) {
    results.bids = {
      total: matchedBids.length,
      results: matchedBids.slice(0, MAX_PER_CATEGORY).map((b) => ({
        id: b.id || b.lotTitle,
        title: b.lotTitle || b.title || 'Bid',
        subtitle: `${b.status || b.won ? 'won' : 'pending'} · $${(b.amount || b.bidAmount || 0).toFixed(2)}`,
        context: { bidId: b.id },
      })),
    };
  }

  // Browse Lots: match by title
  const matchedBrowse = data.browseLots.filter((l) =>
    [l.title, l.category, l.source].some(
      (f) => f && f.toLowerCase().includes(q),
    ),
  );
  if (matchedBrowse.length > 0) {
    results.browseLots = {
      total: matchedBrowse.length,
      results: matchedBrowse.slice(0, MAX_PER_CATEGORY).map((l) => ({
        id: l.id || l.url || l.title,
        title: l.title || 'Untitled Lot',
        subtitle: [l.source, l.currentBid != null ? `$${l.currentBid}` : null, l.category].filter(Boolean).join(' · '),
        context: { lotUrl: l.url, browseLotId: l.id },
      })),
    };
  }

  // Transactions: match by description, category, notes
  const matchedTxns = (data.transactions || []).filter((t) =>
    [t.description, t.category, t.notes, t.supplier].some(
      (f) => f && f.toLowerCase().includes(q),
    ),
  );
  if (matchedTxns.length > 0) {
    results.transactions = {
      total: matchedTxns.length,
      results: matchedTxns.slice(0, MAX_PER_CATEGORY).map((t) => ({
        id: t.id || t.date,
        title: t.description || t.category || 'Transaction',
        subtitle: `${t.type === 'income' ? '+' : '-'}$${Math.abs(t.amount || 0).toFixed(2)} · ${t.category || ''} · ${t.date || ''}`,
        context: { transactionId: t.id },
      })),
    };
  }

  return results;
}

// ── Flatten results for keyboard navigation ─────────────────────────────────
function flattenResults(grouped) {
  const flat = [];
  for (const [category, { results }] of Object.entries(grouped)) {
    for (const result of results) {
      flat.push({ ...result, category });
    }
  }
  return flat;
}

// ── Main component ──────────────────────────────────────────────────────────
export default function GlobalSearch({ onNavigate, onClose }) {
  const [query, setQuery] = useState('');
  const [recentSearches, setRecentSearches] = useState([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const data = useSearchData();

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Global "/" shortcut — handled by parent, but also close on Escape
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const grouped = useMemo(() => searchAll(query, data), [query, data]);
  const flat = useMemo(() => flattenResults(grouped), [grouped]);
  const totalResults = Object.values(grouped).reduce((s, g) => s + g.total, 0);

  // Reset active index when results change
  useEffect(() => {
    setActiveIndex(flat.length > 0 ? 0 : -1);
  }, [flat.length, query]);

  const navigate = useCallback(
    (item) => {
      // Track recent search
      if (query.trim()) {
        setRecentSearches((prev) => {
          const next = [query.trim(), ...prev.filter((s) => s !== query.trim())].slice(0, 10);
          return next;
        });
      }
      const view = NAV_MAP[item.category] || 'dashboard';
      onNavigate(view, item.context);
      onClose();
    },
    [query, onNavigate, onClose],
  );

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((prev) => (prev < flat.length - 1 ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((prev) => (prev > 0 ? prev - 1 : flat.length - 1));
    } else if (e.key === 'Enter' && activeIndex >= 0 && flat[activeIndex]) {
      e.preventDefault();
      navigate(flat[activeIndex]);
    }
  };

  // Scroll active item into view
  useEffect(() => {
    if (activeIndex < 0 || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-idx="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-black/40" onClick={onClose}>
      <div
        className="bg-surface rounded-2xl shadow-2xl w-full max-w-xl mx-4 max-h-[70vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border-subtle">
          <Search size={18} className="text-fg-subtle shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search items, lots, UPCs, bids..."
            className="flex-1 text-sm text-fg placeholder:text-fg-subtle outline-none bg-transparent"
            autoComplete="off"
            spellCheck={false}
          />
          {query && (
            <button onClick={() => setQuery('')} className="p-1 hover:bg-muted rounded">
              <X size={14} className="text-fg-subtle" />
            </button>
          )}
          <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono text-fg-subtle bg-muted border border-border rounded">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="flex-1 overflow-y-auto">
          {/* No query — show recent searches or hint */}
          {!query.trim() && (
            <div className="p-5">
              {recentSearches.length > 0 ? (
                <>
                  <p className="text-[10px] font-semibold text-fg-subtle uppercase tracking-wider mb-2">Recent</p>
                  <div className="space-y-1">
                    {recentSearches.map((s, i) => (
                      <button
                        key={i}
                        onClick={() => setQuery(s)}
                        className="flex items-center gap-2 w-full px-3 py-2 text-sm text-fg-muted hover:bg-muted/40 rounded-lg text-left transition-colors"
                      >
                        <Search size={13} className="text-border-strong" />
                        {s}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-sm text-fg-subtle text-center py-8">
                  Type to search across all modules
                </p>
              )}
            </div>
          )}

          {/* Has query but no results */}
          {query.trim() && flat.length === 0 && (
            <div className="p-8 text-center">
              <Search size={28} className="mx-auto text-border mb-3" />
              <p className="text-sm text-fg-subtle">No results for "{query}"</p>
              <p className="text-xs text-border-strong mt-1">Try a different search term</p>
            </div>
          )}

          {/* Grouped results */}
          {query.trim() && Object.entries(grouped).map(([category, { total, results }]) => {
            const meta = CATEGORY_META[category];
            if (!meta) return null;
            const Icon = meta.icon;

            return (
              <div key={category} className="py-2">
                <div className="flex items-center justify-between px-5 py-1.5">
                  <div className="flex items-center gap-1.5">
                    <Icon size={12} style={{ color: meta.color }} />
                    <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: meta.color }}>
                      {meta.label}
                    </span>
                  </div>
                  {total > MAX_PER_CATEGORY && (
                    <span className="text-[10px] text-fg-subtle">
                      {total} total
                    </span>
                  )}
                </div>

                {results.map((result) => {
                  const globalIdx = flat.findIndex(
                    (f) => f.id === result.id && f.category === category,
                  );
                  const isActive = globalIdx === activeIndex;

                  return (
                    <button
                      key={`${category}-${result.id}`}
                      data-idx={globalIdx}
                      onClick={() => navigate({ ...result, category })}
                      onMouseEnter={() => setActiveIndex(globalIdx)}
                      className={`flex items-center gap-3 w-full px-5 py-2.5 text-left transition-colors ${
                        isActive ? 'bg-muted' : 'hover:bg-muted/40'
                      }`}
                    >
                      <div
                        className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                        style={{ backgroundColor: `color-mix(in srgb, ${meta.color} 10%, transparent)` }}
                      >
                        <Icon size={13} style={{ color: meta.color }} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-fg truncate">{result.title}</p>
                        <p className="text-[11px] text-fg-subtle truncate">{result.subtitle}</p>
                      </div>
                      {isActive && (
                        <CornerDownLeft size={13} className="text-border-strong shrink-0" />
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Footer hints */}
        {flat.length > 0 && (
          <div className="flex items-center gap-4 px-5 py-2.5 border-t border-border-subtle bg-muted/40/50">
            <div className="flex items-center gap-1 text-[10px] text-fg-subtle">
              <ArrowUp size={10} />
              <ArrowDown size={10} />
              <span>navigate</span>
            </div>
            <div className="flex items-center gap-1 text-[10px] text-fg-subtle">
              <CornerDownLeft size={10} />
              <span>select</span>
            </div>
            <div className="flex items-center gap-1 text-[10px] text-fg-subtle">
              <kbd className="px-1 py-0.5 font-mono bg-muted border border-border rounded text-[9px]">esc</kbd>
              <span>close</span>
            </div>
            <span className="ml-auto text-[10px] text-fg-subtle">{totalResults} result{totalResults !== 1 ? 's' : ''}</span>
          </div>
        )}
      </div>
    </div>
  );
}
