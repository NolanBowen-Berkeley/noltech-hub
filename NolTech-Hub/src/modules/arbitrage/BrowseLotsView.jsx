// ─── Browse Lots View ─────────────────────────────────────────────────────────
// Extracted from ArbitrageScanner.jsx. Shows scraped lots with enrichment,
// filtering, and pricing. Must stay always-mounted (CSS hidden) so manifest
// pricing continues in the background when switching tabs.

import { useState, useEffect, useCallback, useRef, useMemo, useDeferredValue } from 'react';
import {
  Globe, Loader2, Search, Zap, X, AlertTriangle,
  Bookmark, BookmarkPlus, Star, StarOff, Gavel,
  LayoutGrid, Rows3,
} from 'lucide-react';
import eventBus from '../../services/eventBus';
import { getEbayFeeRate } from '../../utils/fees';
import { decryptObject } from '../../services/crypto';
import DatePicker from '../../components/DatePicker';
import { useApp } from '../../context/AppContext.jsx';
import { pipelineFetch } from '../../services/pipelineFetch';
import { loadEnrichmentsFromAnalyses } from '../../services/analysisEnrichmentLoader';
import { decrypt } from '../../services/crypto';
import { KEY_LAMBDA_URL, KEY_AUTH_SECRET } from '../../services/soldComps';
import { fmt, formatDateTime as formatDate, parseQuantity } from '../../utils/formatters';
import LotCard from './LotCard';
import LotCardCompact from './LotCardCompact';
import BrowseLotsStatusStrip from './BrowseLotsStatusStrip';
import BrowseLotsSummary from './BrowseLotsSummary';
import BrowseLotsCategoryGrid from './BrowseLotsCategoryGrid';
import { captureScrapedLots, findComparableClosesBulk } from '../../services/lotHistory';
import { getLiqCloseRatios, estimateLiqBidSync } from '../../services/liqBidModel';
import { loadGeminiKey } from '../../services/gemini';
import { enqueueLots } from '../../services/lotAnalysisQueue';
import CostDashboard from './CostDashboard';
import { mergeUpcCache, saveUpcCache } from '../../utils/upcCacheMerge';
import { supabase, isCloudEnabled, getActiveWorkspace } from '../../services/supabase';
import { pullSoldCompsByUpc } from '../../services/soldCompsPull';

const KEY_BROWSE = 'noltech:arbitrage:browse-lots';
const KEY_SAVED_SEARCHES = 'noltech:arbitrage:saved-searches';
const KEY_SHOW_COMPS = 'noltech:arbitrage:show-comparables';
const KEY_VIEW_MODE = 'noltech:arbitrage:browse-view-mode';

// ─── SSE consumer for /lots/all/stream ──────────────────────────────────────
// The cloud worker exposes a Server-Sent Events endpoint that fires:
//   event: source_start   { source }
//   event: source_done    { source, ok, count, lots, error? }
//   event: complete       { totalLots, sources, at }
// We accumulate per-source progress + lots, return the aggregate that matches
// the /lots/all JSON shape so the rest of loadLots doesn't need to know.
async function streamLotsAll(endpoint, setProgress) {
  // Build the stream URL — rewrite /api/lots/all → /lots/all/stream, preserve
  // the ?sources= and ?noCache= query so the worker filters + freshness
  // behavior match the regular /lots/all path.
  const [pathPart, queryPart = ''] = endpoint.split('?');
  const streamPath = (pathPart === '/api/lots/all' ? '/lots/all/stream' : pathPart) + (queryPart ? '?' + queryPart : '');

  // EventSource doesn't allow custom headers (no Authorization), and Electron
  // CSP gets tricky with cross-origin SSE. Use fetch+ReadableStream instead —
  // the same pipelineFetch path that already works for /api/lots/all, just
  // consuming the response as a stream.
  const { pipelineFetch: f } = await import('../../services/pipelineFetch');
  console.log('[BrowseLotsView SSE] requesting', streamPath);
  const res = await f(streamPath, { signal: AbortSignal.timeout(180000) });
  console.log('[BrowseLotsView SSE] response', res.status, 'content-type:', res.headers.get('content-type'));
  if (!res.ok) throw new Error(`SSE stream returned ${res.status}`);
  if (!res.body) throw new Error('SSE stream has no body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const allLots = [];
  let aggregate = { lots: [], sources: [], totalLots: 0 };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE messages are double-newline terminated.
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = raw.split('\n');
      let event = 'message', data = '';
      for (const line of lines) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      let payload;
      try { payload = JSON.parse(data); } catch { continue; }

      if (event === 'source_start') {
        setProgress?.((p) => ({ ...p, [payload.source]: { status: 'fetching', count: 0 } }));
      } else if (event === 'source_done') {
        setProgress?.((p) => ({
          ...p,
          [payload.source]: payload.ok
            ? { status: 'done',  count: payload.count }
            : { status: 'error', count: 0, error: payload.error },
        }));
        if (payload.ok && Array.isArray(payload.lots)) allLots.push(...payload.lots);
      } else if (event === 'complete') {
        aggregate = { lots: allLots, sources: payload.sources, totalLots: payload.totalLots, mock: false };
      }
    }
  }
  return aggregate;
}

function BrowseLotsView({ onAnalyzeLot }) {
  const [serverOnline, setServerOnline] = useState(null); // null=checking, true/false
  const [lots, setLots] = useState([]);
  const [loading, setLoading] = useState(false);
  // Per-source progress for SSE-based scrape. Map of { sourceSlug: { status: 'fetching'|'done'|'error', count, error? } }
  // Empty object until a scrape kicks off. Used by the loading UI to show
  // live progress instead of a blank spinner.
  const [sourceProgress, setSourceProgress] = useState({});
  const [error, setError] = useState('');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [sortBy, setSortBy] = useState('signal');
  const [usedMock, setUsedMock] = useState(false);
  const [categorySearch, setCategorySearch] = useState('');
  const [endDateFilter, setEndDateFilter] = useState('');
  const [hideEnded, setHideEnded] = useState(true);
  const [conditionFilter, setConditionFilter] = useState('all');
  const [channelFilter, setChannelFilter] = useState('all');
  const [minPriceFilter, setMinPriceFilter] = useState('');
  const [maxPriceFilter, setMaxPriceFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  // ── Summary-strip quick filters ────────────────────────────────────────
  // Driven by clicks on the BrowseLotsSummary stat tiles. Independent from
  // the existing dropdown filters, applied AFTER the existing filter chain
  // so they layer cleanly. Both default to off.
  const [signalFilter, setSignalFilter] = useState(null);   // null | 'strong_buy' | etc.
  const [endingSoonFilter, setEndingSoonFilter] = useState(false);
  const [brandFilter, setBrandFilter] = useState('all');     // 'all' or lowercased brand name
  const [scrapedAt, setScrapedAt] = useState(null);

  // ── Active bid commitment tracker ──────────────────────────────────────
  // Sums bid ceilings of all currently active/pending bids so the user can
  // see at a glance how much they'd be on the hook for if every active bid
  // hit max. Refreshed whenever quickBid runs or the bid:status-changed
  // event fires from BidTracker.
  const [activeBidCeiling, setActiveBidCeiling] = useState(0);
  const [activeBidCount, setActiveBidCount] = useState(0);
  // Set of lot IDs that have at least one active/pending bid — used to mark
  // lot cards in the grid so the user can see which lots they're already
  // bidding on without checking the Bid & Buy tab.
  const [bidLotIds, setBidLotIds] = useState(() => new Set());
  const refreshActiveBidStats = async () => {
    try {
      const bids = (await window.storage.get('noltech:arbitrage:bids')) || [];
      const active = bids.filter((b) => b.status === 'active' || b.status === 'pending');
      const total = active.reduce((s, b) => s + (parseFloat(b.bidCeiling) || parseFloat(b.bidAmount) || 0), 0);
      setActiveBidCount(active.length);
      setActiveBidCeiling(total);
      setBidLotIds(new Set(active.map((b) => b.lotId).filter(Boolean)));
    } catch (e) { console.error('[BrowseLotsView] active bid stats failed:', e); }
  };
  useEffect(() => {
    refreshActiveBidStats();
    const onChange = () => refreshActiveBidStats();
    const unsub1 = eventBus.on('bid:status-changed', onChange);
    const unsub2 = eventBus.on('bid:logged', onChange);
    return () => { unsub1(); unsub2(); };
  }, []);

  // ── Saved searches ──────────────────────────────────────────────────────
  // Named snapshots of the current filter state. Engrained into the existing
  // filter row — a small bookmark button saves, chips render inline above.
  const [savedSearches, setSavedSearches] = useState([]);
  const [savedSearchOpen, setSavedSearchOpen] = useState(false);
  const [savedSearchName, setSavedSearchName] = useState('');
  const [activeSavedId, setActiveSavedId] = useState(null);
  // "More filters" popover (condition, category, channel, price range)
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);

  // View mode — 'detail' (full LotCard, 2-col) or 'compact' (LotCardCompact, 3-4 col).
  // Persisted to storage so the user's preference sticks across sessions.
  const [viewMode, setViewMode] = useState('detail');
  useEffect(() => {
    window.storage.get(KEY_VIEW_MODE)
      .then((v) => { if (v === 'compact' || v === 'detail') setViewMode(v); })
      .catch((e) => console.error('[BrowseLotsView] view-mode load failed:', e));
  }, []);
  const switchViewMode = (mode) => {
    setViewMode(mode);
    window.storage.set(KEY_VIEW_MODE, mode).catch((e) => console.error('[BrowseLotsView] view-mode save failed:', e));
  };

  const currentFilterSnapshot = () => ({
    sourceFilter, categorySearch, endDateFilter, hideEnded,
    conditionFilter, channelFilter, minPriceFilter, maxPriceFilter,
    categoryFilter, sortBy,
  });

  const applySnapshot = (s) => {
    if (!s) return;
    setSourceFilter(s.sourceFilter ?? 'all');
    setCategorySearch(s.categorySearch ?? '');
    setEndDateFilter(s.endDateFilter ?? '');
    setHideEnded(s.hideEnded ?? true);
    setConditionFilter(s.conditionFilter ?? 'all');
    setChannelFilter(s.channelFilter ?? 'all');
    setMinPriceFilter(s.minPriceFilter ?? '');
    setMaxPriceFilter(s.maxPriceFilter ?? '');
    setCategoryFilter(s.categoryFilter ?? 'all');
    setSortBy(s.sortBy ?? 'signal');
  };

  const snapshotsEqual = (a, b) => {
    if (!a || !b) return false;
    const keys = ['sourceFilter','categorySearch','endDateFilter','hideEnded','conditionFilter','channelFilter','minPriceFilter','maxPriceFilter','categoryFilter','sortBy'];
    return keys.every((k) => (a[k] ?? '') === (b[k] ?? ''));
  };

  // Load saved searches on mount
  useEffect(() => {
    window.storage.get(KEY_SAVED_SEARCHES)
      .then((v) => { if (Array.isArray(v)) setSavedSearches(v); })
      .catch((e) => console.error('[BrowseLotsView] saved searches load failed:', e));
  }, []);

  const persistSavedSearches = (next) => {
    setSavedSearches(next);
    window.storage.set(KEY_SAVED_SEARCHES, next).catch((e) => console.error('[BrowseLotsView] saved searches save failed:', e));
  };

  const handleSaveSearch = () => {
    const name = savedSearchName.trim();
    if (!name) return;
    const entry = { id: crypto.randomUUID(), name, snapshot: currentFilterSnapshot(), createdAt: new Date().toISOString() };
    persistSavedSearches([entry, ...savedSearches]);
    setSavedSearchName('');
    setSavedSearchOpen(false);
    setActiveSavedId(entry.id);
  };

  const handleLoadSearch = (entry) => {
    applySnapshot(entry.snapshot);
    setActiveSavedId(entry.id);
    setSavedSearchOpen(false);
  };

  const handleDeleteSearch = (id) => {
    persistSavedSearches(savedSearches.filter((s) => s.id !== id));
    if (activeSavedId === id) setActiveSavedId(null);
  };

  // Clear the "active" indicator as soon as filters drift
  useEffect(() => {
    if (!activeSavedId) return;
    const match = savedSearches.find((s) => s.id === activeSavedId);
    if (match && !snapshotsEqual(match.snapshot, currentFilterSnapshot())) setActiveSavedId(null);
  }, [sourceFilter, categorySearch, endDateFilter, hideEnded, conditionFilter, channelFilter, minPriceFilter, maxPriceFilter, categoryFilter, sortBy, activeSavedId, savedSearches]);

  // Enrichment state: { [lotId]: { status: 'loading'|'done'|'error', manifestItems, totals } }
  const [enrichments, setEnrichments] = useState({});
  const [keywordSearchEnabled, setKeywordSearchEnabled] = useState(true);

  // Force-fresh mode. When on:
  //   1. loadLots always adds noCache=1 (already default via loadLots args)
  //   2. enrichLots passes forceRefresh=true — Worker bypasses upcCache KV
  //      AND compsLookup skips sold_comps Supabase cache
  //   3. loadEnrichmentsFromAnalyses is skipped (no lot_analyses hydration)
  //   4. pullFromCloud is skipped (no browse_lots polling rehydrate)
  // Persisted so it survives reloads — user has to explicitly turn off.
  const [forceFreshMode, setForceFreshMode] = useState(false);
  useEffect(() => {
    window.storage.get('noltech:scraper:force-fresh')
      .then((v) => { if (typeof v === 'boolean') setForceFreshMode(v); })
      .catch(() => {});
  }, []);
  useEffect(() => {
    window.storage.set('noltech:scraper:force-fresh', forceFreshMode).catch(() => {});
  }, [forceFreshMode]);

  // Comparable-closes overlay (TL closing-price tracker). User-toggled — when on,
  // each lot card shows what similar TL lots have closed for in recent history.
  const [showComparables, setShowComparables]   = useState(false);
  const [comparablesByLot, setComparablesByLot] = useState({}); // { lotId: comparable | null }
  const [liqEstimatesByLot, setLiqEstimatesByLot] = useState({}); // { lotId: { estimatedClose, ... } }

  // Bulk-select state — when the user enables select-mode, each lot card
  // shows a checkbox and an action toolbar appears above the list.
  const [selectMode,  setSelectMode]  = useState(false);
  const [selected,    setSelected]    = useState({}); // { lotId: true }
  const [bulkBusy,    setBulkBusy]    = useState(false);
  const [bulkResult,  setBulkResult]  = useState(null);
  const selectedIds = Object.keys(selected).filter((k) => selected[k]);

  // Lot notes state — persisted per lot ID
  const [lotNotes, setLotNotes] = useState({});
  const [watchlist, setWatchlist] = useState({});

  // eBay API call counter
  const [ebayCallStats, setEbayCallStats] = useState(null); // { calls, limit, remaining, date }
  const refreshCallStats = async () => {
    try {
      const resp = await pipelineFetch('/api/ebay/call-stats', { signal: AbortSignal.timeout(3000) });
      const data = await resp.json();
      setEbayCallStats(data);
    } catch (e) { console.error('[BrowseLotsView] eBay call stats fetch failed:', e); }
  };

  // ── Cloud → Hub sync ─────────────────────────────────────────────────
  // Pulls fresh browse-lots data from Supabase (which the AWS scraper
  // writes to every 2h). Updates the local IndexedDB cache so the Source
  // page reflects AWS-side state without requiring a manual local Refresh.
  // Called on mount AND every 2 minutes via interval below.
  const pullFromCloud = useCallback(async () => {
    if (!isCloudEnabled) return;
    // Force-fresh mode: skip the cloud rehydrate — otherwise browse_lots
    // rows from other devices' scrapes overwrite our just-fetched fresh data.
    if (forceFreshMode) return;
    try {
      // getActiveWorkspace returns a workspace ID string (not an object).
      const raw = await getActiveWorkspace();
      const workspaceId = typeof raw === 'string' ? raw : raw?.workspace_id;
      if (!workspaceId) return;

      // Fetch ALL fresh lots, not just the timestamp. Supabase returns
      // the full lot object in `data` jsonb, so we can rebuild the Hub's
      // browse-lots cache directly from cloud truth.
      const { data: cloudLots, error } = await supabase
        .from('browse_lots')
        .select('id, source, data, scraped_at')
        .eq('workspace_id', workspaceId)
        .order('scraped_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      if (!cloudLots || cloudLots.length === 0) return;

      const latestScrapedAt = cloudLots[0].scraped_at;
      const reconstructed = cloudLots
        .map((row) => row.data)
        .filter(Boolean);

      // Decide whether to apply: only if cloud is strictly newer than local.
      const local = await window.storage.get(KEY_BROWSE);
      const localTs = local?.scrapedAt ? new Date(local.scrapedAt).getTime() : 0;
      const cloudTs = new Date(latestScrapedAt).getTime();
      if (cloudTs <= localTs) return; // local is already fresher

      // Preserve enrichments for lots that survive (lot IDs are stable).
      const freshIds = new Set(reconstructed.map((l) => l.id));
      const keptEnrich = {};
      const prevEnrich = local?.enrichments || {};
      for (const [id, val] of Object.entries(prevEnrich)) {
        if (freshIds.has(id)) keptEnrich[id] = val;
      }

      const updated = {
        lots: reconstructed,
        usedMock: false,
        scrapedAt: latestScrapedAt,
        _version: 2,
        enrichments: keptEnrich,
      };
      await window.storage.set(KEY_BROWSE, updated);

      // Update React state so the page re-renders with fresh data
      setLots(reconstructed);
      setScrapedAt(latestScrapedAt);
      setEnrichments(keptEnrich);

      // Also pull UPC-tagged sold_comps so any priced items the AWS
      // pipeline produced land in the local IndexedDB UPC cache without
      // the user clicking "Reprice". Silent — only error-logged. Cursor-
      // based so subsequent calls only fetch what's new.
      try {
        const r = await pullSoldCompsByUpc();
        if (r.merged > 0) {
          // Fire so the UPC Cache panel (and anything else watching the
          // key) refreshes immediately.
          eventBus.emit('sync:array-updated', { storageKey: 'noltech:arbitrage:upc-cache' });
        }
      } catch (e) {
        console.warn('[BrowseLotsView] sold-comps pull failed:', e?.message || e);
      }
    } catch (e) {
      console.warn('[BrowseLotsView] cloud pull failed:', e?.message || e);
    }
  }, [forceFreshMode]);

  // Periodic cloud poll — every 2 minutes while the Source page is
  // mounted, the Hub asks Supabase for the latest scrape and merges in
  // any new data. This is what makes "1d 12h ago" become "5m ago"
  // automatically.
  useEffect(() => {
    if (!isCloudEnabled) return;
    const id = setInterval(() => { pullFromCloud(); }, 120_000); // 2 min
    return () => clearInterval(id);
  }, [pullFromCloud]);
  useEffect(() => { refreshCallStats(); }, []);

  // Restore previously scraped lots + enrichments and check server health on mount.
  // All three storage reads + the health ping run in parallel.
  useEffect(() => {
    (async () => {
      const [cachedRes, notesRes, wlRes, healthRes] = await Promise.allSettled([
        window.storage.get(KEY_BROWSE),
        window.storage.get('noltech:arbitrage:lot-notes'),
        window.storage.get('noltech:arbitrage:watchlist'),
        // Health ping against the local pipeline service.
        pipelineFetch('/api/health', { signal: AbortSignal.timeout(3000) }),
      ]);

      if (cachedRes.status === 'fulfilled') {
        const cached = cachedRes.value;
        if (cached?.lots?.length && cached._version >= 2) {
          setLots(cached.lots);
          setUsedMock(cached.usedMock || false);
          setScrapedAt(cached.scrapedAt || null);
          const savedEnrich = cached.enrichments || {};
          const cleaned = {};
          // Drop enrichments where (a) >50% items errored AND (b) cached
          // more than 10 min ago. These are stale Bright Data outages —
          // re-trigger on next view rather than show permanent Error badges.
          const STALE_ERROR_MS = 10 * 60 * 1000;
          const ERROR_RATIO_THRESHOLD = 0.5;
          const now = Date.now();
          for (const [id, data] of Object.entries(savedEnrich)) {
            if (data.status !== 'done') continue;
            const errorRatio = Number(data.errorRatio) || 0;
            const cachedAt = Number(data.cachedAt) || 0;
            const age = cachedAt > 0 ? now - cachedAt : Infinity;
            if (errorRatio > ERROR_RATIO_THRESHOLD && age > STALE_ERROR_MS) {
              // Stale error burst — skip, will re-enrich on view
              continue;
            }
            cleaned[id] = data;
          }
          if (Object.keys(cleaned).length) setEnrichments(cleaned);
        } else if (cached?.lots?.length) {
          // Stale pre-v2 format — discard
          window.storage.set(KEY_BROWSE, null).catch(e => console.error('[BrowseLotsView] browse cache clear failed:', e));
        }
      } else {
        console.error('[BrowseLotsView] browse cache load failed:', cachedRes.reason);
      }

      // Cloud-side freshness check. Local `scrapedAt` only advances when
      // Cloud freshness pull — runs on mount AND periodically (every 2 min)
      // so the freshness indicator and lot list stay in sync with AWS-side
      // scrapes without requiring a manual Refresh.
      await pullFromCloud();

      if (notesRes.status === 'fulfilled' && notesRes.value && typeof notesRes.value === 'object') {
        setLotNotes(notesRes.value);
      } else if (notesRes.status === 'rejected') {
        console.error('[BrowseLotsView] lot notes load failed:', notesRes.reason);
      }

      if (wlRes.status === 'fulfilled' && wlRes.value && typeof wlRes.value === 'object') {
        setWatchlist(wlRes.value);
      } else if (wlRes.status === 'rejected') {
        console.error('[BrowseLotsView] watchlist load failed:', wlRes.reason);
      }

      setServerOnline(healthRes.status === 'fulfilled' && healthRes.value.ok);
    })();
    // Restore the comparable-closes toggle preference
    window.storage.get(KEY_SHOW_COMPS)
      .then((v) => { if (typeof v === 'boolean') setShowComparables(v); })
      .catch(e => console.error('[browse lots] storage error:', e));
  }, []);

  // Persist toggle preference + recompute comparables when it flips on
  useEffect(() => {
    window.storage.set(KEY_SHOW_COMPS, showComparables).catch(e => console.error('[browse lots] storage error:', e));
  }, [showComparables]);

  // Listen for inbound browse_lots updates from the AWS sync-agent's
  // scrape-lots cron (via syncEngine realtime subscription). When fresh
  // lots land in Supabase, syncEngine merges them into IndexedDB and
  // emits this event — we re-read the cache and update local state so the
  // user sees fresh auctions appear without clicking Refresh.
  useEffect(() => {
    const onCloudUpdate = async () => {
      try {
        const cached = await window.storage.get(KEY_BROWSE);
        if (!cached?.lots) return;
        setLots(cached.lots);
        if (cached.scrapedAt) setScrapedAt(cached.scrapedAt);
      } catch (e) { console.error('[BrowseLotsView] cloud-update read failed:', e); }
    };
    const unsub = eventBus.on('sync:browse-lots-updated', onCloudUpdate);
    return unsub;
  }, []);

  // Recompute comparables whenever the toggle is on AND lots change.
  // Skipped when off so we don't burn cycles for users who don't use the
  // feature. Cheap regardless — pure local-storage lookup.
  useEffect(() => {
    if (!showComparables) { setComparablesByLot({}); return; }
    if (!lots.length) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await findComparableClosesBulk(lots);
        if (!cancelled) setComparablesByLot(result);
      } catch (e) {
        console.error('[BrowseLotsView] comparable-closes compute failed:', e);
      }
    })();
    return () => { cancelled = true; };
  }, [showComparables, lots]);

  // Auto-populate enrichments from prior auto-analyze cron runs. The cron
  // pays for sold-comps pricing every 5 min on every Newegg_Business lot —
  // pulling that work into the in-memory enrichments state lets each LotCard
  // render its full pricing grid without the user clicking Price Manifests.
  // Only fills lots NOT already enriched (manual Price Manifests wins) so a
  // re-run doesn't get clobbered.
  useEffect(() => {
    if (!lots.length) return;
    let cancelled = false;
    (async () => {
      // Force-fresh mode: skip cron-analysis rehydrate — every price must
      // come from a live enrich call, not lot_analyses.item_results.
      if (forceFreshMode) return;
      try {
        const lotIds = lots.map((l) => l.id);
        const fromCron = await loadEnrichmentsFromAnalyses(lotIds);
        if (cancelled || fromCron.size === 0) return;
        setEnrichments((prev) => {
          const next = { ...prev };
          let added = 0;
          for (const [id, entry] of fromCron) {
            if (!next[id] || next[id].status !== 'done') {
              next[id] = entry;
              added += 1;
            }
          }
          if (added > 0) console.log(`[BrowseLotsView] auto-populated ${added} enrichments from cron analyses`);
          return next;
        });
      } catch (e) {
        console.warn('[BrowseLotsView] cron enrichment load failed:', e?.message);
      }
    })();
    return () => { cancelled = true; };
  }, [lots, forceFreshMode]);

  // Liquidation.com data-driven bid estimates — predicts each lot's close from
  // the per-category close-ratio model (liqBidModel). Recomputes when lots
  // change; reads the persisted model that the closing-price poll maintains.
  useEffect(() => {
    if (!lots.length) { setLiqEstimatesByLot({}); return; }
    let cancelled = false;
    (async () => {
      try {
        const model = await getLiqCloseRatios();
        const out = {};
        for (const lot of lots) {
          if ((lot.source || '').toLowerCase().includes('liquidation')) {
            const est = estimateLiqBidSync(lot, model);
            if (est) out[lot.id] = est;
          }
        }
        if (!cancelled) setLiqEstimatesByLot(out);
      } catch (e) {
        console.error('[BrowseLotsView] liq bid-estimate compute failed:', e);
      }
    })();
    return () => { cancelled = true; };
  }, [lots]);

  const loadLots = async (useMock = false) => {
    setLoading(true);
    setError('');
    try {
      let endpoint = useMock ? '/api/lots/sample' : '/api/lots/all';
      // Pass enabled sources from settings to the server. Both the local
      // Express scraper and the cloud worker accept ?sources=a,b,c.
      // Also append noCache=1 — this is the user-triggered Refresh button;
      // they expect fresh data. The background auto-scrape in useAutoSync.js
      // does NOT pass noCache and DOES get cached results, which is the
      // right behavior for a polling timer.
      if (!useMock) {
        const params = ['noCache=1'];
        try {
          const sourceConfig = await window.storage.get('noltech:settings:sources');
          if (sourceConfig?.enabled?.length) {
            params.push('sources=' + sourceConfig.enabled.join(','));
          }
        } catch (e) { console.error('[BrowseLotsView] source config load failed:', e); }
        endpoint += '?' + params.join('&');
      }
      // Real scrapes use the SSE streaming endpoint so the UI can show
      // per-source progress as each source completes, instead of a blank
      // spinner for 20-30s. Mock data returns instantly, so it takes the
      // plain fetch path.
      let data;
      if (!useMock) {
        setSourceProgress({});  // reset before streaming
        try {
          data = await streamLotsAll(endpoint, setSourceProgress);
          // Defensive: if SSE returns no lots AND no progress was reported,
          // something silently broke (pipeline died mid-stream, parser
          // swallowed events, etc.). Fall through to the regular fetch so
          // the user isn't stuck.
          if (!data?.lots?.length && Object.keys(sourceProgress).length === 0) {
            throw new Error('SSE stream returned no progress');
          }
        } catch (sseErr) {
          console.warn('[BrowseLotsView] SSE failed, falling back to regular fetch:', sseErr?.message);
          setSourceProgress({});
          const res = await pipelineFetch(endpoint, { signal: AbortSignal.timeout(120000) });
          if (!res.ok) throw new Error(`Server returned ${res.status}`);
          data = await res.json();
        }
      } else {
        const res = await pipelineFetch(endpoint, { signal: AbortSignal.timeout(120000) });
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        data = await res.json();
      }
      const freshLots = data.lots || [];
      const isMock    = useMock || data.sample === true || data.mock === true;
      const now       = new Date().toISOString();
      setLots(freshLots);
      setUsedMock(isMock);
      setScrapedAt(now);
      // Keep enrichments for lots that still exist after rescrape (lot IDs are stable)
      const freshIds = new Set(freshLots.map(l => l.id));
      setEnrichments(prev => {
        const kept = {};
        for (const [id, data] of Object.entries(prev)) {
          if (freshIds.has(id)) kept[id] = data;
        }
        return kept;
      });
      // Persist lots + surviving enrichments
      const freshIds2 = new Set(freshLots.map(l => l.id));
      const keptEnrich = {};
      for (const [id, data] of Object.entries(enrichments)) {
        if (freshIds2.has(id)) keptEnrich[id] = data;
      }
      window.storage.set(KEY_BROWSE, { lots: freshLots, usedMock: isMock, scrapedAt: now, _version: 2, enrichments: keptEnrich }).catch(e => console.error('[BrowseLotsView] browse cache save failed:', e));
      // Capture freshly-seen TL lots into the lot-history log so we can
      // build comparable-closes data over time. Best-effort; never blocks
      // the UI if storage fails.
      captureScrapedLots(freshLots).catch((e) => console.error('[BrowseLotsView] lot history capture failed:', e));
      // ── Tier 39: auto-enqueue Newegg_Business lots for the auto-analyze
      // Worker. enqueueLots respects the 24h cooldown + pre-filters internally,
      // so we can safely fire it after every scrape. Fire-and-forget — never
      // block the UI.
      const liqLots = freshLots.filter((l) => l.source === 'liquidation.com' && l.seller === 'Newegg_Business');
      if (liqLots.length > 0) {
        enqueueLots(liqLots)
          .then((r) => {
            // Always log the outcome so we can see why lots get skipped
            // (cooldown / no_manifest_items / bid_too_close_to_msrp / errors).
            // Bucket reasons so the console isn't a wall of 38 individual lines.
            const reasonCounts = {};
            for (const d of (r.details || [])) {
              const key = `${d.status}${d.reason ? ':' + d.reason.split(' (')[0] : ''}`;
              reasonCounts[key] = (reasonCounts[key] || 0) + 1;
            }
            console.log(`[BrowseLotsView] tier39 auto-analyze: queued ${r.queued}, skipped ${r.skipped}, errors ${r.errors}`, reasonCounts);
          })
          .catch((e) => console.warn('[BrowseLotsView] tier39 enqueue failed:', e?.message || e));
      } else {
        console.log(`[BrowseLotsView] tier39 auto-analyze: 0 lots matched filter (source=liquidation.com, seller=Newegg_Business) out of ${freshLots.length} scraped`);
      }
      if (data.errors?.length) {
        setError(data.errors.map((e) => `${e.source}: ${e.error}`).join(' | '));
      }
      // Don't auto-enrich — user triggers manually via "Price Manifests" button
    } catch (err) {
      setError(err.message || "Couldn't load lots");
    } finally {
      setLoading(false);
    }
  };

  // ── Persist a note for a specific lot ──
  const persistNote = async (lotId, note) => {
    const updated = { ...lotNotes, [lotId]: note };
    // Remove empty notes to keep storage clean
    if (!note.trim()) delete updated[lotId];
    setLotNotes(updated);
    try {
      await window.storage.set('noltech:arbitrage:lot-notes', updated);
    } catch (e) {
      console.error('Failed to save lot note:', e);
    }
  };

  const toggleWatch = async (lotId) => {
    const updated = { ...watchlist };
    if (updated[lotId]) {
      delete updated[lotId];
    } else {
      updated[lotId] = { addedAt: new Date().toISOString() };
    }
    setWatchlist(updated);
    try { await window.storage.set('noltech:arbitrage:watchlist', updated); } catch (e) { console.error('[BrowseLotsView] watchlist save failed:', e); }
  };

  // ── Quick bid: save a bid directly from the lot card ──
  const quickBid = async (lot, bidCeiling, estResale) => {
    try {
      const bids = await window.storage.get('noltech:arbitrage:bids') || [];
      const newBid = {
        id: crypto.randomUUID(),
        lotId: lot.id,
        lotTitle: lot.title,
        source: lot.source || '',
        lotUrl: lot.url || '',
        bidAmount: lot.price || 0,
        bidCeiling: bidCeiling || 0,
        estResale: estResale || 0,
        status: 'active',
        wonPrice: null,
        actualProfit: null,
        notes: '',
        bidDate: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await window.storage.set('noltech:arbitrage:bids', [newBid, ...bids]);
      // Brief visual feedback
      setBidFeedback(lot.id);
      setTimeout(() => setBidFeedback(null), 2000);
      // Refresh the active-bid commitment counter.
      eventBus.emit('bid:logged', { bidId: newBid.id });
      // Bottom-right toast confirming the bid was logged.
      const fmtUsd = (n) => (typeof n === 'number' && isFinite(n)) ? `$${n.toFixed(2)}` : '—';
      eventBus.emit('notification:push', {
        type: 'success',
        title: 'Bid Logged',
        message: `${lot.title || 'Lot'} — asking ${fmtUsd(lot.price)}, ceiling ${fmtUsd(bidCeiling)}`,
      });
    } catch (e) {
      console.error('Quick bid error:', e);
      eventBus.emit('notification:push', {
        type: 'error',
        title: 'Bid Failed',
        message: e?.message || 'Could not save bid',
      });
    }
  };
  const [bidFeedback, setBidFeedback] = useState(null);

  // Compare feature removed — stub to keep existing handlers non-breaking
  const comparePick = null;
  const quickCompare = () => {};

  // ── Bulk actions on selected lots ──
  const toggleSelect = (lotId) => {
    setSelected((prev) => ({ ...prev, [lotId]: !prev[lotId] }));
  };
  const selectAllVisible = (visibleLots) => {
    const next = { ...selected };
    for (const l of visibleLots) next[l.id] = true;
    setSelected(next);
  };
  const clearSelection = () => setSelected({});

  const bulkStar = async () => {
    if (!selectedIds.length) return;
    setBulkBusy(true); setBulkResult(null);
    try {
      const updated = { ...watchlist };
      let added = 0;
      const now = new Date().toISOString();
      for (const id of selectedIds) {
        if (!updated[id]) { updated[id] = { addedAt: now }; added++; }
      }
      setWatchlist(updated);
      await window.storage.set('noltech:arbitrage:watchlist', updated);
      setBulkResult({ ok: true, msg: `Starred ${added} new lot${added !== 1 ? 's' : ''} (${selectedIds.length - added} already starred).` });
    } catch (e) { setBulkResult({ ok: false, msg: e.message }); }
    finally { setBulkBusy(false); }
  };

  const bulkUnstar = async () => {
    if (!selectedIds.length) return;
    setBulkBusy(true); setBulkResult(null);
    try {
      const updated = { ...watchlist };
      let removed = 0;
      for (const id of selectedIds) {
        if (updated[id]) { delete updated[id]; removed++; }
      }
      setWatchlist(updated);
      await window.storage.set('noltech:arbitrage:watchlist', updated);
      setBulkResult({ ok: true, msg: `Unstarred ${removed} lot${removed !== 1 ? 's' : ''}.` });
    } catch (e) { setBulkResult({ ok: false, msg: e.message }); }
    finally { setBulkBusy(false); }
  };

  const bulkBid = async () => {
    if (!selectedIds.length) return;
    if (!confirm(`Log a bid entry for ${selectedIds.length} lot${selectedIds.length !== 1 ? 's' : ''}? Each will use the lot's current asking price as the bid amount and its 30%-margin ceiling as the ceiling.`)) return;
    setBulkBusy(true); setBulkResult(null);
    try {
      const existing = (await window.storage.get('noltech:arbitrage:bids')) || [];
      const newRows = [];
      for (const id of selectedIds) {
        const lot = lots.find((l) => l.id === id);
        if (!lot) continue;
        const ceiling = lot.metrics?.bidCeilings?.at30pct || 0;
        newRows.push({
          id: crypto.randomUUID(),
          lotId: lot.id,
          lotTitle: lot.title,
          source: lot.source || '',
          lotUrl: lot.url || '',
          bidAmount: lot.price || 0,
          bidCeiling: ceiling,
          estResale: lot.estimation?.estimatedResalePerUnit ? lot.estimation.estimatedResalePerUnit * (parseQuantity(lot.quantity) || 1) : 0,
          status: 'active',
          wonPrice: null,
          actualProfit: null,
          notes: '',
          bidDate: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
      await window.storage.set('noltech:arbitrage:bids', [...newRows, ...existing]);
      setBulkResult({ ok: true, msg: `Created ${newRows.length} bid entr${newRows.length !== 1 ? 'ies' : 'y'} in Bid Tracker.` });
    } catch (e) { setBulkResult({ ok: false, msg: e.message }); }
    finally { setBulkBusy(false); }
  };

  const bulkPriceManifests = async () => {
    if (!selectedIds.length) return;
    const targets = lots.filter((l) => selectedIds.includes(l.id) && (
      (l.palletId && l.manifestSlug) ||
      (l.source === 'liquidation.com' && l.url)
    ));
    if (!targets.length) {
      setBulkResult({ ok: false, msg: 'No selected lots have manifest data to price.' });
      return;
    }
    enrichLots(targets, enrichments);
    setBulkResult({ ok: true, msg: `Started pricing ${targets.length} manifest${targets.length !== 1 ? 's' : ''}.` });
  };

  // Price a single lot's manifest on demand (per-card kebab action). Passes an
  // enrichments map WITHOUT this lot so enrichLots' "already done" filter never
  // skips it — i.e. this always (re)prices the one lot, even if priced before.
  const priceSingleLot = (lot) => {
    if (!lot) return;
    const withoutThis = { ...enrichments };
    delete withoutThis[lot.id];
    enrichLots([lot], withoutThis);
  };

  // ── Persist enrichments to storage ──
  // Each enrichment entry gets a `cachedAt` timestamp + an `errorRatio` so
  // future loads can detect "this whole enrichment was a Bright Data outage,
  // retry it" instead of permanently displaying error badges. Specifically:
  //   - errorRatio = fraction of items with priceSource='sold-comps-error'
  //   - On mount, if errorRatio > 0.5 AND cachedAt > 10 min ago, treat as
  //     unenriched so the next view triggers a fresh fetch.
  //
  // Without this, a single bad enrichment burst (e.g. Bright Data
  // soft-rate-limiting after heavy cache-wipe activity) leaves the lot
  // stuck with 100% Error badges forever.
  const persistEnrichments = async (updated) => {
    try {
      const stamped = {};
      const now = Date.now();
      for (const [lotId, entry] of Object.entries(updated)) {
        if (entry?.status === 'done' && Array.isArray(entry.manifestItems)) {
          const total = entry.manifestItems.length;
          const errored = entry.manifestItems.filter((it) => it.priceSource === 'sold-comps-error').length;
          stamped[lotId] = {
            ...entry,
            cachedAt: entry.cachedAt || now,
            errorRatio: total > 0 ? errored / total : 0,
          };
        } else {
          stamped[lotId] = entry;
        }
      }
      const cached = await window.storage.get(KEY_BROWSE);
      if (cached) {
        await window.storage.set(KEY_BROWSE, { ...cached, enrichments: stamped });
      }
    } catch (e) { console.error('[BrowseLotsView] enrichments persist failed:', e); }
  };

  // ── Enrich lots with manifest sold-comp pricing ──
  const enrichAbortRef = useRef(false);

  const cancelEnrichment = () => {
    enrichAbortRef.current = true;
    setEnrichments(prev => {
      const updated = { ...prev };
      for (const [id, data] of Object.entries(updated)) {
        if (data.status === 'loading') updated[id] = { status: 'error' };
      }
      return updated;
    });
  };

  const enrichLots = async (lotsToEnrich, existingEnrichments) => {
    enrichAbortRef.current = false;
    const existing = existingEnrichments || {};
    const enrichableLots = (lotsToEnrich || []).filter(
      l => existing[l.id]?.status !== 'done' && (
        (l.source?.includes('techliq') && l.palletId && l.manifestSlug) ||
        (l.source === 'liquidation.com' && l.url)
      )
    );
    if (!enrichableLots.length) return;

    let appId = '', certId = '';
    try {
      const rawCreds = await window.storage.get('noltech:ebay:token');
      const creds = await decryptObject(rawCreds || {});
      appId  = creds?.appId?.trim() || '';
      certId = creds?.certId?.trim() || '';
    } catch (e) { console.error('[BrowseLotsView] credential load failed:', e); }

    // Gemini key (decrypted) — passed to the enrich endpoint so the scraper
    // can decompose prebuilt desktops into priced component line items.
    let geminiKey = '';
    try { geminiKey = (await loadGeminiKey()) || ''; }
    catch (e) { console.error('[BrowseLotsView] gemini key load failed:', e); }

    const loadingEnrich = {};
    enrichableLots.forEach(l => { loadingEnrich[l.id] = { status: 'loading' }; });
    setEnrichments(prev => ({ ...prev, ...loadingEnrich }));
    const allEnrichments = { ...existing, ...loadingEnrich };
    const LOT_CONCURRENCY = 5;

    // Sold-comps Lambda config — only needed for the cloud-routed Liq path
    // (cloud worker calls the Lambda directly). Loaded lazily inside
    // enrichOneLot so it's resolved at call time, not module init.
    const loadSoldCompsConfig = async () => {
      try {
        const url    = (await window.storage.get(KEY_LAMBDA_URL)) || '';
        const secEnc = (await window.storage.get(KEY_AUTH_SECRET)) || '';
        const secret = secEnc ? await decrypt(secEnc) : '';
        const workspaceId = await getActiveWorkspace();
        return { url: String(url).trim(), secret: String(secret).trim(), workspaceId };
      } catch { return { url: '', secret: '', workspaceId: null }; }
    };

    const enrichOneLot = async (lot) => {
      try {
        // Two body shapes — TechLiquidators uses palletId+manifestSlug, the
        // Liquidation.com path uses source+lotUrl.
        //
        // CRITICAL: lotCondition is hardcoded to 'any' (no LH_ItemCondition
        // filter on eBay) regardless of the lot's auction-level condition.
        //
        // Why not 'working' or 'for_parts'? Both narrow the eBay search too
        // aggressively for flagship SKUs:
        //   - 'for_parts' returned count=0 on motherboards (the for_parts
        //     bucket is empty for many product categories)
        //   - 'working' returned 1-2 samples on flagship motherboards,
        //     which trips the "Low confidence" warning on every item
        // 'any' queries ALL eBay sold listings (working + for_parts + used
        // + refurb in one shot). The Lambda's outlier filter (IQR +
        // too-good-to-be-true floor in forPartsFilter.js) drops the
        // obviously-broken low-price listings as outliers, so the post-
        // filter median tracks the working-tier price while numSales stays
        // in the 30-60 range that the warning threshold (< 3) was designed
        // for.
        const lotCondition = 'any';
        const isLiq = lot.source === 'liquidation.com';

        // One backend now, so one body shape. The pipeline's /lots/enrich
        // reads the sold-comps config from the body when present and falls
        // back to its own env-configured values otherwise.
        //
        // Liq lots carry lotUrl; TechLiquidators carries palletId +
        // manifestSlug. TL manifest enrichment needs xlsx parsing the
        // pipeline doesn't implement yet — it answers 501 for those, which
        // the error branch below surfaces as a failed enrichment.
        const sc = await loadSoldCompsConfig();
        const body = {
          ...(isLiq
            ? { source: 'liquidation', lotUrl: lot.url }
            : { palletId: lot.palletId, manifestSlug: lot.manifestSlug }),
          lotCondition,
          enableKeywordSearch: keywordSearchEnabled,
          // Force-fresh mode skips every cache layer (disk upc:*, Supabase
          // sold_comps) and hits Bright Data live.
          forceRefresh:         forceFreshMode,
          soldCompsUrl:         sc.url || null,
          soldCompsAuth:        sc.secret || null,
          soldCompsWorkspaceId: sc.workspaceId || null,
          // Gemini key for desktop part-out.
          geminiKey:            geminiKey || null,
          // eBay App/Cert IDs enable the Browse API fallback when sold-comps
          // returns no results.
          appId:                appId || null,
          certId:               certId || null,
        };
        // 6-minute per-lot timeout — a worst-case 100-item lot with retries
        // can legitimately take 4-5 minutes.
        const resp = await pipelineFetch('/api/lots/enrich', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(360_000),
        });
        const data = await resp.json();
        if (data.success) {
          const entry = { status: 'done', manifestItems: data.manifestItems, totals: data.totals, noAppId: data.noAppId || false };
          allEnrichments[lot.id] = entry;
          setEnrichments(prev => ({ ...prev, [lot.id]: entry }));
          eventBus.emit('manifest:priced', { lotId: lot.id, manifestItems: data.manifestItems, totals: data.totals });
        } else {
          allEnrichments[lot.id] = { status: 'error' };
          setEnrichments(prev => ({ ...prev, [lot.id]: { status: 'error' } }));
        }
      } catch (e) {
        console.error('[BrowseLotsView] lot enrichment failed:', e);
        allEnrichments[lot.id] = { status: 'error' };
        setEnrichments(prev => ({ ...prev, [lot.id]: { status: 'error' } }));
      }
    };

    for (let i = 0; i < enrichableLots.length; i += LOT_CONCURRENCY) {
      if (enrichAbortRef.current) break;
      const batch = enrichableLots.slice(i, i + LOT_CONCURRENCY);
      await Promise.all(batch.map(enrichOneLot));
      persistEnrichments(allEnrichments);
      refreshCallStats();
      // Fire-and-forget UPC cache sync so the next batch can start immediately.
      // Merge instead of overwrite — preserves client-side fields (Gemini-
      // cleaned titles, manual edits, manual category overrides, manually
      // added UPCs not yet on the server). See utils/upcCacheMerge.js.
      pipelineFetch('/api/upc-cache', { signal: AbortSignal.timeout(5000) })
        .then((r) => r.json())
        .then(async (d) => {
          if (!d?.success || !d.cache) return;
          const local = (await window.storage.get('noltech:arbitrage:upc-cache')) || {};
          const merged = mergeUpcCache(local, d.cache);
          await saveUpcCache(merged);
          // Broadcast so UPC Cache panel + anything else watching this
          // key reloads to show the new entries without manual refresh.
          eventBus.emit('sync:array-updated', { storageKey: 'noltech:arbitrage:upc-cache' });
        })
        .catch((e) => console.error('[BrowseLotsView] UPC cache sync failed:', e));
    }
  };

  // Filter + sort.
  // useDeferredValue keeps the search box responsive: keystrokes update the
  // input immediately while the (expensive) filter+sort over all lots runs
  // against the deferred value, so typing never blocks on re-filtering.
  const deferredSearch = useDeferredValue(categorySearch);
  const catQuery = deferredSearch.trim().toLowerCase();
  const endDateMs = endDateFilter ? new Date(endDateFilter + 'T23:59:59').getTime() : null;

  // Memoized so the filter+sort only recomputes when lots or a filter/sort
  // input actually changes — not on every unrelated re-render (notes typing,
  // enrichment updates streaming in, etc.).
  const displayed = useMemo(() => lots
    .filter((l) => {
      if (sourceFilter !== 'all' && l.source !== sourceFilter) return false;

      // Category / keyword search across title, brands, categories
      if (catQuery) {
        const haystack = [l.title || '', l.topBrands || '', l.topCategories || '']
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(catQuery)) return false;
      }

      // Hide ended auctions
      if (hideEnded && l.auction?.endsAt) {
        if (new Date(l.auction.endsAt).getTime() < Date.now()) return false;
      }

      // End-date filter: only lots whose auction ends on or before selected date
      if (endDateMs) {
        const endsAt = l.auction?.endsAt;
        if (!endsAt) return false; // non-auction lots have no end date — exclude when filtering by date
        if (new Date(endsAt).getTime() > endDateMs) return false;
      }

      // Condition filter
      if (conditionFilter !== 'all') {
        const lotCond = (l.condition || l.estimation?.condition || '').toLowerCase().replace(/[\s-]/g, '_');
        if (lotCond !== conditionFilter) return false;
      }

      // Category filter
      if (categoryFilter !== 'all') {
        const text = [l.topCategories, l.estimation?.category, l.title].filter(Boolean).join(' ').toLowerCase();
        if (!text.includes(categoryFilter.toLowerCase())) return false;
      }

      // Channel filter
      if (channelFilter !== 'all') {
        const ch = (l.channel || '').toLowerCase();
        if (channelFilter === 'auction' && !ch.includes('auction')) return false;
        if (channelFilter === 'fixed' && ch.includes('auction')) return false;
      }

      // Price range
      if (minPriceFilter) {
        const min = parseFloat(minPriceFilter);
        if (!isNaN(min) && (l.price || 0) < min) return false;
      }
      if (maxPriceFilter) {
        const max = parseFloat(maxPriceFilter);
        if (!isNaN(max) && (l.price || 0) > max) return false;
      }

      // Summary-strip quick filters — applied last
      if (signalFilter) {
        const sig = l.metrics?.signal;
        if (sig !== signalFilter) return false;
      }
      if (endingSoonFilter) {
        const endsAt = l.auction?.endsAt;
        if (!endsAt) return false;
        const diff = new Date(endsAt).getTime() - Date.now();
        if (diff <= 0 || diff > 4 * 3600000) return false;
      }
      if (brandFilter && brandFilter !== 'all') {
        const text = String(l.topBrands || '').toLowerCase();
        if (!text.includes(brandFilter)) return false;
      }

      return true;
    })
    .sort((a, b) => {
      // Helper: is this lot ending within 1 hour?
      const isEndingSoon = (l) => {
        const endsAt = l.auction?.endsAt;
        if (!endsAt) return false;
        const diff = new Date(endsAt).getTime() - Date.now();
        return diff > 0 && diff < 3600000;
      };

      if (sortBy === 'signal') {
        const ORDER = { god_tier: 0, steal: 1, strong_buy: 2, buy: 3, watch: 4, pass: 5, dumpster: 6 };
        const os = (ORDER[a.metrics?.signal] ?? 99) - (ORDER[b.metrics?.signal] ?? 99);
        if (os !== 0) return os;
        // Within same signal tier, float ending-soon lots to top
        const aEnd = isEndingSoon(a);
        const bEnd = isEndingSoon(b);
        if (aEnd && !bEnd) return -1;
        if (!aEnd && bEnd) return 1;
        return (b.metrics?.roi || 0) - (a.metrics?.roi || 0);
      }
      if (sortBy === 'roi') return (b.metrics?.roi || 0) - (a.metrics?.roi || 0);
      if (sortBy === 'price_asc') return (a.price || 0) - (b.price || 0);
      if (sortBy === 'price_desc') return (b.price || 0) - (a.price || 0);
      if (sortBy === 'end_date' || sortBy === 'ending_soon') {
        const ta = a.auction?.endsAt ? new Date(a.auction.endsAt).getTime() : Infinity;
        const tb = b.auction?.endsAt ? new Date(b.auction.endsAt).getTime() : Infinity;
        return ta - tb;
      }
      return 0;
    }),
  [lots, sourceFilter, catQuery, hideEnded, endDateMs, conditionFilter, categoryFilter,
   channelFilter, minPriceFilter, maxPriceFilter, signalFilter, endingSoonFilter, brandFilter, sortBy]);

  // Pagination — only mount a window of cards so a 300-lot scrape doesn't
  // render 300 heavy cards at once (each runs confidence/risk/difficulty math
  // + an image). Window grows via "Load more"; resets when the filtered set
  // changes so we never strand the user deep in a stale list.
  const PAGE_SIZE = 48;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [
    lots, sourceFilter, catQuery, hideEnded, endDateMs, conditionFilter, categoryFilter,
    channelFilter, minPriceFilter, maxPriceFilter, signalFilter, endingSoonFilter, brandFilter, sortBy,
  ]);
  const visibleLots = useMemo(() => displayed.slice(0, visibleCount), [displayed, visibleCount]);

  // Filter-dropdown source data — only depends on `lots`, so memoize to avoid
  // re-scanning the whole list on every keystroke / enrichment update.
  const { sources, conditions, categories, hasAuctions, hasFixed } = useMemo(() => ({
    sources: [...new Set(lots.map((l) => l.source))],
    conditions: [...new Set(lots.map((l) => (l.condition || l.estimation?.condition || '').toLowerCase().replace(/[\s-]/g, '_')).filter(Boolean))].sort(),
    categories: [...new Set(lots.flatMap((l) => {
      const cats = [];
      if (l.estimation?.category) cats.push(l.estimation.category);
      if (l.topCategories) l.topCategories.split(',').map(c => c.trim().toLowerCase()).filter(Boolean).forEach(c => cats.push(c));
      return cats;
    }))].sort(),
    hasAuctions: lots.some(l => (l.channel || '').toLowerCase().includes('auction')),
    hasFixed: lots.some(l => !(l.channel || '').toLowerCase().includes('auction')),
  }), [lots]);
  const showChannelFilter = hasAuctions && hasFixed;

  const activeFilterCount = [
    conditionFilter !== 'all',
    categoryFilter !== 'all',
    channelFilter !== 'all',
    !!minPriceFilter,
    !!maxPriceFilter,
  ].filter(Boolean).length;

  // Manifest segment derived stats (used by status strip)
  const enrichVals = Object.values(enrichments);
  const enrichLoadingCount = enrichVals.filter(e => e.status === 'loading').length;
  const enrichDoneCount    = enrichVals.filter(e => e.status === 'done').length;
  const enrichErrorCount   = enrichVals.filter(e => e.status === 'error').length;
  const enrichTotalCount   = enrichVals.length;
  const totalPriced        = enrichVals.reduce((n, e) => n + (e.totals?.numPriced || 0), 0);
  const totalItems         = enrichVals.reduce((n, e) => n + (e.totals?.numItems || 0), 0);
  const enrichableCount    = lots.filter(l =>
    (l.source?.includes('techliq') && l.palletId && l.manifestSlug) ||
    (l.source === 'liquidation.com' && l.url)
  ).length;
  const unenrichedCount    = enrichableCount - enrichDoneCount;
  const showManifestSegment = lots.length > 0 && enrichableCount > 0;

  return (
    <div className="space-y-4">
      {/* Tier 39 auto-analyze cost dashboard — right-aligned widget showing
          today's spend against the daily cap. Only visible when cloud sync
          is configured + a workspace is active. */}
      <div className="flex justify-end">
        <CostDashboard />
      </div>
      {/* Consolidated status strip — server health + manifest pricing + freshness */}
      <BrowseLotsStatusStrip
        serverOnline={serverOnline}
        hasLots={lots.length > 0}
        loading={loading}
        onLoadMock={() => loadLots(true)}
        onFetchLive={() => loadLots(false)}
        activeBidCount={activeBidCount}
        activeBidCeiling={activeBidCeiling}
        showManifestSegment={showManifestSegment}
        enrichLoading={enrichLoadingCount}
        enrichDone={enrichDoneCount}
        enrichErrors={enrichErrorCount}
        enrichTotal={enrichTotalCount}
        enrichableCount={enrichableCount}
        unenriched={unenrichedCount}
        totalPriced={totalPriced}
        totalItems={totalItems}
        onPrice={() => enrichLots(lots, enrichments)}
        onRerun={() => { setEnrichments({}); persistEnrichments({}); enrichLots(lots, {}); }}
        onCancel={cancelEnrichment}
        scrapedAt={scrapedAt}
        onRefresh={() => loadLots(usedMock)}
        ebayCallStats={ebayCallStats}
        keywordSearchEnabled={keywordSearchEnabled}
        setKeywordSearchEnabled={setKeywordSearchEnabled}
        forceFreshMode={forceFreshMode}
        setForceFreshMode={setForceFreshMode}
        showComparables={showComparables}
        setShowComparables={setShowComparables}
        selectMode={selectMode}
        setSelectMode={setSelectMode}
        selectedCount={selectedIds.length}
        onClearSelection={clearSelection}
      />

      {/* Category landing grid — visible by default to give the user a
          visual entry point. Hides itself once a category filter is picked
          (renders just a "← All categories" pill instead). */}
      {lots.length > 0 && (
        <BrowseLotsCategoryGrid
          lots={lots}
          currentCategory={categoryFilter}
          onPickCategory={setCategoryFilter}
        />
      )}

      {/* At-a-glance summary — clickable stat tiles + category/brand/grade
          pills. Driven off the unfiltered lots list so counts stay accurate
          even when a filter is active. */}
      {lots.length > 0 && (
        <BrowseLotsSummary
          lots={lots}
          signalFilter={signalFilter}
          endingSoonFilter={endingSoonFilter}
          categoryFilter={categoryFilter}
          brandFilter={brandFilter}
          onToggleSignal={(s) => setSignalFilter((curr) => (curr === s ? null : s))}
          onToggleEndingSoon={() => setEndingSoonFilter((v) => !v)}
          onSetCategory={setCategoryFilter}
          onSetBrand={setBrandFilter}
        />
      )}

      {/* Filters + controls — only shown when lots are loaded */}
      {lots.length > 0 && (
        <div className="space-y-2">
          {/* Saved-search strip — rendered only when there are saved searches.
              Chips act as one-tap filter presets; active chip shows a subtle
              accent ring so you know which snapshot you're on. */}
          {savedSearches.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <Bookmark size={12} className="text-fg-subtle shrink-0" />
              {savedSearches.map((s) => {
                const active = activeSavedId === s.id;
                return (
                  <span key={s.id} className="inline-flex items-center group">
                    <button
                      onClick={() => handleLoadSearch(s)}
                      className={`text-xs pl-2.5 pr-1.5 py-0.5 rounded-l-md border transition-colors ${
                        active
                          ? 'border-accent/50 bg-accent-subtle text-accent-fg font-semibold'
                          : 'border-border bg-surface text-fg-muted hover:bg-muted/40 hover:text-fg'
                      }`}
                      title={`Apply "${s.name}"`}
                    >
                      {s.name}
                    </button>
                    <button
                      onClick={() => handleDeleteSearch(s.id)}
                      className={`text-xs px-1 py-0.5 rounded-r-md border-y border-r opacity-0 group-hover:opacity-100 transition-opacity ${
                        active ? 'border-accent/50 text-accent hover:bg-accent-subtle' : 'border-border text-fg-subtle hover:text-danger hover:bg-danger-subtle'
                      }`}
                      title={`Delete "${s.name}"`}
                    >
                      <X size={10} />
                    </button>
                  </span>
                );
              })}
            </div>
          )}

          {/* Single-row filter bar */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Category / keyword search */}
            <div className="relative flex-grow min-w-[160px] max-w-xs">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none" />
              <input
                type="text"
                placeholder="Search: ipad, thinkpad, gpu…"
                value={categorySearch}
                onChange={(e) => setCategorySearch(e.target.value)}
                className="w-full pl-8 pr-3 py-1.5 text-xs border border-border rounded-lg bg-surface text-fg placeholder-textsecondary/60 focus:outline-none focus:ring-1 focus:ring-primary"
              />
              {categorySearch && (
                <button
                  onClick={() => setCategorySearch('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-muted hover:text-fg"
                >
                  <X size={11} />
                </button>
              )}
            </div>

            {/* Hide ended checkbox */}
            <label className="flex items-center gap-1.5 text-xs text-fg-muted cursor-pointer select-none whitespace-nowrap">
              <input
                type="checkbox"
                checked={hideEnded}
                onChange={e => setHideEnded(e.target.checked)}
                className="rounded border-border-strong text-primary focus:ring-primary/30 w-3.5 h-3.5"
              />
              Hide ended
            </label>

            {/* End-date filter */}
            <div className="relative flex items-center gap-1.5">
              <DatePicker
                value={endDateFilter}
                onChange={(v) => setEndDateFilter(v)}
                placeholder="Filter by end date"
                className="text-xs"
              />
              {endDateFilter && (
                <button
                  onClick={() => setEndDateFilter('')}
                  className="text-fg-muted hover:text-fg"
                  title="Clear date filter"
                >
                  <X size={11} />
                </button>
              )}
            </div>

            <div className="border-l border-border mx-2 h-6" />

            {/* Source tabs (middle) */}
            <div className="flex flex-wrap gap-1">
              {['all', ...sources].map((s) => (
                <button
                  key={s}
                  onClick={() => setSourceFilter(s)}
                  className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors ${
                    sourceFilter === s
                      ? 'bg-primary text-white'
                      : 'bg-surface border border-border text-fg-muted hover:bg-muted/40'
                  }`}
                >
                  {s === 'all' ? 'All Sources' : s}
                </button>
              ))}
            </div>

            {/* Sort */}
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="text-xs border border-border rounded-lg px-2 py-1.5 bg-surface text-fg sm:ml-auto"
            >
              <option value="signal">Sort: Best Deal First</option>
              <option value="roi">Sort: Highest ROI</option>
              <option value="end_date">Sort: Ending Soonest</option>
              <option value="price_asc">Sort: Lowest Price</option>
              <option value="price_desc">Sort: Highest Price</option>
            </select>

            {/* View mode toggle (Detail / Compact grid) */}
            <div className="inline-flex items-center bg-surface border border-border rounded-lg p-0.5" role="tablist" aria-label="Lot view mode">
              <button
                type="button"
                onClick={() => switchViewMode('detail')}
                className={`p-1.5 rounded-md transition-colors ${
                  viewMode === 'detail' ? 'bg-primary text-white' : 'text-fg-muted hover:text-fg'
                }`}
                title="Detail view"
                aria-pressed={viewMode === 'detail'}
              >
                <Rows3 size={14} />
              </button>
              <button
                type="button"
                onClick={() => switchViewMode('compact')}
                className={`p-1.5 rounded-md transition-colors ${
                  viewMode === 'compact' ? 'bg-primary text-white' : 'text-fg-muted hover:text-fg'
                }`}
                title="Compact grid"
                aria-pressed={viewMode === 'compact'}
              >
                <LayoutGrid size={14} />
              </button>
            </div>

            {/* More filters popover trigger */}
            <div className="relative">
              <button
                onClick={() => setMoreFiltersOpen((o) => !o)}
                className={`flex items-center gap-1 text-xs border rounded-lg px-2.5 py-1.5 transition-colors whitespace-nowrap ${
                  moreFiltersOpen || activeFilterCount > 0
                    ? 'border-primary/40 bg-primary/5 text-primary'
                    : 'border-border bg-surface text-fg-muted hover:bg-muted/40 hover:text-fg'
                }`}
                title="More filters"
              >
                Filters{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ''} <span className="text-[10px]">{'▾'}</span>
              </button>
              {moreFiltersOpen && (
                <div className="absolute left-0 top-full mt-1 z-30 w-[320px] max-w-[calc(100vw-2rem)] bg-surface rounded-xl border border-border shadow-lg p-4">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-subtle mb-3">
                    Filter lots
                  </p>
                  <div className="flex flex-col gap-3">
                    {conditions.length > 1 && (
                      <label className="flex flex-col gap-1">
                        <span className="text-[11px] font-medium text-fg-muted">Condition</span>
                        <select
                          value={conditionFilter}
                          onChange={(e) => setConditionFilter(e.target.value)}
                          className="text-xs border border-border rounded-lg px-2 py-1.5 bg-surface text-fg"
                        >
                          <option value="all">All Conditions</option>
                          {conditions.map((c) => (
                            <option key={c} value={c}>{c.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase())}</option>
                          ))}
                        </select>
                      </label>
                    )}

                    {categories.length > 1 && (
                      <label className="flex flex-col gap-1">
                        <span className="text-[11px] font-medium text-fg-muted">Category</span>
                        <select
                          value={categoryFilter}
                          onChange={(e) => setCategoryFilter(e.target.value)}
                          className="text-xs border border-border rounded-lg px-2 py-1.5 bg-surface text-fg"
                        >
                          <option value="all">All Categories</option>
                          {categories.map((c) => (
                            <option key={c} value={c}>{c.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase())}</option>
                          ))}
                        </select>
                      </label>
                    )}

                    {showChannelFilter && (
                      <label className="flex flex-col gap-1">
                        <span className="text-[11px] font-medium text-fg-muted">Channel</span>
                        <select
                          value={channelFilter}
                          onChange={(e) => setChannelFilter(e.target.value)}
                          className="text-xs border border-border rounded-lg px-2 py-1.5 bg-surface text-fg"
                        >
                          <option value="all">All Types</option>
                          <option value="auction">Auction Only</option>
                          <option value="fixed">Buy Now Only</option>
                        </select>
                      </label>
                    )}

                    <div className="flex flex-col gap-1">
                      <span className="text-[11px] font-medium text-fg-muted">Price range</span>
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          placeholder="Min $"
                          value={minPriceFilter}
                          onChange={(e) => setMinPriceFilter(e.target.value)}
                          className="flex-1 text-xs border border-border rounded-lg px-2 py-1.5 bg-surface text-fg font-mono placeholder-textsecondary/50"
                        />
                        <span className="text-xs text-fg-muted">{'–'}</span>
                        <input
                          type="number"
                          placeholder="Max $"
                          value={maxPriceFilter}
                          onChange={(e) => setMaxPriceFilter(e.target.value)}
                          className="flex-1 text-xs border border-border rounded-lg px-2 py-1.5 bg-surface text-fg font-mono placeholder-textsecondary/50"
                        />
                      </div>
                    </div>

                    {activeFilterCount > 0 && (
                      <button
                        onClick={() => {
                          setConditionFilter('all');
                          setCategoryFilter('all');
                          setChannelFilter('all');
                          setMinPriceFilter('');
                          setMaxPriceFilter('');
                        }}
                        className="text-xs text-danger hover:underline self-start mt-1"
                      >
                        Clear all filters
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Save current filters */}
            <div className="relative">
              <button
                onClick={() => setSavedSearchOpen((o) => !o)}
                className={`flex items-center gap-1 text-xs border rounded-lg px-2.5 py-1.5 transition-colors whitespace-nowrap ${
                  savedSearchOpen
                    ? 'border-accent/50 bg-accent-subtle text-accent-fg'
                    : 'border-border bg-surface text-fg-muted hover:bg-muted/40 hover:text-fg'
                }`}
                title="Save current filter combination"
              >
                <BookmarkPlus size={11} /> Save <span className="text-[10px]">{'▾'}</span>
              </button>
              {savedSearchOpen && (
                <div className="absolute left-0 top-full mt-1 z-30 w-64 max-w-[calc(100vw-2rem)] glossy-elevated p-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-subtle mb-1.5 px-1">Save this search</p>
                  <div className="flex items-center gap-1.5">
                    <input
                      autoFocus
                      type="text"
                      value={savedSearchName}
                      onChange={(e) => setSavedSearchName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleSaveSearch(); if (e.key === 'Escape') setSavedSearchOpen(false); }}
                      placeholder="e.g. Apple under $500"
                      className="flex-1 text-xs border border-border rounded-md px-2 py-1.5 bg-surface text-fg placeholder-fg-subtle focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/50"
                    />
                    <button
                      onClick={handleSaveSearch}
                      disabled={!savedSearchName.trim()}
                      className="text-[11px] px-2 py-1.5 rounded-md bg-accent text-accent-fg font-semibold disabled:opacity-40 hover:brightness-110 transition-all"
                    >
                      Save
                    </button>
                  </div>
                  <p className="text-[10px] text-fg-subtle mt-1.5 px-1 leading-relaxed">
                    Captures source, search, categories, conditions, price range + sort. Appears as a chip above.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="flex items-start gap-2 px-4 py-3 bg-warning-subtle border border-warning/30 rounded-xl text-sm text-warning">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {/* Loading skeleton with per-source progress (SSE path) */}
      {loading && (
        <div className="space-y-3">
          {Object.keys(sourceProgress).length > 0 ? (
            <div className="rounded-xl border border-border bg-surface p-3 space-y-1.5">
              <div className="flex items-center gap-2 text-sm font-semibold text-fg">
                <Loader2 size={14} className="animate-spin text-primary" />
                Scraping sources…
              </div>
              {Object.entries(sourceProgress).map(([src, info]) => (
                <div key={src} className="flex items-center justify-between text-xs">
                  <span className="text-fg-muted capitalize">{src.replace(/_/g, ' ')}</span>
                  <span className={
                    info.status === 'done'  ? 'text-success font-mono' :
                    info.status === 'error' ? 'text-danger font-mono' :
                                              'text-fg-muted font-mono'
                  }>
                    {info.status === 'done'    ? `✓ ${info.count} lots` :
                     info.status === 'error'  ? `✗ ${info.error || 'failed'}` :
                                                'fetching…'}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-fg-muted">
              <Loader2 size={14} className="animate-spin" />
              Fetching lots from both sources… (this can take 20–30 seconds)
            </div>
          )}
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-40 bg-muted rounded-xl animate-pulse" />
          ))}
        </div>
      )}

      {/* Lot grid */}
      {!loading && displayed.length > 0 && (
        <>
          <p className="text-xs text-fg-muted">
            {displayed.length}{lots.length !== displayed.length ? ` of ${lots.length}` : ''} lots
            {' · '}ROI estimates based on curated MSRP database + condition multipliers
            {usedMock && ' · Using sample data'}
            {scrapedAt && ` · Scraped ${new Date(scrapedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
          </p>

          {/* Bulk actions toolbar (only shown in select mode) */}
          {selectMode && (
            <div className="bg-primary/5 border border-primary/30 rounded-lg p-2.5 flex items-center gap-2 flex-wrap text-xs">
              <span className="font-semibold text-primary">{selectedIds.length} selected</span>
              <button type="button" onClick={() => selectAllVisible(displayed)} className="text-primary hover:underline">All visible ({displayed.length})</button>
              <span className="text-primary/40">/</span>
              <button type="button" onClick={clearSelection} className="text-primary hover:underline">Clear</button>
              <span className="mx-1 text-fg-subtle">|</span>
              <button type="button" onClick={bulkStar} disabled={!selectedIds.length || bulkBusy}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-surface border border-border text-fg text-xs hover:bg-muted disabled:opacity-50">
                <Star size={14} /> Star
              </button>
              <button type="button" onClick={bulkUnstar} disabled={!selectedIds.length || bulkBusy}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-surface border border-border text-fg text-xs hover:bg-muted disabled:opacity-50">
                <StarOff size={14} /> Unstar
              </button>
              <button type="button" onClick={bulkPriceManifests} disabled={!selectedIds.length || bulkBusy}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-surface border border-border text-fg text-xs hover:bg-muted disabled:opacity-50">
                <Zap size={14} /> Price manifests
              </button>
              <button type="button" onClick={bulkBid} disabled={!selectedIds.length || bulkBusy}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-surface border border-border text-fg text-xs hover:bg-muted disabled:opacity-50">
                <Gavel size={14} /> Log bids
              </button>
              {bulkResult && (
                <span className={`text-[11px] ${bulkResult.ok ? 'text-success' : 'text-danger'} ml-2`}>
                  {bulkResult.ok ? '✓ ' : '✗ '}{bulkResult.msg}
                </span>
              )}
            </div>
          )}

          <div className={
            viewMode === 'compact'
              ? 'grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3'
              : 'grid grid-cols-1 sm:grid-cols-2 gap-3'
          }>
            {/* LazyMount removed: at typical Browse Lots sizes (under a few
                hundred lots) it costs more than it saves and its
                IntersectionObserver doesn't reliably re-fire after sort
                reorders, leaving cards permanently blank. */}
            {visibleLots.map((lot) => (
              <div key={lot.id} className="relative">
                {selectMode && (
                  <button
                    type="button"
                    onClick={() => toggleSelect(lot.id)}
                    className={`absolute top-2 left-2 z-20 w-6 h-6 rounded-md flex items-center justify-center text-xs font-bold transition-colors ${
                      selected[lot.id]
                        ? 'bg-primary text-white'
                        : 'bg-surface/80 backdrop-blur border border-border text-fg-muted hover:bg-surface hover:border-primary'
                    }`}
                    title={selected[lot.id] ? 'Deselect' : 'Select'}
                  >
                    {selected[lot.id] ? '✓' : ''}
                  </button>
                )}
                {viewMode === 'compact' ? (
                  <LotCardCompact
                    lot={lot}
                    onAnalyze={onAnalyzeLot}
                    enrichment={enrichments[lot.id]}
                    isWatched={!!watchlist[lot.id]}
                    onToggleWatch={toggleWatch}
                    onQuickBid={quickBid}
                    hasActiveBid={bidLotIds.has(lot.id)}
                    liqEstimate={liqEstimatesByLot[lot.id]}
                  />
                ) : (
                  <LotCard
                    lot={lot}
                    onAnalyze={onAnalyzeLot}
                    enrichment={enrichments[lot.id]}
                    lotNotes={lotNotes}
                    onSaveNote={persistNote}
                    isWatched={!!watchlist[lot.id]}
                    onToggleWatch={toggleWatch}
                    onQuickBid={quickBid}
                    onQuickCompare={quickCompare}
                    comparableCloses={showComparables ? comparablesByLot[lot.id] : null}
                    hasActiveBid={bidLotIds.has(lot.id)}
                    liqEstimate={liqEstimatesByLot[lot.id]}
                    onPriceLot={() => priceSingleLot(lot)}
                  />
                )}
              </div>
            ))}
          </div>

          {/* Load more — reveals the next window of cards. Keeps the initial
              paint cheap on big scrapes while still allowing access to all lots. */}
          {visibleCount < displayed.length && (
            <div className="flex justify-center pt-4">
              <button
                type="button"
                onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-surface border border-border text-fg text-sm font-medium hover:bg-muted transition-colors"
              >
                Load more
                <span className="text-fg-muted">
                  ({Math.min(PAGE_SIZE, displayed.length - visibleCount)} of {displayed.length - visibleCount} remaining)
                </span>
              </button>
            </div>
          )}
        </>
      )}

      {/* No results after filtering */}
      {!loading && lots.length > 0 && displayed.length === 0 && (
        <div className="text-center py-12 text-fg-muted">
          <Search size={28} className="mx-auto mb-3 opacity-30" />
          <p className="font-medium">No lots match your filters</p>
          <p className="text-sm mt-1">Try a different keyword or clear the date filter.</p>
        </div>
      )}

      {/* Empty state */}
      {!loading && lots.length === 0 && serverOnline !== null && !error && (
        <div className="text-center py-12 text-fg-muted">
          <Globe size={32} className="mx-auto mb-3 opacity-30" />
          <p className="font-medium">No lots loaded</p>
          <p className="text-sm mt-1">
            {serverOnline ? 'Click Fetch Live Lots above to pull from your configured sources.' : 'Start the pipeline server or load sample data to get started.'}
          </p>
        </div>
      )}
    </div>
  );
}

export default BrowseLotsView;
