// ─── Pipeline cron freshness probe ──────────────────────────────────────────
// The four data-pulling crons in noltech-pipeline (discovery, refresh,
// analysis, alerts) do NOT write to agent_heartbeats — only ebay-sync does.
// To surface their health in the Hub we infer last-success from the most
// recent row in each cron's output table:
//
//   discovery + refresh → max(liquidation_lots_newegg.scraped_at)
//   analysis           → max(lot_analyses.scored_at)
//   alerts             → max(bid_alerts_sent.sent_at)   (informational only;
//                        absence is normal when no bids are closing soon)
//
// Three parallel queries, each .order().limit(1).maybeSingle() filtered by
// workspace_id. Cost is bounded regardless of table size.

function ageMin(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 60000));
}

function shortAge(iso) {
  const m = ageMin(iso);
  if (m == null)   return 'never';
  if (m < 1)       return 'now';
  if (m < 60)      return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24)      return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

async function readLatest(supabase, table, column, workspaceId) {
  try {
    const { data, error } = await supabase
      .from(table)
      .select(column)
      .eq('workspace_id', workspaceId)
      .order(column, { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return { iso: null, error: error.message };
    return { iso: data?.[column] || null, error: null };
  } catch (e) {
    return { iso: null, error: e?.message || 'query_failed' };
  }
}

export async function fetchPipelineCronFreshness({ supabase, workspaceId }) {
  if (!supabase || !workspaceId) {
    return { status: 'warn', text: 'No cloud — pipeline crons unavailable', detail: null };
  }

  const [discovery, analysis, alerts] = await Promise.all([
    readLatest(supabase, 'liquidation_lots_newegg', 'scraped_at',  workspaceId),
    readLatest(supabase, 'lot_analyses',            'scored_at',   workspaceId),
    readLatest(supabase, 'bid_alerts_sent',         'sent_at',     workspaceId),
  ]);

  // Surface per-table structural errors immediately. If discovery's table
  // returns 'relation does not exist' but analysis succeeds, we shouldn't
  // pretend discovery just "never ran" — that's silent migration drift.
  // Discovery is the load-bearing signal; analysis is secondary.
  if (discovery.error) {
    return {
      status: 'warn',
      text:   'Discovery table unavailable',
      detail: `discovery: ${discovery.error}\nanalysis: ${analysis.error || 'ok'}\nalerts: ${alerts.error || 'ok'}`,
    };
  }
  if (analysis.error) {
    return {
      status: 'warn',
      text:   'Analysis table unavailable',
      detail: `discovery: ok\nanalysis: ${analysis.error}\nalerts: ${alerts.error || 'ok'}`,
    };
  }

  const dAge = ageMin(discovery.iso);
  const aAge = ageMin(analysis.iso);

  // Discovery + refresh both touch liquidation_lots_newegg. Discovery runs
  // every 30 min, refresh every 15 min — so we expect scraped_at to bump at
  // least every 30 min when the worker is healthy.
  //   first-run pending  : both null              → warn (NOT error)
  //   green              : last scrape <= 60m   AND  (no analyses yet OR last analysis <= 30m)
  //   yellow             : last scrape 60-180m  OR   last analysis 30-90m
  //   red                : last scrape > 180m   OR   last analysis > 90m
  //
  // Analysis being null is OK — empty queue is normal. Alerts being null is
  // ALWAYS OK — alerts only fire when something is closing soon. NULL discovery
  // with successful query = brand-new workspace, no lots scraped yet → warn,
  // not error — matches the eBay Sync tile's first-run handling for symmetry.
  let status = 'ok';
  if (dAge == null && aAge == null)                          status = 'warn';
  else if (dAge != null && dAge > 180)                       status = 'error';
  else if (aAge != null && aAge > 90)                        status = 'error';
  else if ((dAge != null && dAge > 60) || (aAge != null && aAge > 30)) status = 'warn';

  // Tile text — short, scannable
  let text;
  if (dAge == null && aAge == null) {
    text = 'No data yet — first run pending';
  } else {
    const parts = [];
    parts.push(`Disc ${shortAge(discovery.iso)}`);
    if (analysis.iso) parts.push(`Anlz ${shortAge(analysis.iso)}`);
    text = parts.join(' · ');
  }

  // Tooltip — multi-line ISO timestamps for the curious
  const detail = [
    `discovery/refresh : ${discovery.iso || 'never'}${discovery.error ? ` (err: ${discovery.error})` : ''}`,
    `analysis          : ${analysis.iso || 'never'}${analysis.error ? ` (err: ${analysis.error})` : ''}`,
    `alerts (info)     : ${alerts.iso || 'never'}${alerts.error ? ` (err: ${alerts.error})` : ''}`,
  ].join('\n');

  return { status, text, detail };
}
