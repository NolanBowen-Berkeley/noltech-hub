import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import {
  TrendingDown, TrendingUp, RefreshCw, Play, Pause, Plus, Trash2, CheckCircle,
  AlertTriangle, Loader2, Heart, Package, Clock, Tag, Settings,
  List, History, ChevronDown, ChevronUp, X, Zap, Activity, ArrowUpDown,
} from 'lucide-react';
import { EBAY_TOKEN_KEY, PIPELINE_BASE } from '../../utils/constants';
import { decryptObject } from '../../services/crypto';
import { fmt } from '../../utils/formatters';
import { Button, Input, Label, Modal, Sparkline } from '../../components/ui';
import EmptyState from '../../components/EmptyState';

const MarketRepricer = lazy(() => import('./MarketRepricer'));

// Round a price DOWN to the nearest $x.95 charm-pricing value.
// e.g. 18.88 → 17.95, 19.00 → 18.95, 19.95 → 19.95 (stays).
function charmPrice(price) {
  if (price <= 0.99) return 0.99;
  const whole = Math.floor(price);
  const frac  = price - whole;
  const out   = frac >= 0.95 ? whole + 0.95 : whole - 0.05;
  return Math.max(0.99, Math.round(out * 100) / 100);
}
// Round UP to the nearest $x.95 — used for increase flows so the new price
// lands AT or ABOVE the computed target.
function charmPriceUp(price) {
  if (price <= 0.95) return 0.95;
  const whole = Math.floor(price);
  const frac  = price - whole;
  const out   = frac <= 0.95 ? whole + 0.95 : whole + 1.95;
  return Math.max(0.95, Math.round(out * 100) / 100);
}
// Apply charm rounding in the direction of the move. `pct` is a signed
// percentage (negative = down, positive = up).
function charmForDirection(basePrice, targetPrice, pct) {
  if (pct === 0) return targetPrice;
  return pct > 0 ? charmPriceUp(targetPrice) : charmPrice(targetPrice);
}

// ─── Storage keys ─────────────────────────────────────────────────────────────
const KEY_RULES     = 'noltech:pricereductor:rules';
const KEY_ORIGINALS = 'noltech:pricereductor:originals'; // { [itemId]: { originalPrice, firstSeenAt } }
const KEY_LOG       = 'noltech:pricereductor:log';
const KEY_AUTO      = 'noltech:pricereductor:auto';

const INTERVALS = [
  { label: 'Every hour',    ms: 60 * 60 * 1000 },
  { label: 'Every 6 hours', ms: 6 * 60 * 60 * 1000 },
  { label: 'Every 12 hours',ms: 12 * 60 * 60 * 1000 },
  { label: 'Once a day',    ms: 24 * 60 * 60 * 1000 },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}
function pctCls(n) {
  return n > 0 ? 'text-success' : n < 0 ? 'text-danger' : 'text-fg-muted';
}
function daysAgo(isoDate) {
  if (!isoDate) return null;
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / 86400000);
}
function ageCls(days) {
  if (days == null) return 'text-fg-muted';
  if (days >= 30) return 'text-danger font-semibold';
  if (days >= 14) return 'text-warning font-medium';
  return 'text-fg-muted';
}

// ─── Default rules ────────────────────────────────────────────────────────────
const DEFAULT_RULES = [
  {
    id: 'default-1',
    name: '7-day step-down',
    enabled: true,
    direction: 'down',
    triggerAfterDays: 7,
    reduceByPct: 5,
    maxReductionPct: 30,
    minPrice: 9.99,
    maxPrice: 0, // 0 = no ceiling
    skuPattern: '',
  },
];

// ─── Rule Form ────────────────────────────────────────────────────────────────
const BLANK_RULE = {
  name: '', enabled: true,
  direction: 'down',
  triggerAfterDays: 7,
  reduceByPct: 5,
  maxReductionPct: 30,
  minPrice: 9.99,
  maxPrice: 0,
  skuPattern: '',
};

function RuleForm({ initial, onSave, onCancel }) {
  // Normalize legacy rules (no direction field) → 'down'
  const [form, setForm] = useState({ direction: 'down', maxPrice: 0, ...(initial || BLANK_RULE) });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setNum = (k) => (e) => setForm((f) => ({ ...f, [k]: parseFloat(e.target.value) || 0 }));
  const direction = form.direction || 'down';
  const isUp = direction === 'up';

  const perCycleLabel = isUp ? 'Increase by (% per cycle)' : 'Reduce by (% per cycle)';
  const maxTotalLabel = isUp ? 'Max total increase (%)' : 'Max total reduction (%)';
  const maxTotalHelp  = isUp
    ? 'Never raise more than this % above original'
    : 'Never reduce more than this % from original';

  return (
    <div className="bg-muted/40 border border-border rounded-xl p-4 space-y-3">
      {/* Direction toggle */}
      <div>
        <Label>Direction</Label>
        <div className="inline-flex rounded-lg border border-border bg-surface p-0.5">
          {[
            { id: 'down', label: 'Reduce', icon: TrendingDown, cls: 'text-danger' },
            { id: 'up',   label: 'Increase', icon: TrendingUp, cls: 'text-success' },
          ].map((d) => {
            const active = direction === d.id;
            const Icon = d.icon;
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => setForm((f) => ({ ...f, direction: d.id }))}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  active ? `bg-muted/80 text-fg ${d.cls}` : 'text-fg-muted hover:text-fg'
                }`}
              >
                <Icon size={12} /> {d.label}
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-fg-muted mt-1">
          {isUp
            ? 'Raise asks on aging listings — useful when demand picks up or you want to claw back a past drop.'
            : 'Drop asks on aging listings — classic markdown schedule.'}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2">
          <Label>Rule Name</Label>
          <Input value={form.name} onChange={set('name')} placeholder={isUp ? '14-day bump' : '7-day step-down'} />
        </div>

        <div>
          <Label>Trigger after (days listed)</Label>
          <Input type="number" min="1" value={form.triggerAfterDays} onChange={setNum('triggerAfterDays')} />
          <p className="text-[11px] text-fg-muted mt-0.5">{isUp ? 'Raise again every this many days' : 'Reduce again every this many days'}</p>
        </div>

        <div>
          <Label>{perCycleLabel}</Label>
          <Input type="number" min="0.1" max="50" step="0.1" value={form.reduceByPct} onChange={setNum('reduceByPct')} />
        </div>

        <div>
          <Label>{maxTotalLabel}</Label>
          <Input type="number" min="1" max="200" value={form.maxReductionPct} onChange={setNum('maxReductionPct')} />
          <p className="text-[11px] text-fg-muted mt-0.5">{maxTotalHelp}</p>
        </div>

        <div>
          <Label>Price floor ($)</Label>
          <Input type="number" min="0.01" step="0.01" value={form.minPrice} onChange={setNum('minPrice')} />
          <p className="text-[11px] text-fg-muted mt-0.5">Never go below this price</p>
        </div>

        <div>
          <Label>Price ceiling ($)<span className="text-fg-subtle text-[10px] ml-1">optional</span></Label>
          <Input type="number" min="0" step="0.01" value={form.maxPrice || ''} onChange={setNum('maxPrice')} placeholder="0 = no ceiling" />
          <p className="text-[11px] text-fg-muted mt-0.5">
            {isUp ? 'Stop raising once you hit this price' : 'Safety cap — useful if someone over-edited manually'}
          </p>
        </div>

        <div className="sm:col-span-2">
          <Label hint="optional — leave blank to apply to all">SKU Pattern filter</Label>
          <Input value={form.skuPattern} onChange={set('skuPattern')}
            placeholder="e.g. LOT001 — only applies to SKUs containing this text" />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-fg cursor-pointer">
          <input type="checkbox" checked={form.enabled}
            onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
            className="accent-primary w-4 h-4" />
          Enabled
        </label>
        <div className="flex gap-2 ml-auto">
          <Button variant="accent" onClick={() => onSave({ ...form, id: form.id || uuid() })}>Save Rule</Button>
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}

// ─── Rules Tab ────────────────────────────────────────────────────────────────
function RulesTab({ rules, onRulesChange }) {
  const [showForm, setShowForm] = useState(false);
  const [editing,  setEditing]  = useState(null);

  const save = (rule) => {
    const updated = editing ? rules.map((r) => r.id === rule.id ? rule : r) : [...rules, rule];
    onRulesChange(updated);
    setShowForm(false); setEditing(null);
  };
  const del = (id) => { if (confirm('Delete rule?')) onRulesChange(rules.filter((r) => r.id !== id)); };
  const toggle = (id) => onRulesChange(rules.map((r) => r.id === id ? { ...r, enabled: !r.enabled } : r));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-fg-muted">{rules.length} rule{rules.length !== 1 ? 's' : ''}</p>
        {!showForm && !editing && (
          <button onClick={() => setShowForm(true)}
            className="flex items-center gap-1.5 px-3 py-2 bg-primary text-white text-sm font-semibold rounded-lg hover:bg-primary/90 transition-colors">
            <Plus size={14} /> Add Rule
          </button>
        )}
      </div>

      {showForm && !editing && <RuleForm onSave={save} onCancel={() => setShowForm(false)} />}

      {rules.length === 0 && !showForm && (
        <EmptyState
          icon={TrendingDown}
          title="No rules yet"
          description="Add a rule to schedule price reductions or increases over time."
        />
      )}

      {rules.map((rule) => {
        const dir = rule.direction === 'up' ? 'up' : 'down';
        const isUp = dir === 'up';
        const DirIcon = isUp ? TrendingUp : TrendingDown;
        return (
        <div key={rule.id} className={`bg-surface rounded-xl border shadow-sm p-4 ${rule.enabled ? 'border-border' : 'border-border opacity-60'}`}>
          {editing?.id === rule.id ? (
            <RuleForm initial={rule} onSave={save} onCancel={() => setEditing(null)} />
          ) : (
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <input type="checkbox" checked={rule.enabled} onChange={() => toggle(rule.id)}
                  className="accent-primary w-4 h-4 mt-0.5 cursor-pointer" />
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className={`inline-flex items-center gap-0.5 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${isUp ? 'bg-success-subtle text-success' : 'bg-danger-subtle text-danger'}`}>
                      <DirIcon size={9} /> {isUp ? 'Raise' : 'Reduce'}
                    </span>
                    <p className="text-sm font-semibold text-fg">{rule.name}</p>
                  </div>
                  <p className="text-xs text-fg-muted mt-1">
                    After <strong>{rule.triggerAfterDays}d</strong> listed →
                    {isUp ? ' raise ' : ' reduce '}<strong>{rule.reduceByPct}%</strong> per cycle ·
                    max <strong>{rule.maxReductionPct}%</strong> {isUp ? 'above original' : 'off original'} ·
                    floor <strong>{fmt(rule.minPrice)}</strong>
                    {rule.maxPrice > 0 && <> · ceiling <strong>{fmt(rule.maxPrice)}</strong></>}
                    {rule.skuPattern && <> · SKU contains <span className="font-mono">{rule.skuPattern}</span></>}
                  </p>
                </div>
              </div>
              <div className="flex gap-1 shrink-0">
                <button onClick={() => setEditing(rule)} className="text-xs px-2 py-1.5 border border-border rounded-lg text-fg-muted hover:bg-muted/40">Edit</button>
                <button onClick={() => del(rule.id)} className="p-1.5 border border-border rounded-lg text-fg-muted hover:bg-danger-subtle hover:text-danger hover:border-danger/30 transition-colors">
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          )}
        </div>
        );
      })}
    </div>
  );
}

// ─── Confirm Reduction Modal ──────────────────────────────────────────────────
function ConfirmReductionModal({ reductions, onConfirm, onCancel }) {
  const totalOld    = reductions.reduce((s, r) => s + r.oldPrice * Math.max(1, parseInt(r.quantity) || 1), 0);
  const totalNew    = reductions.reduce((s, r) => s + r.newPrice * Math.max(1, parseInt(r.quantity) || 1), 0);
  const totalImpact = totalNew - totalOld;
  const totalUnits  = reductions.reduce((s, r) => s + Math.max(1, parseInt(r.quantity) || 1), 0);

  // Split reductions vs increases for dual-direction headers
  const downs = reductions.filter((r) => r.newPrice < r.oldPrice);
  const ups   = reductions.filter((r) => r.newPrice > r.oldPrice);
  const mixed = downs.length > 0 && ups.length > 0;
  const netPositive = totalImpact >= 0;

  const headerClass = mixed
    ? 'bg-warning-subtle border-warning/30'
    : netPositive
      ? 'bg-success-subtle border-success/30'
      : 'bg-danger-subtle border-danger/30';
  const impactClass = mixed
    ? 'text-accent'
    : netPositive
      ? 'text-success'
      : 'text-danger';
  const HeaderIcon = mixed ? ArrowUpDown : netPositive ? TrendingUp : TrendingDown;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-surface rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-border-subtle">
          <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${
            mixed ? 'bg-warning-subtle' : netPositive ? 'bg-success-subtle' : 'bg-danger-subtle'
          }`}>
            <HeaderIcon size={18} className={impactClass} />
          </div>
          <div>
            <p className="font-semibold text-fg">
              Apply {reductions.length} Price Change{reductions.length !== 1 ? 's' : ''}?
            </p>
            <p className="text-xs text-fg-muted">
              {mixed
                ? `${downs.length} reduction${downs.length !== 1 ? 's' : ''} · ${ups.length} increase${ups.length !== 1 ? 's' : ''} — live on eBay`
                : netPositive
                  ? 'Increases will be pushed live on eBay'
                  : 'Reductions will be pushed live on eBay'}
            </p>
          </div>
          <button onClick={onCancel} className="ml-auto text-fg-muted hover:text-fg">
            <X size={18} />
          </button>
        </div>

        {/* Earnings impact summary */}
        <div className={`px-6 py-4 border-b flex items-center justify-between ${headerClass}`}>
          <div>
            <p className="text-xs font-semibold text-fg-muted uppercase tracking-wide">Total Listing Value Impact</p>
            <p className={`text-2xl font-bold font-mono ${impactClass}`}>
              {totalImpact > 0 ? '+' : ''}{fmt(totalImpact)}
            </p>
          </div>
          <div className="text-right text-sm text-fg-muted">
            <p>{fmt(totalOld)} → <span className="font-semibold text-fg">{fmt(totalNew)}</span></p>
            <p className="text-xs">
              {reductions.length} listing{reductions.length !== 1 ? 's' : ''} · {totalUnits} unit{totalUnits !== 1 ? 's' : ''}
            </p>
          </div>
        </div>

        {/* Per-item list */}
        <div className="max-h-56 overflow-y-auto divide-y divide-border-subtle">
          {reductions.map((r) => {
            const qty = Math.max(1, parseInt(r.quantity) || 1);
            const rowImpact = (r.newPrice - r.oldPrice) * qty;
            const isUp = rowImpact > 0;
            return (
              <div key={r.itemId} className="flex items-center gap-3 px-6 py-2.5">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-fg truncate">{r.title}</p>
                  <p className="text-xs text-fg-muted">
                    {r.sku || r.itemId}{qty > 1 ? ` · qty ${qty}` : ''}
                  </p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-sm font-mono">
                    <span className="line-through text-fg-muted">{fmt(r.oldPrice)}</span>
                    {' → '}
                    <span className="font-semibold text-fg">{fmt(r.newPrice)}</span>
                  </p>
                  <p className={`text-xs font-mono ${isUp ? 'text-success' : 'text-danger'}`}>
                    {isUp ? '+' : ''}{fmt(rowImpact)}{qty > 1 ? ` (${qty}×)` : ''}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        {/* Actions */}
        <div className="flex gap-3 px-6 py-4 border-t border-border-subtle">
          <button onClick={onCancel}
            className="flex-1 px-4 py-2 border border-border rounded-lg text-sm font-medium text-fg-muted hover:bg-muted/40 transition-colors">
            Cancel
          </button>
          <button onClick={onConfirm}
            className="flex-1 px-4 py-2 bg-accent text-white rounded-lg text-sm font-semibold hover:bg-accent-hover transition-colors flex items-center justify-center gap-2">
            <Zap size={14} />
            {mixed ? 'Confirm Changes' : netPositive ? 'Confirm Increases' : 'Confirm Reductions'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Listings Tab ─────────────────────────────────────────────────────────────
function ListingsTab({ creds, rules, originals, onOriginalsChange, onApply, applying, progress, log = [] }) {
  const [listings,   setListings]   = useState([]);
  const [preview,    setPreview]    = useState([]); // reductions to apply
  const [loading,    setLoading]    = useState(false);
  const [preloading, setPreloading] = useState(false);
  const [error,      setError]      = useState('');
  const [selected,   setSelected]   = useState(new Set()); // itemIds selected to apply
  const [sortBy,     setSortBy]     = useState('days');
  const [showOnly,   setShowOnly]   = useState('all'); // all | pending | ok | selected
  const [confirmItems, setConfirmItems] = useState(null); // reductions pending confirmation
  const [manualReductions, setManualReductions] = useState({}); // { itemId: reductionPct } — user-set overrides
  const [defaultReductionPct, setDefaultReductionPct] = useState(10); // used for newly-selected non-rule items

  const fetch = async () => {
    if (!creds.userToken) return setError('Enter your eBay credentials in the Settings tab first.');
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams(creds).toString();
      const res    = await window.fetch(`${PIPELINE_BASE}/api/ebay/listings?${params}`, { signal: AbortSignal.timeout(45000) });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      // Record originals for newly-seen items, and repair any entries where
      // the price was recorded as 0 (e.g. a parse failure on a previous run).
      const updated = { ...originals };
      let changed = false;
      for (const l of data.listings) {
        const existing = updated[l.itemId];
        const hasValidOriginal = existing && existing.originalPrice > 0;
        if (!hasValidOriginal && l.currentPrice > 0) {
          updated[l.itemId] = {
            originalPrice: l.currentPrice,
            firstSeenAt: existing?.firstSeenAt || new Date().toISOString(),
          };
          changed = true;
        }
      }
      if (changed) onOriginalsChange(updated);
      setListings(data.listings);
      await runPreview(data.listings, updated);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const runPreview = async (listingsList, origs) => {
    if (!creds.userToken || !listingsList.length) return;
    setPreloading(true);
    try {
      const res = await window.fetch(`${PIPELINE_BASE}/api/ebay/preview-reductions`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ creds, rules, originals: origs }),
        signal:  AbortSignal.timeout(45000),
      });
      const data = await res.json();
      if (data.success) {
        setPreview(data.reductions || []);
        // Select rule-flagged by default; keep any existing manual selections
        setSelected((prev) => {
          const next = new Set(prev);
          (data.reductions || []).forEach((r) => next.add(r.itemId));
          return next;
        });
      }
    } catch (e) { console.error('[PriceReductor] preview reductions failed:', e); }
    finally { setPreloading(false); }
  };

  const previewMap = Object.fromEntries(preview.map((r) => [r.itemId, r]));

  const sorted = [...listings].sort((a, b) => {
    const da = daysAgo(a.startTime) ?? 0;
    const db = daysAgo(b.startTime) ?? 0;
    if (sortBy === 'days')    return db - da;
    if (sortBy === 'price')   return b.currentPrice - a.currentPrice;
    if (sortBy === 'views')   return b.hitCount - a.hitCount;
    if (sortBy === 'watches') return b.watchCount - a.watchCount;
    return 0;
  }).filter((l) => {
    if (showOnly === 'pending')  return !!previewMap[l.itemId];
    if (showOnly === 'ok')       return !previewMap[l.itemId];
    if (showOnly === 'selected') return selected.has(l.itemId);
    return true;
  });

  // Build the effective price change for any selected item. Supports both
  // directions — `pct` is a SIGNED percentage: positive = increase from
  // current, negative = reduce from current. Server-returned rule reductions
  // carry their own signed `reduction` + direction which we trust verbatim.
  const buildReduction = (itemId) => {
    const listing = listings.find((l) => l.itemId === itemId);
    if (!listing) return null;
    const ruleReduction = previewMap[itemId];
    const manualOverride = manualReductions[itemId];
    const hasManual = manualOverride != null && manualOverride !== '';

    // Default signed pct. For rules, use their direction-aware signed reduction.
    // If the server sent us back a signed `adjustment`, use that; otherwise
    // fall back to `reduction` which was historically a positive number for
    // "down" rules.
    let pct;
    if (hasManual) {
      pct = parseFloat(manualOverride);
    } else if (ruleReduction) {
      pct = ruleReduction.adjustment != null
        ? ruleReduction.adjustment
        : (ruleReduction.direction === 'up' ? Math.abs(ruleReduction.reduction) : -Math.abs(ruleReduction.reduction));
    } else {
      // defaultReductionPct is stored as POSITIVE = reduction. User can type
      // negative to force an increase from current.
      pct = -Math.abs(defaultReductionPct);
    }
    if (!pct || Math.abs(pct) < 0.01) return null;

    // Trust server's newPrice when available AND user hasn't overridden.
    let newPrice;
    if (ruleReduction && !hasManual) {
      newPrice = ruleReduction.newPrice;
    } else {
      const raw = listing.currentPrice * (1 + pct / 100);
      newPrice = pct > 0 ? charmPriceUp(raw) : charmPrice(raw);
    }

    // Sanity: don't submit a "change" that doesn't actually move the price
    if (Math.abs(newPrice - listing.currentPrice) < 0.01) return null;

    return {
      itemId,
      title:        listing.title,
      sku:          listing.sku,
      oldPrice:     listing.currentPrice,
      newPrice,
      quantity:     Math.max(1, parseInt(listing.quantity) || 1),
      reduction:    pct, // signed: negative = down, positive = up
      adjustment:   pct,
      direction:    pct > 0 ? 'up' : 'down',
      listingType:  listing.listingType || 'FixedPriceItem',
      ruleName:     ruleReduction?.ruleName || 'Manual',
    };
  };

  const handleApply = () => {
    const toApply = [...selected].map(buildReduction).filter(Boolean);
    if (!toApply.length) return;
    setConfirmItems(toApply);
  };

  const confirmApply = async () => {
    const toApply = confirmItems;
    setConfirmItems(null);
    await onApply(toApply);
    await fetch();
  };

  return (
    <div className="space-y-4">
      {confirmItems && (
        <ConfirmReductionModal
          reductions={confirmItems}
          onConfirm={confirmApply}
          onCancel={() => setConfirmItems(null)}
        />
      )}
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={fetch} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-2 bg-primary text-white text-sm font-semibold rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors">
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {listings.length ? 'Refresh' : 'Fetch Listings'}
        </button>

        {listings.length > 0 && (
          <>
            <label className="flex items-center gap-1.5 text-xs text-fg-muted whitespace-nowrap" title="Positive = reduce, negative = increase. Applied to manually selected listings.">
              Default %:
              <input
                type="number"
                min="-200"
                max="200"
                step="0.5"
                value={defaultReductionPct}
                onChange={(e) => setDefaultReductionPct(parseFloat(e.target.value) || 0)}
                className={`w-20 border border-border rounded-md px-2 py-1 text-xs bg-surface font-mono focus:outline-none focus:ring-2 focus:ring-accent-ring/40 ${
                  defaultReductionPct < 0 ? 'text-success' : 'text-fg'
                }`}
                title="Positive = reduce, negative = increase"
              />
              <span className="text-[10px] text-fg-subtle font-mono">
                {defaultReductionPct > 0 ? '↓' : defaultReductionPct < 0 ? '↑' : ''}
              </span>
            </label>

            <button onClick={handleApply} disabled={applying || selected.size === 0}
              className="flex items-center gap-1.5 px-3 py-2 bg-accent text-white text-sm font-semibold rounded-lg hover:bg-accent-hover disabled:opacity-50 transition-colors">
              {applying ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
              {applying && progress
                ? `Applying ${progress.done}/${progress.total}…`
                : `Apply ${selected.size} Change${selected.size !== 1 ? 's' : ''}`}
            </button>

            <div className="flex gap-1 ml-auto">
              {[['all','All'],['selected','Selected'],['pending','Rule-Flagged'],['ok','Not Flagged']].map(([v,l]) => (
                <button key={v} onClick={() => setShowOnly(v)}
                  className={`text-xs px-2.5 py-1.5 rounded-lg border font-medium transition-colors ${
                    showOnly === v ? 'bg-primary text-white border-primary' : 'bg-surface border-border text-fg-muted hover:bg-muted/40'
                  }`}>{l}</button>
              ))}
            </div>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}
              className="text-xs border border-border rounded-lg px-2 py-1.5 bg-surface text-fg">
              <option value="days">Sort: Oldest First</option>
              <option value="price">Sort: Highest Price</option>
              <option value="watches">Sort: Most Watchers</option>
            </select>
          </>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 px-4 py-3 bg-danger-subtle border border-danger/30 rounded-xl text-sm text-danger">
          <AlertTriangle size={15} className="shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {/* Summary bar */}
      {listings.length > 0 && (() => {
        // 30-day daily reduction counts + $ saved series (from log)
        const days = 30;
        const msDay = 86400000;
        const now = Date.now();
        const bucketStart = now - (days - 1) * msDay;
        const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0,0,0,0); return d.getTime(); };
        const countByDay  = new Array(days).fill(0);
        const savedByDay  = new Array(days).fill(0);
        const combinedValue = listings.reduce((a, l) => a + (l.currentPrice || 0) * (l.quantity || 1), 0);
        let combinedSpark = [];
        log.forEach((e) => {
          const t = e.appliedAt ? new Date(e.appliedAt).getTime() : 0;
          if (!t) return;
          const idx = Math.floor((startOfDay(t) - startOfDay(bucketStart)) / msDay);
          if (idx >= 0 && idx < days) {
            countByDay[idx] += 1;
            savedByDay[idx] += Math.max(0, (e.oldPrice || 0) - (e.newPrice || 0));
          }
        });
        // Cumulative combined-value trend from log: start with current value and walk backwards
        // subtracting each reduction's delta × qty (approximate — assumes qty 1 unless stored).
        const reverseDeltas = new Array(days).fill(0);
        log.forEach((e) => {
          const t = e.appliedAt ? new Date(e.appliedAt).getTime() : 0;
          if (!t) return;
          const idx = Math.floor((startOfDay(t) - startOfDay(bucketStart)) / msDay);
          if (idx >= 0 && idx < days) {
            reverseDeltas[idx] += Math.max(0, (e.oldPrice || 0) - (e.newPrice || 0)) * (e.quantity || 1);
          }
        });
        let running = combinedValue;
        combinedSpark = new Array(days);
        for (let i = days - 1; i >= 0; i--) {
          combinedSpark[i] = running;
          running += reverseDeltas[i];
        }
        const previewDowns = preview.filter((r) => (r.direction || 'down') === 'down').length;
        const previewUps   = preview.filter((r) => r.direction === 'up').length;
        const needChangeLabel = previewDowns > 0 && previewUps > 0
          ? 'Need Change'
          : previewUps > 0 ? 'Need Increase' : 'Need Reduction';
        const needChangeIcon = previewUps > 0 && previewDowns === 0
          ? TrendingUp
          : previewUps > 0 && previewDowns > 0 ? ArrowUpDown : TrendingDown;
        const needChangeValue = previewDowns + previewUps > 0
          ? `${previewDowns + previewUps}${previewUps > 0 && previewDowns > 0 ? ` (${previewDowns}↓/${previewUps}↑)` : ''}`
          : 0;
        const cards = [
          { label: 'Active Listings', value: listings.length, icon: Package, spark: null },
          { label: 'Combined Value',  value: fmt(combinedValue), icon: Package, spark: combinedSpark, color: 'var(--success)' },
          { label: needChangeLabel,   value: needChangeValue,    icon: needChangeIcon, cls: preview.length > 0 ? 'text-accent' : 'text-fg-muted', spark: countByDay, color: 'var(--accent)' },
          { label: 'Total Watchers',  value: listings.reduce((a,l) => a + l.watchCount, 0), icon: Heart, spark: null },
        ];
        return (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {cards.map(({ label, value, icon: Icon, cls, spark, color }) => (
              <div key={label} className="card-hover bg-surface rounded-xl border border-border px-3 py-2.5 flex items-center gap-2.5">
                <Icon size={15} className={cls || 'text-fg-muted'} />
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] text-fg-muted uppercase tracking-wide">{label}</p>
                  <p className={`text-base font-bold font-mono tabular-nums ${cls || 'text-fg'}`}>{value}</p>
                  {spark && spark.some((n) => n > 0) && (
                    <div className="mt-0.5 -mb-0.5">
                      <Sparkline data={spark} color={color || 'var(--fg-muted)'} width={72} height={14} />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        );
      })()}

      {/* Listings table */}
      {sorted.length > 0 && (
        <div className="bg-surface rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 border-b border-border">
                <tr>
                  <th className="px-3 py-2.5 w-8">
                    <input type="checkbox"
                      checked={sorted.length > 0 && sorted.every((l) => selected.has(l.itemId))}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelected((s) => { const n = new Set(s); sorted.forEach((l) => n.add(l.itemId)); return n; });
                        } else {
                          setSelected((s) => { const n = new Set(s); sorted.forEach((l) => n.delete(l.itemId)); return n; });
                        }
                      }}
                      title="Select all visible"
                      className="accent-primary w-3.5 h-3.5" />
                  </th>
                  {['Title / SKU', 'Days', 'Watchers', 'Current', 'Adjust %', 'New Price', 'Source'].map((h) => (
                    <th key={h} className="px-3 py-2.5 text-left font-semibold text-fg-muted whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {sorted.map((l, i) => {
                  const r    = previewMap[l.itemId];
                  const days = daysAgo(l.startTime);
                  const orig = originals[l.itemId]?.originalPrice;
                  const isSelected = selected.has(l.itemId);
                  const manualPct = manualReductions[l.itemId];

                  // Rule's native signed pct vs. current price (not original).
                  const rulePctVsCurrent = r
                    ? ((r.newPrice - l.currentPrice) / l.currentPrice) * 100
                    : null;

                  // Signed effective pct (negative = reduce, positive = increase)
                  let effectivePct;
                  if (manualPct != null && manualPct !== '') {
                    effectivePct = parseFloat(manualPct);
                  } else if (r) {
                    effectivePct = rulePctVsCurrent;
                  } else {
                    // Default field is positive=reduction, so flip sign
                    effectivePct = -Math.abs(defaultReductionPct);
                  }

                  // Compute preview price using signed pct
                  let previewNewPrice;
                  if (r && manualPct == null) {
                    previewNewPrice = r.newPrice;
                  } else if (Math.abs(effectivePct) >= 0.01) {
                    const raw = l.currentPrice * (1 + effectivePct / 100);
                    previewNewPrice = effectivePct > 0 ? charmPriceUp(raw) : charmPrice(raw);
                  } else {
                    previewNewPrice = l.currentPrice;
                  }

                  const dir = effectivePct > 0 ? 'up' : effectivePct < 0 ? 'down' : 'flat';
                  const source = manualPct != null
                    ? 'Manual'
                    : r?.ruleName
                      ? r.ruleName
                      : isSelected
                        ? 'Default'
                        : '—';
                  return (
                    <tr key={l.itemId} className={`${i % 2 === 0 ? 'bg-surface' : 'bg-muted/20'} ${isSelected ? 'ring-1 ring-inset ring-accent/40' : r ? 'ring-1 ring-inset ring-warning/30' : ''}`}>
                      <td className="px-3 py-2.5 text-center">
                        <input type="checkbox"
                          checked={isSelected}
                          onChange={(e) => setSelected((s) => {
                            const n = new Set(s);
                            e.target.checked ? n.add(l.itemId) : n.delete(l.itemId);
                            return n;
                          })}
                          className="accent-primary w-3.5 h-3.5" />
                      </td>
                      <td className="px-3 py-2.5 max-w-[200px]">
                        <p className="font-medium text-fg truncate" title={l.title}>{l.title}</p>
                        {l.sku && <p className="font-mono text-fg-muted text-[11px]">{l.sku}</p>}
                        {orig && orig !== l.currentPrice && (
                          <p className="text-[11px] text-fg-muted">orig {fmt(orig)}</p>
                        )}
                      </td>
                      <td className={`px-3 py-2.5 whitespace-nowrap ${ageCls(days)}`}>{days != null ? `${days}d` : '—'}</td>
                      <td className="px-3 py-2.5 text-center">
                        <span className="flex items-center gap-0.5"><Heart size={11} className="text-fg-muted" />{l.watchCount || 0}</span>
                      </td>
                      <td className="px-3 py-2.5 font-mono font-semibold text-fg">{fmt(l.currentPrice)}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            min="-200"
                            max="200"
                            step="0.5"
                            value={manualPct != null ? manualPct : (r ? rulePctVsCurrent?.toFixed(1) : '')}
                            onChange={(e) => {
                              const v = e.target.value;
                              setManualReductions((m) => {
                                const next = { ...m };
                                if (v === '') delete next[l.itemId];
                                else next[l.itemId] = v;
                                return next;
                              });
                              if (v !== '' && !isSelected) {
                                setSelected((s) => new Set(s).add(l.itemId));
                              }
                            }}
                            disabled={!isSelected && !r}
                            placeholder={r ? `${rulePctVsCurrent?.toFixed(1)}` : `-${Math.abs(defaultReductionPct)}`}
                            className={`w-20 border border-border rounded-md px-2 py-0.5 text-xs bg-surface font-mono focus:outline-none focus:ring-1 focus:ring-accent-ring/40 disabled:opacity-40 ${
                              dir === 'up' ? 'text-success' : dir === 'down' ? 'text-danger' : 'text-fg'
                            }`}
                            title="Positive = raise price, negative = reduce"
                          />
                          <span className={`text-[11px] ${dir === 'up' ? 'text-success' : dir === 'down' ? 'text-danger' : 'text-fg-muted'}`}>
                            {dir === 'up' ? '↑' : dir === 'down' ? '↓' : '%'}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 font-mono">
                        {isSelected || r ? (
                          <span className={`font-semibold ${dir === 'up' ? 'text-success' : dir === 'down' ? 'text-warning-fg' : 'text-fg'}`}>
                            {fmt(previewNewPrice)}
                          </span>
                        ) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-fg-muted max-w-[120px] truncate text-[11px]">{source}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {listings.length === 0 && !loading && !error && (
        <div className="text-center py-10 text-fg-muted">
          <Package size={36} className="mx-auto mb-3 opacity-25" />
          <p className="font-medium">No active listings</p>
          <p className="text-sm mt-1">Tap Fetch Listings to pull your active eBay inventory.</p>
        </div>
      )}

      {preloading && (
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <Loader2 size={12} className="animate-spin" /> Computing reductions…
        </div>
      )}
    </div>
  );
}

// ─── Log Tab ──────────────────────────────────────────────────────────────────
function LogTab({ log, onClear }) {
  if (!log.length) return (
    <div className="text-center py-10 text-fg-muted">
      <History size={36} className="mx-auto mb-3 opacity-25" />
      <p className="font-medium">No price changes applied yet</p>
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-fg-muted">{log.length} price changes recorded</p>
        <button onClick={() => { if (confirm('Clear log?')) onClear(); }}
          className="text-xs border border-border text-fg-muted px-3 py-1.5 rounded-lg hover:bg-danger-subtle hover:text-danger hover:border-danger/30 transition-colors">
          Clear Log
        </button>
      </div>
      <div className="bg-surface rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 border-b border-border">
              <tr>
                {['Applied At', 'SKU', 'Title', 'Old Price', 'New Price', 'Saved', 'Rule'].map((h) => (
                  <th key={h} className="px-3 py-2.5 text-left font-semibold text-fg-muted whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {[...log].reverse().map((entry, i) => (
                <tr key={i} className={i % 2 === 0 ? 'bg-surface' : 'bg-muted/40'}>
                  <td className="px-3 py-2 text-fg-muted whitespace-nowrap">{new Date(entry.appliedAt).toLocaleString()}</td>
                  <td className="px-3 py-2 font-mono">{entry.sku || '—'}</td>
                  <td className="px-3 py-2 max-w-[180px] truncate text-fg" title={entry.title}>{entry.title}</td>
                  <td className="px-3 py-2 font-mono text-fg-muted line-through">{fmt(entry.oldPrice)}</td>
                  <td className="px-3 py-2 font-mono font-semibold text-fg">{fmt(entry.newPrice)}</td>
                  <td className="px-3 py-2 font-mono text-success">−{fmt(entry.oldPrice - entry.newPrice)}</td>
                  <td className="px-3 py-2 text-fg-muted">{entry.ruleName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────
function SettingsTab({ autoConfig, onAutoChange }) {
  const inputCls = 'w-full border border-border rounded-lg px-3 py-2 text-sm bg-surface text-fg focus:outline-none focus:ring-1 focus:ring-primary';
  return (
    <div className="space-y-5 max-w-lg">
      <div className="flex items-start gap-3 bg-muted/40 border border-border rounded-xl px-4 py-3">
        <Settings className="w-4 h-4 text-fg-muted flex-shrink-0 mt-0.5" />
        <p className="text-xs text-fg-muted leading-relaxed">
          eBay credentials (User Token, App ID, Dev ID, Cert ID) are managed in{' '}
          <strong className="text-fg">App Settings → eBay Credentials</strong>.
          Changes there apply to all modules automatically.
        </p>
      </div>

      <div>
        <p className="text-sm font-semibold text-fg mb-3">Auto-Reduce Schedule</p>
        <p className="text-xs text-fg-muted mb-3">
          While the app is open, automatically check and apply price reductions on the selected interval.
        </p>
        <div className="space-y-2.5">
          <label className="flex items-center gap-2 text-sm text-fg cursor-pointer">
            <input type="checkbox" className="accent-primary w-4 h-4"
              checked={autoConfig.enabled}
              onChange={(e) => onAutoChange({ ...autoConfig, enabled: e.target.checked })} />
            Enable auto-reduce
          </label>
          <div>
            <label className="text-xs font-medium text-fg-muted block mb-1">Run interval</label>
            <select className={inputCls} value={autoConfig.intervalMs}
              onChange={(e) => onAutoChange({ ...autoConfig, intervalMs: parseInt(e.target.value) })}>
              {INTERVALS.map(({ label, ms }) => (
                <option key={ms} value={ms}>{label}</option>
              ))}
            </select>
          </div>
          {autoConfig.lastRunAt && (
            <p className="text-xs text-fg-muted">
              Last run: {new Date(autoConfig.lastRunAt).toLocaleString()}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main Shell ───────────────────────────────────────────────────────────────
// No tabs — Listings is the only view. Market / Rules / Log / Settings open as modal overlays.

const DEFAULT_AUTO = { enabled: false, intervalMs: INTERVALS[0].ms, lastRunAt: null };

export default function PriceReductor() {
  const [modal,     setModal]     = useState(null); // 'market' | 'rules' | 'log' | 'settings' | null
  const [creds,     setCreds]     = useState({ userToken: '', appId: '', devId: '', certId: '' });
  const [rules,     setRules]     = useState(DEFAULT_RULES);
  const [originals, setOriginals] = useState({});
  const [log,       setLog]       = useState([]);
  const [autoConfig,setAutoConfig]= useState(DEFAULT_AUTO);
  const [applying,  setApplying]  = useState(false);
  const [applyProgress, setApplyProgress] = useState(null); // { done, total }
  const [autoStatus,setAutoStatus]= useState(''); // last auto-run message
  const [loaded,    setLoaded]    = useState(false);
  const autoRef = useRef(null);

  // Load from storage
  useEffect(() => {
    (async () => {
      try {
        const [c, r, o, l, a] = await Promise.all([
          window.storage.get(EBAY_TOKEN_KEY).then(raw => decryptObject(raw || {})),
          window.storage.get(KEY_RULES),
          window.storage.get(KEY_ORIGINALS),
          window.storage.get(KEY_LOG),
          window.storage.get(KEY_AUTO),
        ]);
        // Map shared creds format { token, appId, devId, certId } → internal format
        if (c) setCreds({ userToken: c.token || '', appId: c.appId || '', devId: c.devId || '', certId: c.certId || '' });
        if (Array.isArray(r) && r.length) setRules(r);
        if (o) setOriginals(o);
        if (Array.isArray(l)) setLog(l);
        if (a) setAutoConfig({ ...DEFAULT_AUTO, ...a });
      } catch (e) { console.error('PriceReductor load:', e); }
      finally { setLoaded(true); }
    })();
  }, []);

  // Write lock to prevent concurrent storage writes on the same key
  const writeLock = useRef({});
  const safeWrite = useCallback(async (key, value) => {
    const prev = writeLock.current[key] || Promise.resolve();
    const next = prev.then(() => window.storage.set(key, value))
      .catch(e => console.error(`[PriceReductor] ${key} save failed:`, e));
    writeLock.current[key] = next;
    return next;
  }, []);

  // Persist rules and auto config (creds are read-only here — edit in Settings)
  useEffect(() => { if (loaded) safeWrite(KEY_RULES, rules); }, [rules, loaded, safeWrite]);
  useEffect(() => { if (loaded) safeWrite(KEY_AUTO, autoConfig); }, [autoConfig, loaded, safeWrite]);

  const saveOriginals = useCallback((o) => {
    setOriginals(o);
    safeWrite(KEY_ORIGINALS, o);
  }, [safeWrite]);

  const appendLog = useCallback((entries) => {
    setLog((prev) => {
      const updated = [...prev, ...entries].slice(-500); // keep last 500
      safeWrite(KEY_LOG, updated);
      return updated;
    });
  }, [safeWrite]);

  // Apply a set of pre-computed reductions
  const handleApply = useCallback(async (reductions) => {
    setApplying(true);
    try {
      // Server runs 5 eBay ReviseItem calls in parallel (concurrency=5),
      // so 40 listings finish in ~12s. Batch size stays large for efficient
      // progress reporting on bigger seller accounts (100+ listings).
      const BATCH_SIZE = 40;
      const PER_BATCH_TIMEOUT = 240000; // 4 min — safety margin for slow eBay responses
      const batches = [];
      for (let i = 0; i < reductions.length; i += BATCH_SIZE) {
        batches.push(reductions.slice(i, i + BATCH_SIZE));
      }

      const allApplied = [];
      const allFailed  = [];

      for (let b = 0; b < batches.length; b++) {
        setApplyProgress({ done: b * BATCH_SIZE, total: reductions.length });
        try {
          const res = await window.fetch(`${PIPELINE_BASE}/api/ebay/apply-reductions`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ creds, reductions: batches[b] }),
            signal:  AbortSignal.timeout(PER_BATCH_TIMEOUT),
          });
          const data = await res.json();
          if (data.applied?.length) allApplied.push(...data.applied);
          if (data.failed?.length)  allFailed.push(...data.failed);
        } catch (err) {
          // Whole batch failed — mark each as failed with timeout message
          batches[b].forEach((r) => allFailed.push({ ...r, error: err.message || 'timed out' }));
        }
      }

      setApplyProgress({ done: reductions.length, total: reductions.length });

      if (allApplied.length) appendLog(allApplied);
      if (allFailed.length) {
        const preview = allFailed.slice(0, 10).map((f) => `${f.title}: ${f.error}`).join('\n');
        const more = allFailed.length > 10 ? `\n…and ${allFailed.length - 10} more` : '';
        alert(`${allFailed.length} listing(s) failed:\n${preview}${more}`);
      }
      return { applied: allApplied, failed: allFailed };
    } catch (err) {
      alert('Apply failed: ' + err.message);
    } finally {
      setApplying(false);
      setTimeout(() => setApplyProgress(null), 2000);
    }
  }, [creds, appendLog]);

  // Auto-reduce scheduler
  useEffect(() => {
    if (autoRef.current) clearInterval(autoRef.current);
    if (!autoConfig.enabled || !creds.userToken || !loaded) return;

    const run = async () => {
      try {
        const res  = await window.fetch(`${PIPELINE_BASE}/api/ebay/preview-reductions`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ creds, rules, originals }),
          signal:  AbortSignal.timeout(60000),
        });
        const data = await res.json();
        if (data.success && data.reductions?.length) {
          await handleApply(data.reductions);
          setAutoStatus(`Auto-reduced ${data.reductions.length} listing(s) at ${new Date().toLocaleTimeString()}`);
        } else {
          setAutoStatus(`Auto-check: no changes needed (${new Date().toLocaleTimeString()})`);
        }
        setAutoConfig((a) => ({ ...a, lastRunAt: new Date().toISOString() }));
      } catch (err) {
        setAutoStatus(`Auto-check failed: ${err.message}`);
      }
    };

    autoRef.current = setInterval(run, autoConfig.intervalMs);
    return () => clearInterval(autoRef.current);
  }, [autoConfig.enabled, autoConfig.intervalMs, creds, rules, originals, loaded, handleApply]);

  if (!loaded) return (
    <div className="space-y-3">
      <div className="h-8 w-48 shimmer rounded-lg" />
      <div className="h-32 shimmer rounded-xl" />
      <div className="h-64 shimmer rounded-xl" />
    </div>
  );

  return (
    <div className="space-y-3">
      {/* Single-row header: title + auto-reduce pill + modal-trigger buttons */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h1 className="text-xl md:text-2xl font-semibold text-fg tracking-tight flex items-center gap-2">
            <TrendingDown size={20} className="text-accent" /> Price Reductor
          </h1>
          <p className="text-xs text-fg-muted hidden md:block">
            Auto-reduce stale eBay listings
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium border ${
            autoConfig.enabled
              ? 'bg-success-subtle border-success/20 text-success-fg'
              : 'bg-muted/40 border-border text-fg-muted'
          }`}>
            {autoConfig.enabled ? <Play size={10} /> : <Pause size={10} />}
            {autoConfig.enabled
              ? `Auto ${INTERVALS.find((i) => i.ms === autoConfig.intervalMs)?.label?.replace('Every ', '') || ''}`
              : 'Auto OFF'}
          </span>
          <Button variant="secondary" size="sm" onClick={() => setModal('market')}>
            <Activity /> Market
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setModal('rules')}>
            <TrendingDown /> Rules
            {rules.length > 0 && <span className="text-[10px] bg-muted px-1.5 rounded-md">{rules.length}</span>}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setModal('log')}>
            <History /> Log
            {log.length > 0 && <span className="text-[10px] bg-muted px-1.5 rounded-md">{log.length}</span>}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setModal('settings')}>
            <Settings /> Settings
          </Button>
        </div>
      </div>

      {/* Auto-status message */}
      {autoStatus && (
        <div className="flex items-center gap-2 px-3 py-2 bg-info-subtle border border-info/20 rounded-lg text-xs text-info-fg">
          <Zap size={12} /> {autoStatus}
          <button onClick={() => setAutoStatus('')} className="ml-auto"><X size={11} /></button>
        </div>
      )}

      {/* Primary view — always visible */}
      <ListingsTab progress={applyProgress}
        creds={creds} rules={rules} originals={originals}
        onOriginalsChange={saveOriginals}
        onApply={handleApply}
        applying={applying}
        log={log}
      />

      {/* Secondary views as modals */}
      <Modal open={modal === 'market'} onClose={() => setModal(null)} size="2xl"
        title="Market Repricer" subtitle="Compare active listings to current eBay market">
        <Suspense fallback={<div className="h-48 bg-muted/40 rounded-xl animate-pulse" />}>
          <MarketRepricer />
        </Suspense>
      </Modal>

      <Modal open={modal === 'rules'} onClose={() => setModal(null)} size="xl"
        title="Reduction Rules" subtitle="Define how prices drop over time by age + percentage">
        <RulesTab rules={rules} onRulesChange={setRules} />
      </Modal>

      <Modal open={modal === 'log'} onClose={() => setModal(null)} size="2xl"
        title="Reduction History" subtitle={`${log.length} price change${log.length !== 1 ? 's' : ''} recorded`}>
        <LogTab log={log} onClear={() => { setLog([]); safeWrite(KEY_LOG, []); }} />
      </Modal>

      <Modal open={modal === 'settings'} onClose={() => setModal(null)} size="md"
        title="Auto-Reduce Settings" subtitle="Schedule automatic reductions in the background">
        <SettingsTab autoConfig={autoConfig} onAutoChange={setAutoConfig} />
      </Modal>
    </div>
  );
}
