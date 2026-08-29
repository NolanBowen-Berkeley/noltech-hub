import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion } from 'framer-motion';
import { useApp } from '../../context/AppContext';
import { useSkuOverlay } from '../../hooks/useSkuOverlay';
import {
  DollarSign, Plus, Trash2, Upload, RefreshCw, ChevronDown, ChevronUp,
  AlertTriangle, CheckCircle, X, Tag, FileText, BarChart2, Loader2,
  Link, Unlink, ExternalLink, Search, Receipt, PieChart, BarChart3,
} from 'lucide-react';
import EmptyState from '../../components/EmptyState';
import DatePicker from '../../components/DatePicker';
import { EBAY_TOKEN_KEY, PIPELINE_BASE } from '../../utils/constants';
import { decryptObject } from '../../services/crypto';
import { fmt } from '../../utils/formatters';
import { Button, Card, Badge, AnimatedNumber, Modal, Input, Label, Select, Stat, Sparkline } from '../../components/ui';

// ─── Storage keys ─────────────────────────────────────────────────────────────
const KEY_SALES   = 'noltech:lotprofit:sales';
const KEY_LOTS_LEGACY = 'noltech:lotprofit:lots'; // read-once for migration

// ─── Helpers ──────────────────────────────────────────────────────────────────
function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}
function fmtPct(n) {
  if (n == null || isNaN(n)) return '—';
  return (n > 0 ? '+' : '') + Number(n).toFixed(1) + '%';
}
function profitCls(n) {
  if (n == null) return 'text-fg-muted';
  return n > 0 ? 'text-success' : n < 0 ? 'text-danger' : 'text-warning';
}

// ─── eBay CSV column normaliser ───────────────────────────────────────────────
// eBay exports columns with slightly different names across regions/reports.
// Maps every known variant to a canonical field name.
const COL_MAP = {
  sku:       ['custom label', 'sku', 'custom label (sku)', 'seller sku', 'item sku'],
  title:     ['listing title', 'item title', 'title', 'description'],
  orderId:   ['order number', 'order id', 'transaction id', 'sales record number'],
  date:      ['transaction creation date', 'order date', 'sale date', 'date sold', 'paid on date'],
  qty:       ['quantity', 'qty', 'quantity sold'],
  price:     ['sale price', 'item price', 'sold for', 'unit price', 'sales price'],
  shipping:  ['postage and packaging', 'shipping and handling', 'buyer paid shipping', 'shipping paid'],
  fees:      ['final value fee - fixed', 'final value fee', 'selling costs', 'total selling costs', 'ebay fees', 'ebay final value fee'],
  net:       ['net amount', 'net payout', 'total payout'],
};

function normaliseRow(headers, row) {
  const lower = headers.map((h) => h.toLowerCase().trim());
  const get = (variants) => {
    for (const v of variants) {
      const idx = lower.findIndex((h) => h.includes(v));
      if (idx !== -1) return (row[idx] || '').toString().trim();
    }
    return '';
  };
  const money = (s) => parseFloat(s.replace(/[$,\s]/g, '')) || 0;

  const sku      = get(COL_MAP.sku);
  const title    = get(COL_MAP.title);
  const orderId  = get(COL_MAP.orderId);
  const date     = get(COL_MAP.date);
  const qty      = parseInt(get(COL_MAP.qty)) || 1;
  const price    = money(get(COL_MAP.price));
  const shipping = money(get(COL_MAP.shipping));
  const fees     = money(get(COL_MAP.fees));
  const net      = money(get(COL_MAP.net));

  // Skip rows that have no sale price and no SKU — likely blank/summary rows
  if (!price && !sku) return null;

  // Use the actual fee from the CSV if present — never calculate a fallback.
  // For API-synced orders, the real FinalValueFee from eBay is used directly.
  const ebayFees  = fees > 0 ? fees : 0;
  const netPayout = net > 0  ? net  : Math.round((price + shipping - ebayFees) * 100) / 100;

  return { id: uuid(), sku, title, orderId, date, qty, price, shipping, ebayFees, netPayout, lotId: null, source: 'csv' };
}

// ─── Parse eBay CSV/TSV text ──────────────────────────────────────────────────
function parseEbayCSV(text) {
  // Detect delimiter: TSV (tab) or CSV (comma)
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const delim = lines[0].includes('\t') ? '\t' : ',';

  const splitRow = (line) => {
    if (delim === '\t') return line.split('\t');
    // Simple CSV split (handles quoted fields)
    const result = [];
    let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { result.push(cur); cur = ''; continue; }
      cur += ch;
    }
    result.push(cur);
    return result;
  };

  const headers = splitRow(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitRow(lines[i]);
    const row  = normaliseRow(headers, cols);
    if (row) rows.push(row);
  }
  return rows;
}

// ─── Match sales to lots by SKU prefix and/or suffix ─────────────────────────
function matchSalesToLots(sales, lots) {
  return sales.map((sale) => {
    if (!sale.sku) return sale;
    const skuU = sale.sku.toUpperCase();
    const match = lots.find((l) => {
      const pre = l.skuPrefix?.trim().toUpperCase();
      const suf = l.skuSuffix?.trim().toUpperCase();
      if (pre && suf) return skuU.startsWith(pre) && skuU.endsWith(suf);
      if (pre)        return skuU.startsWith(pre);
      if (suf)        return skuU.endsWith(suf);
      return false;
    });
    return match ? { ...sale, lotId: match.id } : sale;
  });
}

// ─── Per-lot profit summary ───────────────────────────────────────────────────
// IMPORTANT: scraper's `netPayout` is `totalRevenue − fees` and already
// subtracts ad fees (which are bundled into the fee total at scrape time).
// It does NOT subtract YOUR shipping-label cost — that's a separate expense
// the seller pays out-of-pocket. We deduct labelCost here so Net / Profit /
// ROI reflect actual take-home, matching the Bookkeeping module which has
// the auto_shipping rows. Falls back to 0 for CSV-imported sales that don't
// carry a labelCost field.
function calcLotSummary(lot, sales) {
  const matched = sales.filter((s) => s.lotId === lot.id);
  const revenue   = matched.reduce((a, s) => a + (s.totalRevenue || (s.price + (s.shipping || 0))) * s.qty, 0);
  const fees      = matched.reduce((a, s) => a + (s.ebayFees || 0), 0);
  const labels    = matched.reduce((a, s) => a + (Number(s.labelCost) || 0) * (s.qty || 1), 0);
  const netRevenue = matched.reduce(
    (a, s) => a + ((s.netPayout || 0) - (Number(s.labelCost) || 0) * (s.qty || 1)),
    0,
  );
  const profit    = netRevenue - lot.totalCost;
  const roi       = lot.totalCost > 0 ? (profit / lot.totalCost) * 100 : 0;
  return { matched, revenue, fees, labels, netRevenue, profit, roi, soldCount: matched.length };
}

// ─── Lot Form ─────────────────────────────────────────────────────────────────
const BLANK_LOT = { name: '', skuPrefix: '', skuSuffix: '', purchaseDate: '', totalCost: '', itemCount: '', source: '', notes: '' };

function LotForm({ initial, onSave, onCancel }) {
  const [form, setForm] = useState({ ...BLANK_LOT, ...initial });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const handleSave = () => {
    if (!form.name.trim())  return alert('Enter a lot name.');
    if (!form.totalCost)    return alert('Enter the lot cost.');
    onSave({
      ...form,
      id:         form.id || uuid(),
      totalCost:  parseFloat(form.totalCost)  || 0,
      itemCount:  parseInt(form.itemCount)    || 0,
      createdAt:  form.createdAt || new Date().toISOString(),
    });
  };

  return (
    <div className="bg-muted/40 border border-border rounded-xl p-4 space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Label required>Lot Name</Label>
          <Input placeholder="ThinkPad Lot — March 2026" value={form.name} onChange={set('name')} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label hint="SKU starts with">SKU Prefix</Label>
            <Input placeholder="e.g. LOT001" value={form.skuPrefix}
              onChange={(e) => setForm((f) => ({ ...f, skuPrefix: e.target.value.toUpperCase() }))} />
          </div>
          <div>
            <Label hint="SKU ends with">SKU Suffix</Label>
            <Input placeholder="e.g. -A or -LOT2" value={form.skuSuffix || ''}
              onChange={(e) => setForm((f) => ({ ...f, skuSuffix: e.target.value.toUpperCase() }))} />
          </div>
        </div>
        <div>
          <Label>Purchase Date</Label>
          <DatePicker value={form.purchaseDate} onChange={v => setForm(f => ({ ...f, purchaseDate: v }))} />
        </div>
        <div>
          <Label required>Total Lot Cost</Label>
          <Input type="number" min="0" step="0.01" placeholder="450.00" value={form.totalCost} onChange={set('totalCost')} />
        </div>
        <div>
          <Label>Item Count</Label>
          <Input type="number" min="0" placeholder="20" value={form.itemCount} onChange={set('itemCount')} />
        </div>
        <div>
          <Label>Source</Label>
          <Select value={form.source} onChange={set('source')}>
            <option value="">— select —</option>
            <option>liquidation.com</option>
            <option>TechLiquidators</option>
            <option>Local Sourcing</option>
            <option>Brokering</option>
            <option>Other</option>
          </Select>
        </div>
      </div>
      <div>
        <Label>Notes</Label>
        <Input placeholder="Manifest notes, condition, etc." value={form.notes} onChange={set('notes')} />
      </div>
      <div className="flex gap-2 pt-1">
        <Button variant="accent" size="md" onClick={handleSave}>Save Lot</Button>
        <Button variant="secondary" size="md" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

// ─── Lots Tab ─────────────────────────────────────────────────────────────────
function LotsTab({ lots, sales, onLotsChange, onOpenSales, onOpenReport }) {
  const [showForm, setShowForm] = useState(false);
  const [editing,  setEditing]  = useState(null);
  const [query,    setQuery]    = useState('');
  const [sortBy,   setSortBy]   = useState('date'); // 'date' | 'profit' | 'roi' | 'revenue' | 'name'

  const saveLot = (lot) => {
    const updated = editing
      ? lots.map((l) => l.id === lot.id ? lot : l)
      : [...lots, lot];
    onLotsChange(updated);
    setShowForm(false);
    setEditing(null);
  };

  const deleteLot = (id) => {
    if (!confirm('Delete this lot? Associated sales will become unmatched.')) return;
    onLotsChange(lots.filter((l) => l.id !== id));
  };

  // Enrich + filter + sort
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const enriched = lots.map((lot) => ({ lot, ...calcLotSummary(lot, sales) }));
    const filtered = q
      ? enriched.filter(({ lot }) =>
          lot.name.toLowerCase().includes(q) ||
          (lot.source || '').toLowerCase().includes(q) ||
          (lot.skuPrefix || '').toLowerCase().includes(q))
      : enriched;
    const sorters = {
      date:    (a, b) => (b.lot.purchaseDate || '').localeCompare(a.lot.purchaseDate || ''),
      profit:  (a, b) => b.profit - a.profit,
      roi:     (a, b) => b.roi - a.roi,
      revenue: (a, b) => b.revenue - a.revenue,
      name:    (a, b) => a.lot.name.localeCompare(b.lot.name),
    };
    return [...filtered].sort(sorters[sortBy] || sorters.date);
  }, [lots, sales, query, sortBy]);

  return (
    <Card padding="none" radius="lg" className="overflow-hidden">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-border">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search lots…"
            className="w-full pl-8 pr-3 py-1.5 text-xs border border-border rounded-lg bg-surface text-fg placeholder-fg-subtle focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent-ring/40"
          />
        </div>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
          className="text-xs border border-border rounded-lg px-2 py-1.5 bg-surface text-fg"
        >
          <option value="date">Newest first</option>
          <option value="profit">Most profit</option>
          <option value="roi">Best ROI</option>
          <option value="revenue">Most revenue</option>
          <option value="name">Name A–Z</option>
        </select>
        <div className="ml-auto flex items-center gap-2">
          {onOpenSales && (
            <Button variant="secondary" size="sm" onClick={onOpenSales}>
              <Receipt /> Sales ({sales.length})
            </Button>
          )}
          {onOpenReport && (
            <Button variant="secondary" size="sm" onClick={onOpenReport}>
              <PieChart /> Report
            </Button>
          )}
          {!showForm && !editing && (
            <Button variant="accent" size="sm" onClick={() => setShowForm(true)}>
              <Plus /> Add Lot
            </Button>
          )}
        </div>
      </div>

      {/* Inline form */}
      {(showForm && !editing) && (
        <div className="px-4 py-4 border-b border-border bg-muted/30">
          <LotForm onSave={saveLot} onCancel={() => setShowForm(false)} />
        </div>
      )}

      {/* Empty state */}
      {rows.length === 0 && !showForm && (
        <EmptyState
          icon={BarChart3}
          title={query ? 'No lots match' : 'No lots yet'}
          description={query
            ? 'Try a different search term.'
            : 'Lots are synced from Lot Purchases. Add a lot there or create one here.'}
        />
      )}

      {/* Table */}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/40 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
                <th className="px-3 py-1.5 text-left">Lot</th>
                <th className="px-3 py-1.5 text-right">Cost</th>
                <th className="px-3 py-1.5 text-right">Revenue</th>
                <th className="px-3 py-1.5 text-right">Net</th>
                <th className="px-3 py-1.5 text-right">Profit</th>
                <th className="px-3 py-1.5 text-right">ROI</th>
                <th className="px-3 py-1.5 text-center w-16">Sales</th>
                <th className="px-3 py-1.5 w-20"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {rows.map(({ lot, revenue, fees, netRevenue, profit, roi, soldCount }) => {
                const isEditing = editing?.id === lot.id;
                if (isEditing) {
                  return (
                    <tr key={lot.id}>
                      <td colSpan={8} className="px-4 py-4 bg-muted/30">
                        <LotForm initial={lot} onSave={saveLot} onCancel={() => setEditing(null)} />
                      </td>
                    </tr>
                  );
                }
                const hasSales = soldCount > 0;
                return (
                  <tr key={lot.id} className="hover:bg-muted/30 transition-colors group">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-sm font-medium text-fg truncate max-w-[280px]">{lot.name}</p>
                            {lot.skuPrefix && (
                              <Badge size="xs" variant="neutral" className="font-mono">{lot.skuPrefix}…</Badge>
                            )}
                            {lot.skuSuffix && (
                              <Badge size="xs" variant="neutral" className="font-mono">…{lot.skuSuffix}</Badge>
                            )}
                            {lot.source && (
                              <span className="text-[10px] text-fg-subtle">{lot.source}</span>
                            )}
                            {lot.purchaseDate && (
                              <span className="text-[10px] text-fg-subtle">{lot.purchaseDate}</span>
                            )}
                            {lot.itemCount > 0 && (
                              <span className="text-[10px] text-fg-subtle">{lot.itemCount} items</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-fg tabular-nums">{fmt(lot.totalCost)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-fg tabular-nums">
                      {hasSales ? fmt(revenue) : <span className="text-fg-subtle">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-fg tabular-nums">
                      {hasSales ? fmt(netRevenue) : <span className="text-fg-subtle">—</span>}
                    </td>
                    <td className={`px-3 py-2 text-right font-mono text-sm font-semibold tabular-nums ${hasSales ? profitCls(profit) : 'text-fg-subtle'}`}>
                      {hasSales ? fmt(profit) : '—'}
                    </td>
                    <td className={`px-3 py-2 text-right font-mono text-xs font-medium tabular-nums ${hasSales ? profitCls(roi) : 'text-fg-subtle'}`}>
                      {hasSales ? fmtPct(roi) : '—'}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <Badge size="xs" variant={soldCount > 0 ? 'accent' : 'neutral'}>
                        {soldCount}
                      </Badge>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => setEditing(lot)}
                          className="px-2 py-1 rounded-md text-[11px] text-fg-muted hover:text-fg hover:bg-muted transition-colors">
                          Edit
                        </button>
                        <button onClick={() => deleteLot(lot.id)}
                          className="p-1.5 rounded-md text-fg-subtle hover:text-danger hover:bg-danger/10 transition-colors"
                          title="Delete">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ─── Sales Tab ────────────────────────────────────────────────────────────────
function SalesTab({ lots, sales, onSalesChange }) {
  const [dragging,      setDragging]      = useState(false);
  const [importing,     setImporting]     = useState(false);
  const [importResult,  setImportResult]  = useState(null); // { added, skipped, unmatched }
  const [apiCreds,      setApiCreds]      = useState({ userToken: '', appId: '', devId: '', certId: '' });
  const [apiDates,      setApiDates]      = useState(() => {
    const to   = new Date();
    const from = new Date(to.getTime() - 89 * 86400 * 1000); // eBay max is 90 days
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
  });
  const [apiLoading,    setApiLoading]    = useState(false);
  const [apiError,      setApiError]      = useState('');
  const [showApiForm,   setShowApiForm]   = useState(false);
  const [filterLotId,   setFilterLotId]   = useState('all');
  const [filterUnmatched, setFilterUnmatched] = useState(false);
  const fileRef = useRef();

  // Load creds from shared Settings key
  useEffect(() => {
    (async () => {
      try {
        const raw = await window.storage.get(EBAY_TOKEN_KEY);
        const saved = await decryptObject(raw || {});
        if (saved) setApiCreds({ userToken: saved.token || '', appId: saved.appId || '', devId: saved.devId || '', certId: saved.certId || '' });
      } catch (e) { console.error('[LotProfitTracker] credential load failed:', e); }
    })();
  }, []);

  // ── CSV import ──────────────────────────────────────────────────────────────
  const processFile = useCallback(async (file) => {
    if (!file) return;
    setImporting(true);
    setImportResult(null);
    try {
      const text  = await file.text();
      const rows  = parseEbayCSV(text);
      if (!rows.length) {
        setImportResult({ error: 'No valid rows found. Make sure this is an eBay order/transaction export.' });
        return;
      }

      // De-duplicate against existing sales by orderId+sku
      const existing = new Set(sales.map((s) => `${s.orderId}|${s.sku}`));
      const newRows  = rows.filter((r) => !existing.has(`${r.orderId}|${r.sku}`));
      const skipped  = rows.length - newRows.length;

      // Match to lots
      const matched = matchSalesToLots(newRows, lots);
      const unmatched = matched.filter((s) => !s.lotId).length;

      const updated = [...sales, ...matched];
      onSalesChange(updated);
      setImportResult({ added: newRows.length, skipped, unmatched });
    } catch (err) {
      setImportResult({ error: err.message });
    } finally {
      setImporting(false);
    }
  }, [lots, sales, onSalesChange]);

  const onFileChange  = (e)  => processFile(e.target.files[0]);
  const onDrop        = (e)  => { e.preventDefault(); setDragging(false); processFile(e.dataTransfer.files[0]); };
  const onDragOver    = (e)  => { e.preventDefault(); setDragging(true);  };
  const onDragLeave   = ()   => setDragging(false);

  // ── eBay API sync ───────────────────────────────────────────────────────────
  const syncEbayApi = async () => {
    setApiLoading(true);
    setApiError('');
    try {
      const res = await fetch(`${PIPELINE_BASE}/api/ebay/orders`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ...apiCreds, startDate: apiDates.from, endDate: apiDates.to }),
        signal:  AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'API call failed');

      const existing = new Set(sales.map((s) => `${s.orderId}|${s.sku}`));
      const newRows  = (data.orders || []).map((o) => ({ ...o, id: uuid(), source: 'api', lotId: null }))
                         .filter((r) => !existing.has(`${r.orderId}|${r.sku}`));
      const matched  = matchSalesToLots(newRows, lots);
      onSalesChange([...sales, ...matched]);
      setImportResult({ added: newRows.length, skipped: data.orders.length - newRows.length, unmatched: matched.filter((s) => !s.lotId).length });
    } catch (err) {
      setApiError(err.message);
    } finally {
      setApiLoading(false);
    }
  };

  // ── Manual lot assignment ───────────────────────────────────────────────────
  const assignLot = (saleId, lotId) => {
    onSalesChange(sales.map((s) => s.id === saleId ? { ...s, lotId: lotId || null } : s));
  };

  const deleteSale = (id) => {
    onSalesChange(sales.filter((s) => s.id !== id));
  };

  const rematchAll = () => {
    onSalesChange(matchSalesToLots(sales, lots));
    setImportResult({ rematch: true });
  };

  // ── Filter ──────────────────────────────────────────────────────────────────
  const displayed = sales.filter((s) => {
    if (filterUnmatched && s.lotId) return false;
    if (filterLotId !== 'all' && s.lotId !== filterLotId) return false;
    return true;
  });

  const inputCls = 'border border-border rounded-lg px-3 py-2 text-sm text-fg bg-surface focus:outline-none focus:ring-1 focus:ring-primary';

  return (
    <div className="space-y-4">
      {/* Import / sync strip */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => fileRef.current?.click()}
          disabled={importing}
          className="flex items-center gap-1.5 px-3 py-2 bg-primary text-white text-sm font-semibold rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {importing ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          Import eBay CSV
        </button>
        <input ref={fileRef} type="file" accept=".csv,.tsv,.txt" className="hidden" onChange={onFileChange} />

        <button
          onClick={() => setShowApiForm((v) => !v)}
          className="flex items-center gap-1.5 px-3 py-2 border border-border text-fg-muted text-sm rounded-lg hover:bg-muted/40 transition-colors"
        >
          <RefreshCw size={13} />
          eBay API Sync
        </button>

        {sales.length > 0 && (
          <button onClick={rematchAll}
            className="flex items-center gap-1.5 px-3 py-2 border border-border text-fg-muted text-sm rounded-lg hover:bg-muted/40 transition-colors ml-auto">
            <Link size={13} />
            Re-match All
          </button>
        )}
      </div>

      {/* CSV drop zone */}
      <div
        onDrop={onDrop} onDragOver={onDragOver} onDragLeave={onDragLeave}
        onClick={() => fileRef.current?.click()}
        className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
          dragging ? 'border-primary bg-info-subtle' : 'border-border hover:border-border-strong hover:bg-muted/40'
        }`}
      >
        <FileText size={24} className="mx-auto mb-2 text-fg-muted opacity-50" />
        <p className="text-sm font-medium text-fg">Drop eBay order CSV here or click to browse</p>
        <p className="text-xs text-fg-muted mt-1">
          Download from eBay Seller Hub → Orders → Download report (CSV/TSV)
        </p>
      </div>

      {/* API form */}
      {showApiForm && (
        <div className="bg-muted/40 border border-border rounded-xl p-4 space-y-3">
          <p className="text-sm font-semibold text-fg">eBay Trading API — Direct Sync</p>
          {!apiCreds.userToken ? (
            <div className="flex items-start gap-2 bg-warning-subtle border border-warning/30 rounded-lg px-3 py-2.5">
              <AlertTriangle size={14} className="text-warning flex-shrink-0 mt-0.5" />
              <p className="text-xs text-warning">No eBay credentials saved. Go to <strong>App Settings → eBay Credentials</strong> to add your User Token.</p>
            </div>
          ) : (
            <p className="text-xs text-fg-muted">Using credentials from App Settings. Pulls completed orders and matches them to your lots.</p>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-fg-muted font-medium block mb-1">Orders From</label>
              <DatePicker value={apiDates.from} onChange={v => setApiDates(d => ({ ...d, from: v }))} />
            </div>
            <div>
              <label className="text-xs text-fg-muted font-medium block mb-1">Orders To</label>
              <DatePicker value={apiDates.to} onChange={v => setApiDates(d => ({ ...d, to: v }))} />
            </div>
          </div>
          {apiError && <p className="text-xs text-danger">{apiError}</p>}
          <div className="flex gap-2">
            <button onClick={syncEbayApi} disabled={apiLoading || !apiCreds.userToken}
              className="flex items-center gap-1.5 px-4 py-2 bg-primary text-white text-sm font-semibold rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors">
              {apiLoading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              Sync Orders
            </button>
          </div>
        </div>
      )}

      {/* Import result banner */}
      {importResult && (
        <div className={`flex items-start gap-2 px-4 py-3 rounded-xl border text-sm ${
          importResult.error ? 'bg-danger-subtle border-danger/30 text-danger'
          : 'bg-success-subtle border-success/30 text-success'
        }`}>
          {importResult.error
            ? <><AlertTriangle size={15} className="shrink-0 mt-0.5" />{importResult.error}</>
            : importResult.rematch
              ? <><CheckCircle size={15} className="shrink-0 mt-0.5" />Re-matched all sales against current lot SKU prefixes.</>
              : <><CheckCircle size={15} className="shrink-0 mt-0.5" />
                  Imported <strong>{importResult.added}</strong> sales
                  {importResult.skipped > 0 && `, ${importResult.skipped} duplicates skipped`}
                  {importResult.unmatched > 0 && `, `}
                  {importResult.unmatched > 0 && <strong>{importResult.unmatched} unmatched</strong>}
                  {importResult.unmatched > 0 && ' — assign them below or add the lot.'}
                </>
          }
          <button onClick={() => setImportResult(null)} className="ml-auto shrink-0">
            <X size={13} />
          </button>
        </div>
      )}

      {/* Filter bar */}
      {sales.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={filterLotId}
            onChange={(e) => { setFilterLotId(e.target.value); setFilterUnmatched(false); }}
            className={inputCls + ' text-xs py-1.5'}
          >
            <option value="all">All Lots</option>
            {lots.map((l) => {
              const tag = [l.skuPrefix && `${l.skuPrefix}…`, l.skuSuffix && `…${l.skuSuffix}`].filter(Boolean).join(' ');
              return <option key={l.id} value={l.id}>{l.name}{tag ? ` (${tag})` : ''}</option>;
            })}
          </select>
          <button
            onClick={() => { setFilterUnmatched((v) => !v); setFilterLotId('all'); }}
            className={`text-xs px-3 py-1.5 rounded-lg border font-medium transition-colors ${
              filterUnmatched ? 'bg-warning-subtle border-warning/30 text-warning' : 'bg-surface border-border text-fg-muted hover:bg-muted/40'
            }`}
          >
            <Unlink size={11} className="inline mr-1" />
            Unmatched ({sales.filter((s) => !s.lotId).length})
          </button>
          <p className="ml-auto text-xs text-fg-muted">{displayed.length} of {sales.length} sales</p>
        </div>
      )}

      {/* Sales table */}
      {displayed.length > 0 && (
        <div className="bg-surface rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 border-b border-border">
                <tr>
                  {['SKU', 'Title', 'Date', 'Qty', 'Price', 'eBay Fees', 'Net', 'Lot', ''].map((h) => (
                    <th key={h} className="px-3 py-2.5 text-left font-semibold text-fg-muted whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {displayed.map((sale, i) => {
                  const lot = lots.find((l) => l.id === sale.lotId);
                  const labels = (Number(sale.labelCost) || 0) * (sale.qty || 1);
                  const saleNet = (sale.netPayout || 0) - labels;
                  return (
                    <tr key={sale.id} className={i % 2 === 0 ? 'bg-surface' : 'bg-muted/40/50'}>
                      <td className="px-3 py-2 font-mono text-fg whitespace-nowrap">{sale.sku || '—'}</td>
                      <td className="px-3 py-2 text-fg max-w-[200px] truncate" title={sale.title}>{sale.title || '—'}</td>
                      <td className="px-3 py-2 text-fg-muted whitespace-nowrap">{sale.date?.slice(0, 10) || '—'}</td>
                      <td className="px-3 py-2 text-center">{sale.qty}</td>
                      <td className="px-3 py-2 font-mono text-fg">{fmt(sale.totalRevenue || (sale.price + (sale.shipping || 0)))}</td>
                      <td className="px-3 py-2 font-mono text-danger" title={labels > 0 ? `eBay fees ${fmt(sale.ebayFees)} + label ${fmt(labels)}` : undefined}>
                        {fmt((sale.ebayFees || 0) + labels)}
                      </td>
                      <td className="px-3 py-2 font-mono font-semibold text-fg">{fmt(saleNet)}</td>
                      <td className="px-3 py-2 min-w-[120px]">
                        <select
                          value={sale.lotId || ''}
                          onChange={(e) => assignLot(sale.id, e.target.value)}
                          className={`w-full border rounded px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary ${
                            sale.lotId ? 'border-success/30 bg-success-subtle text-success' : 'border-warning/30 bg-warning-subtle text-warning'
                          }`}
                        >
                          <option value="">— unmatched —</option>
                          {lots.map((l) => {
                            const tag = [l.skuPrefix && `${l.skuPrefix}…`, l.skuSuffix && `…${l.skuSuffix}`].filter(Boolean).join(' ');
                            return <option key={l.id} value={l.id}>{l.name}{tag ? ` (${tag})` : ''}</option>;
                          })}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <button onClick={() => deleteSale(sale.id)}
                          className="text-fg-muted hover:text-danger transition-colors">
                          <Trash2 size={12} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {sales.length === 0 && (
        <div className="text-center py-10 text-fg-muted">
          <Upload size={32} className="mx-auto mb-3 opacity-25" />
          <p className="font-medium">No sales imported yet</p>
          <p className="text-sm mt-1">Import an eBay order CSV or sync via the API above.</p>
        </div>
      )}
    </div>
  );
}

// ─── P&L Report Tab ────────────────────────────────────────────────────────────
function ReportTab({ lots, sales }) {
  const [expanded, setExpanded] = useState(null);
  const [sortBy, setSortBy]     = useState('profit');

  const summaries = lots.map((l) => ({ lot: l, ...calcLotSummary(l, sales) }));

  const sorted = [...summaries].sort((a, b) => {
    if (sortBy === 'profit')  return b.profit  - a.profit;
    if (sortBy === 'roi')     return b.roi      - a.roi;
    if (sortBy === 'revenue') return b.revenue  - a.revenue;
    if (sortBy === 'date')    return (b.lot.purchaseDate || '').localeCompare(a.lot.purchaseDate || '');
    return 0;
  });

  // Global totals
  const totalInvested = lots.reduce((a, l) => a + l.totalCost, 0);
  const totalRevenue  = summaries.reduce((a, s) => a + s.revenue, 0);
  const totalFees     = summaries.reduce((a, s) => a + s.fees, 0);
  const totalNet      = summaries.reduce((a, s) => a + s.netRevenue, 0);
  const totalProfit   = summaries.reduce((a, s) => a + s.profit, 0);
  const totalRoi      = totalInvested > 0 ? (totalProfit / totalInvested) * 100 : 0;
  const unmatchedSales = sales.filter((s) => !s.lotId);

  // ── Last-12-month series powering sparklines ─────────────────────────────
  const monthSeries = useMemo(() => {
    const months = 12;
    const now = new Date();
    const buckets = Array.from({ length: months }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - (months - 1 - i), 1);
      return { key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, revenue: 0, net: 0, fees: 0, profit: 0, sold: 0 };
    });
    const idxByKey = Object.fromEntries(buckets.map((b, i) => [b.key, i]));
    sales.forEach((s) => {
      if (!s.date) return;
      const k = s.date.slice(0, 7);
      const idx = idxByKey[k];
      if (idx == null) return;
      const rev = (s.totalRevenue || (s.price + (s.shipping || 0))) * s.qty;
      // Net needs label costs subtracted so it matches calcLotSummary.
      const labels = (Number(s.labelCost) || 0) * (s.qty || 1);
      buckets[idx].revenue += rev;
      buckets[idx].fees    += s.ebayFees || 0;
      buckets[idx].net     += (s.netPayout || 0) - labels;
      buckets[idx].sold    += s.qty || 1;
    });
    // Invested per month by lot purchaseDate
    const investedByMonth = new Array(months).fill(0);
    lots.forEach((l) => {
      if (!l.purchaseDate) return;
      const k = l.purchaseDate.slice(0, 7);
      const idx = idxByKey[k];
      if (idx == null) return;
      investedByMonth[idx] += l.totalCost || 0;
    });
    // Compute profit per month = net - invested for that month (rough proxy)
    buckets.forEach((b, i) => { b.profit = b.net - investedByMonth[i]; });
    return {
      revenue: buckets.map((b) => b.revenue),
      fees:    buckets.map((b) => b.fees),
      profit:  buckets.map((b) => b.profit),
      invested: investedByMonth,
    };
  }, [sales, lots]);

  if (lots.length === 0) {
    return (
      <div className="text-center py-10 text-fg-muted">
        <BarChart2 size={36} className="mx-auto mb-3 opacity-25" />
        <p className="font-medium">No lots to report on yet</p>
        <p className="text-sm mt-1">Add lots in the Lots tab first.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Total Invested', value: totalInvested, intent: 'neutral', spark: monthSeries.invested },
          { label: 'Total Revenue',  value: totalRevenue,  intent: 'accent',  spark: monthSeries.revenue  },
          { label: 'eBay Fees Paid', value: totalFees,     intent: 'danger',  spark: monthSeries.fees     },
          { label: 'Net Profit',     value: totalProfit,   intent: totalProfit >= 0 ? 'success' : 'danger', spark: monthSeries.profit },
        ].map(({ label, value, intent, spark }, i) => (
          <motion.div
            key={label}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: i * 0.05, ease: [0.16, 1, 0.3, 1] }}
          >
            <Card padding="sm" radius="lg" className="card-hover">
              <Stat
                label={label}
                value={fmt(value)}
                intent={intent}
                size="md"
                sparkline={spark}
                sub="Trailing 12 months"
              />
            </Card>
          </motion.div>
        ))}
      </div>

      {/* Overall ROI banner */}
      <div className={`px-4 py-3 rounded-xl border text-sm flex items-center gap-3 ${
        totalProfit > 0 ? 'bg-success-subtle border-success/30 text-success'
        : totalProfit < 0 ? 'bg-danger-subtle border-danger/30 text-danger'
        : 'bg-warning-subtle border-warning/30 text-warning'
      }`}>
        <DollarSign size={16} className="shrink-0" />
        <span>
          Overall ROI across {lots.length} lots: <strong className="font-mono">{fmtPct(totalRoi)}</strong>
          {' · '}{sales.length} sales imported
          {unmatchedSales.length > 0 && <span className="ml-2 text-warning font-medium">⚠ {unmatchedSales.length} sales unmatched</span>}
        </span>
      </div>

      {/* Sort control */}
      <div className="flex items-center gap-2">
        <p className="text-sm font-semibold text-fg">Per-Lot Breakdown</p>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}
          className="ml-auto text-xs border border-border rounded-lg px-2 py-1.5 bg-surface text-fg">
          <option value="profit">Sort: Most Profitable</option>
          <option value="roi">Sort: Highest ROI</option>
          <option value="revenue">Sort: Most Revenue</option>
          <option value="date">Sort: Purchase Date</option>
        </select>
      </div>

      {/* Per-lot rows */}
      <div className="space-y-2">
        {sorted.map(({ lot, matched, revenue, fees, netRevenue, profit, roi, soldCount }) => {
          const isExpanded = expanded === lot.id;
          const costPerSold = soldCount > 0 ? lot.totalCost / soldCount : 0;

          return (
            <div key={lot.id} className={`bg-surface rounded-xl border shadow-sm overflow-hidden ${
              profit > 0 ? 'border-success/30' : profit < 0 ? 'border-danger/30' : 'border-border'
            }`}>
              {/* Header row */}
              <div
                className="px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-muted/40/60 transition-colors"
                onClick={() => setExpanded(isExpanded ? null : lot.id)}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <span className="font-semibold text-sm text-fg">{lot.name}</span>
                    {lot.skuPrefix && <span className="font-mono text-[11px] bg-muted px-2 py-0.5 rounded">{lot.skuPrefix}…</span>}
                    {lot.skuSuffix && <span className="font-mono text-[11px] bg-muted px-2 py-0.5 rounded">…{lot.skuSuffix}</span>}
                  </div>
                  <div className="flex flex-wrap gap-x-5 gap-y-0.5 text-xs text-fg-muted">
                    <span>Cost <span className="font-mono text-fg">{fmt(lot.totalCost)}</span></span>
                    <span>Revenue <span className="font-mono text-fg">{fmt(revenue)}</span></span>
                    <span>Fees <span className="font-mono text-danger">{fmt(fees)}</span></span>
                    <span>Net <span className="font-mono text-fg">{fmt(netRevenue)}</span></span>
                  </div>
                </div>
                {/* Profit pill */}
                <div className="text-right shrink-0">
                  <p className={`text-lg font-bold font-mono ${profitCls(profit)}`}>{fmt(profit)}</p>
                  <p className={`text-xs font-semibold ${profitCls(roi)}`}>{fmtPct(roi)} ROI</p>
                  <p className="text-[11px] text-fg-muted">{soldCount} sold</p>
                </div>
                {isExpanded ? <ChevronUp size={15} className="text-fg-muted shrink-0" /> : <ChevronDown size={15} className="text-fg-muted shrink-0" />}
              </div>

              {/* Expanded: individual sales */}
              {isExpanded && (
                <div className="border-t border-border bg-muted/40/40">
                  {matched.length === 0 ? (
                    <EmptyState
                      icon={Receipt}
                      title="No sales matched to this lot yet"
                      description="Import a CSV or check the SKU prefix."
                      size="sm"
                    />
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead className="bg-muted border-b border-border">
                          <tr>
                            {['SKU', 'Title', 'Date', 'Price', 'Fees', 'Net', 'Cost Basis', 'Item Profit'].map((h) => (
                              <th key={h} className="px-3 py-2 text-left font-semibold text-fg-muted whitespace-nowrap">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {matched.map((sale, i) => {
                            // Per-item net = eBay netPayout minus YOUR shipping label cost
                            // (labelCost is per unit; multiply by qty just like the sum loop).
                            const labels = (Number(sale.labelCost) || 0) * (sale.qty || 1);
                            const itemNet = (sale.netPayout || 0) - labels;
                            const itemProfit = itemNet - costPerSold;
                            return (
                              <tr key={sale.id} className={i % 2 === 0 ? 'bg-surface' : 'bg-muted/40'}>
                                <td className="px-3 py-2 font-mono">{sale.sku}</td>
                                <td className="px-3 py-2 max-w-[180px] truncate text-fg" title={sale.title}>{sale.title || '—'}</td>
                                <td className="px-3 py-2 text-fg-muted whitespace-nowrap">{sale.date?.slice(0, 10) || '—'}</td>
                                <td className="px-3 py-2 font-mono">{fmt(sale.totalRevenue || (sale.price + (sale.shipping || 0)))}</td>
                                <td className="px-3 py-2 font-mono text-danger" title={labels > 0 ? `eBay fees ${fmt(sale.ebayFees)} + label ${fmt(labels)}` : undefined}>
                                  {fmt((sale.ebayFees || 0) + labels)}
                                </td>
                                <td className="px-3 py-2 font-mono">{fmt(itemNet)}</td>
                                <td className="px-3 py-2 font-mono text-fg-muted">{fmt(costPerSold)}</td>
                                <td className={`px-3 py-2 font-mono font-semibold ${profitCls(itemProfit)}`}>{fmt(itemProfit)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                        <tfoot className="bg-muted border-t border-border font-semibold">
                          <tr>
                            <td className="px-3 py-2" colSpan={3}>Totals</td>
                            <td className="px-3 py-2 font-mono">{fmt(revenue)}</td>
                            <td className="px-3 py-2 font-mono text-danger">{fmt(fees)}</td>
                            <td className="px-3 py-2 font-mono">{fmt(netRevenue)}</td>
                            <td className="px-3 py-2 font-mono text-fg-muted">{fmt(lot.totalCost)}</td>
                            <td className={`px-3 py-2 font-mono ${profitCls(profit)}`}>{fmt(profit)}</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main Shell ───────────────────────────────────────────────────────────────
export default function LotProfitTracker() {
  const { state, dispatch } = useApp();
  const { overlay, setFullOverlay } = useSkuOverlay();
  const [sales,  setSales]  = useState([]);
  const [loaded, setLoaded] = useState(false);

  // Derive lots by merging inventory lots with shared SKU overlay
  const lots = useMemo(() =>
    state.lots.map((invLot) => ({
      id:           invLot.id,
      name:         invLot.sourceName || invLot.source || 'Unnamed Lot',
      totalCost:    invLot.cost    || 0,
      itemCount:    invLot.itemCount || 0,
      purchaseDate: invLot.purchaseDate || '',
      source:       invLot.source  || '',
      notes:        invLot.notes   || '',
      skuPrefix:    overlay[invLot.id]?.skuPrefix || '',
      skuSuffix:    overlay[invLot.id]?.skuSuffix || '',
    }))
  , [state.lots, overlay]);

  // Load sales; migrate legacy P&L-only lots into inventory if needed
  useEffect(() => {
    (async () => {
      try {
        const [s, legacy] = await Promise.all([
          window.storage.get(KEY_SALES),
          window.storage.get(KEY_LOTS_LEGACY),
        ]);

        // One-time migration: old P&L-only lots → inventory
        if (Array.isArray(legacy) && legacy.length > 0) {
          const existingIds = new Set(state.lots.map((l) => l.id));
          const overlayUpdates = {};
          legacy.forEach((pnlLot) => {
            if (!existingIds.has(pnlLot.id)) {
              dispatch({
                type: 'ADD_LOT',
                lot: {
                  id:           pnlLot.id,
                  sourceName:   pnlLot.name || '',
                  source:       pnlLot.source || '',
                  cost:         pnlLot.totalCost || 0,
                  itemCount:    pnlLot.itemCount || 0,
                  purchaseDate: pnlLot.purchaseDate || '',
                  notes:        pnlLot.notes || '',
                  status:       'received',
                  items:        [],
                  manifest:     '',
                  createdAt:    pnlLot.createdAt || new Date().toISOString(),
                },
              });
            }
            if (pnlLot.skuPrefix || pnlLot.skuSuffix) {
              overlayUpdates[pnlLot.id] = {
                skuPrefix: pnlLot.skuPrefix || '',
                skuSuffix: pnlLot.skuSuffix || '',
              };
            }
          });
          if (Object.keys(overlayUpdates).length > 0) {
            setFullOverlay({ ...overlay, ...overlayUpdates });
          }
          await window.storage.set(KEY_LOTS_LEGACY, []);
        }

        setSales(Array.isArray(s) ? s : []);
      } catch (e) {
        console.error('LotProfit load error:', e);
      } finally {
        setLoaded(true);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLotsChange = useCallback(async (updatedLots) => {
    const currentIds = new Set(state.lots.map((l) => l.id));

    // Sync lot metadata back to inventory
    updatedLots.forEach((pnlLot) => {
      const invFields = {
        sourceName:   pnlLot.name,
        cost:         parseFloat(pnlLot.totalCost)  || 0,
        itemCount:    parseInt(pnlLot.itemCount)     || 0,
        purchaseDate: pnlLot.purchaseDate || '',
        source:       pnlLot.source || '',
        notes:        pnlLot.notes  || '',
      };
      if (currentIds.has(pnlLot.id)) {
        dispatch({ type: 'UPDATE_LOT', id: pnlLot.id, updates: invFields });
      } else {
        dispatch({ type: 'ADD_LOT', lot: { ...invFields, id: pnlLot.id, status: 'received', items: [], manifest: '', createdAt: new Date().toISOString() } });
      }
    });

    // Handle deletions
    const updatedIds = new Set(updatedLots.map((l) => l.id));
    state.lots.forEach((invLot) => {
      if (!updatedIds.has(invLot.id)) {
        dispatch({ type: 'DELETE_LOT', id: invLot.id });
      }
    });

    // Persist SKU overlay via shared hook
    const newOverlay = { ...overlay };
    updatedLots.forEach((l) => {
      newOverlay[l.id] = { skuPrefix: l.skuPrefix || '', skuSuffix: l.skuSuffix || '' };
    });
    setFullOverlay(newOverlay);

    // Re-match sales
    const rematched = matchSalesToLots(sales, updatedLots);
    setSales(rematched);
    try { await window.storage.set(KEY_SALES, rematched); }
    catch (e) { console.error('Save sales error:', e); }
  }, [state.lots, sales, overlay, dispatch, setFullOverlay]);

  const handleSalesChange = useCallback(async (updated) => {
    setSales(updated);
    try { await window.storage.set(KEY_SALES, updated); }
    catch (e) { console.error('Save sales error:', e); }
  }, []);

  const [showSales, setShowSales] = useState(false);
  const [showReport, setShowReport] = useState(false);

  // Workspace-wide totals (powers summary strip)
  const totals = useMemo(() => {
    let cost = 0, revenue = 0, fees = 0, labels = 0, net = 0, profit = 0, matched = 0;
    for (const lot of lots) {
      const s = calcLotSummary(lot, sales);
      cost    += lot.totalCost || 0;
      revenue += s.revenue;
      fees    += s.fees;
      labels  += s.labels || 0;
      net     += s.netRevenue;
      profit  += s.profit;
      matched += s.soldCount;
    }
    const roi = cost > 0 ? (profit / cost) * 100 : 0;
    return { cost, revenue, fees, labels, net, profit, matched, roi };
  }, [lots, sales]);

  if (!loaded) {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
          <div className="h-20 shimmer rounded-xl" />
          <div className="h-20 shimmer rounded-xl" />
          <div className="h-20 shimmer rounded-xl" />
          <div className="h-20 shimmer rounded-xl" />
        </div>
        <div className="h-32 shimmer rounded-xl" />
        <div className="h-64 shimmer rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Summary strip — replaces redundant header + sub-tabs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
        <Card padding="sm" radius="lg">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">Invested</p>
          <p className="text-lg font-semibold font-mono text-fg tabular-nums mt-0.5">
            <AnimatedNumber value={totals.cost} format={(v) => fmt(v)} />
          </p>
          <p className="text-[10px] text-fg-subtle">{lots.length} lot{lots.length !== 1 ? 's' : ''}</p>
        </Card>
        <Card padding="sm" radius="lg">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">Revenue</p>
          <p className="text-lg font-semibold font-mono text-fg tabular-nums mt-0.5">
            <AnimatedNumber value={totals.revenue} format={(v) => fmt(v)} />
          </p>
          <p className="text-[10px] text-fg-subtle">{totals.matched} sales matched</p>
        </Card>
        <Card padding="sm" radius="lg">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">Net Payout</p>
          <p className="text-lg font-semibold font-mono text-fg tabular-nums mt-0.5">
            <AnimatedNumber value={totals.net} format={(v) => fmt(v)} />
          </p>
          <p className="text-[10px] text-fg-subtle" title={`eBay fees ${fmt(totals.fees)} + shipping labels ${fmt(totals.labels)} subtracted from revenue`}>
            {fmt(totals.fees)} fees · {fmt(totals.labels)} labels
          </p>
        </Card>
        <Card padding="sm" radius="lg">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">Profit</p>
          <p className={`text-lg font-semibold font-mono tabular-nums mt-0.5 ${profitCls(totals.profit)}`}>
            <AnimatedNumber value={totals.profit} format={(v) => fmt(v)} />
          </p>
          <p className={`text-[10px] font-medium ${profitCls(totals.roi)}`}>
            {fmtPct(totals.roi)} ROI
          </p>
        </Card>
      </div>

      {/* Main view — the lots table (top toolbar includes Sales + Report modal triggers) */}
      <LotsTab
        lots={lots}
        sales={sales}
        onLotsChange={handleLotsChange}
        onOpenSales={() => setShowSales(true)}
        onOpenReport={() => setShowReport(true)}
      />

      {/* Slide-over: eBay Sales */}
      <Modal open={showSales} onClose={() => setShowSales(false)} size="2xl" title="eBay Sales" subtitle="Imported sale records and SKU→lot matching">
        <SalesTab lots={lots} sales={sales} onSalesChange={handleSalesChange} />
      </Modal>

      {/* Slide-over: P&L Report */}
      <Modal open={showReport} onClose={() => setShowReport(false)} size="2xl" title="P&L Report" subtitle="Per-lot profitability breakdown">
        <ReportTab lots={lots} sales={sales} />
      </Modal>
    </div>
  );
}
