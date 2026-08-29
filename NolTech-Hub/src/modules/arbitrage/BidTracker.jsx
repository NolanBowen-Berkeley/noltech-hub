import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Gavel,
  Trophy,
  XCircle,
  Plus,
  Pencil,
  Trash2,
  ExternalLink,
  Filter,
  DollarSign,
  TrendingUp,
  BarChart3,
  ChevronDown,
  ChevronUp,
  X,
  Save,
  Ban,
} from 'lucide-react';
import eventBus from '../../services/eventBus';
import { fmt, formatDate, formatPct as pct } from '../../utils/formatters';
import EmptyState from '../../components/EmptyState';

// ─── Constants ───────────────────────────────────────────────────────────────

const STORAGE_KEY = 'noltech:arbitrage:bids';

const SOURCES = [
  { value: 'techliquidators.com', label: 'TechLiquidators' },
  { value: 'liquidation.com', label: 'Liquidation.com' },
  { value: 'other', label: 'Other' },
];

const STATUSES = ['active', 'won', 'lost', 'cancelled'];

const STATUS_CONFIG = {
  active:    { label: 'Active',    cls: 'bg-info-subtle text-info',         icon: Gavel },
  won:       { label: 'Won',       cls: 'bg-success-subtle text-success',   icon: Trophy },
  lost:      { label: 'Lost',      cls: 'bg-danger-subtle text-danger',     icon: XCircle },
  cancelled: { label: 'Cancelled', cls: 'bg-muted text-fg-muted',  icon: Ban },
};

// Per-bid alert presets. The bid-alerts Worker reads `alertConditions` on each
// active bid and applies the matching rule. Add a new preset here AND mirror
// the rule in bid-alerts-worker/src/index.js (resolveAlertRule()).
const ALERT_PRESETS = [
  { value: 'standard',   label: 'Standard',   short: '30m',  desc: 'Final 30 min, only if asking ≤ ceiling (default)' },
  { value: 'early',      label: 'Early',      short: '1h',   desc: 'Final 1 hour, only if asking ≤ ceiling' },
  { value: 'last_call',  label: 'Last call',  short: '10m',  desc: 'Final 10 min only — quietest, last-chance pings' },
  { value: 'any_price',  label: 'Any price',  short: 'Any$', desc: 'Final 30 min — alert even if priced out (track outcome)' },
  { value: 'muted',      label: 'Muted',      short: 'Off',  desc: 'No phone alerts for this bid' },
];
const ALERT_PRESET_MAP = Object.fromEntries(ALERT_PRESETS.map(p => [p.value, p]));
const DEFAULT_ALERT_PRESET = 'standard';

const EMPTY_BID = {
  lotTitle: '',
  source: 'techliquidators.com',
  lotUrl: '',
  bidAmount: '',
  bidCeiling: '',
  estResale: '',
  status: 'active',
  wonPrice: '',
  notes: '',
  alertConditions: DEFAULT_ALERT_PRESET,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function uuid() {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function toNum(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

// ─── Status Badge ────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.active;
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold ${cfg.cls}`}>
      <Icon size={12} />
      {cfg.label}
    </span>
  );
}

// ─── Alert Preset Selector (inline, per-bid) ─────────────────────────────────

function AlertSelector({ value, onChange, disabled }) {
  const cur = ALERT_PRESET_MAP[value] || ALERT_PRESET_MAP[DEFAULT_ALERT_PRESET];
  if (disabled) {
    return <span className="text-xs text-fg-subtle">—</span>;
  }
  const isMuted = value === 'muted';
  const cls = isMuted
    ? 'bg-muted text-fg-muted'
    : 'bg-secondary/10 text-secondary';
  return (
    <select
      value={value || DEFAULT_ALERT_PRESET}
      onChange={(e) => onChange(e.target.value)}
      title={cur.desc}
      className={`text-[11px] font-semibold px-2 py-0.5 rounded border border-border-subtle focus:outline-none focus:ring-2 focus:ring-secondary cursor-pointer ${cls}`}
    >
      {ALERT_PRESETS.map(p => (
        <option key={p.value} value={p.value}>{p.label} ({p.short})</option>
      ))}
    </select>
  );
}

// ─── Source Badge ────────────────────────────────────────────────────────────

function SourceBadge({ source }) {
  const label = SOURCES.find(s => s.value === source)?.label || source;
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-muted text-fg-muted">
      {label}
    </span>
  );
}

// ─── Skeleton ────────────────────────────────────────────────────────────────

function Skeleton({ className = '' }) {
  return <div className={`animate-pulse bg-muted rounded ${className}`} />;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function BidTracker() {
  const [bids, setBids] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_BID });
  const [editingId, setEditingId] = useState(null);
  const [filter, setFilter] = useState('all');
  const [saving, setSaving] = useState(false);

  // ── Load ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    const load = async () => {
      try {
        const data = await window.storage.get(STORAGE_KEY);
        setBids(Array.isArray(data) ? data : []);
      } catch (err) {
        console.error(`Storage error for ${STORAGE_KEY}:`, err);
        setError("Couldn't load bid data. Refresh and try again.");
      } finally {
        setLoading(false);
      }
    };
    load();

    // Reload when cloud sync pushes updates
    const unsub = eventBus.on('sync:array-updated', ({ storageKey }) => {
      if (storageKey === STORAGE_KEY) load();
    });
    return unsub;
  }, []);

  // ── Persist ──────────────────────────────────────────────────────────────

  const persist = useCallback(async (next) => {
    try {
      await window.storage.set(STORAGE_KEY, next);
      setBids(next);
    } catch (err) {
      console.error(`Storage write error for ${STORAGE_KEY}:`, err);
      setError("Couldn't save. Try again.");
    }
  }, []);

  // ── Save bid ─────────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    if (!form.lotTitle.trim()) return;
    setSaving(true);
    const now = new Date().toISOString();

    // Capture old status before building the updated bid
    const oldStatus = editingId ? (bids.find(b => b.id === editingId)?.status ?? null) : null;

    const bid = {
      id: editingId || uuid(),
      lotId: form.lotId || '',
      lotTitle: form.lotTitle.trim(),
      source: form.source,
      lotUrl: form.lotUrl.trim(),
      bidAmount: toNum(form.bidAmount) ?? 0,
      bidCeiling: toNum(form.bidCeiling),
      estResale: toNum(form.estResale),
      status: form.status,
      wonPrice: form.status === 'won' ? (toNum(form.wonPrice) ?? null) : null,
      actualProfit: editingId ? (bids.find(b => b.id === editingId)?.actualProfit ?? null) : null,
      notes: form.notes.trim(),
      alertConditions: ALERT_PRESET_MAP[form.alertConditions] ? form.alertConditions : DEFAULT_ALERT_PRESET,
      bidDate: editingId ? (bids.find(b => b.id === editingId)?.bidDate ?? now) : now,
      updatedAt: now,
    };

    const next = editingId
      ? bids.map(b => b.id === editingId ? bid : b)
      : [bid, ...bids];

    await persist(next);

    // Emit event when bid status has changed
    const newStatus = bid.status;
    if (oldStatus !== null && oldStatus !== newStatus) {
      eventBus.emit('bid:status-changed', { bid, oldStatus, newStatus });
    }

    setForm({ ...EMPTY_BID });
    setEditingId(null);
    setFormOpen(false);
    setSaving(false);
  }, [form, editingId, bids, persist]);

  // ── Edit ─────────────────────────────────────────────────────────────────

  const startEdit = useCallback((bid) => {
    setForm({
      lotId: bid.lotId || '',
      lotTitle: bid.lotTitle,
      source: bid.source,
      lotUrl: bid.lotUrl || '',
      bidAmount: bid.bidAmount ?? '',
      bidCeiling: bid.bidCeiling ?? '',
      estResale: bid.estResale ?? '',
      status: bid.status,
      wonPrice: bid.wonPrice ?? '',
      notes: bid.notes || '',
      alertConditions: ALERT_PRESET_MAP[bid.alertConditions] ? bid.alertConditions : DEFAULT_ALERT_PRESET,
    });
    setEditingId(bid.id);
    setFormOpen(true);
  }, []);

  // Inline quick-change for the alert preset on a single bid. Saves immediately.
  const handleAlertChange = useCallback(async (bidId, newPreset) => {
    const target = bids.find(b => b.id === bidId);
    if (!target || target.alertConditions === newPreset) return;
    const updated = { ...target, alertConditions: newPreset, updatedAt: new Date().toISOString() };
    const next = bids.map(b => b.id === bidId ? updated : b);
    await persist(next);
  }, [bids, persist]);

  // ── Delete ───────────────────────────────────────────────────────────────

  const handleDelete = useCallback(async (id) => {
    const next = bids.filter(b => b.id !== id);
    await persist(next);
  }, [bids, persist]);

  // ── Cancel form ──────────────────────────────────────────────────────────

  const cancelForm = useCallback(() => {
    setForm({ ...EMPTY_BID });
    setEditingId(null);
    setFormOpen(false);
  }, []);

  // ── Derived stats ────────────────────────────────────────────────────────

  const stats = useMemo(() => {
    const total = bids.length;
    const wins = bids.filter(b => b.status === 'won');
    const losses = bids.filter(b => b.status === 'lost');
    const winCount = wins.length;
    const lossCount = losses.length;
    const decided = winCount + lossCount;
    const winRate = decided > 0 ? (winCount / decided) * 100 : 0;

    const totalSpent = wins.reduce((s, b) => s + (b.wonPrice || 0), 0);
    const totalEstValue = wins.reduce((s, b) => s + (b.estResale || 0), 0);

    // Average savings vs ceiling for won bids that have both ceiling and wonPrice
    const savingsList = wins
      .filter(b => b.bidCeiling != null && b.wonPrice != null)
      .map(b => b.bidCeiling - b.wonPrice);
    const avgSavings = savingsList.length > 0
      ? savingsList.reduce((s, v) => s + v, 0) / savingsList.length
      : null;

    // ── Bid outcome accuracy: how close were predicted ceilings to actual closes
    // For each won bid with a ceiling, compare ceiling vs wonPrice. Track:
    //   - withinTolerance: % of bids where wonPrice was within ±15% of ceiling
    //   - avgAbsDeviationPct: how far off the ceiling was on average (normalized)
    //   - signedBiasPct:  positive = consistently overestimating ceiling, negative = under
    const accuracySamples = wins
      .filter(b => b.bidCeiling != null && b.wonPrice != null && parseFloat(b.bidCeiling) > 0 && parseFloat(b.wonPrice) > 0)
      .map(b => {
        const c = parseFloat(b.bidCeiling);
        const w = parseFloat(b.wonPrice);
        return { ceiling: c, wonPrice: w, deviation: (c - w) / c }; // signed: positive = ceiling above close
      });
    const accuracy = accuracySamples.length === 0 ? null : (() => {
      const TOL = 0.15;
      const within = accuracySamples.filter(s => Math.abs(s.deviation) <= TOL).length;
      const avgAbs = accuracySamples.reduce((s, x) => s + Math.abs(x.deviation), 0) / accuracySamples.length;
      const signed = accuracySamples.reduce((s, x) => s + x.deviation, 0) / accuracySamples.length;
      const overEst  = accuracySamples.filter(s => s.deviation >  TOL).length; // ceiling well above close
      const underEst = accuracySamples.filter(s => s.deviation < -TOL).length; // ceiling below close (lucky/lossy)
      return {
        sampleSize: accuracySamples.length,
        withinTolerancePct: (within / accuracySamples.length) * 100,
        avgAbsDeviationPct: avgAbs * 100,
        signedBiasPct:      signed * 100,
        overEstCount:       overEst,
        underEstCount:      underEst,
      };
    })();

    return { total, winCount, lossCount, winRate, totalSpent, totalEstValue, avgSavings, accuracy };
  }, [bids]);

  // ── Filtered + sorted bids ───────────────────────────────────────────────

  const filteredBids = useMemo(() => {
    const list = filter === 'all' ? bids : bids.filter(b => b.status === filter);
    return [...list].sort((a, b) => new Date(b.bidDate) - new Date(a.bidDate));
  }, [bids, filter]);

  // ── Loading skeleton ─────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  // ── Error state ──────────────────────────────────────────────────────────

  if (error && bids.length === 0) {
    return (
      <div className="bg-danger-subtle border border-danger/30 rounded-xl p-6 text-center">
        <XCircle className="mx-auto mb-2 text-danger" size={32} />
        <p className="text-danger font-semibold">{error}</p>
        <button
          onClick={() => window.location.reload()}
          className="mt-3 px-4 py-2 bg-danger text-white rounded-lg text-sm hover:opacity-90"
        >
          Refresh
        </button>
      </div>
    );
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      {/* ─── Inline error banner ─────────────────────────────────────── */}
      {error && (
        <div className="flex items-center gap-2 bg-danger-subtle border border-danger/30 text-danger rounded-lg px-4 py-2 text-sm">
          <XCircle size={16} /> {error}
          <button onClick={() => setError(null)} className="ml-auto"><X size={14} /></button>
        </div>
      )}

      {/* ─── Summary Stats ───────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
        <StatCard icon={Gavel} label="Total Bids" value={stats.total} />
        <StatCard icon={Trophy} label="Wins" value={stats.winCount} color="text-success" />
        <StatCard icon={XCircle} label="Losses" value={stats.lossCount} color="text-danger" />
        <StatCard icon={BarChart3} label="Win Rate" value={pct(stats.winRate)} color={stats.winRate >= 50 ? 'text-success' : 'text-warning'} />
        <StatCard icon={DollarSign} label="Total Spent" value={fmt(stats.totalSpent)} mono />
        <StatCard icon={TrendingUp} label="Est. Value (Won)" value={fmt(stats.totalEstValue)} mono />
        <StatCard icon={DollarSign} label="Avg Savings" value={stats.avgSavings != null ? fmt(stats.avgSavings) : '\u2014'} mono color="text-success" />
      </div>

      {/* ─── Bid Outcome Accuracy ─────────────────
          Measures how close predicted bid ceilings were to actual winning
          prices. Tells you whether your multipliers (realization x ask
          buffer x condition x premium) are calibrated correctly. */}
      {stats.accuracy && (
        <div className="bg-surface rounded-xl border border-border shadow-sm p-4">
          <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <BarChart3 size={14} className="text-fg-muted" />
              <p className="text-sm font-semibold text-fg">Bid Ceiling Accuracy</p>
              <span className="text-[10px] text-fg-muted">
                ({stats.accuracy.sampleSize} won bid{stats.accuracy.sampleSize !== 1 ? 's' : ''} with ceiling data)
              </span>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="p-3 rounded-lg bg-muted/30 border border-border-subtle">
              <p className="text-[10px] uppercase tracking-wide text-fg-muted">Within ±15%</p>
              <p className={`text-2xl font-bold font-mono ${
                stats.accuracy.withinTolerancePct >= 70 ? 'text-success' :
                stats.accuracy.withinTolerancePct >= 50 ? 'text-warning' : 'text-danger'
              }`}>
                {stats.accuracy.withinTolerancePct.toFixed(0)}%
              </p>
              <p className="text-[10px] text-fg-subtle mt-0.5">of ceilings near close price</p>
            </div>
            <div className="p-3 rounded-lg bg-muted/30 border border-border-subtle">
              <p className="text-[10px] uppercase tracking-wide text-fg-muted">Avg deviation</p>
              <p className="text-2xl font-bold font-mono text-fg">
                +/-{stats.accuracy.avgAbsDeviationPct.toFixed(1)}%
              </p>
              <p className="text-[10px] text-fg-subtle mt-0.5">|ceiling - close| / ceiling</p>
            </div>
            <div className="p-3 rounded-lg bg-muted/30 border border-border-subtle">
              <p className="text-[10px] uppercase tracking-wide text-fg-muted">Signed bias</p>
              <p className={`text-2xl font-bold font-mono ${
                Math.abs(stats.accuracy.signedBiasPct) <= 5 ? 'text-success' : 'text-warning'
              }`}>
                {stats.accuracy.signedBiasPct >= 0 ? '+' : ''}{stats.accuracy.signedBiasPct.toFixed(1)}%
              </p>
              <p className="text-[10px] text-fg-subtle mt-0.5">
                {stats.accuracy.signedBiasPct > 5 ? 'ceilings run high' :
                 stats.accuracy.signedBiasPct < -5 ? 'ceilings run low' : 'well-calibrated'}
              </p>
            </div>
            <div className="p-3 rounded-lg bg-muted/30 border border-border-subtle">
              <p className="text-[10px] uppercase tracking-wide text-fg-muted">Outliers</p>
              <p className="text-2xl font-bold font-mono text-fg">
                <span className="text-success">{stats.accuracy.overEstCount}</span>
                <span className="text-fg-subtle text-base"> / </span>
                <span className="text-danger">{stats.accuracy.underEstCount}</span>
              </p>
              <p className="text-[10px] text-fg-subtle mt-0.5">over / under by &gt;15%</p>
            </div>
          </div>
          {Math.abs(stats.accuracy.signedBiasPct) > 10 && stats.accuracy.sampleSize >= 5 && (
            <p className="mt-3 text-[11px] text-warning bg-warning-subtle border border-warning/30 rounded px-2 py-1.5">
              <strong>Calibration tip:</strong>{' '}
              {stats.accuracy.signedBiasPct > 10
                ? 'Your ceilings run ~' + Math.round(stats.accuracy.signedBiasPct) + '% above actual closes — consider tightening realization rate, ask buffer, or condition haircut in Settings.'
                : 'Your ceilings run ~' + Math.round(Math.abs(stats.accuracy.signedBiasPct)) + '% below actual closes — you may be losing winnable lots. Consider loosening one multiplier.'}
            </p>
          )}
        </div>
      )}

      {/* ─── Add / Edit Form Toggle ──────────────────────────────────── */}
      <div className="bg-surface rounded-xl border border-border shadow-sm">
        <button
          onClick={() => formOpen ? cancelForm() : setFormOpen(true)}
          className="w-full flex items-center justify-between px-6 py-4 text-left"
        >
          <span className="flex items-center gap-2 font-semibold text-primary">
            {editingId ? <Pencil size={18} /> : <Plus size={18} />}
            {editingId ? 'Edit Bid' : 'Add New Bid'}
          </span>
          {formOpen ? <ChevronUp size={18} className="text-fg-muted" /> : <ChevronDown size={18} className="text-fg-muted" />}
        </button>

        {formOpen && (
          <div className="px-6 pb-6 border-t border-border-subtle pt-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {/* Lot Title */}
              <div className="lg:col-span-2">
                <label className="block text-sm font-medium text-fg mb-1">Lot Title *</label>
                <input
                  type="text"
                  value={form.lotTitle}
                  onChange={e => setForm(f => ({ ...f, lotTitle: e.target.value }))}
                  placeholder="e.g. Mixed Electronics Pallet - 50 units"
                  className="w-full px-3 py-2 border border-border-strong rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-secondary focus:border-secondary"
                />
              </div>

              {/* Source */}
              <div>
                <label className="block text-sm font-medium text-fg mb-1">Source</label>
                <select
                  value={form.source}
                  onChange={e => setForm(f => ({ ...f, source: e.target.value }))}
                  className="w-full px-3 py-2 border border-border-strong rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-secondary focus:border-secondary bg-surface"
                >
                  {SOURCES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>

              {/* Lot URL */}
              <div className="lg:col-span-2">
                <label className="block text-sm font-medium text-fg mb-1">Lot URL</label>
                <input
                  type="url"
                  value={form.lotUrl}
                  onChange={e => setForm(f => ({ ...f, lotUrl: e.target.value }))}
                  placeholder="https://..."
                  className="w-full px-3 py-2 border border-border-strong rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-secondary focus:border-secondary"
                />
              </div>

              {/* Status */}
              <div>
                <label className="block text-sm font-medium text-fg mb-1">Status</label>
                <select
                  value={form.status}
                  onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
                  className="w-full px-3 py-2 border border-border-strong rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-secondary focus:border-secondary bg-surface"
                >
                  {STATUSES.map(s => (
                    <option key={s} value={s}>{STATUS_CONFIG[s].label}</option>
                  ))}
                </select>
              </div>

              {/* Alert preset — drives the bid-alerts Worker's per-bid rule */}
              <div>
                <label className="block text-sm font-medium text-fg mb-1">
                  Phone alert
                  <span className="text-xs text-fg-muted font-normal ml-1">(when to ping you)</span>
                </label>
                <select
                  value={form.alertConditions}
                  onChange={e => setForm(f => ({ ...f, alertConditions: e.target.value }))}
                  className="w-full px-3 py-2 border border-border-strong rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-secondary focus:border-secondary bg-surface"
                  title={ALERT_PRESET_MAP[form.alertConditions]?.desc}
                >
                  {ALERT_PRESETS.map(p => (
                    <option key={p.value} value={p.value}>{p.label} — {p.desc}</option>
                  ))}
                </select>
              </div>

              {/* Bid Amount */}
              <div>
                <label className="block text-sm font-medium text-fg mb-1">Bid Amount ($)</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.bidAmount}
                  onChange={e => setForm(f => ({ ...f, bidAmount: e.target.value }))}
                  placeholder="0.00"
                  className="w-full px-3 py-2 border border-border-strong rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-secondary focus:border-secondary"
                />
              </div>

              {/* Bid Ceiling */}
              <div>
                <label className="block text-sm font-medium text-fg mb-1">Bid Ceiling ($)</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.bidCeiling}
                  onChange={e => setForm(f => ({ ...f, bidCeiling: e.target.value }))}
                  placeholder="0.00"
                  className="w-full px-3 py-2 border border-border-strong rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-secondary focus:border-secondary"
                />
              </div>

              {/* Est. Resale */}
              <div>
                <label className="block text-sm font-medium text-fg mb-1">Est. Resale ($)</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.estResale}
                  onChange={e => setForm(f => ({ ...f, estResale: e.target.value }))}
                  placeholder="0.00"
                  className="w-full px-3 py-2 border border-border-strong rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-secondary focus:border-secondary"
                />
              </div>

              {/* Won Price (conditional) */}
              {form.status === 'won' && (
                <div>
                  <label className="block text-sm font-medium text-fg mb-1">Won Price ($)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.wonPrice}
                    onChange={e => setForm(f => ({ ...f, wonPrice: e.target.value }))}
                    placeholder="0.00"
                    className="w-full px-3 py-2 border border-border-strong rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-secondary focus:border-secondary"
                  />
                </div>
              )}

              {/* Notes */}
              <div className="lg:col-span-3">
                <label className="block text-sm font-medium text-fg mb-1">Notes</label>
                <input
                  type="text"
                  value={form.notes}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  placeholder="Optional notes..."
                  className="w-full px-3 py-2 border border-border-strong rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-secondary focus:border-secondary"
                />
              </div>
            </div>

            {/* Buttons */}
            <div className="flex items-center gap-3 mt-4">
              <button
                onClick={handleSave}
                disabled={!form.lotTitle.trim() || saving}
                className="flex items-center gap-2 px-5 py-2 bg-primary text-white rounded-lg text-sm font-semibold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Save size={16} />
                {saving ? 'Saving...' : editingId ? 'Update Bid' : 'Save Bid'}
              </button>
              <button
                onClick={cancelForm}
                className="flex items-center gap-2 px-4 py-2 border border-border-strong rounded-lg text-sm text-fg-muted hover:bg-muted/40"
              >
                <X size={16} /> Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ─── Filter Tabs ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 bg-surface rounded-xl border border-border shadow-sm p-1">
        <FilterTab label="All" value="all" count={bids.length} active={filter} onClick={setFilter} />
        <FilterTab label="Active" value="active" count={bids.filter(b => b.status === 'active').length} active={filter} onClick={setFilter} />
        <FilterTab label="Won" value="won" count={bids.filter(b => b.status === 'won').length} active={filter} onClick={setFilter} />
        <FilterTab label="Lost" value="lost" count={bids.filter(b => b.status === 'lost').length} active={filter} onClick={setFilter} />
      </div>

      {/* ─── Bid List ────────────────────────────────────────────────── */}
      {filteredBids.length === 0 ? (
        <EmptyState
          icon={Gavel}
          title={bids.length === 0 ? 'No bids tracked yet' : 'No bids match this filter'}
          description={bids.length === 0
            ? 'Start tracking your liquidation bids to monitor win rates and spending.'
            : 'Try a different filter or add a new bid.'}
          action={bids.length === 0 ? () => setFormOpen(true) : null}
          actionLabel={bids.length === 0 ? 'Add Your First Bid' : ''}
        />
      ) : (
        <div className="bg-surface rounded-xl border border-border shadow-sm overflow-hidden">
          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-fg-muted uppercase tracking-wider">
                  <th className="px-3 py-2">Lot</th>
                  <th className="px-3 py-2">Source</th>
                  <th className="px-3 py-2 text-right">Bid</th>
                  <th className="px-3 py-2 text-right">Ceiling</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Alerts</th>
                  <th className="px-3 py-2 text-right">Won Price</th>
                  <th className="px-3 py-2 text-right">Savings</th>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredBids.map((bid, i) => {
                  const savings = bid.status === 'won' && bid.bidCeiling != null && bid.wonPrice != null
                    ? bid.bidCeiling - bid.wonPrice
                    : null;
                  const rowMuted = bid.status === 'lost' || bid.status === 'cancelled';

                  return (
                    <tr
                      key={bid.id}
                      className={`border-b border-border-subtle ${i % 2 === 1 ? 'bg-muted/40' : ''} ${rowMuted ? 'opacity-60' : ''}`}
                    >
                      <td className="px-3 py-2">
                        <div className="font-medium text-fg truncate max-w-[240px]">
                          {bid.lotUrl ? (
                            <a
                              href={bid.lotUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hover:text-secondary inline-flex items-center gap-1"
                            >
                              {bid.lotTitle}
                              <ExternalLink size={12} className="flex-shrink-0" />
                            </a>
                          ) : (
                            bid.lotTitle
                          )}
                        </div>
                        {bid.notes && (
                          <div className="text-xs text-fg-muted mt-0.5 truncate max-w-[240px]">{bid.notes}</div>
                        )}
                      </td>
                      <td className="px-3 py-2"><SourceBadge source={bid.source} /></td>
                      <td className="px-3 py-2 text-right font-mono font-medium">{fmt(bid.bidAmount)}</td>
                      <td className="px-3 py-2 text-right font-mono text-fg-muted">{fmt(bid.bidCeiling)}</td>
                      <td className="px-3 py-2"><StatusBadge status={bid.status} /></td>
                      <td className="px-3 py-2">
                        <AlertSelector
                          value={bid.alertConditions || DEFAULT_ALERT_PRESET}
                          onChange={(v) => handleAlertChange(bid.id, v)}
                          disabled={bid.status !== 'active'}
                        />
                      </td>
                      <td className="px-3 py-2 text-right font-mono font-medium">
                        {bid.status === 'won' ? fmt(bid.wonPrice) : '\u2014'}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {savings != null ? (
                          <span className={savings >= 0 ? 'text-success font-semibold' : 'text-danger'}>
                            {savings >= 0 ? '+' : ''}{fmt(savings)}
                          </span>
                        ) : '\u2014'}
                      </td>
                      <td className="px-4 py-3 text-fg-muted text-xs">{formatDate(bid.bidDate)}</td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {bid.status === 'won' && (
                            <button
                              onClick={() => window.dispatchEvent(new CustomEvent('ui:bidding-open', { detail: { view: 'won-import', bidId: bid.id } }))}
                              className="px-2 py-1 rounded bg-success/10 text-success hover:bg-success/20 text-[10px] font-semibold inline-flex items-center gap-1"
                              title="Import this won lot to Inventory"
                            >
                              → Inv
                            </button>
                          )}
                          <button
                            onClick={() => startEdit(bid)}
                            className="p-1.5 rounded hover:bg-muted text-fg-muted hover:text-secondary"
                            title="Edit"
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            onClick={() => handleDelete(bid.id)}
                            className="p-1.5 rounded hover:bg-danger-subtle text-fg-muted hover:text-danger"
                            title="Delete"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden divide-y divide-border-subtle">
            {filteredBids.map(bid => {
              const savings = bid.status === 'won' && bid.bidCeiling != null && bid.wonPrice != null
                ? bid.bidCeiling - bid.wonPrice
                : null;
              const rowMuted = bid.status === 'lost' || bid.status === 'cancelled';

              return (
                <div key={bid.id} className={`p-4 ${rowMuted ? 'opacity-60' : ''}`}>
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-fg text-sm truncate">
                        {bid.lotUrl ? (
                          <a href={bid.lotUrl} target="_blank" rel="noopener noreferrer" className="hover:text-secondary inline-flex items-center gap-1">
                            {bid.lotTitle}
                            <ExternalLink size={12} />
                          </a>
                        ) : bid.lotTitle}
                      </div>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <SourceBadge source={bid.source} />
                        <StatusBadge status={bid.status} />
                        {bid.status === 'active' && (
                          <AlertSelector
                            value={bid.alertConditions || DEFAULT_ALERT_PRESET}
                            onChange={(v) => handleAlertChange(bid.id, v)}
                          />
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button onClick={() => startEdit(bid)} aria-label="Edit bid" title="Edit" className="p-1.5 rounded hover:bg-muted text-fg-muted"><Pencil size={14} /></button>
                      <button onClick={() => handleDelete(bid.id)} aria-label="Delete bid" title="Delete" className="p-1.5 rounded hover:bg-danger-subtle text-fg-muted"><Trash2 size={14} /></button>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <span className="text-fg-muted">Bid</span>
                      <div className="font-mono font-medium">{fmt(bid.bidAmount)}</div>
                    </div>
                    <div>
                      <span className="text-fg-muted">Ceiling</span>
                      <div className="font-mono">{fmt(bid.bidCeiling)}</div>
                    </div>
                    {bid.status === 'won' && (
                      <div>
                        <span className="text-fg-muted">Won</span>
                        <div className="font-mono font-medium">{fmt(bid.wonPrice)}</div>
                      </div>
                    )}
                    {savings != null && (
                      <div>
                        <span className="text-fg-muted">Savings</span>
                        <div className={`font-mono font-semibold ${savings >= 0 ? 'text-success' : 'text-danger'}`}>
                          {savings >= 0 ? '+' : ''}{fmt(savings)}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="text-xs text-fg-muted mt-2">{formatDate(bid.bidDate)}</div>
                  {bid.notes && <div className="text-xs text-fg-muted mt-1 italic">{bid.notes}</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, color = 'text-fg', mono = false }) {
  return (
    <div className="bg-surface rounded-xl border border-border shadow-sm p-4">
      <div className="flex items-center gap-2 text-fg-muted text-xs font-medium mb-1">
        <Icon size={14} />
        {label}
      </div>
      <div className={`text-lg font-bold ${color} ${mono ? 'font-mono' : ''}`}>{value}</div>
    </div>
  );
}

function FilterTab({ label, value, count, active, onClick }) {
  const isActive = active === value;
  return (
    <button
      onClick={() => onClick(value)}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
        isActive
          ? 'bg-primary text-white'
          : 'text-fg-muted hover:bg-muted/40 hover:text-fg'
      }`}
    >
      {label}
      <span className={`text-xs ${isActive ? 'text-white/70' : 'text-fg-muted'}`}>
        {count}
      </span>
    </button>
  );
}
