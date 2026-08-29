// ─── Sold Comps Panel ─────────────────────────────────────────────────────────
// Reusable panel that looks up recent eBay sold prices for a product query.
//
// Reads from the Supabase `sold_comps` cache; on cache miss / stale row, calls
// the AWS Lambda Function URL configured in Settings → Sold-Comps Service.
//
// Props:
//   initialQuery  — pre-fill the search box with this string
//   autoFetch     — if true, fire a fetch on mount when initialQuery is set
//   compact       — minimal layout (top stats row + first 5 samples, no big gaps)
//
// Cloud-sync requirement: this panel needs Supabase configured (because the
// cache is workspace-scoped). When cloud is disabled the empty state explains
// that and points the user to Settings.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Search,
  Loader2,
  RefreshCw,
  ExternalLink,
  AlertTriangle,
  PackageX,
  CloudOff,
  Clock,
} from 'lucide-react';
import { fmt, formatDateShort } from '../utils/formatters';
import { Button, Input, Badge } from './ui';
import {
  fetchSoldComps,
  buildCacheKey,
  isLambdaConfigured,
} from '../services/soldComps';
import { supabase, isCloudEnabled, getActiveWorkspace } from '../services/supabase';

function relativeAge(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  const days = Math.round(diff / 86_400_000);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

function priceClass(p) {
  if (p === null || p === undefined) return 'text-fg-muted';
  return 'text-fg';
}

function ConditionPill({ label }) {
  if (!label) return null;
  const lower = String(label).toLowerCase();
  let variant = 'neutral';
  if (lower.includes('new')) variant = 'success';
  else if (lower.includes('refurb')) variant = 'info';
  else if (lower.includes('parts')) variant = 'danger';
  else if (lower.includes('used') || lower.includes('pre-owned')) variant = 'neutral';
  return <Badge variant={variant} size="xs">{label}</Badge>;
}

function SampleRow({ sample, compact }) {
  const total = sample.totalPrice ?? sample.total_price ?? sample.price;
  const title = sample.title || 'Untitled listing';
  const img   = sample.imageUrl || sample.image_url || null;
  const link  = sample.itemUrl  || sample.item_url  || null;
  const sold  = sample.soldAt   || sample.sold_at   || sample.endDate || null;
  const cond  = sample.conditionLabel || sample.condition_label || sample.condition || null;

  return (
    <div className="flex items-center gap-3 py-2 border-b border-border-subtle last:border-0">
      {img ? (
        <img
          src={img}
          alt=""
          loading="lazy"
          onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
          className={`shrink-0 ${compact ? 'size-8' : 'size-10'} rounded-md bg-muted object-cover`}
        />
      ) : (
        <div className={`shrink-0 ${compact ? 'size-8' : 'size-10'} rounded-md bg-muted/60 flex items-center justify-center`}>
          <PackageX className="size-3 text-fg-subtle" />
        </div>
      )}
      <div className="flex-1 min-w-0">
        {link ? (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-fg hover:text-accent line-clamp-1 inline-flex items-center gap-1"
            title={title}
          >
            <span className="truncate">{title}</span>
            <ExternalLink className="size-3 text-fg-subtle shrink-0" />
          </a>
        ) : (
          <p className="text-xs text-fg line-clamp-1" title={title}>{title}</p>
        )}
        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-fg-muted">
          <ConditionPill label={cond} />
          {sold && <span>sold {formatDateShort(sold)}</span>}
        </div>
      </div>
      <div className={`text-right shrink-0 font-mono font-semibold ${compact ? 'text-xs' : 'text-sm'} ${priceClass(total)}`}>
        {fmt(total)}
      </div>
    </div>
  );
}

export default function SoldCompsPanel({
  initialQuery = '',
  autoFetch = false,
  compact = false,
}) {
  const [query, setQuery]   = useState(initialQuery || '');
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState(null);
  const [lambdaReady, setLambdaReady] = useState(false);
  const [hasCloud, setHasCloud] = useState(false);
  const [workspaceId, setWorkspaceId] = useState(null);

  // Track the last fetched query so realtime updates only refetch when relevant.
  const activeQueryRef = useRef('');
  const soldDays = 90;

  // Refresh "is cloud + lambda available?" once on mount and whenever the user
  // toggles into the panel — cheap and gives accurate empty-state copy.
  useEffect(() => {
    let alive = true;
    (async () => {
      if (alive) setHasCloud(!!isCloudEnabled);
      try {
        const ws = isCloudEnabled ? await getActiveWorkspace() : null;
        if (alive) setWorkspaceId(ws);
      } catch { if (alive) setWorkspaceId(null); }
      try {
        const ok = await isLambdaConfigured();
        if (alive) setLambdaReady(!!ok);
      } catch { if (alive) setLambdaReady(false); }
    })();
    return () => { alive = false; };
  }, []);

  const runFetch = useCallback(async ({ force = false, q = null } = {}) => {
    const useQ = (q ?? query ?? '').trim();
    if (!useQ) return;
    setError(null);
    setLoading(true);
    activeQueryRef.current = useQ;
    try {
      const res = await fetchSoldComps(useQ, { soldDays, forceRefresh: force });
      setData(res);
    } catch (e) {
      setError(e?.message || 'Lookup failed');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [query]);

  // Auto-fetch on mount if asked.
  useEffect(() => {
    if (!autoFetch) return;
    const seed = (initialQuery || '').trim();
    if (!seed) return;
    // Don't await — let React paint the loading state first.
    runFetch({ q: seed });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFetch, initialQuery]);

  // ── Realtime subscription ───────────────────────────────────────────────
  // Subscribe to row changes for the current cache_key so the Hub picks up
  // Lambda's writes the moment they land (e.g. user clicks "Refresh", Lambda
  // takes 12s, the panel updates without a manual refetch).
  useEffect(() => {
    if (!isCloudEnabled || !supabase || !workspaceId) return;
    if (!data?.cacheKey) return;
    const cacheKey = data.cacheKey;

    const channel = supabase
      .channel(`sold_comps:${workspaceId}:${cacheKey}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'sold_comps',
          filter: `workspace_id=eq.${workspaceId}`,
        },
        (payload) => {
          const newKey = payload?.new?.cache_key;
          if (newKey !== cacheKey) return;
          // Re-read so we get the same shape the rest of the panel expects.
          if (activeQueryRef.current) {
            runFetch({ q: activeQueryRef.current });
          }
        },
      )
      .subscribe();

    return () => {
      try { supabase.removeChannel(channel); } catch {}
    };
  }, [data?.cacheKey, workspaceId, runFetch]);

  // ── Derived UI flags ────────────────────────────────────────────────────
  const stale = !!data?.stale;
  const samples = useMemo(() => {
    const s = data?.samples || [];
    return compact ? s.slice(0, 5) : s.slice(0, 60);
  }, [data, compact]);

  // ── Empty: no cloud configured ──────────────────────────────────────────
  if (!hasCloud) {
    return (
      <div className="rounded-xl border border-border bg-surface p-4 text-xs text-fg-muted flex items-start gap-2">
        <CloudOff className="size-4 shrink-0 mt-0.5" />
        <div>
          <p className="font-semibold text-fg">Sold Comps unavailable</p>
          <p className="mt-0.5 leading-relaxed">
            Cloud sync isn't configured for this build. Sold comps are workspace-scoped
            and require Supabase. Configure <span className="font-mono">VITE_SUPABASE_URL</span>{' '}
            and <span className="font-mono">VITE_SUPABASE_ANON_KEY</span> to enable.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={`rounded-xl border border-border bg-surface shadow-sm ${compact ? 'p-3' : 'p-4'}`}>
      {/* ── Search bar ────────────────────────────────────────────────── */}
      <form
        className="flex items-center gap-2 mb-3"
        onSubmit={(e) => { e.preventDefault(); runFetch({ force: false }); }}
      >
        <div className="flex-1 relative">
          <Input
            size={compact ? 'sm' : 'md'}
            leadingIcon={Search}
            placeholder='e.g. "Apple iPad Pro 12.9 5th Gen 256GB"'
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Button
          type="submit"
          variant="accent"
          size={compact ? 'sm' : 'md'}
          disabled={loading || !query.trim()}
          loading={loading && !data}
        >
          Search
        </Button>
      </form>

      {/* ── Lambda not configured warning (read-only mode) ─────────────── */}
      {!lambdaReady && !data && !loading && (
        <div className="rounded-lg bg-muted/40 border border-border-subtle px-3 py-2 mb-3 text-[11px] text-fg-muted leading-relaxed">
          Read-only cache mode — the Lambda URL/secret aren't set up locally.
          You'll only see queries that have already been scraped on another device.
          Configure under Settings → Sold-Comps Service to enable on-demand lookups.
        </div>
      )}

      {/* ── Stale-cache yellow banner ──────────────────────────────────── */}
      {data && stale && (
        <div className="rounded-lg bg-warning-subtle border border-warning/30 px-3 py-2 mb-3 text-[11px] text-warning-fg leading-relaxed flex items-start gap-2">
          <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
          <div className="flex-1">
            Couldn't refresh: {data.staleNote || 'Lambda unavailable'}.
            Showing cached data from {relativeAge(data.scrapedAt) || 'earlier'}.
          </div>
          <button
            onClick={() => runFetch({ force: true })}
            className="text-warning-fg hover:underline text-[11px] font-semibold shrink-0"
          >
            Retry
          </button>
        </div>
      )}

      {/* ── Error (no cache, lambda failed) ────────────────────────────── */}
      {error && !data && (
        <div className="rounded-lg bg-danger-subtle border border-danger/30 px-3 py-2 mb-3 text-xs text-danger-fg flex items-start gap-2">
          <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
          <div>{error}</div>
        </div>
      )}

      {/* ── Loading ────────────────────────────────────────────────────── */}
      {loading && !data && (
        <div className="flex items-center gap-2 py-6 justify-center text-xs text-fg-muted">
          <Loader2 className="size-4 animate-spin" />
          Searching eBay sold listings…
        </div>
      )}

      {/* ── Empty initial state ───────────────────────────────────────── */}
      {!loading && !data && !error && (
        <div className="text-center py-5 text-xs text-fg-muted">
          Enter a product to see what similar items have sold for in the last {soldDays} days.
        </div>
      )}

      {/* ── Results ────────────────────────────────────────────────────── */}
      {data && (
        <div className="space-y-3">
          {/* Stats row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="bg-success/5 border border-success/20 rounded-lg p-2.5">
              <p className="text-[10px] uppercase tracking-wide text-fg-muted">Median</p>
              <p className="text-lg font-mono font-bold text-success leading-tight">
                {fmt(data.medianPrice)}
              </p>
              <p className="text-[10px] text-fg-muted mt-0.5">n={data.count} · {data.soldDays}d</p>
            </div>
            <div className="bg-muted/40 border border-border-subtle rounded-lg p-2.5">
              <p className="text-[10px] uppercase tracking-wide text-fg-muted">Range</p>
              <p className="text-sm font-mono font-semibold text-fg leading-tight mt-0.5">
                {fmt(data.lowPrice)} – {fmt(data.highPrice)}
              </p>
              <p className="text-[10px] text-fg-muted mt-0.5">low / high</p>
            </div>
            <div className="bg-muted/40 border border-border-subtle rounded-lg p-2.5">
              <p className="text-[10px] uppercase tracking-wide text-fg-muted">Average</p>
              <p className="text-sm font-mono font-semibold text-fg leading-tight mt-0.5">
                {fmt(data.avgPrice)}
              </p>
              <p className="text-[10px] text-fg-muted mt-0.5">mean</p>
            </div>
            <div className="bg-muted/40 border border-border-subtle rounded-lg p-2.5">
              <p className="text-[10px] uppercase tracking-wide text-fg-muted">Samples</p>
              <p className="text-sm font-mono font-semibold text-fg leading-tight mt-0.5">
                {data.samples?.length || 0}
              </p>
              <p className="text-[10px] text-fg-muted mt-0.5">on file</p>
            </div>
          </div>

          {/* Meta line + refresh */}
          <div className="flex items-center justify-between gap-2 flex-wrap text-[11px] text-fg-muted">
            <div className="flex items-center gap-1.5">
              <Clock className="size-3" />
              <span>
                {data.fromCache ? 'Cached' : 'Fresh'} {relativeAge(data.scrapedAt) || ''}
                {data.scrapedBy ? ` · via ${data.scrapedBy}` : ''}
              </span>
              {stale && <Badge variant="warning" size="xs">stale</Badge>}
            </div>
            <button
              onClick={() => runFetch({ force: true })}
              disabled={loading}
              className={`inline-flex items-center gap-1 hover:underline ${stale ? 'text-warning-fg font-semibold' : 'text-primary'}`}
            >
              {loading ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
              Refresh
            </button>
          </div>

          {/* Samples list */}
          {samples.length > 0 ? (
            <div className="rounded-lg border border-border-subtle bg-bg/40 px-3 py-1">
              {samples.map((s, i) => (
                <SampleRow key={s.itemId || s.item_id || i} sample={s} compact={compact} />
              ))}
              {!compact && (data.samples?.length || 0) > samples.length && (
                <p className="text-[10px] text-fg-subtle text-center py-1.5">
                  Showing {samples.length} of {data.samples.length} samples
                </p>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border bg-bg/40 px-3 py-4 text-center text-xs text-fg-muted">
              No sold listings found for this query. Try fewer keywords.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
