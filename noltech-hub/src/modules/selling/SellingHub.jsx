import { useState, useEffect, lazy, Suspense } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { RefreshCw, TrendingDown, FileText, Handshake, Clock } from 'lucide-react';
import { viewTransition } from '../../components/ui/motion';
import { Tabs } from '../../components/ui';
const ListingGenerator       = lazy(() => import('../arbitrage/ListingGenerator'));
const PriceReductor          = lazy(() => import('../price-reductor/PriceReductor'));
const AutoRelist             = lazy(() => import('../inventory/AutoRelist'));
const OfferManagement        = lazy(() => import('./OfferManagement'));
const ListingAgingDashboard  = lazy(() => import('./ListingAgingDashboard'));

const TAB_ITEMS = [
  { id: 'listgen',     label: 'Listing Generator', icon: FileText },
  { id: 'aging',       label: 'Aging',             icon: Clock },
  { id: 'offers',      label: 'Offers',            icon: Handshake },
  { id: 'pricer',      label: 'Price Reductor',    icon: TrendingDown },
  { id: 'auto-relist', label: 'Auto Relist',       icon: RefreshCw },
];

const SKELETON = <div className="h-64 bg-muted rounded-xl animate-pulse" />;

export default function SellingHub() {
  const [tab, setTab] = useState('listgen');

  useEffect(() => {
    const h = (e) => {
      const next = e?.detail?.tab;
      if (next && TAB_ITEMS.some((t) => t.id === next)) setTab(next);
    };
    window.addEventListener('ui:sell-tab', h);
    return () => window.removeEventListener('ui:sell-tab', h);
  }, []);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h1 className="text-xl md:text-2xl font-semibold text-fg tracking-tight">Sell</h1>
          <p className="text-xs text-fg-muted hidden md:block">List items, manage offers, reduce stale prices, and auto-relist</p>
        </div>
        <Tabs items={TAB_ITEMS} value={tab} onChange={setTab} size="sm" />
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={tab} {...viewTransition}>
          <Suspense fallback={SKELETON}>
            {tab === 'listgen'     && <ListingGenerator />}
            {tab === 'aging'       && <ListingAgingDashboard />}
            {tab === 'offers'      && <OfferManagement />}
            {tab === 'pricer'      && <PriceReductor />}
            {tab === 'auto-relist' && <AutoRelist />}
          </Suspense>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
