// ─── CostDashboard — Tier 39 daily-spend widget ──────────────────────────────
// Sits in the BrowseLotsView header. Reads from `analysis_costs` table for
// today's spend + lots analyzed. Color-codes by % of cap consumed.

import { useEffect, useState, useCallback } from 'react';
import { Activity, AlertTriangle } from 'lucide-react';
import { supabase, isCloudEnabled, getActiveWorkspace } from '../../services/supabase';
import { fmt } from '../../utils/formatters';

const DEFAULT_DAILY_CAP = 5;     // mirrors Worker env DAILY_COST_CAP_USD

export default function CostDashboard({ dailyCap = DEFAULT_DAILY_CAP, className = '' }) {
  const [today, setToday] = useState({ total_usd: 0, lots_analyzed: 0 });
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!isCloudEnabled || !supabase) {
      setLoading(false);
      return;
    }
    const wsId = await getActiveWorkspace();
    if (!wsId) {
      setLoading(false);
      return;
    }
    const todayUtc = new Date().toISOString().slice(0, 10);
    try {
      const { data } = await supabase
        .from('analysis_costs')
        .select('total_usd, lots_analyzed, last_updated')
        .eq('workspace_id', wsId)
        .eq('date', todayUtc)
        .maybeSingle();
      setToday({
        total_usd: Number(data?.total_usd || 0),
        lots_analyzed: Number(data?.lots_analyzed || 0),
        last_updated: data?.last_updated,
      });
    } catch (e) {
      console.warn('[CostDashboard] read failed:', e?.message || e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 60_000);   // refresh every minute
    return () => clearInterval(interval);
  }, [refresh]);

  // Realtime subscription so worker writes appear instantly.
  useEffect(() => {
    if (!isCloudEnabled || !supabase) return;
    let channel = null;
    (async () => {
      const wsId = await getActiveWorkspace();
      if (!wsId) return;
      channel = supabase
        .channel('cost-dashboard')
        .on('postgres_changes', {
          event: '*', schema: 'public', table: 'analysis_costs',
          filter: `workspace_id=eq.${wsId}`,
        }, () => refresh())
        .subscribe();
    })();
    return () => {
      try { if (channel) supabase.removeChannel(channel); } catch {}
    };
  }, [refresh]);

  if (loading) return null;

  const pct = Math.min(100, (today.total_usd / dailyCap) * 100);
  const overCap = today.total_usd >= dailyCap;
  const nearCap = !overCap && pct >= 80;
  const barColor = overCap ? 'bg-rose-500' : nearCap ? 'bg-amber-500' : 'bg-emerald-500';
  const textColor = overCap ? 'text-rose-700' : nearCap ? 'text-amber-700' : 'text-slate-700';

  return (
    <div className={`inline-flex items-center gap-3 px-3 py-1.5 rounded-lg border border-slate-200 bg-white ${className}`}>
      {overCap ? (
        <AlertTriangle size={14} className="text-rose-600" />
      ) : (
        <Activity size={14} className="text-slate-500" />
      )}
      <div className="flex flex-col">
        <div className="flex items-baseline gap-2">
          <span className={`text-xs font-mono ${textColor}`}>
            {fmt(today.total_usd)} / {fmt(dailyCap)}
          </span>
          <span className="text-[10px] text-slate-500">
            {today.lots_analyzed} lot{today.lots_analyzed === 1 ? '' : 's'} today
          </span>
        </div>
        <div className="w-32 h-1 mt-0.5 bg-slate-100 rounded-full overflow-hidden">
          <div className={`h-full ${barColor} transition-all`} style={{ width: `${pct}%` }} />
        </div>
      </div>
      {overCap && (
        <span className="text-[10px] text-rose-700 font-medium">
          cap hit — auto-pause until tomorrow
        </span>
      )}
    </div>
  );
}
