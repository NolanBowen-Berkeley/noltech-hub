import { useState, useEffect, lazy, Suspense } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle } from 'lucide-react';
import { viewTransition } from './components/ui/motion';
import { cn } from './components/ui/cn';

import { AppProvider, useApp }           from './context/AppContext';
import useDarkMode                       from './hooks/useDarkMode';
import { setEbayFeeRate, setResaleRealizationRate, setActiveAskBuffer, setEbayConditionHaircuts, setAuctionFeeRates } from './utils/fees';
import { loadTier }                      from './services/tiers';
import { loadCategories }                from './utils/constants';
import { migrateCloudScraperSettings }   from './utils/pipelineMigration';

import ErrorBoundary                     from './components/ErrorBoundary';
import ModuleErrorBoundary               from './components/ModuleErrorBoundary';
import PinLock                           from './components/PinLock';
import Sidebar                           from './components/Sidebar';
import Topbar                            from './components/ui/Topbar';
import OfflineBanner                     from './components/OfflineBanner';
import ToastContainer                    from './components/ToastContainer';

// Lazy: rendered after PIN unlock, or only on rare demand. Trim cold-start
// payload by deferring these chunks until their parent flag flips.
const GlobalSearch         = lazy(() => import('./components/GlobalSearch'));
const CommandPalette       = lazy(() => import('./components/CommandPalette'));
const KeyboardShortcuts    = lazy(() => import('./components/KeyboardShortcuts'));
const OnboardingTour       = lazy(() => import('./components/OnboardingTour'));
const LoginScreen          = lazy(() => import('./components/LoginScreen'));
const InitialSyncScreen    = lazy(() => import('./components/InitialSyncScreen'));
import { isCloudEnabled, getSession, getActiveWorkspace } from './services/supabase';
import useAutoSync                       from './hooks/useAutoSync';
import useReducedMotion                  from './hooks/useReducedMotion';
import useSalesTaxReminder                from './hooks/useSalesTaxReminder';
import useDailyBackup                     from './hooks/useDailyBackup';
import useBidAlerts                       from './hooks/useBidAlerts';
import { installErrorBridge }             from './services/errorLog';

// Wire the global error bridge once at module-eval time so every
// notification:push of kind 'error' also lands in the persistent error log.
installErrorBridge();
import { trackRecentExternal }           from './hooks/useRecents';

// ─── Page imports (lazy — keep initial bundle small) ────────────────────────
// Each module is a separate code-split chunk. The Hub is the only one
// pre-loaded once Shell mounts; the rest stream in on first navigation.
//
// Why: eager imports here pulled Bookkeeping (148K), Settings (117K),
// ItemManager (73K), BrowseLotsView (55K), and ~500K of other module code
// into the main bundle — front-loading the cost of every screen the user
// might never visit. Lazy splits keep the cold-start payload to just Hub.

const HubHome       = lazy(() => import('./modules/hub/HubHome'));
const SourceHub     = lazy(() => import('./modules/sourcing/SourceHub'));
const BiddingHub    = lazy(() => import('./modules/bidding/BiddingHub'));
const InventoryHub  = lazy(() => import('./modules/inventory/InventoryHub'));
const OperationsHub = lazy(() => import('./modules/operations/OperationsHub'));
const SellingHub    = lazy(() => import('./modules/selling/SellingHub'));
const FinanceHub    = lazy(() => import('./modules/finance/FinanceHub'));
const Settings      = lazy(() => import('./modules/settings/Settings'));

// Skeleton shown during the brief gap between sidebar click and chunk load.
// Matches the size of a module header so it doesn't cause a layout jump.
function ModuleSkeleton() {
  return (
    <div className="animate-pulse">
      <div className="h-8 w-48 bg-muted rounded-md mb-2" />
      <div className="h-4 w-96 max-w-full bg-muted/60 rounded mb-8" />
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-6">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-24 bg-muted/50 rounded-2xl" />
        ))}
      </div>
      <div className="h-64 bg-muted/40 rounded-2xl" />
    </div>
  );
}

// ─── Main content shell ───────────────────────────────────────────────────────

const EMPTY_FILTERS = { dateFrom: '', dateTo: '', source: '', category: '', platform: '' };

const VIEW_LABELS = {
  hub:       'Dashboard',
  source:    'Source',
  bidding:   'Bid & Buy',
  inventory: 'Inventory',
  sell:      'Sell',
  finance:   'Profit & Finance',
  settings:  'Settings',
};

function Shell() {
  const { state, dispatch } = useApp();
  const [isDark, toggleDark] = useDarkMode();
  const [view, setViewRaw] = useState('hub');

  const setView = (v) => {
    setViewRaw(v);
    const label = VIEW_LABELS[v];
    if (v !== 'hub' && label) {
      trackRecentExternal({ type: 'view', id: v, label, view: v });
    }
  };
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [showSearch, setShowSearch] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [focusMode, setFocusMode] = useState(false);

  useEffect(() => {
    const h = () => setShowKeys(true);
    window.addEventListener('ui:show-keys', h);
    return () => window.removeEventListener('ui:show-keys', h);
  }, []);

  // Focus mode: global event to toggle from anywhere (command palette, hub, etc.)
  useEffect(() => {
    const h = () => setFocusMode((f) => !f);
    window.addEventListener('ui:toggle-focus', h);
    return () => window.removeEventListener('ui:toggle-focus', h);
  }, []);

  // Focus mode hides the sidebar by zeroing the CSS var so main content goes edge-to-edge
  useEffect(() => {
    if (!focusMode) return;
    const prev = document.documentElement.style.getPropertyValue('--sidebar-w');
    document.documentElement.style.setProperty('--sidebar-w', '0px');
    document.documentElement.classList.add('focus-mode');
    return () => {
      document.documentElement.style.setProperty('--sidebar-w', prev || '14rem');
      document.documentElement.classList.remove('focus-mode');
    };
  }, [focusMode]);

  // Background auto-sync (scrape, price, eBay orders)
  useAutoSync(dispatch);

  // Quarterly sales-tax filing reminder (~14 days before each deadline)
  useSalesTaxReminder();

  // Daily IndexedDB backup snapshot (~30 day retention)
  useDailyBackup();

  // Watch active bids → alert when a lot is in its final 30 min and still
  // at-or-below the user's bid ceiling. Toasts + desktop notification.
  useBidAlerts();

  // Initialize reduced-motion root class based on OS preference
  useReducedMotion();

  const clearFilters = () => setFilters(EMPTY_FILTERS);

  // Global keyboard shortcuts:
  //  - cmd/ctrl+K → command palette
  //  - /          → legacy global search
  //  - f          → toggle focus mode
  //  - n          → context-aware "new" (fires ui:new event; modules listen)
  //  - Esc        → close overlays / exit focus mode
  useEffect(() => {
    const handler = (e) => {
      const tag = e.target?.tagName;
      const inInput = ['INPUT','TEXTAREA','SELECT'].includes(tag);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setShowPalette(true);
        setShowSearch(false);
        return;
      }
      if (e.key === '/' && !inInput) {
        e.preventDefault();
        setShowSearch(true);
        return;
      }
      if (e.key === 'f' && !inInput && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setFocusMode((f) => !f);
        return;
      }
      if (e.key === 'n' && !inInput && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('ui:new', { detail: { view } }));
        return;
      }
      if (e.key === 'Escape') {
        setShowSearch(false);
        setShowPalette(false);
        setShowKeys(false);
        if (focusMode) setFocusMode(false);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [view, focusMode]);

  // Check if onboarding needed
  useEffect(() => {
    window.storage.get('noltech:onboarding:completed')
      .then(done => { if (!done) setShowOnboarding(true); })
      .catch(e => console.error('[App] onboarding check failed:', e));
  }, []);

  const allItems = state.lots.flatMap((l) => (l.items || []).map((i) => ({ ...i, _lot: l })));
  const stats = {
    lots:      state.lots.length,
    available: allItems.filter((i) => !['sold','recycled','parted_out'].includes(i.status)).length,
    sold:      allItems.filter((i) => i.status === 'sold').length,
  };

  if (state.loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-nolbg">
        <div className="text-center">
          <div className="w-10 h-10 border-4 border-secondary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-textsecondary text-sm">Fetching NolTech Hub…</p>
        </div>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-nolbg">
        <div className="bg-surface border border-danger/30 rounded-xl p-8 max-w-md text-center shadow-sm">
          <AlertTriangle className="w-10 h-10 text-danger mx-auto mb-3" />
          <h2 className="text-lg font-semibold text-textprimary mb-2">Storage Error</h2>
          <p className="text-textsecondary text-sm">{state.error}</p>
          <button onClick={() => window.location.reload()}
            className="mt-4 px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-dark transition-colors">
            Reload
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-bg">
      {!focusMode && <Sidebar view={view} setView={setView} stats={stats} />}

      {!focusMode && (
        <Topbar
          moduleName={VIEW_LABELS[view] || 'NolTech Hub'}
          onOpenPalette={() => setShowPalette(true)}
          onToggleTheme={toggleDark}
          isDark={isDark}
        />
      )}

      {focusMode && (
        <button
          onClick={() => setFocusMode(false)}
          className="fixed top-3 right-3 z-[120] inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md glossy-elevated text-[11px] font-medium text-fg-muted hover:text-fg transition-colors shadow-glow-sm"
          title="Exit focus mode (f or Esc)"
        >
          <span className="inline-block size-1.5 rounded-full bg-accent animate-pulse" />
          Focus mode
          <kbd className="px-1 py-0.5 rounded bg-muted text-[9px] font-mono">Esc</kbd>
        </button>
      )}

      <main
        className={cn(
          'flex-1 min-h-screen overflow-y-auto pb-16 md:pb-6 px-4 md:px-8 transition-[margin] duration-300 ease-out-expo',
          // Top padding accommodates fixed Topbar (48px) on desktop, mobile bar (56px) on phones
          focusMode ? 'pt-4' : 'pt-[72px] md:pt-[64px]',
        )}
        style={{ marginLeft: 'var(--sidebar-w, 0px)' }}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={view} {...viewTransition}>
            <Suspense fallback={<ModuleSkeleton />}>
              {view === 'hub'        && <ModuleErrorBoundary moduleName="Dashboard"><HubHome setView={setView} /></ModuleErrorBoundary>}
              {view === 'source'     && <ModuleErrorBoundary moduleName="Source"><SourceHub setView={setView} /></ModuleErrorBoundary>}
              {view === 'bidding'    && <ModuleErrorBoundary moduleName="Bid & Buy"><BiddingHub /></ModuleErrorBoundary>}
              {view === 'inventory'  && <ModuleErrorBoundary moduleName="Inventory"><InventoryHub filters={filters} setFilters={setFilters} clearFilters={clearFilters} /></ModuleErrorBoundary>}
              {view === 'operations' && <ModuleErrorBoundary moduleName="Operations"><OperationsHub /></ModuleErrorBoundary>}
              {view === 'sell'       && <ModuleErrorBoundary moduleName="Sell"><SellingHub /></ModuleErrorBoundary>}
              {view === 'finance'    && <ModuleErrorBoundary moduleName="Profit & Finance"><FinanceHub /></ModuleErrorBoundary>}
              {view === 'settings'   && <ModuleErrorBoundary moduleName="Settings"><Settings /></ModuleErrorBoundary>}
            </Suspense>
          </motion.div>
        </AnimatePresence>
      </main>

      {/* Lazy overlays — only render their chunks once the trigger flips. */}
      <Suspense fallback={null}>
        {showSearch && (
          <GlobalSearch
            onNavigate={(v) => { setView(v); setShowSearch(false); }}
            onClose={() => setShowSearch(false)}
          />
        )}

        {showPalette && (
          <CommandPalette
            open={showPalette}
            onClose={() => setShowPalette(false)}
            setView={(v) => { setView(v); setShowPalette(false); }}
          />
        )}

        {showKeys && (
          <KeyboardShortcuts
            open={showKeys}
            onClose={() => setShowKeys(false)}
            onNavigate={setView}
          />
        )}

        {showOnboarding && (
          <OnboardingTour onComplete={() => setShowOnboarding(false)} />
        )}
      </Suspense>

      <OfflineBanner />
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

const CLOUD_SKIPPED_KEY = 'noltech:cloud:skipped';

export default function App() {
  const [unlocked, setUnlocked] = useState(false);
  const [cloudStatus, setCloudStatus] = useState('loading'); // 'loading' | 'needs-auth' | 'ready' | 'skipped'
  useDarkMode();

  // Load custom eBay fee rate and user tier before any module renders
  useEffect(() => {
    window.storage.get('noltech:settings:ebay-fee-rate')
      .then(v => { if (v != null) setEbayFeeRate(parseFloat(v) / 100); })
      .catch(e => console.error('[App] eBay fee rate load failed:', e));
    window.storage.get('noltech:settings:resale-realization-rate')
      .then(v => { if (v != null) setResaleRealizationRate(parseFloat(v) / 100); })
      .catch(e => console.error('[App] realization rate load failed:', e));
    window.storage.get('noltech:settings:active-ask-buffer')
      .then(v => { if (v != null) setActiveAskBuffer(v); })
      .catch(e => console.error('[App] active-ask buffer load failed:', e));
    window.storage.get('noltech:settings:ebay-condition-haircuts')
      .then(v => { if (v && typeof v === 'object') setEbayConditionHaircuts(v); })
      .catch(e => console.error('[App] ebay condition haircuts load failed:', e));
    window.storage.get('noltech:settings:auction-fee-rates')
      .then(v => { if (v && typeof v === 'object') setAuctionFeeRates(v); })
      .catch(e => console.error('[App] auction fee rates load failed:', e));
    loadTier().catch(e => console.error('[App] tier load failed:', e));
    loadCategories().catch(e => console.error('[App] categories load failed:', e));
    // Retire the dead cloud-scraper URL if this install still has one saved,
    // so scrapes don't keep firing at a host that no longer resolves.
    migrateCloudScraperSettings().catch(e => console.error('[App] pipeline migration failed:', e));
  }, []);

  // After PIN unlock, check cloud auth status
  useEffect(() => {
    if (!unlocked) return;
    if (!isCloudEnabled) { setCloudStatus('skipped'); return; }
    (async () => {
      try {
        const skipped = await window.storage.get(CLOUD_SKIPPED_KEY);
        if (skipped) { setCloudStatus('skipped'); return; }
        const session = await getSession();
        if (!session) { setCloudStatus('needs-auth'); return; }
        const activeWs = await getActiveWorkspace();
        if (!activeWs) { setCloudStatus('needs-auth'); return; }
        setCloudStatus('ready');
      } catch {
        setCloudStatus('needs-auth');
      }
    })();
  }, [unlocked]);

  if (!unlocked) {
    return <PinLock onUnlock={() => setUnlocked(true)} />;
  }

  if (cloudStatus === 'loading') {
    return <div className="min-h-screen flex items-center justify-center bg-nolbg"><div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" /></div>;
  }

  // Auth + first-time-sync screens are lazy. While the chunk streams in,
  // show the same minimalist spinner the loading state uses — avoids a flash
  // of blank screen on first run.
  const authFallback = (
    <div className="min-h-screen flex items-center justify-center bg-bg">
      <div className="h-8 w-8 rounded-full border-2 border-accent border-t-transparent animate-spin" />
    </div>
  );

  if (cloudStatus === 'needs-auth') {
    return (
      <Suspense fallback={authFallback}>
        <LoginScreen
          onReady={async () => {
            // Check if local has data — if empty, do initial sync first
            const localLots = await window.storage.get('noltech:inventory:lots').catch(() => null);
            if (!localLots || localLots.length === 0) {
              setCloudStatus('initial-sync');
            } else {
              setCloudStatus('ready');
            }
          }}
          onSkip={async () => { await window.storage.set(CLOUD_SKIPPED_KEY, true); setCloudStatus('skipped'); }}
        />
      </Suspense>
    );
  }

  if (cloudStatus === 'initial-sync') {
    return (
      <Suspense fallback={authFallback}>
        <InitialSyncScreen onDone={() => setCloudStatus('ready')} />
      </Suspense>
    );
  }

  return (
    <ErrorBoundary>
      <AppProvider>
        <Shell />
        <ToastContainer />
      </AppProvider>
    </ErrorBoundary>
  );
}
