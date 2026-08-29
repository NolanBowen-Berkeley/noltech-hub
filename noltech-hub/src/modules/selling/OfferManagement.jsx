// ─── Offer Management ─────────────────────────────────────────────────────
// Pulls pending eBay best offers and lets you accept/decline/counter in bulk.
// Also owns a small rules engine: per-listing or global thresholds for
// auto-accept / auto-counter / auto-decline. Rules are evaluated on the
// client when you press "Apply rules" — no background automation yet.
//
// Storage:
//   noltech:offers:rules    →  { autoAcceptPct, autoCounterPct, autoDeclinePct, counterAtPct, enabled }
//   noltech:offers:log      →  array of { offerId, itemId, action, at, counterPrice? }

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Handshake, RefreshCw, Check, X, ArrowDown, Settings, AlertCircle, Clock,
  Zap, TrendingDown, TrendingUp, ExternalLink,
} from 'lucide-react';
import {
  Button, Card, Badge, Input, Label, Modal, Stat, Tabs, Sparkline,
  Table, THead, TBody, TR, TH, TD,
} from '../../components/ui';
import EmptyState from '../../components/EmptyState';
import { fmt } from '../../utils/formatters';
import { EBAY_TOKEN_KEY, PIPELINE_BASE } from '../../utils/constants';
import { decryptObject } from '../../services/crypto';

const RULES_KEY = 'noltech:offers:rules';
const LOG_KEY   = 'noltech:offers:log';

const DEFAULT_RULES = {
  enabled: false,
  autoAcceptPct:  90, // ≥ 90% of asking → auto-accept
  autoCounterPct: 70, // 70–89% → counter
  counterAtPct:   88, // counter at 88% of asking
  autoDeclinePct: 60, // < 60% → auto-decline
};

function pctToRatio(pct) { return (pct || 0) / 100; }

function decideAction(offer, rules) {
  if (!rules.enabled || !offer.listingPrice || !offer.offerAmount) return null;
  const ratio = offer.offerAmount / offer.listingPrice;
  const accept = pctToRatio(rules.autoAcceptPct);
  const counter = pctToRatio(rules.autoCounterPct);
  const decline = pctToRatio(rules.autoDeclinePct);
  if (ratio >= accept)  return { action: 'Accept' };
  if (ratio < decline)  return { action: 'Decline' };
  if (ratio >= counter) return {
    action: 'Counter',
    counterPrice: Math.round(offer.listingPrice * pctToRatio(rules.counterAtPct) * 100) / 100,
  };
  return null; // sits in the gap → manual review
}

function timeLeftStr(iso) {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'Expired';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h >= 1)  return `${h}h ${m}m`;
  return `${m}m`;
}

function ratioBadge(ratio) {
  if (ratio == null) return { variant: 'neutral', label: '—' };
  const pct = Math.round(ratio * 100);
  if (ratio >= 0.9)  return { variant: 'success', label: `${pct}%` };
  if (ratio >= 0.75) return { variant: 'warning', label: `${pct}%` };
  return { variant: 'danger', label: `${pct}%` };
}

// ─── Rules Editor ─────────────────────────────────────────────────────────
function RulesEditor({ rules, onChange }) {
  const set = (k) => (e) => onChange({ ...rules, [k]: parseFloat(e.target.value) || 0 });
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-fg">Auto-response rules</p>
          <p className="text-[11px] text-fg-muted">
            Manual mode: rules apply only when you tap "Apply rules". For
            hands-off background processing, enable <span className="font-semibold text-fg">Background automation</span> below.
          </p>
        </div>
        <label className="inline-flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={!!rules.enabled}
            onChange={(e) => onChange({ ...rules, enabled: e.target.checked })}
            className="accent-accent size-4"
          />
          <span className="text-sm text-fg">{rules.enabled ? 'Enabled' : 'Disabled'}</span>
        </label>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <Label className="text-[10px] uppercase tracking-wider inline-flex items-center gap-1">
            <TrendingUp className="size-3 text-success" /> Auto-accept at or above
          </Label>
          <div className="relative">
            <Input type="number" min="0" max="100" value={rules.autoAcceptPct} onChange={set('autoAcceptPct')} />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-fg-muted">% of asking</span>
          </div>
        </div>
        <div>
          <Label className="text-[10px] uppercase tracking-wider inline-flex items-center gap-1">
            <TrendingDown className="size-3 text-danger" /> Auto-decline below
          </Label>
          <div className="relative">
            <Input type="number" min="0" max="100" value={rules.autoDeclinePct} onChange={set('autoDeclinePct')} />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-fg-muted">% of asking</span>
          </div>
        </div>
        <div>
          <Label className="text-[10px] uppercase tracking-wider inline-flex items-center gap-1">
            <ArrowDown className="size-3 text-accent" /> Counter when at or above
          </Label>
          <div className="relative">
            <Input type="number" min="0" max="100" value={rules.autoCounterPct} onChange={set('autoCounterPct')} />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-fg-muted">% of asking</span>
          </div>
        </div>
        <div>
          <Label className="text-[10px] uppercase tracking-wider">Counter at</Label>
          <div className="relative">
            <Input type="number" min="0" max="100" value={rules.counterAtPct} onChange={set('counterAtPct')} />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-fg-muted">% of asking</span>
          </div>
        </div>
      </div>

      <div className="bg-muted/40 border border-border-subtle rounded-lg p-3">
        <p className="text-[11px] text-fg-muted leading-relaxed">
          Visual summary · At <span className="font-semibold text-fg">${rules.autoAcceptPct}%+</span> → accept ·{' '}
          <span className="font-semibold text-fg">{rules.autoCounterPct}–{rules.autoAcceptPct - 1}%</span> → counter at{' '}
          <span className="font-semibold text-fg">{rules.counterAtPct}%</span> ·{' '}
          <span className="font-semibold text-fg">&lt;{rules.autoDeclinePct}%</span> → decline · rest → manual
        </p>
      </div>

      {/* ── Background automation (Tier 1 expansion) ────────────────── */}
      <div className="border-t border-border-subtle pt-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-fg flex items-center gap-1.5">
              <Zap className="size-3.5 text-accent" /> Background automation
            </p>
            <p className="text-[11px] text-fg-muted">
              Run rules every 15 min in the background without you clicking Apply. Daily cap + dry-run mode protect against runaway behavior.
            </p>
          </div>
          <label className="inline-flex items-center gap-2 cursor-pointer shrink-0">
            <input
              type="checkbox"
              checked={!!rules.autoBackground}
              onChange={(e) => onChange({ ...rules, autoBackground: e.target.checked })}
              disabled={!rules.enabled}
              className="accent-accent size-4 disabled:opacity-50"
            />
            <span className={`text-sm ${rules.autoBackground ? 'text-fg' : 'text-fg-muted'}`}>
              {rules.autoBackground ? 'On' : 'Off'}
            </span>
          </label>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <Label className="text-[10px] uppercase tracking-wider">Daily cap</Label>
            <div className="relative">
              <Input
                type="number"
                min="1"
                max="500"
                value={rules.dailyMaxAuto ?? 50}
                onChange={(e) => onChange({ ...rules, dailyMaxAuto: parseInt(e.target.value, 10) || 50 })}
                disabled={!rules.autoBackground}
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-fg-muted">/ day</span>
            </div>
            <p className="text-[10px] text-fg-subtle mt-1">Hard limit. Resets at UTC midnight.</p>
          </div>

          <div>
            <Label className="text-[10px] uppercase tracking-wider">Wait after listing</Label>
            <div className="relative">
              <Input
                type="number"
                min="0"
                max="168"
                step="1"
                value={rules.minHoursSinceListed ?? 0}
                onChange={(e) => onChange({ ...rules, minHoursSinceListed: parseInt(e.target.value, 10) || 0 })}
                disabled={!rules.autoBackground}
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-fg-muted">hours</span>
            </div>
            <p className="text-[10px] text-fg-subtle mt-1">Skip listings younger than this.</p>
          </div>

          <div className="flex items-end">
            <label className="inline-flex items-center gap-2 cursor-pointer w-full">
              <input
                type="checkbox"
                checked={!!rules.dryRun}
                onChange={(e) => onChange({ ...rules, dryRun: e.target.checked })}
                disabled={!rules.autoBackground}
                className="accent-accent size-4 disabled:opacity-50"
              />
              <span className="text-xs">
                <span className={rules.dryRun ? 'text-warning font-semibold' : 'text-fg'}>Dry-run mode</span>
                <span className="block text-[10px] text-fg-subtle">Logs would-be actions without calling eBay.</span>
              </span>
            </label>
          </div>
        </div>

        {rules.autoBackground && !rules.dryRun && (
          <div className="rounded-lg border border-warning/30 bg-warning-subtle p-2.5 text-[11px] text-warning flex items-start gap-2">
            <AlertCircle className="size-3.5 shrink-0 mt-0.5" />
            <span>
              <strong>Live mode active.</strong> The Hub will accept/decline/counter offers automatically on its own — irreversibly. Use dry-run for the first day to confirm the rules behave as you expect before going live.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Offer Row ─────────────────────────────────────────────────────────────
function OfferRow({ offer, suggested, onRespond, pending }) {
  const hasAsking = offer.listingPrice > 0;
  const ratio = hasAsking ? offer.ratio : null;
  const badge = ratioBadge(ratio);
  const delta = hasAsking ? (offer.offerAmount || 0) - offer.listingPrice : null;
  const expires = timeLeftStr(offer.expiresAt);
  const expiringSoon = expires && expires.endsWith('m') && !expires.startsWith('Expired');
  const title = (offer.listingTitle && offer.listingTitle.trim()) || `Item #${offer.itemId || '—'}`;
  const viewUrl = offer.viewUrl || (offer.itemId ? `https://www.ebay.com/itm/${offer.itemId}` : null);

  return (
    <TR>
      <TD className="align-top max-w-[340px]">
        {viewUrl ? (
          <a
            href={viewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="link-underline inline-flex items-start gap-1.5 group"
          >
            <span className="text-sm text-fg line-clamp-2">{title}</span>
            <ExternalLink className="size-3 mt-0.5 opacity-0 group-hover:opacity-100 text-fg-subtle shrink-0 transition-opacity" />
          </a>
        ) : (
          <span className="text-sm text-fg line-clamp-2">{title}</span>
        )}
        <p className="text-[11px] text-fg-muted mt-0.5">
          from <span className="text-fg font-medium">{offer.buyer || 'unknown'}</span> · qty {offer.qty}
        </p>
      </TD>

      <TD className="w-24 align-top text-right">
        {hasAsking ? (
          <>
            <div className="font-mono tabular-nums text-sm text-fg-muted">{fmt(offer.listingPrice)}</div>
            <div className="text-[10px] text-fg-subtle mt-0.5">asking</div>
          </>
        ) : (
          <>
            <div className="font-mono tabular-nums text-sm text-fg-subtle">—</div>
            <div className="text-[10px] text-fg-subtle mt-0.5 italic">unknown</div>
          </>
        )}
      </TD>

      <TD className="w-28 align-top text-right">
        <div className="font-mono tabular-nums text-sm font-semibold text-fg">{fmt(offer.offerAmount)}</div>
        <div className="mt-0.5 flex items-center justify-end gap-1">
          <Badge variant={badge.variant} size="xs">{badge.label}</Badge>
          {delta != null && (
            <span className={`text-[10px] font-mono tabular-nums ${delta < 0 ? 'text-danger' : 'text-success'}`}>
              {delta < 0 ? '' : '+'}{fmt(delta)}
            </span>
          )}
        </div>
      </TD>

      <TD className="w-24 align-top text-right">
        <div className={`text-[11px] inline-flex items-center gap-1 ${expiringSoon ? 'text-warning font-semibold' : 'text-fg-muted'}`}>
          <Clock className="size-3" />
          {expires || '—'}
        </div>
      </TD>

      <TD className="w-32 align-top">
        {suggested ? (
          <Badge variant={
            suggested.action === 'Accept'  ? 'success' :
            suggested.action === 'Decline' ? 'danger'  :
            'warning'
          } size="xs" className="font-semibold">
            {suggested.action}{suggested.counterPrice ? ` ${fmt(suggested.counterPrice)}` : ''}
          </Badge>
        ) : (
          <span className="text-[10px] text-fg-subtle italic">manual</span>
        )}
      </TD>

      <TD className="w-[220px] align-top text-right">
        <div className="inline-flex items-center gap-1">
          <Button
            variant="success"
            size="xs"
            onClick={() => onRespond(offer, { action: 'Accept' })}
            disabled={pending}
          >
            <Check /> Accept
          </Button>
          <CounterButton offer={offer} onSubmit={(price) => onRespond(offer, { action: 'Counter', counterPrice: price })} disabled={pending} />
          <Button
            variant="secondary"
            size="xs"
            onClick={() => onRespond(offer, { action: 'Decline' })}
            disabled={pending}
          >
            <X /> Decline
          </Button>
        </div>
      </TD>
    </TR>
  );
}

function CounterButton({ offer, onSubmit, disabled }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    // Default counter: 88% of asking if known, else midpoint between offer and 10% above
    const base = offer.listingPrice > 0
      ? offer.listingPrice * 0.88
      : (offer.offerAmount || 0) * 1.1;
    setValue(base.toFixed(2));
    const click = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', click);
    return () => document.removeEventListener('mousedown', click);
  }, [open, offer.listingPrice, offer.offerAmount]);

  return (
    <div ref={ref} className="relative inline-block">
      <Button variant="accent" size="xs" onClick={() => setOpen((o) => !o)} disabled={disabled}>
        <ArrowDown /> Counter
      </Button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.14 }}
            className="absolute right-0 top-full mt-1 z-30 w-52 glossy-elevated p-2"
          >
            <Label className="text-[10px] uppercase tracking-wider">Counter price</Label>
            <Input
              type="number"
              step="0.01"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') { onSubmit(parseFloat(value)); setOpen(false); } }}
            />
            <div className="flex items-center justify-end gap-1 mt-2">
              <Button variant="ghost" size="xs" onClick={() => setOpen(false)}>Cancel</Button>
              <Button
                variant="accent"
                size="xs"
                onClick={() => { onSubmit(parseFloat(value)); setOpen(false); }}
                disabled={!value || parseFloat(value) <= 0}
              >
                Send
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────
export default function OfferManagement() {
  const [offers, setOffers]   = useState([]);
  const [log, setLog]         = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [rules, setRules]     = useState(DEFAULT_RULES);
  const [showRules, setShowRules] = useState(false);
  const [pending, setPending] = useState({});      // { offerId: true while in-flight }
  const [selected, setSelected] = useState(new Set());
  const [lastFetched, setLastFetched] = useState(null);

  // Hydrate rules + log
  useEffect(() => {
    window.storage.get(RULES_KEY).then((v) => { if (v) setRules({ ...DEFAULT_RULES, ...v }); });
    window.storage.get(LOG_KEY).then((v) => { if (Array.isArray(v)) setLog(v); });
  }, []);

  const persistRules = (next) => { setRules(next); window.storage.set(RULES_KEY, next).catch(() => {}); };

  const loadOffers = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const raw = await window.storage.get(EBAY_TOKEN_KEY).catch(() => null);
      const creds = await decryptObject(raw || {});
      if (!creds?.token) throw new Error('No eBay token. Add credentials in Settings.');
      const res = await fetch(`${PIPELINE_BASE}/api/ebay/best-offers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userToken: creds.token,
          appId: creds.appId || '',
          devId: creds.devId || '',
          certId: creds.certId || '',
        }),
        signal: AbortSignal.timeout(45000),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to load offers');
      setOffers(data.offers || []);
      setLastFetched(new Date().toISOString());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => { loadOffers(); }, [loadOffers]);

  const respond = useCallback(async (offer, { action, counterPrice, comment }) => {
    setPending((p) => ({ ...p, [offer.offerId]: true }));
    try {
      const raw = await window.storage.get(EBAY_TOKEN_KEY).catch(() => null);
      const creds = await decryptObject(raw || {});
      const res = await fetch(`${PIPELINE_BASE}/api/ebay/respond-offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userToken: creds.token,
          appId:  creds.appId  || '',
          devId:  creds.devId  || '',
          certId: creds.certId || '',
          itemId:  offer.itemId,
          offerId: offer.offerId,
          action,
          counterPrice,
          comment,
        }),
        signal: AbortSignal.timeout(20000),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Response failed');
      // Remove offer from list + record in log
      setOffers((os) => os.filter((o) => o.offerId !== offer.offerId));
      const entry = {
        offerId: offer.offerId, itemId: offer.itemId,
        action, counterPrice: counterPrice || null,
        buyer: offer.buyer, listingPrice: offer.listingPrice, offerAmount: offer.offerAmount,
        title: offer.listingTitle, at: new Date().toISOString(),
      };
      const nextLog = [entry, ...log].slice(0, 200);
      setLog(nextLog);
      window.storage.set(LOG_KEY, nextLog).catch(() => {});
    } catch (e) {
      setError(e.message);
    } finally {
      setPending((p) => { const n = { ...p }; delete n[offer.offerId]; return n; });
    }
  }, [log]);

  // Stats + suggestions
  const suggestions = useMemo(() => {
    const map = new Map();
    offers.forEach((o) => { const s = decideAction(o, rules); if (s) map.set(o.offerId, s); });
    return map;
  }, [offers, rules]);

  const stats = useMemo(() => {
    const total = offers.length;
    const autoAcceptable = [...suggestions.values()].filter((s) => s.action === 'Accept').length;
    const autoCounter    = [...suggestions.values()].filter((s) => s.action === 'Counter').length;
    const autoDecline    = [...suggestions.values()].filter((s) => s.action === 'Decline').length;
    const avgRatio = total > 0
      ? offers.reduce((a, o) => a + (o.ratio || 0), 0) / total
      : 0;
    return { total, autoAcceptable, autoCounter, autoDecline, avgRatio };
  }, [offers, suggestions]);

  const applyAllRules = useCallback(async () => {
    if (!rules.enabled) { setShowRules(true); return; }
    const actionable = offers.filter((o) => suggestions.has(o.offerId));
    if (!actionable.length) return;
    if (!confirm(`Apply rules to ${actionable.length} offer${actionable.length !== 1 ? 's' : ''}? Accepts + declines are irreversible.`)) return;
    for (const o of actionable) {
      const s = suggestions.get(o.offerId);
      if (s) await respond(o, s);
    }
  }, [rules.enabled, offers, suggestions, respond]);

  // Log spark: daily counts of actions over last 14 days
  const logSpark = useMemo(() => {
    const days = 14;
    const buckets = new Array(days).fill(0);
    const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0,0,0,0); return d.getTime(); };
    const bucketStart = startOfDay(Date.now() - (days - 1) * 86400000);
    log.forEach((e) => {
      const t = new Date(e.at).getTime();
      const idx = Math.floor((startOfDay(t) - bucketStart) / 86400000);
      if (idx >= 0 && idx < days) buckets[idx]++;
    });
    return buckets;
  }, [log]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h2 className="text-xl md:text-2xl font-semibold text-fg tracking-tight flex items-center gap-2">
            <Handshake className="size-5 text-accent" /> Offers
          </h2>
          <p className="text-xs text-fg-muted hidden md:block">
            Pending eBay Best Offers — accept, decline, or counter.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setShowRules(true)}>
            <Settings /> Rules
          </Button>
          <Button variant="secondary" size="sm" onClick={loadOffers} loading={loading}>
            <RefreshCw /> {loading ? 'Loading…' : 'Refresh'}
          </Button>
          <Button
            variant="accent"
            size="sm"
            onClick={applyAllRules}
            disabled={!offers.length}
            title={rules.enabled ? `Apply rules to ${stats.autoAcceptable + stats.autoCounter + stats.autoDecline} actionable offers` : 'Enable rules first'}
          >
            <Zap /> Apply rules
          </Button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card padding="sm" radius="lg" className="card-hover">
          <Stat label="Pending" value={stats.total} intent="neutral" size="md" />
        </Card>
        <Card padding="sm" radius="lg" className="card-hover">
          <Stat label="Auto-accept" value={stats.autoAcceptable} intent="success" size="md" sub={`≥ ${rules.autoAcceptPct}% of asking`} />
        </Card>
        <Card padding="sm" radius="lg" className="card-hover">
          <Stat label="Auto-counter" value={stats.autoCounter} intent="warning" size="md" sub={`${rules.autoCounterPct}–${rules.autoAcceptPct - 1}% → counter ${rules.counterAtPct}%`} />
        </Card>
        <Card padding="sm" radius="lg" className="card-hover">
          <Stat
            label="Avg offer ratio"
            value={stats.total ? `${Math.round(stats.avgRatio * 100)}%` : '—'}
            intent={stats.avgRatio >= 0.85 ? 'success' : stats.avgRatio >= 0.7 ? 'warning' : 'danger'}
            size="md"
            sparkline={log.length > 1 ? logSpark : undefined}
            sub={lastFetched ? `Synced ${new Date(lastFetched).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Not synced'}
          />
        </Card>
      </div>

      {error && (
        <Card padding="sm" radius="lg" className="border-danger/40 bg-danger-subtle/30">
          <div className="flex items-start gap-2 text-sm text-danger-fg">
            <AlertCircle className="size-4 mt-0.5 shrink-0" />
            <div>
              <p className="font-semibold">Couldn't load offers</p>
              <p className="text-xs">{error}</p>
            </div>
          </div>
        </Card>
      )}

      {/* Table */}
      {offers.length === 0 && !loading ? (
        <EmptyState
          icon={Handshake}
          title={error ? 'Couldn\'t load offers' : 'No pending offers'}
          description={error ? 'Check your eBay credentials in Settings.' : 'When buyers send offers, they\'ll show up here with accept / decline / counter actions.'}
        />
      ) : (
        <Card padding="none" radius="lg" className="overflow-hidden">
          <div className="overflow-x-auto">
            <Table className="min-w-[980px]">
              <THead sticky>
                <TR>
                  <TH>Listing / Buyer</TH>
                  <TH className="w-24 text-right">Asking</TH>
                  <TH className="w-28 text-right">Offer</TH>
                  <TH className="w-24 text-right">Expires</TH>
                  <TH className="w-32">Suggested</TH>
                  <TH className="w-[220px] text-right">Actions</TH>
                </TR>
              </THead>
              <TBody>
                {offers.map((o) => (
                  <OfferRow
                    key={o.offerId}
                    offer={o}
                    suggested={suggestions.get(o.offerId)}
                    onRespond={respond}
                    pending={!!pending[o.offerId]}
                  />
                ))}
              </TBody>
            </Table>
          </div>
        </Card>
      )}

      {/* Recent log */}
      {log.length > 0 && (
        <Card padding="md" radius="lg">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-fg inline-flex items-center gap-1.5">
              <Clock className="size-3.5" /> Recent responses
            </h3>
            <span className="text-[11px] text-fg-muted">{log.length} total</span>
          </div>
          <div className="space-y-1">
            {log.slice(0, 8).map((e) => (
              <div key={e.offerId} className="row-hover flex items-center gap-3 px-2 py-1.5 rounded-md text-xs">
                <Badge
                  variant={e.action === 'Accept' ? 'success' : e.action === 'Decline' ? 'danger' : 'warning'}
                  size="xs"
                >
                  {e.action}
                </Badge>
                <span className="flex-1 min-w-0 truncate text-fg">{e.title}</span>
                <span className="font-mono tabular-nums text-fg-muted shrink-0">
                  {fmt(e.offerAmount)}{e.counterPrice ? ` → ${fmt(e.counterPrice)}` : ''}
                </span>
                <span className="text-fg-subtle shrink-0">{new Date(e.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Rules modal */}
      <Modal
        open={showRules}
        onClose={() => setShowRules(false)}
        size="lg"
        title="Offer response rules"
        subtitle="Configure thresholds that drive the one-click Apply Rules action."
        footer={
          <div className="flex items-center justify-between">
            <Button variant="ghost" size="sm" onClick={() => persistRules(DEFAULT_RULES)}>
              Reset to defaults
            </Button>
            <Button variant="accent" size="sm" onClick={() => setShowRules(false)}>Done</Button>
          </div>
        }
      >
        <RulesEditor rules={rules} onChange={persistRules} />
      </Modal>
    </div>
  );
}
