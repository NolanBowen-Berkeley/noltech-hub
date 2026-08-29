// ─── Auto-Sync Hook ───────────────────────────────────────────────────────────
// Runs background tasks on configurable intervals:
// 1. Auto-scrape lots from liquidation sites
// 2. Auto-price manifests after scrape
// 3. Auto-sync eBay orders and match to inventory

import { useEffect, useRef, useCallback } from 'react';
import { decryptObject } from '../services/crypto';
import { EBAY_TOKEN_KEY, PIPELINE_BASE } from '../utils/constants';
import eventBus from '../services/eventBus';
import { pollClosingPrices } from '../services/lotHistory';
import { mergeUpcCache, saveUpcCache } from '../utils/upcCacheMerge';
import { PRICE_REASON, isMarkdown, appendHistoryRow } from '../utils/priceHistoryReasons';

const SYNC_KEY   = 'noltech:settings:auto-sync';
const BROWSE_KEY = 'noltech:arbitrage:browse-lots';
const PIPELINE    = PIPELINE_BASE;

const DEFAULTS = {
  scrapeEnabled:   false,
  scrapeInterval:  30,    // minutes
  priceEnabled:    false,
  priceAfterScrape: true, // auto-price after scrape (not on separate timer)
  ebayEnabled:     false,
  ebayInterval:    60,    // minutes
  ebayDaysBack:    90,    // how many days of orders to sync
  // TechLiquidators closing-price poller — fills in finalBid for ended lots
  // already in our local history. Low volume (≤10 requests/cycle), throttled
  // internally with 1.5s+ jitter between requests, no auth needed.
  closingPriceEnabled:  true,
  closingPriceInterval: 60, // minutes
  // eBay Best Offer background auto-responder. Disabled by default — user
  // turns on per-rule in Sell → Offers → Rules, and toggles autoBackground
  // there. This config just controls the polling cadence.
  offersAutoEnabled:    false,
  offersAutoInterval:   15,  // minutes — offer-clock-sensitive, poll often
};

export default function useAutoSync(dispatch) {
  const configRef  = useRef(DEFAULTS);
  const timersRef  = useRef({});
  const runningRef = useRef({});

  // ── Load config from storage ──
  useEffect(() => {
    window.storage.get(SYNC_KEY)
      .then(v => { if (v) configRef.current = { ...DEFAULTS, ...v }; })
      .catch(e => console.error('[useAutoSync] config load failed:', e));
  }, []);

  // ── Auto-scrape ──
  const doScrape = useCallback(async () => {
    if (runningRef.current.scrape) return;
    runningRef.current.scrape = true;
    console.log('[auto-sync] Scraping lots...');
    try {
      // Get enabled sources
      let sourcesParam = '';
      try {
        const sourceConfig = await window.storage.get('noltech:settings:sources');
        if (sourceConfig?.enabled?.length) sourcesParam = '?sources=' + sourceConfig.enabled.join(',');
      } catch (e) { console.error('[useAutoSync] source config load failed:', e); }

      const res = await fetch(`${PIPELINE}/api/lots/all${sourcesParam}`, { signal: AbortSignal.timeout(120000) });
      const data = await res.json();
      if (data.lots?.length) {
        const now = new Date().toISOString();
        // Load existing enrichments to preserve them
        const cached = await window.storage.get(BROWSE_KEY).catch(() => null);
        const freshIds = new Set(data.lots.map(l => l.id));
        const keptEnrich = {};
        if (cached?.enrichments) {
          for (const [id, d] of Object.entries(cached.enrichments)) {
            if (freshIds.has(id)) keptEnrich[id] = d;
          }
        }
        await window.storage.set(BROWSE_KEY, {
          lots: data.lots, usedMock: false, scrapedAt: now, _version: 2, enrichments: keptEnrich,
        });
        console.log(`[auto-sync] Scraped ${data.lots.length} lots`);
        eventBus.emit('lots:scraped', { count: data.lots.length });

        // Auto-price manifests if enabled
        if (configRef.current.priceAfterScrape && configRef.current.priceEnabled) {
          await doPrice(data.lots, keptEnrich);
        }
      }
    } catch (e) {
      console.error('[auto-sync] Scrape failed:', e.message);
    } finally {
      runningRef.current.scrape = false;
    }
  }, []);

  // ── Auto-price manifests ──
  const doPrice = useCallback(async (lots, existingEnrichments) => {
    if (runningRef.current.price) return;
    runningRef.current.price = true;
    console.log('[auto-sync] Pricing manifests...');
    try {
      // Load lots if not passed
      if (!lots) {
        const cached = await window.storage.get(BROWSE_KEY).catch(() => null);
        lots = cached?.lots || [];
        existingEnrichments = cached?.enrichments || {};
      }

      // Get credentials
      let appId = '', certId = '';
      try {
        const rawCreds = await window.storage.get(EBAY_TOKEN_KEY);
        const creds = await decryptObject(rawCreds || {});
        appId = creds?.appId?.trim() || '';
        certId = creds?.certId?.trim() || '';
      } catch (e) { console.error('[useAutoSync] credential load failed:', e); }

      // Only price TechLiquidators lots (Liquidation.com uses MSRP/4)
      const tlLots = lots.filter(l =>
        l.source?.includes('techliq') && l.palletId && l.manifestSlug &&
        existingEnrichments?.[l.id]?.status !== 'done'
      );

      if (!tlLots.length) { runningRef.current.price = false; return; }

      // Batch enrichment: 4 lots in flight at a time. Server already handles per-lot
      // UPC concurrency=5, so 4 × 5 = 20 concurrent UPC lookups is a safe ceiling.
      const BATCH = 4;
      const enrichOne = async (lot) => {
        try {
          const resp = await fetch(`${PIPELINE}/api/lots/enrich`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ palletId: lot.palletId, manifestSlug: lot.manifestSlug, appId, certId }),
            signal: AbortSignal.timeout(90000),
          });
          const data = await resp.json();
          if (data.success) {
            existingEnrichments[lot.id] = { status: 'done', manifestItems: data.manifestItems, totals: data.totals };
          }
        } catch (e) { console.error('[useAutoSync] lot enrichment failed:', e); }
      };
      for (let i = 0; i < tlLots.length; i += BATCH) {
        const slice = tlLots.slice(i, i + BATCH);
        await Promise.all(slice.map(enrichOne));
      }

      // Save enrichments back
      const cached = await window.storage.get(BROWSE_KEY).catch(() => null);
      if (cached) {
        await window.storage.set(BROWSE_KEY, { ...cached, enrichments: existingEnrichments });
      }

      // Sync UPC cache — MERGE with local cache, never overwrite. Without
      // the merge, a smaller server cache (e.g. after a failed reprice run)
      // would wipe local entries plus all client-only fields like
      // cleanTitle. See utils/upcCacheMerge.js.
      try {
        const cacheResp = await fetch(`${PIPELINE}/api/upc-cache`, { signal: AbortSignal.timeout(5000) });
        const cacheData = await cacheResp.json();
        if (cacheData.success && cacheData.cache) {
          const local = (await window.storage.get('noltech:arbitrage:upc-cache')) || {};
          const merged = mergeUpcCache(local, cacheData.cache);
          await saveUpcCache(merged);
          eventBus.emit('sync:array-updated', { storageKey: 'noltech:arbitrage:upc-cache' });
        }
      } catch (e) { console.error('[useAutoSync] UPC cache sync failed:', e); }

      console.log(`[auto-sync] Priced ${tlLots.length} lots`);
    } catch (e) {
      console.error('[auto-sync] Pricing failed:', e.message);
    } finally {
      runningRef.current.price = false;
    }
  }, []);

  // ── Auto-sync eBay orders ──
  const doEbaySync = useCallback(async () => {
    if (runningRef.current.ebay) return;
    runningRef.current.ebay = true;
    console.log('[auto-sync] Syncing eBay orders...');
    try {
      const rawCreds = await window.storage.get(EBAY_TOKEN_KEY);
      const creds = await decryptObject(rawCreds || {});
      const token = creds?.token?.trim();
      if (!token) { runningRef.current.ebay = false; return; }

      const end = new Date();
      const daysBack = configRef.current.ebayDaysBack || 90;
      const start = new Date(end.getTime() - daysBack * 86400000);
      const resp = await fetch(`${PIPELINE}/api/ebay/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userToken: token,
          appId: creds?.appId || '',
          devId: creds?.devId || '',
          certId: creds?.certId || '',
          startDate: start.toISOString(),
          endDate: end.toISOString(),
        }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await resp.json();
      if (data.success && data.orders?.length) {
        console.log(`[auto-sync] Fetched ${data.orders.length} eBay orders`);
        eventBus.emit('ebay:orders-synced', { count: data.orders.length, orders: data.orders });
      }
    } catch (e) {
      console.error('[auto-sync] eBay sync failed:', e.message);
    } finally {
      runningRef.current.ebay = false;
    }
  }, []);

  // ── Start/stop timers based on config ──
  useEffect(() => {
    const startTimers = async () => {
      const config = await window.storage.get(SYNC_KEY).catch(() => null);
      if (config) configRef.current = { ...DEFAULTS, ...config };
      const c = configRef.current;

      // Clear old timers
      Object.values(timersRef.current).forEach(clearInterval);
      timersRef.current = {};

      if (c.scrapeEnabled && c.scrapeInterval > 0) {
        console.log(`[auto-sync] Scrape timer: every ${c.scrapeInterval}m`);
        timersRef.current.scrape = setInterval(doScrape, c.scrapeInterval * 60000);
      }

      if (c.ebayEnabled && c.ebayInterval > 0) {
        console.log(`[auto-sync] eBay sync timer: every ${c.ebayInterval}m`);
        timersRef.current.ebay = setInterval(doEbaySync, c.ebayInterval * 60000);
      }

      if (c.closingPriceEnabled && c.closingPriceInterval > 0) {
        console.log(`[auto-sync] TL closing-price poll: every ${c.closingPriceInterval}m`);
        const doClosingPoll = async () => {
          if (runningRef.current.closingPrice) return;
          runningRef.current.closingPrice = true;
          try {
            const r = await pollClosingPrices({ limit: 10, minHoursSinceLastCheck: 6 });
            if (r.checked > 0) console.log(`[auto-sync] closes: checked ${r.checked}, updated ${r.updated}, errors ${r.errors}`);
            // Recompute the Liquidation.com close-ratio model whenever new
            // closes land so the bid estimator stays current.
            if (r.updated > 0) {
              try {
                const { computeLiqCloseRatios } = await import('../services/liqBidModel');
                const model = await computeLiqCloseRatios();
                console.log(`[auto-sync] liq close-ratio model: ${model.totalCloses} closes across ${Object.keys(model.categories).length} categories`);
              } catch (e) { console.warn('[auto-sync] liq ratio recompute failed:', e?.message || e); }
            }
          } catch (e) { console.error('[auto-sync] closes poll failed:', e); }
          finally { runningRef.current.closingPrice = false; }
        };
        // Run once shortly after startup so a freshly-launched session catches up
        setTimeout(doClosingPoll, 60000);
        timersRef.current.closingPrice = setInterval(doClosingPoll, c.closingPriceInterval * 60000);
      }

      // ── eBay Best Offer auto-responder (background) ──
      // Polls pending offers and applies the user's rules. Safety bounds
      // (daily cap, dry-run, item exclusions) are enforced in the service.
      if (c.offersAutoEnabled && c.offersAutoInterval > 0) {
        console.log(`[auto-sync] Offer auto-responder: every ${c.offersAutoInterval}m`);
        const doOfferAuto = async () => {
          if (runningRef.current.offers) return;
          runningRef.current.offers = true;
          try {
            const { runAutoCycle } = await import('../services/offerAutomation.js');
            const r = await runAutoCycle();
            if (r.cycleSkipped) {
              if (r.reason !== 'disabled') {
                console.log(`[auto-sync] offers: skipped (${r.reason})`);
              }
            } else if (r.acted > 0 || r.errored > 0) {
              console.log(`[auto-sync] offers: ${r.acted} acted${r.dryRun ? ' (DRY RUN)' : ''}, ${r.notActionable} not-actionable, ${r.errored} errored (${r.todayCount}/${r.cap} today)`);
            }
          } catch (e) {
            console.error('[auto-sync] offer auto-responder failed:', e);
          } finally {
            runningRef.current.offers = false;
          }
        };
        setTimeout(doOfferAuto, 30000); // 30s after startup
        timersRef.current.offers = setInterval(doOfferAuto, c.offersAutoInterval * 60000);
      }
    };

    startTimers();

    // ── Auto-markdown stale listings (runs once on startup) ──
    (async () => {
      try {
        const reducerConfig = await window.storage.get('noltech:pricereductor:auto').catch(() => null);
        if (!reducerConfig?.enabled) return;

        const lots = (await window.storage.get('noltech:inventory:lots').catch(() => [])) || [];
        const allItems = lots.flatMap(l => (l.items || []).map(i => ({ ...i, _lotDate: l.purchaseDate })));
        const staleDays = reducerConfig.daysThreshold || 30;
        const reductionPct = reducerConfig.reductionPct || 10;
        const now = Date.now();
        let reduced = 0;

        for (const item of allItems) {
          if (item.status !== 'listed' || !item.listingPrice) continue;
          const listedDate = item.dateAdded || item._lotDate;
          if (!listedDate) continue;
          const age = Math.floor((now - new Date(listedDate).getTime()) / 86400000);
          if (age < staleDays) continue;

          // Cooldown: skip if ANY markdown (manual batch or prior auto run)
          // landed within the last 7 days. Using isMarkdown — direction-
          // semantic — so a user's batch reduction yesterday correctly
          // blocks today's auto-markdown, which the old equality filter
          // on 'auto_markdown' missed.
          const history = (await window.storage.get('noltech:price-history').catch(() => ({}))) || {};
          const itemHistory = history[item.id] || [];
          const lastReduction = [...itemHistory].reverse().find((h) => isMarkdown(h));
          if (lastReduction) {
            const daysSinceReduction = (now - new Date(lastReduction.date).getTime()) / 86400000;
            if (daysSinceReduction < 7) continue;
          }

          const newPrice = Math.round(item.listingPrice * (1 - reductionPct / 100) * 100) / 100;
          dispatch({ type: 'UPDATE_ITEM', id: item.id, updates: { listingPrice: newPrice } });
          eventBus.emit('price:changed', {
            itemId: item.id,
            oldPrice: item.listingPrice,
            newPrice,
            reason: PRICE_REASON.AUTO_MARKDOWN,
          });

          // Log to price history (canonical full-ISO date via appendHistoryRow).
          history[item.id] = appendHistoryRow(itemHistory, {
            price: newPrice,
            reason: PRICE_REASON.AUTO_MARKDOWN,
            oldPrice: item.listingPrice,
          });
          await window.storage.set('noltech:price-history', history);
          reduced++;
        }

        if (reduced > 0) {
          eventBus.emit('notification:push', {
            type: 'info',
            title: 'Auto Price Reduction',
            message: `${reduced} stale listing${reduced !== 1 ? 's' : ''} reduced by ${reductionPct}%`,
          });
        }
      } catch (e) { console.error('[auto-sync] Stale listing markdown error:', e); }
    })();

    // ── Scheduled listings — notify when due ──
    const checkScheduled = async () => {
      try {
        const list = (await window.storage.get('noltech:inventory:scheduled-listings').catch(() => [])) || [];
        const nowMs = Date.now();
        let changed = false;
        const next = list.map(s => {
          if (s.status === 'pending' && new Date(s.scheduledAt).getTime() <= nowMs && !s.notified) {
            eventBus.emit('notification:push', {
              type: 'info',
              title: 'Listings Ready to Post',
              message: `${s.listings.length} scheduled listing${s.listings.length !== 1 ? 's' : ''} for "${s.lotName}" is due — export now.`,
            });
            changed = true;
            return { ...s, notified: true };
          }
          return s;
        });
        if (changed) await window.storage.set('noltech:inventory:scheduled-listings', next);
      } catch (e) { console.error('[auto-sync] Scheduled check error:', e); }
    };
    checkScheduled();
    timersRef.current.scheduled = setInterval(checkScheduled, 60000);

    // Listen for config changes
    const unsub = eventBus.on('autosync:config-changed', startTimers);

    return () => {
      Object.values(timersRef.current).forEach(clearInterval);
      unsub();
    };
  }, [doScrape, doEbaySync, dispatch]);
}
