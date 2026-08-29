// ─── Bidding Hub ──────────────────────────────────────────────────────────────
// Summary strip + primary Bid Tracker table. Won Lots + Component DB moved
// into modals triggered from the action strip.

import { useState, useEffect, lazy, Suspense, useMemo } from 'react';
import { Trophy, Database, Gavel, CheckCircle2, Clock } from 'lucide-react';
import { Button, Card, Modal, AnimatedNumber, ModuleHeader, MetricTile } from '../../components/ui';
import { fmt } from '../../utils/formatters';
import eventBus from '../../services/eventBus';

const BidTracker     = lazy(() => import('../arbitrage/BidTracker'));
const WonLotImporter = lazy(() => import('../arbitrage/WonLotImporter'));
const ComponentDB    = lazy(() => import('../arbitrage/ComponentDB'));

const SKELETON = <div className="h-64 bg-muted rounded-xl animate-pulse" />;

const BIDS_KEY = 'noltech:arbitrage:bids';

export default function BiddingHub() {
  const [bids, setBids] = useState([]);
  const [showWon, setShowWon] = useState(false);
  const [showComponents, setShowComponents] = useState(false);

  useEffect(() => {
    const load = () => window.storage.get(BIDS_KEY)
      .then((v) => setBids(Array.isArray(v) ? v : []))
      .catch(() => setBids([]));
    load();
    // Event-driven reload instead of polling. Bids change via:
    //   1. BidTracker → bid:status-changed
    //   2. Cloud sync → sync:array-updated with this storage key
    const offStatus = eventBus.on('bid:status-changed', load);
    const offSync = eventBus.on('sync:array-updated', (e) => {
      if (e?.storageKey === BIDS_KEY) load();
    });
    return () => { offStatus(); offSync(); };
  }, []);

  // Open the Won-Lot Importer modal in response to a global event (fired from
  // BidTracker when the user clicks "→ Inv" on a won-bid row).
  useEffect(() => {
    const handler = (e) => {
      if (e?.detail?.view === 'won-import') setShowWon(true);
    };
    window.addEventListener('ui:bidding-open', handler);
    return () => window.removeEventListener('ui:bidding-open', handler);
  }, []);

  const stats = useMemo(() => {
    const active  = bids.filter((b) => b.status === 'pending' || b.status === 'active').length;
    const won     = bids.filter((b) => b.status === 'won');
    const wonSpend = won.reduce((s, b) => s + (parseFloat(b.wonPrice) || parseFloat(b.bidAmount) || 0), 0);
    const totalBidCeiling = bids
      .filter((b) => b.status === 'pending' || b.status === 'active')
      .reduce((s, b) => s + (parseFloat(b.bidCeiling) || parseFloat(b.bidAmount) || 0), 0);
    const winRate = bids.length > 0
      ? (won.length / bids.filter((b) => ['won', 'lost', 'cancelled'].includes(b.status)).length) * 100
      : 0;
    return { active, wonCount: won.length, wonSpend, totalBidCeiling, winRate };
  }, [bids]);

  return (
    <div className="space-y-4">
      <ModuleHeader
        eyebrow="BID & BUY"
        title="Track bids and import won lots"
        description="Every active bid, win-rate trend, and a one-click path to import won manifests into inventory."
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => setShowWon(true)}>
              <Trophy /> Won Lots ({stats.wonCount})
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setShowComponents(true)}>
              <Database /> Components
            </Button>
          </>
        }
      />

      {/* Bento KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricTile
          label="Active Bids"
          icon={Gavel}
          value={<AnimatedNumber value={stats.active} />}
          hint={`${fmt(stats.totalBidCeiling)} ceiling`}
        />
        <MetricTile
          label="Won"
          icon={Trophy}
          intent="success"
          value={<span className="text-success"><AnimatedNumber value={stats.wonCount} /></span>}
          hint={`${fmt(stats.wonSpend)} spent`}
        />
        <MetricTile
          label="Win Rate"
          icon={CheckCircle2}
          value={isFinite(stats.winRate) && stats.winRate > 0
            ? <><AnimatedNumber value={stats.winRate} format={(v) => v.toFixed(0)} />%</>
            : <span className="text-fg-subtle text-[20px]">—</span>}
          hint="of resolved bids"
        />
        <MetricTile
          label="Total Tracked"
          icon={Clock}
          value={<AnimatedNumber value={bids.length} />}
          hint="across all sources"
        />
      </div>

      {/* Primary view */}
      <Suspense fallback={SKELETON}>
        <BidTracker />
      </Suspense>

      <Modal open={showWon} onClose={() => setShowWon(false)} size="2xl" title="Won Lots" subtitle="Import manifests from won bids into inventory">
        <Suspense fallback={SKELETON}><WonLotImporter /></Suspense>
      </Modal>

      <Modal open={showComponents} onClose={() => setShowComponents(false)} size="2xl" title="Component Database" subtitle="Reference values for common parts">
        <Suspense fallback={SKELETON}><ComponentDB /></Suspense>
      </Modal>
    </div>
  );
}
