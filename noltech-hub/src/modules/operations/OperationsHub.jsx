// ─── Operations Hub ──────────────────────────────────────────────────────────
// Centralizes the warehouse loop: Process new arrivals → Photo prep → Ship.
// Locations + Batch are lower-volume tools accessible via the secondary
// "More:" row so they don't compete with the primary flow.
//
// The Testing tab was removed because testing-status is set inline from item
// rows in Inventory rather than via the dedicated checklist screen. The
// TestingChecklist component file remains in place — any future entry-point
// (e.g., a per-row "Test" button) can revive it without changes here.
//
// Tab counts are derived from state.lots so they can't drift from the
// sub-tabs' own filters. Last-tab choice persists at noltech:operations:tab.
// Other modules can deep-link via:
//   window.dispatchEvent(new CustomEvent('ui:ops-tab', { detail: { tab } }))
// mirroring the existing 'ui:sell-tab' pattern in SellingHub.

import { useState, useEffect, useMemo, lazy, Suspense } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ClipboardCheck, Camera, Truck, MapPin, CheckSquare } from 'lucide-react';
import { viewTransition } from '../../components/ui/motion';
import { Tabs } from '../../components/ui';
import { useApp } from '../../context/AppContext';
import { hasLabel } from '../inventory/ShippingQueue';

const LotProcessor       = lazy(() => import('../inventory/LotProcessor'));
const PhotoWorkflow      = lazy(() => import('../inventory/PhotoWorkflow'));
const ShippingQueue      = lazy(() => import('../inventory/ShippingQueue'));
const InventoryLocations = lazy(() => import('../inventory/InventoryLocations'));
const BatchUpdater       = lazy(() => import('../inventory/BatchUpdater'));

const TAB_STORAGE_KEY = 'noltech:operations:tab';
const VALID_TABS = new Set(['process', 'photos', 'shipping', 'locations', 'batch']);

const SKELETON = <div className="h-64 bg-muted rounded-xl animate-pulse" />;

function countLabel(name, n) {
  return n > 0 ? `${name} (${n})` : name;
}

export default function OperationsHub() {
  const { state } = useApp();
  const [tab, setTab] = useState('process');

  // Last-tab persistence — restore on mount, save on every change.
  useEffect(() => {
    let cancelled = false;
    window.storage.get(TAB_STORAGE_KEY)
      .then((stored) => {
        if (cancelled) return;
        if (typeof stored === 'string' && VALID_TABS.has(stored)) setTab(stored);
      })
      .catch(() => { /* default tab is fine on read failure */ });
    return () => { cancelled = true; };
  }, []);

  const setTabPersisted = (next) => {
    if (!VALID_TABS.has(next)) return;
    setTab(next);
    window.storage.set(TAB_STORAGE_KEY, next).catch(() => { /* silent */ });
  };

  // Deep-link bridge — mirrors SellingHub's 'ui:sell-tab' / CommandPalette.
  useEffect(() => {
    const onUiOpsTab = (e) => {
      const next = e?.detail?.tab;
      if (typeof next === 'string' && VALID_TABS.has(next)) setTabPersisted(next);
    };
    window.addEventListener('ui:ops-tab', onUiOpsTab);
    return () => window.removeEventListener('ui:ops-tab', onUiOpsTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Counts pulled from state.lots so tab badges reflect actual backlog.
  //   processLots — every lot in 'received' or 'processing' state. Note this
  //     counts the TOTAL backlog; the per-device hidden-lots set
  //     (noltech:operations:hidden-lots) is intentionally NOT subtracted
  //     since hiding is a personal UI preference, not a completion signal.
  //   shipPending — uses ShippingQueue's exported hasLabel() helper so this
  //     badge stays physically in sync with that view's Pending filter and
  //     cannot drift if the shipping definition changes.
  const counts = useMemo(() => {
    let processLots = 0, shipPending = 0;
    for (const lot of state.lots || []) {
      if (lot.status === 'received' || lot.status === 'processing') processLots++;
      for (const item of (lot.items || [])) {
        if (item.status === 'sold' && item.sale && !hasLabel(item)) shipPending++;
      }
    }
    return { processLots, shipPending };
  }, [state.lots]);

  const PRIMARY_TABS = useMemo(() => ([
    { id: 'process',  label: countLabel('Process',  counts.processLots), icon: ClipboardCheck },
    { id: 'photos',   label: 'Photos',                                   icon: Camera },
    { id: 'shipping', label: countLabel('Shipping', counts.shipPending), icon: Truck },
  ]), [counts]);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h1 className="text-xl md:text-2xl font-semibold text-fg tracking-tight">Operations</h1>
          <p className="text-xs text-fg-muted hidden md:block">
            Receive, prep, and ship inventory
          </p>
        </div>
        <Tabs items={PRIMARY_TABS} value={tab} onChange={setTabPersisted} size="sm" />
      </div>

      {/* Secondary row — lower-volume tools, intentionally de-emphasized. */}
      <div className="mb-3 flex items-center gap-1.5 text-xs">
        <span className="text-fg-subtle">More:</span>
        <SecondaryLink
          active={tab === 'locations'}
          onClick={() => setTabPersisted('locations')}
          icon={MapPin}
          label="Locations"
        />
        <span className="text-fg-subtle">·</span>
        <SecondaryLink
          active={tab === 'batch'}
          onClick={() => setTabPersisted('batch')}
          icon={CheckSquare}
          label="Batch"
        />
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={tab} {...viewTransition}>
          <Suspense fallback={SKELETON}>
            {tab === 'process'   && <LotProcessor />}
            {tab === 'photos'    && <PhotoWorkflow />}
            {tab === 'shipping'  && <ShippingQueue />}
            {tab === 'locations' && <InventoryLocations />}
            {tab === 'batch'     && <BatchUpdater />}
          </Suspense>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function SecondaryLink({ active, onClick, icon: Icon, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 px-2 py-1 rounded transition-colors ${
        active
          ? 'text-fg bg-muted'
          : 'text-fg-muted hover:text-fg hover:bg-muted/60'
      }`}
    >
      <Icon className="w-3 h-3" />
      {label}
    </button>
  );
}
