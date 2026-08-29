// ─── Inventory Hub ────────────────────────────────────────────────────────────
// Primary tabs: Lots, Items. Everything else is a button in the top-right that
// opens an overlay (Process, Testing, eBay Sync, Shipping, Returns, Operations).

import { useState, useEffect, lazy, Suspense } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Package, List, ShoppingCart, Undo2,
} from 'lucide-react';
import { viewTransition } from '../../components/ui/motion';
import { Tabs, Button, Modal } from '../../components/ui';
import LotManager from './LotManager';
import ItemManager from './ItemManager';

const EbayOrderSync     = lazy(() => import('./EbayOrderSync'));
const ReturnsManager    = lazy(() => import('./ReturnsManager'));

const TAB_ITEMS = [
  { id: 'lots',  label: 'Lots',  icon: Package },
  { id: 'items', label: 'Items', icon: List },
];

const SKELETON = <div className="h-64 bg-muted rounded-xl animate-pulse" />;

const RETURNS_KEY  = 'noltech:returns:cases';

export default function InventoryHub({ filters, setFilters, clearFilters }) {
  const [tab, setTab] = useState('lots');
  const [modal, setModal] = useState(null); // 'ebay' | 'returns'

  // Lightweight count badges for button labels
  const [returnsOpen, setReturnsOpen] = useState(0);

  useEffect(() => {
    window.storage.get(RETURNS_KEY).then((v) => {
      const activeStatuses = new Set(['opened', 'in_transit', 'received']);
      const count = (Array.isArray(v) ? v : []).filter((c) => activeStatuses.has(c.status)).length;
      setReturnsOpen(count);
    }).catch(e => console.error('[inventory hub] storage error:', e));
  }, [modal]);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h1 className="text-xl md:text-2xl font-semibold text-fg tracking-tight">Inventory</h1>
          <p className="text-xs text-fg-muted hidden md:block">Manage lots and items</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Tabs items={TAB_ITEMS} value={tab} onChange={setTab} size="sm" />
          <span className="h-5 w-px bg-border mx-1 hidden md:block" />
          <Button variant="secondary" size="sm" onClick={() => setModal('ebay')}>
            <ShoppingCart /> eBay Sync
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setModal('returns')}>
            <Undo2 /> Returns
            {returnsOpen > 0 && <span className="text-[10px] bg-warning-subtle text-warning-fg px-1.5 rounded-md">{returnsOpen}</span>}
          </Button>
        </div>
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={tab} {...viewTransition}>
          {tab === 'lots' && <LotManager />}
          {tab === 'items' && <ItemManager filters={filters} setFilters={setFilters} clearFilters={clearFilters} />}
        </motion.div>
      </AnimatePresence>

      {/* Secondary views as modals — Process / Testing / Workflow / Shipping
          moved to the top-level Operations module. */}
      <Modal open={modal === 'ebay'} onClose={() => setModal(null)} size="2xl"
        title="eBay Order Sync" subtitle="Pull recent orders and match them to inventory">
        <Suspense fallback={SKELETON}><EbayOrderSync /></Suspense>
      </Modal>

      <Modal open={modal === 'returns'} onClose={() => setModal(null)} size="2xl"
        title="Returns" subtitle="Track buyer returns through refund + disposition">
        <Suspense fallback={SKELETON}><ReturnsManager /></Suspense>
      </Modal>
    </div>
  );
}
