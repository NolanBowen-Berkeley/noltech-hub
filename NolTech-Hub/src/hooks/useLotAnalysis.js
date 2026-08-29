// ─── useLotAnalysis ──────────────────────────────────────────────────────────
// Subscribes to lot_analysis_queue + lot_analyses for a given lotId.
// Returns { queue, result, loading, refresh, requeue }.
//
// Live-updates via Supabase realtime — when the Worker writes a result, the
// UI re-renders without polling.

import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase, isCloudEnabled, getActiveWorkspace } from '../services/supabase';
import { getLotAnalysisStatus, requeueLot } from '../services/lotAnalysisQueue';

export function useLotAnalysis(lotId) {
  const [queue, setQueue] = useState(null);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const workspaceIdRef = useRef(null);
  const subscriptionsRef = useRef([]);

  const refresh = useCallback(async () => {
    if (!lotId) return;
    setLoading(true);
    try {
      const status = await getLotAnalysisStatus(lotId);
      setQueue(status?.queue || null);
      setResult(status?.result || null);
    } catch (e) {
      // Surface the failure so a Supabase outage or schema mismatch doesn't
      // present as a permanently-empty analysis panel with no diagnostic.
      console.error('[useLotAnalysis] status fetch failed:', e);
    } finally {
      setLoading(false);
    }
  }, [lotId]);

  const requeue = useCallback(async () => {
    if (!lotId) return null;
    const out = await requeueLot(lotId);
    if (out.ok) {
      // Optimistic: show pending immediately.
      setQueue((prev) => ({ ...(prev || {}), status: 'pending', enqueued_at: new Date().toISOString() }));
    }
    return out;
  }, [lotId]);

  useEffect(() => {
    if (!lotId) return;
    refresh();
  }, [lotId, refresh]);

  useEffect(() => {
    if (!lotId || !isCloudEnabled || !supabase) return;
    let cancelled = false;

    (async () => {
      const wsId = await getActiveWorkspace();
      if (!wsId || cancelled) return;
      workspaceIdRef.current = wsId;

      const queueChannel = supabase
        .channel(`lot-queue-${lotId}`)
        .on(
          'postgres_changes',
          {
            event: '*', schema: 'public', table: 'lot_analysis_queue',
            filter: `workspace_id=eq.${wsId}`,
          },
          (payload) => {
            const row = payload.new || payload.old;
            if (row && row.lot_id === lotId) refresh();
          },
        )
        .subscribe();

      const analysisChannel = supabase
        .channel(`lot-result-${lotId}`)
        .on(
          'postgres_changes',
          {
            event: '*', schema: 'public', table: 'lot_analyses',
            filter: `workspace_id=eq.${wsId}`,
          },
          (payload) => {
            const row = payload.new || payload.old;
            if (row && row.lot_id === lotId) refresh();
          },
        )
        .subscribe();

      subscriptionsRef.current = [queueChannel, analysisChannel];
    })();

    return () => {
      cancelled = true;
      for (const ch of subscriptionsRef.current) {
        try { supabase.removeChannel(ch); } catch {}
      }
      subscriptionsRef.current = [];
    };
  }, [lotId, refresh]);

  // Derived: simple status string for UI.
  const status = (() => {
    if (loading && !queue && !result) return 'loading';
    if (result) return 'scored';
    if (queue?.status === 'pending') return 'pending';
    if (queue?.status === 'processing') return 'processing';
    if (queue?.status === 'error') return 'error';
    if (queue?.status === 'deferred_cost_cap') return 'cost_cap';
    if (queue?.status === 'done' && !result) return 'completing';
    return 'not_queued';
  })();

  // Derived: recommendation + margin (when scored).
  const recommendation = result?.recommendation || null;
  const marginPct = result?.scenarios?.[recommendation]?.margin_pct ?? null;
  const profit = result?.scenarios?.[recommendation]?.profit ?? null;
  const redFlags = result?.red_flags || [];

  return {
    queue,
    result,
    status,
    recommendation,
    marginPct,
    profit,
    redFlags,
    loading,
    refresh,
    requeue,
  };
}
