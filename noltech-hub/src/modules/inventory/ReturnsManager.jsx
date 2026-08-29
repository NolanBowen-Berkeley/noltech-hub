// ─── Returns Manager ──────────────────────────────────────────────────────────
// Tracks eBay return cases through their lifecycle: opened → in transit → received
// → refund issued → item disposition (relist / scrap / partial).
// Auto-posts bookkeeping entries for refunds.

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Undo2, Plus, Package, DollarSign, AlertCircle, CheckCircle2, Clock, X, Trash2, RotateCcw, Recycle, ShoppingCart } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { fmt, formatDate } from '../../utils/formatters';
import { Button, Card, Badge, Modal, Input, Label, Select, Textarea, AnimatedNumber } from '../../components/ui';

const RETURNS_KEY = 'noltech:returns:cases';
const BOOKS_KEY   = 'noltech:books:transactions';

const STATUS_OPTIONS = [
  { value: 'opened',      label: 'Opened',       color: 'warning', icon: AlertCircle },
  { value: 'in_transit',  label: 'In Transit',   color: 'info',    icon: Clock },
  { value: 'received',    label: 'Received',     color: 'accent',  icon: Package },
  { value: 'refunded',    label: 'Refunded',     color: 'success', icon: CheckCircle2 },
  { value: 'resolved',    label: 'Resolved',     color: 'neutral', icon: CheckCircle2 },
  { value: 'disputed',    label: 'Disputed',     color: 'danger',  icon: AlertCircle },
];

const REASON_OPTIONS = [
  'Not as described',
  'Doesn\'t work / defective',
  'Arrived damaged',
  'Wrong item sent',
  'Changed mind',
  'Didn\'t match listing photos',
  'Missing parts/accessories',
  'Other',
];

const DISPOSITION_OPTIONS = [
  { value: 'relist',       label: 'Relist',       icon: ShoppingCart },
  { value: 'part_out',     label: 'Part Out',     icon: Package },
  { value: 'scrap',        label: 'Scrap',        icon: Recycle },
  { value: 'return_to_supplier', label: 'Return to Supplier', icon: RotateCcw },
];

function uid() {
  return crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function CaseForm({ initial, items, onSave, onCancel }) {
  const [form, setForm] = useState(() => ({
    id: initial?.id || uid(),
    itemId: initial?.itemId || '',
    orderId: initial?.orderId || '',
    openedAt: initial?.openedAt || new Date().toISOString().slice(0, 10),
    status: initial?.status || 'opened',
    reason: initial?.reason || 'Not as described',
    refundAmount: initial?.refundAmount ?? '',
    returnShipCost: initial?.returnShipCost ?? '',
    disposition: initial?.disposition || '',
    notes: initial?.notes || '',
    createdAt: initial?.createdAt || new Date().toISOString(),
  }));

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const handleSave = () => {
    if (!form.orderId && !form.itemId) { alert('Enter an order ID or pick an item.'); return; }
    onSave({
      ...form,
      refundAmount:   parseFloat(form.refundAmount)   || 0,
      returnShipCost: parseFloat(form.returnShipCost) || 0,
      updatedAt: new Date().toISOString(),
    });
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Item</Label>
          <Select value={form.itemId} onChange={set('itemId')}>
            <option value="">— Select an item —</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {[i.brand, i.model].filter(Boolean).join(' ') || i.serialNumber || i.id.slice(0, 8)}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Order ID</Label>
          <Input value={form.orderId} onChange={set('orderId')} placeholder="eBay order #" className="font-mono" />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <Label>Opened</Label>
          <Input type="date" value={form.openedAt} onChange={set('openedAt')} />
        </div>
        <div>
          <Label>Status</Label>
          <Select value={form.status} onChange={set('status')}>
            {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
        </div>
        <div>
          <Label>Reason</Label>
          <Select value={form.reason} onChange={set('reason')}>
            {REASON_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label hint="What you refunded the buyer">Refund Amount</Label>
          <Input type="number" step="0.01" value={form.refundAmount} onChange={set('refundAmount')} placeholder="0.00" className="font-mono" />
        </div>
        <div>
          <Label hint="Label cost if you paid for return shipping">Return Shipping</Label>
          <Input type="number" step="0.01" value={form.returnShipCost} onChange={set('returnShipCost')} placeholder="0.00" className="font-mono" />
        </div>
      </div>
      <div>
        <Label>Disposition</Label>
        <Select value={form.disposition} onChange={set('disposition')}>
          <option value="">— Not yet decided —</option>
          {DISPOSITION_OPTIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
        </Select>
      </div>
      <div>
        <Label>Notes</Label>
        <Textarea value={form.notes} onChange={set('notes')} rows={3} placeholder="Item condition on return, buyer messages, etc." />
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button variant="accent" onClick={handleSave}>Save Case</Button>
      </div>
    </div>
  );
}

function StatusBadge({ status }) {
  const cfg = STATUS_OPTIONS.find((s) => s.value === status) || STATUS_OPTIONS[0];
  const Icon = cfg.icon;
  return (
    <Badge variant={cfg.color} size="xs" icon={Icon}>{cfg.label}</Badge>
  );
}

export default function ReturnsManager() {
  const { state, dispatch } = useApp();
  const [cases, setCases]       = useState([]);
  const [loaded, setLoaded]     = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing]   = useState(null);
  const [filter, setFilter]     = useState('active');  // 'active' | 'all' | 'resolved'

  // All items for the picker
  const allItems = useMemo(() => state.lots.flatMap((l) => l.items || []), [state.lots]);

  // Load
  useEffect(() => {
    window.storage.get(RETURNS_KEY)
      .then((v) => setCases(Array.isArray(v) ? v : []))
      .catch((e) => console.error('[Returns] load failed:', e))
      .finally(() => setLoaded(true));
  }, []);

  const persist = useCallback(async (next) => {
    setCases(next);
    try { await window.storage.set(RETURNS_KEY, next); }
    catch (e) { console.error('[Returns] save failed:', e); }
  }, []);

  const saveCase = useCallback(async (c) => {
    const isNew = !cases.some((x) => x.id === c.id);
    const next  = isNew ? [c, ...cases] : cases.map((x) => x.id === c.id ? c : x);
    await persist(next);

    // If status flipped to 'refunded' and amount > 0, post an expense transaction
    const totalLoss = (parseFloat(c.refundAmount) || 0) + (parseFloat(c.returnShipCost) || 0);
    if (c.status === 'refunded' && totalLoss > 0) {
      const importId = `return:${c.id}`;
      const existing = await window.storage.get(BOOKS_KEY) || [];
      const alreadyPosted = existing.some((t) => t.importId === importId);
      if (!alreadyPosted) {
        const item = allItems.find((i) => i.id === c.itemId);
        const itemName = item ? ([item.brand, item.model].filter(Boolean).join(' ') || item.serialNumber) : c.orderId;
        const tx = {
          id: uid(),
          source: 'auto_return',
          importId,
          date: c.openedAt?.slice(0, 10) || new Date().toISOString().slice(0, 10),
          type: 'expense',
          category: 'Returns & Refunds',
          description: `Return refund — ${itemName || c.orderId}`,
          amount: totalLoss,
          notes: `Auto-posted refund${c.returnShipCost > 0 ? ` + ${fmt(c.returnShipCost)} return shipping` : ''}. ${c.notes || ''}`,
        };
        await window.storage.set(BOOKS_KEY, [tx, ...existing]);
      }
    }

    // If disposition is 'scrap' or 'part_out', update inventory item status
    if (c.itemId && c.disposition) {
      const statusMap = { scrap: 'recycled', part_out: 'parted_out', return_to_supplier: 'returned' };
      const newStatus = statusMap[c.disposition];
      if (newStatus) {
        dispatch({ type: 'UPDATE_ITEM', id: c.itemId, updates: { status: newStatus } });
      } else if (c.disposition === 'relist') {
        dispatch({ type: 'UPDATE_ITEM', id: c.itemId, updates: { status: 'listed', sale: null } });
      }
    }

    setShowForm(false); setEditing(null);
  }, [cases, persist, allItems, dispatch]);

  const deleteCase = useCallback(async (id) => {
    if (!confirm('Delete this return case? The bookkeeping entry (if any) will remain.')) return;
    await persist(cases.filter((c) => c.id !== id));
  }, [cases, persist]);

  const filtered = useMemo(() => {
    const activeSet = new Set(['opened', 'in_transit', 'received']);
    return cases.filter((c) => {
      if (filter === 'active')  return activeSet.has(c.status);
      if (filter === 'resolved') return !activeSet.has(c.status);
      return true;
    }).sort((a, b) => (b.openedAt || '').localeCompare(a.openedAt || ''));
  }, [cases, filter]);

  // KPIs
  const stats = useMemo(() => {
    const active   = cases.filter((c) => ['opened', 'in_transit', 'received'].includes(c.status)).length;
    const refunded = cases.filter((c) => c.status === 'refunded').length;
    const totalRefunded = cases.filter((c) => c.status === 'refunded').reduce((s, c) => s + (parseFloat(c.refundAmount) || 0), 0);
    const totalShipCost = cases.reduce((s, c) => s + (parseFloat(c.returnShipCost) || 0), 0);
    return { active, refunded, totalRefunded, totalShipCost, total: cases.length };
  }, [cases]);

  if (!loaded) return <div className="h-32 bg-muted/40 rounded-xl animate-pulse" />;

  return (
    <div className="space-y-3">
      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
        <Card padding="sm">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">Active</p>
          <p className="text-lg font-semibold font-mono text-warning tabular-nums mt-0.5">
            <AnimatedNumber value={stats.active} />
          </p>
          <p className="text-[10px] text-fg-subtle">open cases</p>
        </Card>
        <Card padding="sm">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">Refunded</p>
          <p className="text-lg font-semibold font-mono text-fg tabular-nums mt-0.5">
            <AnimatedNumber value={stats.refunded} />
          </p>
          <p className="text-[10px] text-fg-subtle">{fmt(stats.totalRefunded)} issued</p>
        </Card>
        <Card padding="sm">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">Return Ship</p>
          <p className="text-lg font-semibold font-mono text-danger tabular-nums mt-0.5">
            <AnimatedNumber value={stats.totalShipCost} format={(v) => fmt(v)} />
          </p>
          <p className="text-[10px] text-fg-subtle">paid on returns</p>
        </Card>
        <Card padding="sm">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">Total Cases</p>
          <p className="text-lg font-semibold font-mono text-fg tabular-nums mt-0.5">
            <AnimatedNumber value={stats.total} />
          </p>
          <p className="text-[10px] text-fg-subtle">all time</p>
        </Card>
      </div>

      {/* Toolbar */}
      <Card padding="none" radius="lg" className="overflow-hidden">
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border flex-wrap">
          <div className="inline-flex items-center gap-1 p-0.5 rounded-lg bg-muted border border-border-subtle">
            {['active', 'all', 'resolved'].map((f) => (
              <button key={f} onClick={() => setFilter(f)}
                className={`text-xs px-2.5 py-1 rounded-md font-medium transition-colors capitalize ${filter === f ? 'bg-surface text-fg shadow-glow-sm' : 'text-fg-muted hover:text-fg'}`}>
                {f}
              </button>
            ))}
          </div>
          <Button variant="accent" size="sm" onClick={() => { setEditing(null); setShowForm(true); }}>
            <Plus /> New Return
          </Button>
        </div>

        {filtered.length === 0 ? (
          <div className="py-10 text-center">
            <Undo2 className="mx-auto size-8 text-fg-subtle opacity-50 mb-2" />
            <p className="text-sm text-fg">No returns in this view</p>
            <p className="text-xs text-fg-muted mt-0.5">When a buyer opens a return, log it here to track through resolution.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/40 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
                  <th className="px-3 py-1.5 text-left">Opened</th>
                  <th className="px-3 py-1.5 text-left">Item / Order</th>
                  <th className="px-3 py-1.5 text-left">Reason</th>
                  <th className="px-3 py-1.5 text-left">Status</th>
                  <th className="px-3 py-1.5 text-right">Refund</th>
                  <th className="px-3 py-1.5 text-left">Disposition</th>
                  <th className="px-3 py-1.5 w-12"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {filtered.map((c) => {
                  const item = allItems.find((i) => i.id === c.itemId);
                  const name = item ? ([item.brand, item.model].filter(Boolean).join(' ') || item.serialNumber) : c.orderId;
                  const dispCfg = DISPOSITION_OPTIONS.find((d) => d.value === c.disposition);
                  return (
                    <tr key={c.id} className="hover:bg-muted/30 cursor-pointer group" onClick={() => { setEditing(c); setShowForm(true); }}>
                      <td className="px-3 py-2 text-xs font-mono text-fg-muted whitespace-nowrap">{formatDate(c.openedAt) || '—'}</td>
                      <td className="px-3 py-2">
                        <p className="text-sm text-fg truncate max-w-[220px]">{name || '—'}</p>
                        {c.orderId && <p className="text-[10px] font-mono text-fg-subtle">#{c.orderId}</p>}
                      </td>
                      <td className="px-3 py-2 text-xs text-fg-muted truncate max-w-[180px]">{c.reason}</td>
                      <td className="px-3 py-2"><StatusBadge status={c.status} /></td>
                      <td className="px-3 py-2 text-right font-mono text-xs text-danger tabular-nums">{c.refundAmount > 0 ? fmt(c.refundAmount) : '—'}</td>
                      <td className="px-3 py-2 text-xs text-fg-muted">
                        {dispCfg ? <span className="flex items-center gap-1"><dispCfg.icon className="size-3" />{dispCfg.label}</span> : <span className="text-fg-subtle">—</span>}
                      </td>
                      <td className="px-3 py-2">
                        <button onClick={(e) => { e.stopPropagation(); deleteCase(c.id); }}
                          className="p-1 rounded-md text-fg-subtle hover:text-danger opacity-0 group-hover:opacity-100 transition-opacity">
                          <Trash2 className="size-3" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal open={showForm} onClose={() => { setShowForm(false); setEditing(null); }} size="lg"
        title={editing ? 'Edit Return Case' : 'New Return Case'}
        subtitle="Track through resolution. Refunds auto-post to bookkeeping when marked refunded.">
        <CaseForm
          key={editing?.id || 'new'}
          initial={editing}
          items={allItems}
          onSave={saveCase}
          onCancel={() => { setShowForm(false); setEditing(null); }}
        />
      </Modal>
    </div>
  );
}
