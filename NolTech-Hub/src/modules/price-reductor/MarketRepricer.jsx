// ─── Market Repricer ──────────────────────────────────────────────────────────
// Scans active listings, pulls eBay market comps by title, and surfaces pricing
// suggestions (reduce to beat market, or raise to match rising market).

import { useState, useCallback, useMemo } from 'react';
import { RefreshCw, TrendingDown, TrendingUp, Check, X, AlertCircle, Loader2, Search } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { EBAY_TOKEN_KEY, PIPELINE_BASE } from '../../utils/constants';
import { decryptObject } from '../../services/crypto';
import { fmt } from '../../utils/formatters';
import { Button, Card, Badge, Input } from '../../components/ui';

const CACHE_KEY = 'noltech:marketrepricer:cache';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function titleFor(item) {
  return item.ebayTitle || item.model || [item.brand, item.model].filter(Boolean).join(' ') || item.serialNumber || '';
}

export default function MarketRepricer() {
  const { state, dispatch } = useApp();
  const [analyzing, setAnalyzing]     = useState(false);
  const [progress,  setProgress]      = useState({ done: 0, total: 0 });
  const [suggestions, setSuggestions] = useState([]);  // { itemId, currentPrice, median, low, high, sampleSize, suggestion, reason }
  const [error, setError]             = useState('');
  const [bufferPct, setBufferPct]     = useState(3);    // %: aim this much below median to win buy-box

  // Flatten listed items
  const listedItems = useMemo(() => {
    return state.lots.flatMap((l) =>
      (l.items || []).filter((i) => i.status === 'listed' && i.listingPrice > 0)
        .map((i) => ({ ...i, _lot: l }))
    );
  }, [state.lots]);

  const runAnalysis = useCallback(async () => {
    setAnalyzing(true);
    setError('');
    setSuggestions([]);
    setProgress({ done: 0, total: listedItems.length });

    try {
      // Get eBay creds
      const rawCreds = await window.storage.get(EBAY_TOKEN_KEY);
      const creds = await decryptObject(rawCreds || {});
      const appId  = creds?.appId?.trim();
      const certId = creds?.certId?.trim();
      if (!appId || !certId) {
        setError('eBay credentials missing. Add appId + certId in Settings.');
        setAnalyzing(false);
        return;
      }

      // Load cache
      let cache = await window.storage.get(CACHE_KEY) || {};

      const out = [];
      for (let i = 0; i < listedItems.length; i++) {
        const item = listedItems[i];
        const title = titleFor(item);
        if (!title) { setProgress({ done: i + 1, total: listedItems.length }); continue; }

        const cacheKey = title.toLowerCase().slice(0, 60);
        let market = cache[cacheKey];
        if (!market || (Date.now() - market._cachedAt > CACHE_TTL_MS)) {
          try {
            const resp = await fetch(`${PIPELINE_BASE}/api/ebay/market-price`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ query: title, appId, certId }),
              signal: AbortSignal.timeout(10000),
            });
            const data = await resp.json();
            if (data.success) {
              market = { ...data, _cachedAt: Date.now() };
              cache[cacheKey] = market;
            }
          } catch (e) {
            console.error('[MarketRepricer] lookup failed:', title, e);
          }
        }

        if (market && market.success !== false && market.median) {
          const currentPrice = parseFloat(item.listingPrice) || 0;
          const buffer = 1 - (parseFloat(bufferPct) / 100);
          const targetPrice = Math.round(market.median * buffer * 100) / 100;
          const diff = targetPrice - currentPrice;
          const diffPct = currentPrice > 0 ? (diff / currentPrice) * 100 : 0;

          let suggestion = null;
          let reason = '';
          if (diff < -0.5 && Math.abs(diffPct) > 2) {
            suggestion = targetPrice;
            reason = `Market median $${market.median.toFixed(2)}; drop to beat competition`;
          } else if (diff > 0.5 && diffPct > 5) {
            suggestion = targetPrice;
            reason = `Market median $${market.median.toFixed(2)}; you can raise`;
          } else {
            reason = 'Within market range';
          }

          out.push({
            itemId: item.id,
            title,
            brand: item.brand,
            currentPrice,
            median: market.median,
            low: market.low,
            high: market.high,
            sampleSize: market.sampleSize,
            suggestion,
            targetPrice,
            diff,
            diffPct,
            reason,
          });
        }

        setProgress({ done: i + 1, total: listedItems.length });
      }

      // Persist cache
      await window.storage.set(CACHE_KEY, cache);

      // Show actionable suggestions first
      out.sort((a, b) => {
        if (a.suggestion && !b.suggestion) return -1;
        if (!a.suggestion && b.suggestion) return 1;
        return Math.abs(b.diff) - Math.abs(a.diff);
      });
      setSuggestions(out);
    } catch (e) {
      setError(e.message || 'Analysis failed');
    } finally {
      setAnalyzing(false);
    }
  }, [listedItems, bufferPct]);

  const applySuggestion = useCallback((s) => {
    if (!s.suggestion) return;
    dispatch({ type: 'UPDATE_ITEM', id: s.itemId, updates: { listingPrice: s.suggestion } });
    setSuggestions((prev) => prev.map((x) => x.itemId === s.itemId ? { ...x, applied: true } : x));
  }, [dispatch]);

  const applyAll = useCallback(() => {
    const actionable = suggestions.filter((s) => s.suggestion && !s.applied);
    if (!actionable.length) return;
    if (!confirm(`Apply ${actionable.length} price changes?`)) return;
    actionable.forEach(applySuggestion);
  }, [suggestions, applySuggestion]);

  const actionableCount = suggestions.filter((s) => s.suggestion && !s.applied).length;
  const totals = useMemo(() => {
    const analyzed = suggestions.length;
    const suggested = suggestions.filter((s) => s.suggestion).length;
    const wouldGain = suggestions.filter((s) => s.suggestion && s.diff > 0 && !s.applied).reduce((sum, s) => sum + s.diff, 0);
    const wouldLose = suggestions.filter((s) => s.suggestion && s.diff < 0 && !s.applied).reduce((sum, s) => sum + Math.abs(s.diff), 0);
    return { analyzed, suggested, wouldGain, wouldLose };
  }, [suggestions]);

  return (
    <div className="space-y-4">
      <Card padding="md">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-sm font-semibold text-fg">Market-Based Repricing</h3>
            <p className="text-xs text-fg-muted mt-0.5">
              Compare your active listings to current eBay market. {listedItems.length} listing{listedItems.length !== 1 ? 's' : ''} to analyze.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[10px] text-fg-muted uppercase tracking-wider">Buffer % below median</label>
            <Input
              size="sm"
              type="number"
              min="0"
              max="20"
              step="0.5"
              value={bufferPct}
              onChange={(e) => setBufferPct(e.target.value)}
              className="w-20 font-mono"
            />
            <Button variant="accent" size="sm" onClick={runAnalysis} loading={analyzing}>
              {!analyzing && <RefreshCw />}
              {analyzing ? `Analyzing ${progress.done}/${progress.total}…` : 'Analyze Market'}
            </Button>
          </div>
        </div>

        {error && (
          <div className="mt-3 flex items-center gap-2 bg-danger-subtle border border-danger/20 rounded-lg px-3 py-2 text-xs text-danger-fg">
            <AlertCircle size={13} /> {error}
          </div>
        )}
      </Card>

      {suggestions.length > 0 && (
        <Card padding="none" radius="lg" className="overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/30">
            <div className="flex items-center gap-4 text-xs text-fg-muted">
              <span>{totals.analyzed} analyzed</span>
              <span>{totals.suggested} suggested changes</span>
              {totals.wouldGain > 0 && <span className="text-success">+{fmt(totals.wouldGain)} potential</span>}
              {totals.wouldLose > 0 && <span className="text-danger">−{fmt(totals.wouldLose)} reductions</span>}
            </div>
            {actionableCount > 0 && (
              <Button variant="accent" size="sm" onClick={applyAll}>
                Apply All ({actionableCount})
              </Button>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/40 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
                  <th className="px-3 py-1.5 text-left">Item</th>
                  <th className="px-3 py-1.5 text-right">Current</th>
                  <th className="px-3 py-1.5 text-right">Market Med.</th>
                  <th className="px-3 py-1.5 text-right">Target</th>
                  <th className="px-3 py-1.5 text-right">Δ</th>
                  <th className="px-3 py-1.5 text-left">Reason</th>
                  <th className="px-3 py-1.5 w-20"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {suggestions.map((s) => (
                  <tr key={s.itemId} className="hover:bg-muted/30">
                    <td className="px-3 py-2">
                      <p className="text-sm text-fg truncate max-w-[260px]">{s.title}</p>
                      <p className="text-[10px] text-fg-subtle">{s.sampleSize} comps</p>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{fmt(s.currentPrice)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-fg-muted">{fmt(s.median)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{s.suggestion ? fmt(s.targetPrice) : <span className="text-fg-subtle">—</span>}</td>
                    <td className={`px-3 py-2 text-right font-mono text-xs font-semibold ${s.diff > 0.5 ? 'text-success' : s.diff < -0.5 ? 'text-danger' : 'text-fg-subtle'}`}>
                      {s.suggestion ? (s.diff > 0 ? '+' : '') + fmt(s.diff) : '—'}
                    </td>
                    <td className="px-3 py-2 text-[11px] text-fg-muted">
                      <div className="flex items-center gap-1.5">
                        {s.suggestion && (s.diff > 0 ? <TrendingUp className="size-3 text-success" /> : <TrendingDown className="size-3 text-danger" />)}
                        <span className="truncate max-w-[200px]">{s.reason}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {s.applied ? (
                        <Badge variant="success" size="xs"><Check className="size-3" /> Applied</Badge>
                      ) : s.suggestion ? (
                        <Button variant="secondary" size="xs" onClick={() => applySuggestion(s)}>Apply</Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {!analyzing && suggestions.length === 0 && listedItems.length === 0 && (
        <Card padding="lg" className="text-center">
          <Search className="mx-auto size-8 text-fg-subtle opacity-50 mb-3" />
          <p className="text-sm font-semibold text-fg">No active listings</p>
          <p className="text-xs text-fg-muted mt-1">Sync your eBay listings first, then run a market analysis.</p>
        </Card>
      )}
    </div>
  );
}
