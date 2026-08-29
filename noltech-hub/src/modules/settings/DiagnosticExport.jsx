// ─── Diagnostic Export ───────────────────────────────────────────────────────
// Bundles app config + recent errors + storage sizes into a single JSON file
// the user can attach to support emails. Sensitive values (encrypted creds,
// API keys, PIN hash) are omitted entirely. Useful when something breaks and
// the user wants to send context without manually pasting console output.

import { useState } from 'react';
import { Stethoscope, Download, Loader2 } from 'lucide-react';
import { PIPELINE_BASE } from '../../utils/constants';

// Keys whose values must NEVER appear in a diagnostic export. Their presence
// is recorded (so we can confirm the user has them set), but the values are
// stripped.
const REDACTED_KEYS = new Set([
  'noltech:apikey',
  'noltech:pin',
  'noltech:ebay:token',
  'noltech:ebay:oauth-cache',
]);

// Keys to include in the diagnostic config snapshot (non-sensitive settings)
const CONFIG_KEYS = [
  'noltech:settings',
  'noltech:settings:darkmode',
  'noltech:settings:sources',
  'noltech:settings:auto-sync',
  'noltech:settings:categories',
  'noltech:settings:condition-multipliers',
  'noltech:settings:ebay-fee-rate',
  'noltech:settings:resale-realization-rate',
  'noltech:settings:active-ask-buffer',
  'noltech:settings:ebay-condition-haircuts',
  'noltech:settings:auction-fee-rates',
  'noltech:settings:bstock-marketplaces',
  'noltech:settings:listing-aging-days',
  'noltech:sales-tax:home-state',
];

// Keys whose SIZE we report but not their full content (could be large)
const SIZE_ONLY_KEYS = [
  'noltech:inventory:lots',
  'noltech:arbitrage:browse-lots',
  'noltech:arbitrage:upc-cache',
  'noltech:arbitrage:lot-history',
  'noltech:books:transactions',
  'noltech:sales:history',
  'noltech:lotprofit:sales',
  'noltech:notifications',
  'noltech:price-history',
  'noltech:photos',
  'noltech:backup:daily-snapshots',
];

function bytesOf(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function DiagnosticExport() {
  const [busy,    setBusy]    = useState(false);
  const [summary, setSummary] = useState(null);

  const buildBundle = async () => {
    setBusy(true);
    setSummary(null);

    const bundle = {
      _meta: {
        app: 'NolTech Hub',
        kind: 'diagnostic',
        generatedAt: new Date().toISOString(),
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        language: navigator.language,
        url: location.href,
      },
      config: {},
      storageSizes: [],
      redactedPresence: {},
      recentNotifications: [],
      pipelineHealth: null,
      ebayCallStats: null,
      recentErrors: [],
    };

    // Recent module crashes (captured by ModuleErrorBoundary). Rolling log
    // of the last 25 errors with stack + component stack. Useful when
    // debugging a hard-to-reproduce crash users report after the fact.
    try {
      const errLog = await window.storage.get('noltech:errors:recent');
      if (Array.isArray(errLog)) bundle.recentErrors = errLog;
    } catch (e) {
      bundle.recentErrors = [{ note: `failed to read error log: ${e.message}` }];
    }

    // Non-sensitive config snapshot
    for (const key of CONFIG_KEYS) {
      try {
        const v = await window.storage.get(key);
        if (v !== null && v !== undefined) bundle.config[key] = v;
      } catch (e) {
        bundle.config[key] = `[read error: ${e.message}]`;
      }
    }

    // Storage size report for big keys
    for (const key of SIZE_ONLY_KEYS) {
      try {
        const v = await window.storage.get(key);
        const size = bytesOf(v);
        let count = null;
        if (Array.isArray(v)) count = v.length;
        else if (v && typeof v === 'object' && Array.isArray(v.lots)) count = v.lots.length;
        bundle.storageSizes.push({ key, sizeBytes: size, sizeReadable: fmtBytes(size), count });
      } catch (e) {
        bundle.storageSizes.push({ key, error: e.message });
      }
    }

    // Just record whether sensitive keys exist (not their values)
    for (const key of REDACTED_KEYS) {
      try {
        const v = await window.storage.get(key);
        bundle.redactedPresence[key] = v !== null && v !== undefined;
      } catch {
        bundle.redactedPresence[key] = 'read error';
      }
    }

    // Recent notifications (last 50, errors first)
    try {
      const notifs = (await window.storage.get('noltech:notifications').catch(() => [])) || [];
      bundle.recentNotifications = notifs.slice(-50).map((n) => ({
        ts:      n?.ts || null,
        type:    n?.type || null,
        title:   n?.title || null,
        message: (n?.message || '').slice(0, 300),
      }));
    } catch (e) {
      bundle.recentNotifications = [`read error: ${e.message}`];
    }

    // Live scraper health ping
    try {
      const r = await fetch(`${PIPELINE_BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
      bundle.pipelineHealth = { ok: r.ok, status: r.status };
    } catch (e) {
      bundle.pipelineHealth = { ok: false, error: e.message };
    }

    // eBay call stats (if scraper exposes it)
    try {
      const r = await fetch(`${PIPELINE_BASE}/api/ebay/call-stats`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) bundle.ebayCallStats = await r.json();
    } catch {}

    // Trigger download
    const json = JSON.stringify(bundle, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `noltech-diagnostic-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);

    const totalBytes = bundle.storageSizes.reduce((s, x) => s + (x.sizeBytes || 0), 0);
    setSummary({
      bytes:    json.length,
      configKeyCount: Object.keys(bundle.config).length,
      storageKeyCount: bundle.storageSizes.length,
      storageTotalBytes: totalBytes,
      notifCount: bundle.recentNotifications.length,
    });
    setBusy(false);
  };

  return (
    <div className="bg-surface rounded-xl border border-border shadow-sm p-5">
      <div className="flex items-center gap-2 mb-1">
        <Stethoscope className="w-4 h-4 text-fg-muted" />
        <h3 className="text-sm font-semibold text-fg">Diagnostic Export</h3>
      </div>
      <p className="text-xs text-fg-muted mb-3 leading-relaxed">
        Bundles your app config, storage sizes, recent error notifications, and live scraper status
        into a single JSON file. Useful when reporting a bug — attach the file instead of pasting
        console output. <strong>Sensitive values are stripped</strong> (encrypted creds, API keys, PIN
        hash) — only their presence/absence is recorded.
      </p>
      <button
        type="button"
        onClick={buildBundle}
        disabled={busy}
        className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-primary text-white hover:bg-primary/90 disabled:opacity-50 transition-colors"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
        {busy ? 'Building bundle…' : 'Export diagnostic bundle'}
      </button>
      {summary && (
        <p className="text-[11px] text-fg-muted mt-3">
          Saved {fmtBytes(summary.bytes)} bundle: {summary.configKeyCount} config keys ·
          {' '}{summary.storageKeyCount} storage entries ({fmtBytes(summary.storageTotalBytes)} total) ·
          {' '}{summary.notifCount} recent notifications
        </p>
      )}
    </div>
  );
}
