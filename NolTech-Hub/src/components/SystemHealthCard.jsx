// ─── System Health Card ──────────────────────────────────────────────────────
// One-glance status panel for the Hub. Surfaces:
//   - Local pipeline reachability + bearer auth (noltech-pipeline /health)
//   - eBay OAuth refresh-token status (Hub-owned encrypted refresh token)
//   - eBay sync heartbeat (agent_heartbeats, agent_id=ebay-sync-worker)
//   - Pipeline Crons freshness (discovery + analysis output-table mtimes)
//   - Recent error count from notifications storage

import { useState, useEffect } from 'react';
import { Activity, HardDrive, RefreshCw, ShieldCheck, AlertTriangle, Server, X } from 'lucide-react';
import { EBAY_TOKEN_KEY, EBAY_SYNC_AGENT_ID } from '../utils/constants';
import { decryptObject } from '../services/crypto';
import { inspectEbayAccessTokenCache } from '../services/ebayAuth';
import { supabase, isCloudEnabled, getActiveWorkspace } from '../services/supabase';
import { pipelineFetch } from '../services/pipelineFetch';
import { fetchPipelineCronFreshness } from '../services/pipelineCronHealth';
import eventBus from '../services/eventBus';

const STATUS_CLS = {
  ok:    { dot: 'bg-success', text: 'text-success' },
  warn:  { dot: 'bg-warning', text: 'text-warning' },
  error: { dot: 'bg-danger',  text: 'text-danger' },
};

function timeAgo(isoOrMs) {
  if (!isoOrMs) return null;
  const t = typeof isoOrMs === 'number' ? isoOrMs : new Date(isoOrMs).getTime();
  if (!Number.isFinite(t)) return null;
  const ms = Date.now() - t;
  if (ms < 0) return `in ${Math.abs(Math.round(ms / 60000))}m`;
  const mins = Math.round(ms / 60000);
  if (mins < 1)   return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// Bare duration ("for 4h", "for 35m") — distinct from timeAgo()'s
// point-in-time framing ("4h ago"). Used in stale-heartbeat copy where
// "No heartbeat for 4h ago" would read ungrammatically.
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'unknown';
  const mins = Math.round(ms / 60000);
  if (mins < 60)  return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function timeUntil(ms) {
  if (!ms || !Number.isFinite(ms)) return null;
  const d = ms - Date.now();
  if (d < 0) return 'expired';
  const mins = Math.round(d / 60000);
  if (mins < 60)  return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.round(hours / 24);
  return `in ${days}d`;
}

export default function SystemHealthCard({ setView }) {
  const [cloud,    setCloud]    = useState({ status: 'ok', text: 'Checking…' });
  const [oauth,    setOauth]    = useState({ status: 'ok', text: 'Checking…' });
  const [ebaySync, setEbaySync] = useState({ status: 'ok', text: 'Checking…' });
  const [crons,    setCrons]    = useState({ status: 'ok', text: 'Checking…', detail: null });
  const [errors,   setErrors]   = useState({ status: 'ok', text: 'Checking…' });
  const [ebaySyncHeartbeat, setEbaySyncHeartbeat] = useState(null);
  const [showEbaySyncDetails, setShowEbaySyncDetails] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);

    // 1) Local pipeline — pings the service's /health. Reachability and, when
    //    a bearer token is configured, token correctness in one round trip.
    //    Electron starts this automatically; "Not running" means the child
    //    process died or was never spawned.
    try {
      const r = await pipelineFetch('/api/health', { signal: AbortSignal.timeout(5000) });
      if (r.status === 401 || r.status === 403) {
        setCloud({ status: 'error', text: 'Auth failed — token wrong' });
      } else if (!r.ok) {
        setCloud({ status: 'error', text: `Returned ${r.status}` });
      } else {
        const body = await r.json().catch(() => null);
        // A reachable pipeline with no Bright Data token can't scrape at all,
        // which is worth flagging distinctly from "offline".
        if (body && body.brightdataConfigured === false) {
          setCloud({ status: 'warn', text: 'Online — no Bright Data token' });
        } else {
          setCloud({ status: 'ok', text: 'Online' });
        }
      }
    } catch (e) {
      setCloud({
        status: 'error',
        text: e?.name === 'TimeoutError' ? 'Timed out' : 'Not running',
      });
    }

    // 2) eBay OAuth state — Hub owns the encrypted refresh token.
    try {
      const credsRaw = await window.storage.get(EBAY_TOKEN_KEY).catch(() => null);
      const creds = await decryptObject(credsRaw || {});
      if (!creds?.token) {
        setOauth({ status: 'warn', text: 'No eBay credentials saved' });
      } else if (!creds.oauthRefreshToken) {
        setOauth({ status: 'warn', text: 'Static OAuth token (no auto-refresh)' });
      } else {
        const cache = await inspectEbayAccessTokenCache();
        if (!cache.hasToken) {
          setOauth({ status: 'ok', text: 'Auto-refresh on (no cached token yet)' });
        } else if ((cache.msUntilExpiry || 0) <= 0) {
          setOauth({ status: 'warn', text: 'Access token expired — will refresh on next sync' });
        } else {
          setOauth({ status: 'ok', text: `Token valid ${timeUntil(cache.expiresAt)}` });
        }
      }
    } catch (e) {
      setOauth({ status: 'error', text: `Check failed: ${e.message}` });
    }

    // 3) Recent errors from notifications log
    try {
      const notifs = (await window.storage.get('noltech:notifications').catch(() => [])) || [];
      const oneHourAgo = Date.now() - 3600000;
      const recent = notifs.filter((n) => {
        if (!n || n.type !== 'error') return false;
        const t = n.ts ? new Date(n.ts).getTime() : 0;
        return t > oneHourAgo;
      });
      if (recent.length === 0)      setErrors({ status: 'ok',    text: 'None in last hour' });
      else if (recent.length < 3)   setErrors({ status: 'warn',  text: `${recent.length} in last hour` });
      else                          setErrors({ status: 'error', text: `${recent.length} in last hour` });
    } catch {
      setErrors({ status: 'ok', text: 'None tracked' });
    }

    // 4) eBay Sync Worker heartbeat — the noltech-pipeline /run/ebay-sync
    //    cron writes a row to agent_heartbeats with agent_id='ebay-sync-worker'
    //    on every tick (every 30 min). Stale = no row newer than 35 min.
    try {
      if (!isCloudEnabled || !supabase) {
        setEbaySyncHeartbeat(null);
        setEbaySync({ status: 'warn', text: 'No cloud — eBay sync unavailable' });
      } else {
        const currentWs = await getActiveWorkspace();
        if (!currentWs) {
          setEbaySyncHeartbeat(null);
          setEbaySync({ status: 'warn', text: 'No workspace selected' });
        } else {
          const { data: hb, error } = await supabase
            .from('agent_heartbeats')
            .select('*')
            .eq('workspace_id', currentWs)
            .eq('agent_id', EBAY_SYNC_AGENT_ID)
            .maybeSingle();

          if (error) {
            setEbaySyncHeartbeat(null);
            setEbaySync({ status: 'warn', text: 'Could not check worker status' });
          } else if (!hb) {
            setEbaySyncHeartbeat(null);
            setEbaySync({ status: 'warn', text: 'No heartbeat yet — first cron pending' });
          } else {
            setEbaySyncHeartbeat(hb);
            // The Worker writes last_run_at on every tick (persist.js).
            // updated_at is unreliable: missing on migration 024 schemas, and
            // frozen at insert-time on migration 011 (DEFAULT now() doesn't
            // re-fire on UPDATE). So staleness is computed off last_run_at.
            const lastRunMs = hb.last_run_at ? new Date(hb.last_run_at).getTime() : 0;
            const hasRun    = lastRunMs > 0;
            const ageMs     = hasRun ? (Date.now() - lastRunMs) : Infinity;
            // Cron runs every 30 min — give 5 min slack before flagging stale.
            const STALE_MS = 35 * 60 * 1000;
            const stale    = hasRun && ageMs > STALE_MS;

            if (!hasRun) {
              // Row exists but no last_run_at — first cron hasn't completed.
              setEbaySync({ status: 'warn', text: 'No completed run yet' });
            } else if (hb.status === 'running' && !stale) {
              setEbaySync({ status: 'ok', text: 'Currently syncing eBay…' });
            } else if (stale) {
              // Any status that's gone stale (incl. a "running" row that got
              // wedged) flags red. Shows duration, not "ago".
              setEbaySync({ status: 'error', text: `No heartbeat for ${formatDuration(ageMs)}` });
            } else if (hb.status === 'error') {
              setEbaySync({ status: 'error', text: hb.last_error || 'Last sync errored' });
            } else if (hb.status === 'ok') {
              setEbaySync({ status: 'ok', text: `OK · last run ${timeAgo(hb.last_run_at)}` });
            } else {
              setEbaySync({ status: 'ok', text: `${hb.status || 'idle'} · ${timeAgo(hb.last_run_at)}` });
            }
          }
        }
      }
    } catch (e) {
      setEbaySyncHeartbeat(null);
      setEbaySync({ status: 'warn', text: 'Worker check failed' });
    }

    // 5) Pipeline Crons freshness (discovery + analysis + alerts) — these
    //    crons don't write agent_heartbeats; we infer last-success from
    //    output-table row mtimes.
    try {
      if (!isCloudEnabled || !supabase) {
        setCrons({ status: 'warn', text: 'No cloud — pipeline crons unavailable', detail: null });
      } else {
        const ws = await getActiveWorkspace().catch(() => null);
        if (!ws) {
          setCrons({ status: 'warn', text: 'No workspace selected', detail: null });
        } else {
          const result = await fetchPipelineCronFreshness({ supabase, workspaceId: ws });
          setCrons(result);
        }
      }
    } catch (e) {
      setCrons({ status: 'warn', text: 'Cron check failed', detail: e?.message || null });
    }

    setRefreshing(false);
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 60000); // re-check every minute
    return () => clearInterval(id);
  }, []);

  // Re-check immediately when a Sync All finishes — sync touches OAuth token
  // cache and notification log; the user expects the panel to reflect the new
  // state without waiting up to 60s for the polling interval.
  useEffect(() => {
    const unsub = eventBus.on('sync:all-complete', () => refresh());
    return unsub;
  }, []);

  const ebaySyncTooltip = ebaySyncHeartbeat
    ? [
        `agent_id: ${ebaySyncHeartbeat.agent_id || '—'}`,
        `hostname: ${ebaySyncHeartbeat.hostname || '—'}`,
        `status: ${ebaySyncHeartbeat.status || '—'}`,
        ebaySyncHeartbeat.last_run_at ? `last_run_at: ${ebaySyncHeartbeat.last_run_at}` : null,
        ebaySyncHeartbeat.last_run_summary ? `summary: ${JSON.stringify(ebaySyncHeartbeat.last_run_summary)}` : null,
        ebaySyncHeartbeat.last_error ? `error: ${ebaySyncHeartbeat.last_error}` : null,
      ].filter(Boolean).join('\n')
    : null;

  const rows = [
    { key: 'cloud',    Icon: HardDrive,      title: 'Local Pipeline',    state: cloud,    hint: cloud.status === 'warn' ? 'Settings → Local Pipeline.' : cloud.status === 'error' ? 'Service not running, or the bearer token is wrong.' : null, onClick: cloud.status !== 'ok' ? () => setView?.('settings') : undefined },
    { key: 'oauth',    Icon: ShieldCheck,    title: 'eBay OAuth',        state: oauth,    hint: oauth.status !== 'ok' ? 'Settings → eBay Credentials → Test refresh now.' : null, onClick: () => setView?.('settings') },
    { key: 'ebaySync', Icon: Server,         title: 'eBay Sync Worker',  state: ebaySync, hint: ebaySyncHeartbeat ? 'Click for full heartbeat details.' : (ebaySync.status !== 'ok' ? 'Cron runs every 30 min; writes heartbeat to Supabase.' : null), onClick: ebaySyncHeartbeat ? () => setShowEbaySyncDetails(true) : undefined, tooltip: ebaySyncTooltip },
    { key: 'crons',    Icon: Activity,       title: 'Pipeline Crons',    state: crons,    hint: crons.status !== 'ok' ? 'Discovery + analysis crons in noltech-pipeline.' : null, tooltip: crons.detail },
    { key: 'errors',   Icon: AlertTriangle,  title: 'Recent errors',     state: errors,   hint: errors.status !== 'ok' ? 'Check the notification center for details.' : null },
  ];

  const overall = rows.some((r) => r.state.status === 'error')
    ? 'error'
    : rows.some((r) => r.state.status === 'warn') ? 'warn' : 'ok';
  const overallCfg = STATUS_CLS[overall];

  return (
    <div className={`bg-surface rounded-xl border shadow-sm p-4 mb-3 ${
      overall === 'error' ? 'border-danger/40' : overall === 'warn' ? 'border-warning/40' : 'border-border'
    }`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${overallCfg.dot}`} />
          <p className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">System Health</p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          className="flex items-center gap-1 text-[11px] text-fg-muted hover:text-fg disabled:opacity-50 transition-colors"
        >
          <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {rows.map((row) => {
          const cfg = STATUS_CLS[row.state.status];
          const Icon = row.Icon;
          const RowEl = row.onClick ? 'button' : 'div';
          return (
            <RowEl
              key={row.key}
              {...(row.onClick ? { type: 'button', onClick: row.onClick } : {})}
              title={row.tooltip || row.hint || ''}
              className={`flex items-start gap-2 p-2 rounded-lg border border-border bg-muted/20 ${row.onClick ? 'hover:bg-muted/40 cursor-pointer transition-colors text-left w-full' : ''}`}
            >
              <Icon size={14} className={`shrink-0 mt-0.5 ${cfg.text}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
                  <span className="text-xs font-semibold text-fg">{row.title}</span>
                </div>
                <p className={`text-[11px] mt-0.5 ${cfg.text} truncate`}>{row.state.text}</p>
                {row.hint && <p className="text-[10px] text-fg-subtle truncate mt-0.5">{row.hint}</p>}
              </div>
            </RowEl>
          );
        })}
      </div>

      {showEbaySyncDetails && ebaySyncHeartbeat && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          onClick={() => setShowEbaySyncDetails(false)}
        >
          <div
            className="bg-surface rounded-xl border border-border shadow-lg max-w-lg w-full max-h-[80vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-border">
              <div className="flex items-center gap-2">
                <Server size={16} className="text-fg" />
                <h3 className="text-sm font-semibold text-fg">eBay Sync Worker</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowEbaySyncDetails(false)}
                className="text-fg-muted hover:text-fg transition-colors"
              >
                <X size={16} />
              </button>
            </div>
            <div className="p-4 space-y-2 text-xs">
              <div className="flex justify-between gap-4">
                <span className="text-fg-muted">agent_id</span>
                <span className="font-mono text-fg truncate">{ebaySyncHeartbeat.agent_id || '—'}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-fg-muted">hostname</span>
                <span className="font-mono text-fg truncate">{ebaySyncHeartbeat.hostname || '—'}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-fg-muted">status</span>
                <span className="font-mono text-fg truncate">{ebaySyncHeartbeat.status || '—'}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-fg-muted">last_run_at</span>
                <span className="font-mono text-fg truncate">
                  {ebaySyncHeartbeat.last_run_at ? `${ebaySyncHeartbeat.last_run_at} (${timeAgo(ebaySyncHeartbeat.last_run_at)})` : '—'}
                </span>
              </div>
              {ebaySyncHeartbeat.last_error && (
                <div>
                  <p className="text-fg-muted mb-1">last_error</p>
                  <pre className="bg-muted/30 rounded p-2 text-[11px] text-danger whitespace-pre-wrap break-words">{ebaySyncHeartbeat.last_error}</pre>
                </div>
              )}
              <div>
                <p className="text-fg-muted mb-1">last_run_summary</p>
                <pre className="bg-muted/30 rounded p-2 text-[11px] text-fg whitespace-pre-wrap break-words font-mono">
                  {ebaySyncHeartbeat.last_run_summary
                    ? JSON.stringify(ebaySyncHeartbeat.last_run_summary, null, 2)
                    : '—'}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
