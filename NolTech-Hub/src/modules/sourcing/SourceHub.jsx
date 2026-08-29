// ─── Source Hub ────────────────────────────────────────────────────────────────
// Four tabs of lot-list views (Browse, Auto-ROI, Watchlist, Lot History) live
// in the ModuleHeader. Browse stays always-mounted (CSS hidden when inactive)
// so its background manifest pricing keeps running. Tools that aren't lists —
// Deal Analyzer + Component DB — remain modal overlays in the actions row.

import { useState, useEffect, lazy, Suspense } from 'react';
import { Star, FlaskConical, Boxes, History, TrendingUp, Search } from 'lucide-react';
import BrowseLotsView from '../arbitrage/BrowseLotsView';
import { Button, Modal, ModuleHeader } from '../../components/ui';
import eventBus from '../../services/eventBus';

const Watchlist        = lazy(() => import('../arbitrage/Watchlist'));
const DealAnalyzer     = lazy(() => import('../arbitrage/DealAnalyzer'));
const ComponentDB      = lazy(() => import('../arbitrage/ComponentDB'));
const LotHistoryViewer = lazy(() => import('../arbitrage/LotHistoryViewer'));
const Tier39Dashboard  = lazy(() => import('../arbitrage/Tier39Dashboard'));

const SKELETON = <div className="h-64 bg-muted rounded-xl animate-pulse" />;
const WATCHLIST_KEY = 'noltech:arbitrage:watchlist';
const COMPONENTS_KEY = 'noltech:arbitrage:components';
const LOT_HISTORY_KEY = 'noltech:arbitrage:lot-history';
const TAB_KEY = 'noltech:source:tab';

const TAB_IDS = ['browse', 'tier39', 'watchlist', 'history'];

export default function SourceHub() {
  const [tab, setTab] = useState('browse');
  const [modal, setModal] = useState(null); // 'analyzer' | 'components' | null
  const [watchCount, setWatchCount] = useState(0);
  const [componentCount, setComponentCount] = useState(0);
  const [historyCount, setHistoryCount] = useState(0);

  // Restore last tab. Keep BrowseLotsView always-mounted regardless so its
  // background SSE/enrichment work isn't gated on which tab the user is on.
  useEffect(() => {
    window.storage.get(TAB_KEY).then((v) => {
      if (typeof v === 'string' && TAB_IDS.includes(v)) setTab(v);
    }).catch(() => {});
  }, []);
  useEffect(() => { window.storage.set(TAB_KEY, tab).catch(() => {}); }, [tab]);

  // Badge counts. Reload on mount, when a modal closes, and on sync writes.
  useEffect(() => {
    const load = () => {
      window.storage.get(WATCHLIST_KEY)
        .then((v) => setWatchCount(v && typeof v === 'object' ? Object.keys(v).length : 0))
        .catch(() => setWatchCount(0));
      window.storage.get(COMPONENTS_KEY)
        .then((v) => setComponentCount(Array.isArray(v) ? v.length : 0))
        .catch(() => setComponentCount(0));
      window.storage.get(LOT_HISTORY_KEY)
        .then((v) => setHistoryCount(Array.isArray(v) ? v.length : 0))
        .catch(() => setHistoryCount(0));
    };
    load();
    const off = eventBus.on('sync:array-updated', (e) => {
      if (!e?.storageKey) return;
      if (e.storageKey === WATCHLIST_KEY
          || e.storageKey === COMPONENTS_KEY
          || e.storageKey === LOT_HISTORY_KEY) {
        load();
      }
    });
    return () => off();
  }, [modal]);

  // Command-palette driven entry: ui:source-open { detail: { view } }.
  // 'analyzer'/'components' open modals (tools); other views switch tabs.
  useEffect(() => {
    const h = (e) => {
      const v = e?.detail?.view;
      if (v === 'analyzer' || v === 'components') setModal(v);
      else if (v === 'watchlist') setTab('watchlist');
      else if (v === 'history') setTab('history');
      else if (v === 'tier39' || v === 'auto-roi') setTab('tier39');
      else if (v === 'browse') setTab('browse');
    };
    window.addEventListener('ui:source-open', h);
    return () => window.removeEventListener('ui:source-open', h);
  }, []);

  const TABS = [
    { id: 'browse',    label: 'Browse',     icon: Search },
    { id: 'tier39',    label: 'Auto-ROI',   icon: TrendingUp },
    { id: 'watchlist', label: 'Watchlist',  icon: Star,    count: watchCount  || undefined },
    { id: 'history',   label: 'Lot History', icon: History, count: historyCount || undefined },
  ];

  return (
    <div>
      <ModuleHeader
        eyebrow="SOURCE"
        title="Find underpriced lots"
        description="Scrape liquidation sites, evaluate manifests, and tag the ones worth bidding on."
        tabs={TABS}
        activeTab={tab}
        onTabChange={setTab}
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => setModal('analyzer')}>
              <FlaskConical /> Analyzer
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setModal('components')}>
              <Boxes /> Components
              {componentCount > 0 && (
                <span className="text-[10px] bg-muted text-fg-muted px-1.5 rounded-md">{componentCount}</span>
              )}
            </Button>
          </>
        }
      />

      {/* Browse stays mounted so the SSE/enrichment loop never restarts on tab
          switches. Other tabs render on demand. */}
      <div className="mt-5">
        <div style={{ display: tab === 'browse' ? 'block' : 'none' }}>
          <BrowseLotsView onAnalyzeLot={null} />
        </div>

        {tab === 'tier39' && (
          <Suspense fallback={SKELETON}>
            <Tier39Dashboard onAnalyzeLot={null} />
          </Suspense>
        )}
        {tab === 'watchlist' && (
          <Suspense fallback={SKELETON}>
            <Watchlist />
          </Suspense>
        )}
        {tab === 'history' && (
          <Suspense fallback={SKELETON}>
            <LotHistoryViewer />
          </Suspense>
        )}
      </div>

      {/* Tool overlays */}
      <Modal
        open={modal === 'analyzer'}
        onClose={() => setModal(null)}
        size="2xl"
        title="Deal Analyzer"
        subtitle="Paste a listing URL or describe a lot to get a three-path profit read"
      >
        <Suspense fallback={SKELETON}><DealAnalyzer /></Suspense>
      </Modal>

      <Modal
        open={modal === 'components'}
        onClose={() => setModal(null)}
        size="2xl"
        title="Component Value Database"
        subtitle="Reference prices for parts the scanner uses to value lots"
      >
        <Suspense fallback={SKELETON}><ComponentDB /></Suspense>
      </Modal>
    </div>
  );
}
