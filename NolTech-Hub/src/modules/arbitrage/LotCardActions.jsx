// ─── Lot Card Actions Row ────────────────────────────────────────────────────
// Single condensed action bar for a scraped lot card. Replaces the older two-
// row layout. Primary CTA (Deep Analyze) + Bid + View Listing + Star toggle +
// kebab menu containing the rest of the actions (CSVs, Compare, Notes, AI
// read, Refresh AI, Clear AI). The AI summary expansion and notes textarea
// still render in LotCard below this row — this component just provides the
// invocation surface.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowRight,
  ExternalLink,
  Files,
  FileText,
  Gavel,
  Loader2,
  MoreHorizontal,
  RotateCw,
  Sparkles,
  Star,
  Trash,
  Zap,
} from 'lucide-react';

function LotCardActions({
  // Primary
  onAnalyze,
  onQuickBid,
  onPriceLot,      // price THIS lot's manifest (per-card, on demand)
  isPricing,       // true while this lot is being priced
  // Star
  isWatched,
  onToggleWatch,
  // Kebab menu items
  url,
  onExportManifestCsv,
  onExportListingsCsv,
  showListingsCsv,
  onQuickCompare,
  onToggleNotes,
  notesOpen,
  // AI controls
  hasAiSummary,
  aiOpen,
  aiLoading,
  onShowAi,        // toggles aiOpen if cached, else fetches
  onRefreshAi,
  onClearAi,
  // Misc
  isMock,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, right: 0 });
  const btnRef = useRef(null);
  const menuRef = useRef(null);

  // The menu is portaled to <body> (fixed-positioned) so it escapes the card's
  // stacking context — otherwise the next grid card paints over it. Position
  // it under the kebab button, right-aligned.
  const openMenu = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) {
      setMenuPos({ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) });
    }
    setMenuOpen(true);
  };

  // Close on outside click (check both the trigger and the portaled menu) and
  // on scroll/resize (the fixed menu would otherwise detach from the button).
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e) => {
      if (btnRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      setMenuOpen(false);
    };
    const reposition = () => setMenuOpen(false);
    document.addEventListener('mousedown', handler);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      document.removeEventListener('mousedown', handler);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [menuOpen]);

  const closeMenu = () => setMenuOpen(false);

  const MenuItem = ({ icon: Icon, label, onClick, danger = false, disabled = false }) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        onClick?.();
        closeMenu();
      }}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
        disabled
          ? 'text-fg-subtle cursor-not-allowed'
          : danger
            ? 'text-danger hover:bg-danger-subtle'
            : 'text-fg hover:bg-muted/40'
      }`}
    >
      <Icon size={13} className="shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );

  return (
    <div className="flex items-center gap-2 pt-1 border-t border-border-subtle">
      {/* Deep Analyze — primary CTA */}
      <button
        type="button"
        onClick={onAnalyze}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-white text-xs font-semibold rounded-lg hover:bg-primary/90 transition-colors"
      >
        <ArrowRight size={12} /> Deep Analyze
      </button>

      {/* Bid — secondary */}
      {onQuickBid && (
        <button
          type="button"
          onClick={onQuickBid}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-muted text-fg text-xs rounded-lg hover:bg-muted/80 transition-colors"
        >
          <Gavel size={12} /> Bid
        </button>
      )}

      {/* View Listing — opens the source listing in a new tab */}
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 px-3 py-1.5 bg-muted text-fg text-xs rounded-lg hover:bg-muted/80 transition-colors"
          title="View source listing"
        >
          <ExternalLink size={12} /> View Listing
        </a>
      )}

      {/* Star — icon toggle */}
      {onToggleWatch && (
        <button
          type="button"
          onClick={onToggleWatch}
          className={`flex items-center justify-center w-8 h-8 rounded-lg border transition-colors ${
            isWatched
              ? 'border-warning/40 bg-warning-subtle text-warning hover:bg-warning-subtle/80'
              : 'border-border text-fg-muted hover:bg-muted/40'
          }`}
          title={isWatched ? 'Remove from Watchlist' : 'Add to Watchlist'}
        >
          <Star size={16} fill={isWatched ? 'currentColor' : 'none'} />
        </button>
      )}

      {/* Kebab menu */}
      <div className="relative">
        <button
          ref={btnRef}
          type="button"
          onClick={() => (menuOpen ? closeMenu() : openMenu())}
          className={`flex items-center justify-center w-8 h-8 rounded-lg border transition-colors ${
            menuOpen
              ? 'border-primary/40 bg-primary/10 text-primary'
              : 'border-border bg-surface text-fg-muted hover:bg-muted/40'
          }`}
          title="More actions"
        >
          <MoreHorizontal size={14} />
        </button>
        {menuOpen && createPortal(
          <div
            ref={menuRef}
            style={{ position: 'fixed', top: menuPos.top, right: menuPos.right, zIndex: 1000 }}
            className="w-48 bg-surface rounded-xl border border-border shadow-lg py-1 overflow-hidden"
          >
            {/* Price this lot's manifest individually (sold-comps + desktop
                part-out). Always re-prices on click. */}
            {onPriceLot && (
              <>
                {isPricing ? (
                  <div className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-primary">
                    <Loader2 size={13} className="animate-spin shrink-0" />
                    <span>Pricing…</span>
                  </div>
                ) : (
                  <MenuItem icon={Zap} label="Price Manifest" onClick={onPriceLot} />
                )}
                <div className="border-t border-border-subtle my-1" />
              </>
            )}
            {onExportManifestCsv && (
              <MenuItem icon={FileText} label="Manifest CSV" onClick={onExportManifestCsv} />
            )}
            {showListingsCsv && onExportListingsCsv && (
              <MenuItem icon={ExternalLink} label="Listings CSV" onClick={onExportListingsCsv} />
            )}
            {onQuickCompare && (
              <MenuItem icon={Files} label="Compare" onClick={onQuickCompare} />
            )}
            {onToggleNotes && (
              <MenuItem
                icon={FileText}
                label={notesOpen ? 'Hide Notes' : 'Notes'}
                onClick={onToggleNotes}
              />
            )}
            <div className="border-t border-border-subtle my-1" />
            {/* AI controls */}
            {aiLoading ? (
              <div className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-accent">
                <Loader2 size={13} className="animate-spin shrink-0" />
                <span>Reading…</span>
              </div>
            ) : (
              <MenuItem
                icon={Sparkles}
                label={hasAiSummary ? (aiOpen ? 'Hide AI read' : 'Show AI read') : 'AI read'}
                onClick={onShowAi}
              />
            )}
            {hasAiSummary && (
              <>
                <MenuItem icon={RotateCw} label="Refresh AI" onClick={onRefreshAi} disabled={aiLoading} />
                <MenuItem icon={Trash} label="Clear AI" onClick={onClearAi} danger />
              </>
            )}
          </div>,
          document.body
        )}
      </div>

      {/* Mock badge — pinned right */}
      {isMock && (
        <span className="text-[10px] text-fg-muted/50 ml-auto italic">mock data</span>
      )}
    </div>
  );
}

export default LotCardActions;
