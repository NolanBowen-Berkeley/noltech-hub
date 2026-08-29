import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import usePagination from '../../hooks/usePagination';
import { useApp } from '../../context/AppContext';
import {
  BookOpen, Plus, Download, TrendingUp, TrendingDown, DollarSign,
  X, Trash2, Edit2, Upload, RefreshCw, AlertCircle, Settings,
  ChevronLeft, ChevronRight, PieChart as PieIcon, FileBarChart, Receipt,
  Package, ExternalLink, Tag, ArrowRight, ClipboardCheck, Search,
  Lock, Unlock, FileText, Calendar, Wrench, ChevronDown,
} from 'lucide-react';
import { getLockedMonths, lockMonth, unlockMonth, subscribeLockedMonths } from '../../utils/lockedMonths';
import EbayMatchTab from './EbayMatchTab';
import MonthlySummaryTab from './MonthlySummaryTab';
import { Card, Button, Modal, AnimatedNumber, Input, Label, Select, Stat, TrendDelta, Sparkline, Tabs, FlashOnChange, Badge } from '../../components/ui';
import EmptyState from '../../components/EmptyState';
import DatePicker from '../../components/DatePicker';
import { EBAY_TOKEN_KEY, PIPELINE_BASE } from '../../utils/constants';
import { decryptObject } from '../../services/crypto';
import { fmt, localDateStr } from '../../utils/formatters';
import { estimateTax, getThreshold1099K, SOURCE_LINKS } from '../../utils/tax1099k';
import eventBus from '../../services/eventBus';
import { modalBackdrop, modalPanel } from '../../components/ui/motion';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell, Legend,
  ComposedChart, Area, Line, ReferenceLine,
} from 'recharts';
import { CHART_COLORS as PIE_COLORS } from '../../utils/theme';

// ─── Constants ────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'noltech:books:transactions';
const CATEGORIES_KEY = 'noltech:books:custom-categories';

const DEFAULT_INCOME_CATS = [
  'eBay Sales', 'Mercari Sales', 'Facebook Marketplace', 'Local / Cash Sale', 'Other Income',
];
const INCOME_CATS = DEFAULT_INCOME_CATS; // kept for backwards-compat in helpers below; the root component prefers `incomeCats` state.

const SUPPLIERS = [
  'Liquidation.com', 'TechLiquidators', 'Local / In-Person', 'eBay', 'Amazon',
  'Direct from Business', 'Auction', 'Other',
];

const PAYMENT_METHODS = [
  'Apple Card', 'PayPal', 'PayPal Credit Card', 'Wells Fargo', 'Wire Transfer',
  'Cash', 'Zelle', 'Check', 'Other',
];

const DEFAULT_EXPENSE_CATS = [
  'Cost of Goods (Lots)', 'Shipping', 'Shipping Supplies', 'Postage & Freight',
  'eBay Fees', 'eBay Ad Fees', 'Mercari Fees', 'Platform Fees',
  'Equipment & Tools', 'Office Supplies',
  'Storage', 'Vehicle & Mileage', 'Software & Subscriptions',
  'Advertising', 'Returns & Refunds', 'Other Expense',
];
const EXPENSE_CATS = DEFAULT_EXPENSE_CATS; // see INCOME_CATS comment above.

// Rough Schedule C line mapping for the tax report
const SCHED_C = {
  'Cost of Goods (Lots)':        'Part III – Cost of Goods Sold',
  'Advertising':                  'Line 8 – Advertising',
  'eBay Ad Fees':                 'Line 8 – Advertising',
  'Vehicle & Mileage':            'Line 9 – Car and Truck',
  'Platform Fees':                'Line 10 – Commissions & Fees',
  'eBay Fees':                    'Line 10 – Commissions & Fees',
  'Mercari Fees':                 'Line 10 – Commissions & Fees',
  'Office Supplies':              'Line 18 – Office Expense',
  'Shipping':                     'Line 22 – Supplies',
  'Shipping Supplies':            'Line 22 – Supplies',
  'Postage & Freight':            'Line 27a – Other Expenses',
  'Equipment & Tools':            'Line 27a – Other Expenses',
  'Storage':                      'Line 20b – Other Business Property',
  'Software & Subscriptions':     'Line 27a – Other Expenses',
  'Returns & Refunds':            'Revenue Reduction',
  'Other Expense':                'Line 27a – Other Expenses',
};

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function profitCls(n) {
  if (!n && n !== 0) return 'text-fg-muted';
  return n > 0 ? 'text-success' : n < 0 ? 'text-danger' : 'text-warning';
}

function currentYear() { return new Date().getFullYear(); }

// estimateTax now lives in src/utils/tax1099k.js so the reconciliation card
// and the tax-tile pull from the same source of truth.

// Year-scoped CSV export. Pass `year` to filter to a single calendar year
// (matches the year selected in the toolbar). Pass null/undefined for ALL.
function exportCSV(transactions, year) {
  const scoped = year
    ? transactions.filter(t => (t.date || '').startsWith(`${year}-`))
    : transactions;
  const headers = ['Date','Type','Category','Supplier','Description','Amount','PaymentMethod','Notes'];
  const rows = scoped.map(t => [
    t.date, t.type, t.category,
    `"${(t.supplier || '').replace(/"/g, '""')}"`,
    `"${(t.description || '').replace(/"/g, '""')}"`,
    t.type === 'income' ? Number(t.amount || 0).toFixed(2) : (-Number(t.amount || 0)).toFixed(2),
    `"${(t.paymentMethod || '').replace(/"/g, '""')}"`,
    `"${(t.notes || '').replace(/"/g, '""')}"`,
  ]);
  const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  const tag  = year ? `${year}` : 'all';
  a.download = `noltech-books-${tag}-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── CSV Import Parser ────────────────────────────────────────────────────────

function parseCSVLine(line) {
  const fields = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      fields.push(cur.trim()); cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur.trim());
  return fields;
}

// Handles "January 24", "Feb 6", "March 17" → "2026-01-24" etc.
// Also handles typos like "Februrary", "Feburary"
const MONTH_MAP = {
  jan:1, january:1, januray:1, januaray:1,
  feb:2, february:2, feburary:2, februrary:2, febuary:2,
  mar:3, march:3, marth:3,
  apr:4, april:4,
  may:5,
  jun:6, june:6,
  jul:7, july:7,
  aug:8, august:8,
  sep:9, september:9,
  oct:10, october:10,
  nov:11, november:11,
  dec:12, december:12,
};

function parseFlexibleDate(raw) {
  if (!raw) return null;
  raw = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw; // already ISO
  const m = raw.toLowerCase().match(/([a-z]+)\s+(\d+)(?:,?\s*(\d{4}))?/);
  if (m) {
    const month = MONTH_MAP[m[1]];
    const day   = parseInt(m[2]);
    // Default to the CURRENT calendar year, not a hardcoded sentinel. The
    // old code used 2026 which silently mis-dated every imported row that
    // omitted the year part once the calendar rolled past that.
    const year  = m[3] ? parseInt(m[3]) : currentYear();
    if (month && day) return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  }
  return null;
}

function autoCategory(description, supplier) {
  const s = (description + ' ' + supplier).toLowerCase();
  if (/lot |auction|pallet|liquidation|headphone|motherboard|server|gaming pc|rtx|gtx|radeon|gpu|graphics card|zotac|gigabyte|asus gpu|cpu|intel|raspberry|airpod|iphone|lens/i.test(s))
    return 'Cost of Goods (Lots)';
  if (/box|bubble wrap|tape|moving bag|shipping bag|packing|mailer/i.test(s))
    return 'Shipping Supplies';
  if (/scale|ring light|photo|adapter|dock|hdd bay|psu tester|mat|surge|protector|power supply|food scale|usb/i.test(s))
    return 'Equipment & Tools';
  if (/trash|chair|desk|pen|paper|batteries|battery/i.test(s))
    return 'Office Supplies';
  return 'Cost of Goods (Lots)';
}

function parseMonthlySummaryCSV(lines, headerIdx) {
  const headers = parseCSVLine(lines[headerIdx]).map(h => h.toLowerCase().trim());
  const findCol = (...names) => {
    for (const name of names) {
      const idx = headers.findIndex(h => h.includes(name));
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const monthIdx    = findCol('month');
  const revenueIdx  = findCol('gross revenue');
  const feesIdx     = findCol('ebay fee', 'fees');
  const shippingIdx = findCol('shipping cost');
  const refundsIdx  = findCol('refund');

  if (monthIdx < 0 || revenueIdx < 0) return [];

  const txs = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (!lines[i].replace(/,/g, '').trim()) continue;
    const row  = parseCSVLine(lines[i]);
    const getF = (idx) => idx >= 0 ? (row[idx] || '').trim() : '';
    const money = (s) => Math.abs(parseFloat(s.replace(/[$,\s]/g, '')) || 0);

    const rawMonth = getF(monthIdx);
    if (!rawMonth || /^(month|total|sum)/i.test(rawMonth)) continue;

    const revenue  = money(getF(revenueIdx));
    if (revenue <= 0) continue;

    const date = parseFlexibleDate(rawMonth + ' 1'); // use 1st of month

    if (revenue > 0) {
      txs.push({ id: uid(), source: 'csv_import', date, type: 'income',
        category: 'eBay Sales', supplier: 'eBay',
        description: `eBay Sales — ${rawMonth}`, amount: revenue,
        paymentMethod: 'eBay', notes: 'Imported from Monthly Summary' });
    }
    const fees = money(getF(feesIdx));
    if (fees > 0) {
      txs.push({ id: uid(), source: 'csv_import', date, type: 'expense',
        category: 'Platform Fees', supplier: 'eBay',
        description: `eBay Fees — ${rawMonth}`, amount: fees,
        paymentMethod: '', notes: 'Imported from Monthly Summary' });
    }
    const shipping = money(getF(shippingIdx));
    if (shipping > 0) {
      txs.push({ id: uid(), source: 'csv_import', date, type: 'expense',
        category: 'Postage & Freight', supplier: 'eBay',
        description: `Shipping Cost — ${rawMonth}`, amount: shipping,
        paymentMethod: '', notes: 'Imported from Monthly Summary' });
    }
    const refunds = money(getF(refundsIdx));
    if (refunds > 0) {
      txs.push({ id: uid(), source: 'csv_import', date, type: 'expense',
        category: 'Returns & Refunds', supplier: 'eBay',
        description: `Refunds — ${rawMonth}`, amount: refunds,
        paymentMethod: '', notes: 'Imported from Monthly Summary' });
    }
  }
  return txs;
}

function parseImportCSV(text) {
  const lines = text.trim().split(/\r?\n/);

  // Find the real header row — look for a line containing key columns
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (lower.includes('month') && (lower.includes('gross revenue') || lower.includes('gross item'))) {
      // Monthly summary format — route to dedicated parser
      return parseMonthlySummaryCSV(lines, i);
    }
    if (lower.includes('date') && (lower.includes('description') || lower.includes('supplier'))) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return [];

  const headers = parseCSVLine(lines[headerIdx]).map(h => h.toLowerCase().trim());

  const findCol = (...names) => {
    for (const name of names) {
      const idx = headers.findIndex(h => h.includes(name));
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const dateIdx    = findCol('date');
  const supplierIdx = findCol('supplier');
  const catIdx     = findCol('category');
  const descIdx    = findCol('description');
  const amtIdx     = findCol('total cost', 'amount', 'cost', 'price');
  const pmIdx      = findCol('payment method', 'payment');
  const notesIdx   = findCol('notes');
  const typeIdx    = findCol('type');

  if (dateIdx < 0 || descIdx < 0 || amtIdx < 0) return [];

  const txs = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (!lines[i].replace(/,/g, '').trim()) continue; // skip blank rows
    const row = parseCSVLine(lines[i]);
    const getF = (idx) => idx >= 0 ? (row[idx] || '').trim() : '';

    const rawDate = getF(dateIdx);
    const rawAmt  = getF(amtIdx);
    const desc    = getF(descIdx);

    // Skip totals / second header rows / empty data rows
    if (!rawDate || /^(totals?|date|period|column)/i.test(rawDate.trim())) continue;
    if (!desc && !rawAmt) continue;

    const amount = parseFloat(rawAmt.replace(/[$,\s]/g, ''));
    if (!amount || isNaN(amount) || amount <= 0) continue;

    const date = parseFlexibleDate(rawDate);
    if (!date) continue;

    const type     = typeIdx >= 0 ? (getF(typeIdx) || 'expense') : 'expense';
    const rawCat   = getF(catIdx);
    const supplier = getF(supplierIdx);
    const category = rawCat || autoCategory(desc, supplier);

    txs.push({
      id:            uid(),
      source:        'csv_import',
      date,
      type,
      category,
      supplier,
      description:   desc,
      amount,
      paymentMethod: getF(pmIdx),
      notes:         getF(notesIdx),
    });
  }
  return txs;
}

// ─── Transaction Form Modal ───────────────────────────────────────────────────

function TxModal({ initial, onSave, onClose, incomeCats = INCOME_CATS, expenseCats = EXPENSE_CATS }) {
  const blank = {
    date: new Date().toISOString().slice(0, 10),
    type: 'income', category: incomeCats[0],
    supplier: '', description: '', amount: '', paymentMethod: '', notes: '',
  };
  const [form, setForm] = useState(initial || blank);
  const [ocrStatus, setOcrStatus] = useState(null); // 'processing' | 'success' | 'error'
  const [ocrError, setOcrError] = useState('');
  const [formError, setFormError] = useState('');

  function upd(k, v) {
    setForm(f => {
      const next = { ...f, [k]: v };
      if (k === 'type') next.category = v === 'income' ? incomeCats[0] : expenseCats[0];
      return next;
    });
  }

  async function handleReceiptUpload(file) {
    if (!file) return;
    setOcrStatus('processing');
    setOcrError('');
    try {
      const { decrypt } = await import('../../services/crypto');
      const { extractReceipt } = await import('../../services/ai');
      const rawKey = await window.storage.get('noltech:apikey');
      if (!rawKey) throw new Error('Add your Anthropic API key in Settings first.');
      const apiKey = await decrypt(rawKey);

      // Convert file to base64
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const data = await extractReceipt(apiKey, base64, file.type || 'image/jpeg');

      // Auto-fill form as expense (most receipts are expenses)
      const mappedCategory = expenseCats.find(c => c.toLowerCase().includes(data.category?.toLowerCase() || '')) || expenseCats[0];
      setForm(f => ({
        ...f,
        type: 'expense',
        category: mappedCategory,
        supplier: data.vendor || f.supplier,
        description: data.description || f.description,
        amount: data.amount ? String(data.amount) : f.amount,
        date: data.date || f.date,
      }));
      setOcrStatus('success');
      setTimeout(() => setOcrStatus(null), 3000);
    } catch (e) {
      setOcrError(e.message);
      setOcrStatus('error');
    }
  }

  function submit(e) {
    e.preventDefault();
    const amt = parseFloat(form.amount);
    // Surface validation errors instead of silently returning. The previous
    // no-op left the user staring at a form that wouldn't save with no
    // indication why.
    if (!form.description.trim()) {
      setFormError('Description is required.');
      return;
    }
    if (isNaN(amt) || amt <= 0) {
      setFormError('Enter an amount greater than 0.');
      return;
    }
    setFormError('');
    onSave({ ...form, amount: amt });
  }

  const cats = form.type === 'income' ? incomeCats : expenseCats;

  return (
    <motion.div {...modalBackdrop} className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
      <motion.div {...modalPanel} onClick={(e) => e.stopPropagation()} className="glossy-elevated w-full max-w-md flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle flex-shrink-0">
          <h3 className="font-semibold text-fg">{initial ? 'Edit Transaction' : 'Add Transaction'}</h3>
          <button onClick={onClose} className="p-1 text-fg-subtle hover:text-fg-muted rounded"><X className="w-4 h-4" /></button>
        </div>
        <form onSubmit={submit} className="p-5 space-y-3 overflow-y-auto">
          {/* Receipt OCR upload (expenses only) */}
          {!initial && (
            <label className={`flex items-center justify-center gap-2 w-full py-2 border-2 border-dashed rounded-lg text-xs font-medium cursor-pointer transition-colors ${
              ocrStatus === 'processing' ? 'border-info/30 bg-info-subtle text-info' :
              ocrStatus === 'success' ? 'border-success/30 bg-success-subtle text-success' :
              ocrStatus === 'error' ? 'border-danger/30 bg-danger-subtle text-danger' :
              'border-border text-fg-muted hover:border-primary/30 hover:bg-primary/5'
            }`}>
              {ocrStatus === 'processing' ? (
                <><RefreshCw size={12} className="animate-spin" /> Extracting receipt...</>
              ) : ocrStatus === 'success' ? (
                <><AlertCircle size={12} /> Receipt scanned! Review fields below.</>
              ) : ocrStatus === 'error' ? (
                <><AlertCircle size={12} /> {ocrError || 'OCR failed'}</>
              ) : (
                <><Upload size={12} /> Upload receipt photo to auto-fill</>
              )}
              <input type="file" accept="image/*" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleReceiptUpload(f); e.target.value = ''; }}
                disabled={ocrStatus === 'processing'} />
            </label>
          )}

          {/* Type toggle */}
          <div className="flex gap-2">
            {['income','expense'].map(t => (
              <button key={t} type="button" onClick={() => upd('type', t)}
                className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors
                  ${form.type === t
                    ? t === 'income'
                      ? 'bg-success/10 border-success text-success'
                      : 'bg-danger/10 border-danger text-danger'
                    : 'border-border text-fg-muted hover:border-border-strong'}`}>
                {t === 'income' ? '+ Income' : '− Expense'}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Date</Label>
              <DatePicker value={form.date} onChange={v => upd('date', v)} />
            </div>
            <div>
              <Label>Amount ($)</Label>
              <Input type="number" min="0.01" step="0.01" value={form.amount} onChange={e => upd('amount', e.target.value)}
                placeholder="0.00"
                className="font-mono" />
            </div>
          </div>

          <div>
            <Label>Category</Label>
            <Select value={form.category} onChange={e => upd('category', e.target.value)}>
              {cats.map(c => <option key={c}>{c}</option>)}
            </Select>
          </div>

          <div>
            <Label>Supplier / Source</Label>
            <Select value={SUPPLIERS.includes(form.supplier) ? form.supplier : 'Other'}
              onChange={e => upd('supplier', e.target.value)}>
              <option value="" disabled>Select supplier…</option>
              {SUPPLIERS.map(s => <option key={s} value={s}>{s}</option>)}
            </Select>
            {form.supplier && !SUPPLIERS.includes(form.supplier) && (
              <Input className="mt-1.5" type="text" value={form.supplier} onChange={e => upd('supplier', e.target.value)}
                placeholder="Type supplier name…" />
            )}
          </div>

          <div>
            <Label>Description</Label>
            <Input type="text" value={form.description || ''} onChange={e => upd('description', e.target.value)}
              placeholder="e.g. ThinkPad lot — 10 units" />
          </div>

          <div>
            <Label>Payment Method</Label>
            <Select value={PAYMENT_METHODS.includes(form.paymentMethod) ? form.paymentMethod : 'Other'}
              onChange={e => upd('paymentMethod', e.target.value)}>
              <option value="" disabled>Select payment method…</option>
              {PAYMENT_METHODS.map(p => <option key={p} value={p}>{p}</option>)}
            </Select>
            {form.paymentMethod && !PAYMENT_METHODS.includes(form.paymentMethod) && (
              <Input className="mt-1.5" type="text" value={form.paymentMethod} onChange={e => upd('paymentMethod', e.target.value)}
                placeholder="Type payment method…" />
            )}
          </div>

          <div>
            <Label>Notes (optional)</Label>
            <Input type="text" value={form.notes || ''} onChange={e => upd('notes', e.target.value)} />
          </div>

          {formError && (
            <div className="text-xs font-medium text-danger bg-danger-subtle border border-danger/20 rounded-md px-3 py-1.5">
              {formError}
            </div>
          )}
          <div className="flex gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={onClose} className="flex-1">Cancel</Button>
            <Button type="submit" variant="accent" className="flex-1">Save</Button>
          </div>
        </form>
      </motion.div>
    </motion.div>
  );
}

// ─── eBay Import Modal ────────────────────────────────────────────────────────

function EbayImportModal({ onImport, onClose }) {
  const [creds, setCreds]       = useState(null); // loaded from settings
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date(); d.setMonth(d.getMonth() - 3);
    return d.toISOString().slice(0, 10);
  });
  const [dateTo, setDateTo] = useState(new Date().toISOString().slice(0, 10));
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');

  useEffect(() => {
    window.storage.get(EBAY_TOKEN_KEY).then(async (raw) => {
      const v = await decryptObject(raw || {});
      setCreds(v || {});
    }).catch(() => setCreds({}));
  }, []);

  async function doImport() {
    if (!creds?.token) { setError('No eBay token found. Add it in Settings → eBay Credentials.'); return; }
    setLoading(true); setError('');
    try {
      const res = await fetch(`${PIPELINE_BASE}/api/ebay/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userToken: creds.token,
          appId:     creds.appId  || '',
          devId:     creds.devId  || '',
          certId:    creds.certId || '',
          startDate: dateFrom,
          endDate:   dateTo,
        }),
        signal: AbortSignal.timeout(60000),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'eBay API error');
      onImport(data.orders);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const noCreds = creds !== null && !creds?.token;

  return (
    <motion.div {...modalBackdrop} className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
      <motion.div {...modalPanel} onClick={(e) => e.stopPropagation()} className="glossy-elevated w-full max-w-sm">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <h3 className="font-semibold text-fg">Import eBay Sales</h3>
          <button onClick={onClose} className="p-1 text-fg-subtle hover:text-fg-muted rounded"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-3">
          {noCreds ? (
            <div className="flex gap-2 items-start bg-warning-subtle border border-warning/30 rounded-lg px-3 py-2.5">
              <AlertCircle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
              <p className="text-xs text-warning">No eBay credentials saved. Go to <strong>Settings → eBay Credentials</strong> and add your User Token first.</p>
            </div>
          ) : (
            <p className="text-xs text-fg-muted">Pulls completed orders from the eBay Trading API using credentials saved in Settings. Duplicates are skipped automatically.</p>
          )}
          <div className="flex gap-2">
            <div className="flex-1">
              <Label>From</Label>
              <DatePicker value={dateFrom} onChange={setDateFrom} />
            </div>
            <div className="flex-1">
              <Label>To</Label>
              <DatePicker value={dateTo} onChange={setDateTo} />
            </div>
          </div>
          {error && (
            <div className="flex gap-2 items-start bg-danger/5 border border-danger/20 rounded-lg px-3 py-2">
              <AlertCircle className="w-4 h-4 text-danger flex-shrink-0 mt-0.5" />
              <p className="text-xs text-danger">{error}</p>
            </div>
          )}
          <div className="flex gap-2 pt-1">
            <Button variant="secondary" onClick={onClose} className="flex-1">Cancel</Button>
            <Button variant="accent" onClick={doImport} disabled={loading || noCreds || creds === null} className="flex-1">
              {loading ? 'Importing…' : 'Import Orders'}
            </Button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ─── Overview Tab ─────────────────────────────────────────────────────────────

function OverviewTab({ transactions, year }) {
  const yearly = useMemo(() => transactions.filter(t => t.date.startsWith(String(year))), [transactions, year]);
  const prevYearly = useMemo(
    () => transactions.filter(t => t.date.startsWith(String(year - 1))),
    [transactions, year],
  );

  const totalIncome   = yearly.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const totalExpenses = yearly.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  const netProfit     = totalIncome - totalExpenses;
  const cogs          = yearly.filter(t => t.category === 'Cost of Goods (Lots)').reduce((s, t) => s + t.amount, 0);
  const grossProfit   = totalIncome - cogs;

  const isCurrentYear = year === new Date().getFullYear();
  const monthCap = isCurrentYear ? new Date().getMonth() + 1 : 12;
  const prevThrough = prevYearly.filter(t => {
    const m = parseInt(t.date.slice(5, 7), 10);
    return m >= 1 && m <= monthCap;
  });
  const prevIncome   = prevThrough.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const prevExpenses = prevThrough.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  const prevCogs     = prevThrough.filter(t => t.category === 'Cost of Goods (Lots)').reduce((s, t) => s + t.amount, 0);
  const prevGross    = prevIncome - prevCogs;
  const prevNet      = prevIncome - prevExpenses;

  const monthlyData = useMemo(() => MONTHS.map((month, i) => {
    const pfx = `${year}-${String(i + 1).padStart(2, '0')}`;
    const inc = yearly.filter(t => t.type === 'income'  && t.date.startsWith(pfx)).reduce((s, t) => s + t.amount, 0);
    const exp = yearly.filter(t => t.type === 'expense' && t.date.startsWith(pfx)).reduce((s, t) => s + t.amount, 0);
    const cgs = yearly.filter(t => t.category === 'Cost of Goods (Lots)' && t.date.startsWith(pfx)).reduce((s, t) => s + t.amount, 0);
    return {
      month,
      income:   Math.round(inc * 100) / 100,
      expenses: Math.round(exp * 100) / 100,
      grossProfit: Math.round((inc - cgs) * 100) / 100,
      net: Math.round((inc - exp) * 100) / 100,
    };
  }), [yearly, year]);

  const sparkSeries = useMemo(() => ({
    income:   monthlyData.map(d => d.income),
    expenses: monthlyData.map(d => d.expenses),
    gross:    monthlyData.map(d => d.grossProfit),
    net:      monthlyData.map(d => d.net),
  }), [monthlyData]);

  const expByCategory = {};
  yearly.filter(t => t.type === 'expense').forEach(t => {
    expByCategory[t.category] = (expByCategory[t.category] || 0) + t.amount;
  });
  const pieData = Object.entries(expByCategory)
    .map(([name, value]) => ({ name, value: Math.round(value * 100) / 100 }))
    .sort((a, b) => b.value - a.value);

  const cards = [
    { label: 'Gross Revenue',  value: totalIncome,   prev: prevIncome,   spark: sparkSeries.income,   intent: 'success' },
    { label: 'Total Expenses', value: totalExpenses, prev: prevExpenses, spark: sparkSeries.expenses, intent: 'danger', inverseGood: true },
    { label: 'Gross Profit',   value: grossProfit,   prev: prevGross,    spark: sparkSeries.gross,    intent: grossProfit >= 0 ? 'success' : 'danger' },
    { label: 'Net Profit',     value: netProfit,     prev: prevNet,      spark: sparkSeries.net,      intent: netProfit   >= 0 ? 'success' : 'danger', hero: true },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map(({ label, value, prev, spark, intent, inverseGood, hero }, i) => (
          <motion.div
            key={label}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: i * 0.05, ease: [0.16, 1, 0.3, 1] }}
          >
            <Card padding="sm" radius="lg" className="card-hover">
              <Stat
                label={label}
                value={hero ? (
                  <span className="hero-num">{fmt(value)}</span>
                ) : fmt(value)}
                intent={intent}
                size="md"
                sparkline={spark}
                sub={(
                  <span className="inline-flex items-center gap-1.5">
                    <TrendDelta current={value} previous={prev} inverseGood={inverseGood} />
                    <span>{isCurrentYear ? `vs ${year - 1} YTD` : `vs ${year - 1}`}</span>
                  </span>
                )}
              />
            </Card>
          </motion.div>
        ))}
      </div>

      <div className="bg-surface rounded-xl p-5 shadow-sm border border-border-subtle">
        <h3 className="text-sm font-semibold text-fg mb-4">Monthly Income vs Expenses</h3>
        {monthlyData.some(d => d.income > 0 || d.expenses > 0) ? (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={monthlyData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={v => '$' + (v >= 1000 ? (v/1000).toFixed(0)+'k' : v)} />
              <Tooltip formatter={(v) => fmt(v)} />
              <Legend />
              <Bar dataKey="income"   name="Income"   fill="var(--success)" radius={[3,3,0,0]} />
              <Bar dataKey="expenses" name="Expenses" fill="var(--danger)" radius={[3,3,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <EmptyState
            icon={BookOpen}
            title={`No activity yet for ${year}`}
            description="Add a transaction or import eBay orders to populate this chart."
          />
        )}
      </div>

      {pieData.length > 0 && (
        <div className="bg-surface rounded-xl p-5 shadow-sm border border-border-subtle">
          <h3 className="text-sm font-semibold text-fg mb-4">Expense Breakdown</h3>
          <div className="flex flex-col items-center gap-5">
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={85} label={false}>
                  {pieData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={(v) => fmt(v)} />
              </PieChart>
            </ResponsiveContainer>
            <div className="w-full space-y-0.5">
              {pieData.map((d, i) => {
                const total = pieData.reduce((s, x) => s + x.value, 0);
                const pct   = total > 0 ? Math.round((d.value / total) * 100) : 0;
                return (
                  <div key={d.name} className="row-hover flex items-center gap-3 px-2 py-1.5 rounded-md">
                    <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                    <span className="text-sm text-fg flex-1 min-w-0 truncate">{d.name}</span>
                    <span className="text-xs text-fg-muted w-8 text-right flex-shrink-0">{pct}%</span>
                    <span className="text-sm font-mono text-danger w-24 text-right flex-shrink-0">{fmt(d.value)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Transactions Tab ─────────────────────────────────────────────────────────

// ─── Transaction Detail Modal ──────────────────────────────────────────────
// Click any row in the ledger → see the full picture: order total, seller
// revenue, fee breakdown, sibling auto-rows for the same sale, plus a link
// to the underlying inventory item. Auto-recorded eBay/ticket rows are
// resolved by parsing their importId; manual rows fall back to the basics.
function TransactionDetailModal({ tx, transactions, lots, onClose, onEdit, onDelete }) {
  if (!tx) return null;

  // For auto rows the importId tells us the family. Two shapes coexist:
  //   • OLD: `auto:<itemId>:<soldAt>`        (3 segments, itemId-anchored)
  //   • NEW: `auto:<orderId>[:<txnId>]`      (2-3 segments, order-anchored)
  // We treat everything after the kind prefix as one opaque "anchor" so
  // sibling lookups (`auto_fees:<anchor>`, etc.) work the same for both.
  const parseAuto = (id) => {
    if (!id) return null;
    const m = id.match(/^(auto(?:_fees|_adfee|_ship)?)(?::ticket)?:(.+)$/);
    if (!m) return null;
    return { kind: m[1], anchor: m[2] };
  };
  const refKey = parseAuto(tx.importId);
  const incomeRow = refKey
    ? transactions.find((t) => t.importId === `auto:${refKey.anchor}`)
    : null;
  const feesRow = refKey
    ? transactions.find((t) => t.importId === `auto_fees:${refKey.anchor}`)
    : null;
  const adfeeRow = refKey
    ? transactions.find((t) => t.importId === `auto_adfee:${refKey.anchor}`)
    : null;
  const shipRow = refKey
    ? transactions.find((t) => t.importId === `auto_ship:${refKey.anchor}`)
    : null;

  // Inventory lookup — find the item this transaction points to. Two paths:
  //   • New rows carry `tx.orderId` (the eBay order id) on the row itself —
  //     match items by `item.sale.id === tx.orderId`.
  //   • Old rows have the itemId embedded in the importId — fall back to
  //     parsing the anchor's first colon-segment as a UUID.
  const allItems = (lots || []).flatMap((l) => (l.items || []).map((i) => ({ ...i, _lot: l })));
  const legacyItemId = refKey && /^[0-9a-f-]{20,}$/i.test(refKey.anchor.split(':')[0])
    ? refKey.anchor.split(':')[0]
    : null;
  const item = tx.orderId
    ? allItems.find((i) => i.sale?.id === tx.orderId) || null
    : legacyItemId
      ? allItems.find((i) => i.id === legacyItemId) || null
      : null;
  const sale = item?.sale || null;

  const orderTotal    = parseFloat(sale?.orderTotal) || 0;
  const subtotal      = parseFloat(sale?.subtotal) || 0;
  const buyerShipping = parseFloat(sale?.buyerShipping) || 0;
  const salesTax      = parseFloat(sale?.salesTax) || 0;
  const grossRevenue  = parseFloat(sale?.salePrice) || (incomeRow?.amount ?? tx.amount);
  const labelCost     = parseFloat(sale?.labelCost) || parseFloat(sale?.shippingCost) || (shipRow?.amount ?? 0);
  const platformFees  = parseFloat(sale?.platformFees) || (feesRow?.amount ?? 0);
  const feeBreakdown  = sale?.feeBreakdown || null;
  const netRevenue    = parseFloat(sale?.netRevenue) || (grossRevenue - labelCost - platformFees);
  const profit        = parseFloat(sale?.profit) || 0;
  const isAutoSale    = tx.source === 'auto_sale' || tx.source === 'auto_fees' || tx.source === 'auto_shipping';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        onClick={(e) => e.stopPropagation()}
        className="glossy-elevated w-full max-w-2xl max-h-[85vh] overflow-y-auto"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-border sticky top-0 bg-surface/95 backdrop-blur-sm z-10">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[10px] uppercase font-semibold tracking-wider text-fg-subtle mb-1">
              <span>{tx.date}</span>
              <span>·</span>
              <span>{tx.category}</span>
              {isAutoSale && (
                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-accent-subtle text-accent text-[9px]">
                  <Tag className="size-2.5" /> auto
                </span>
              )}
            </div>
            <p className="text-base font-semibold text-fg leading-snug">{tx.description}</p>
            <p className={`text-xl font-mono tabular-nums mt-1 ${tx.type === 'income' ? 'text-success' : 'text-danger'}`}>
              {tx.type === 'income' ? '+' : '−'}{fmt(tx.amount)}
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded-md text-fg-subtle hover:text-fg hover:bg-muted transition-colors shrink-0">
            <X className="size-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Order total card — only for eBay-style auto rows where we have the data */}
          {isAutoSale && orderTotal > 0 && (
            <div className="bg-surface border border-border-subtle rounded-lg p-4">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-subtle mb-2">Order Total — what the buyer paid</p>
              <div className="flex items-baseline justify-between mb-3">
                <span className="text-2xl font-mono tabular-nums font-bold text-fg">{fmt(orderTotal)}</span>
                <span className="text-[11px] text-fg-muted">eBay invoice total</span>
              </div>
              <div className="space-y-1 text-sm">
                {subtotal > 0 && (
                  <div className="flex justify-between text-fg-muted">
                    <span>Subtotal (items)</span>
                    <span className="font-mono tabular-nums">{fmt(subtotal)}</span>
                  </div>
                )}
                {buyerShipping > 0 && (
                  <div className="flex justify-between text-fg-muted">
                    <span>Buyer-paid shipping</span>
                    <span className="font-mono tabular-nums">{fmt(buyerShipping)}</span>
                  </div>
                )}
                {salesTax > 0 && (
                  <div className="flex justify-between text-fg-subtle">
                    <span>Sales tax (eBay-remitted, not your income)</span>
                    <span className="font-mono tabular-nums">{fmt(salesTax)}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Seller revenue calculation */}
          {isAutoSale && (
            <div className="bg-surface border border-border-subtle rounded-lg p-4">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-subtle mb-2">Net Earnings calculation</p>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between text-fg">
                  <span>Seller revenue (items + buyer ship)</span>
                  <span className="font-mono tabular-nums font-semibold">{fmt(grossRevenue)}</span>
                </div>
                {platformFees > 0 && (
                  <div className="flex justify-between text-danger">
                    <span>− Platform fees</span>
                    <span className="font-mono tabular-nums">{fmt(platformFees)}</span>
                  </div>
                )}
                {labelCost > 0 && (
                  <div className="flex justify-between text-danger">
                    <span>− Shipping label</span>
                    <span className="font-mono tabular-nums">{fmt(labelCost)}</span>
                  </div>
                )}
                <div className="border-t border-border-subtle pt-1.5 mt-1.5 flex justify-between font-semibold text-fg">
                  <span>Net earnings</span>
                  <span className="font-mono tabular-nums text-success">{fmt(netRevenue)}</span>
                </div>
                {profit !== 0 && item && (
                  <div className="flex justify-between text-[11px] text-fg-muted pt-1">
                    <span>Net profit (after cost basis)</span>
                    <span className={`font-mono tabular-nums ${profit >= 0 ? 'text-success' : 'text-danger'}`}>{fmt(profit)}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Fee breakdown */}
          {feeBreakdown && Object.keys(feeBreakdown).length > 0 && (
            <div className="bg-surface border border-border-subtle rounded-lg p-4">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-subtle mb-2">Fee Breakdown</p>
              <div className="space-y-1 text-sm">
                {Object.entries(feeBreakdown)
                  .filter(([, v]) => Number(v) > 0)
                  .sort((a, b) => b[1] - a[1])
                  .map(([name, val]) => (
                    <div key={name} className="flex justify-between text-fg-muted">
                      <span>{name.replace(/([A-Z])/g, ' $1').replace(/^ /, '')}</span>
                      <span className="font-mono tabular-nums">{fmt(val)}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* Item details */}
          {(item || tx.sku) && (
            <div className="bg-surface border border-border-subtle rounded-lg p-4">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-subtle mb-2 inline-flex items-center gap-1">
                <Package className="size-3" /> Linked Inventory Item
              </p>
              <div className="space-y-1 text-sm">
                {item && (
                  <div className="flex justify-between text-fg">
                    <span>Brand / model</span>
                    <span className="font-medium">{[item.brand, item.model].filter(Boolean).join(' ') || '—'}</span>
                  </div>
                )}
                {(item?.sku || item?.serialNumber || tx.sku) && (
                  <div className="flex justify-between text-fg-muted">
                    <span>SKU</span>
                    <span className="font-mono">{item?.sku || item?.serialNumber || tx.sku}</span>
                  </div>
                )}
                {item?._lot && (
                  <div className="flex justify-between text-fg-muted">
                    <span>From lot</span>
                    <span>{item._lot.sourceName || item._lot.name || item._lot.id?.slice(0, 8)}</span>
                  </div>
                )}
                {sale?.id && (
                  <div className="flex justify-between text-fg-muted">
                    <span>Order ID</span>
                    <span className="font-mono text-[11px]">{sale.id}</span>
                  </div>
                )}
                {sale?.buyerName && (
                  <div className="flex justify-between text-fg-muted">
                    <span>Buyer</span>
                    <span>{sale.buyerName}</span>
                  </div>
                )}
                {sale?.labelCostKnown === false && labelCost === 0 && (
                  <div className="flex items-start gap-1.5 mt-2 text-[11px] text-warning-fg bg-warning-subtle rounded px-2 py-1.5">
                    <AlertCircle className="size-3 mt-0.5 shrink-0" />
                    Label cost wasn't returned by eBay — enter it from Shipping Queue to make net earnings accurate.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Related transactions */}
          {(incomeRow || feesRow || adfeeRow || shipRow) && (
            <div className="bg-surface border border-border-subtle rounded-lg p-4">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-subtle mb-2">Related Transactions</p>
              <div className="space-y-1">
                {[incomeRow, feesRow, adfeeRow, shipRow].filter(Boolean).map((r) => (
                  <div
                    key={r.id}
                    className={`row-hover flex items-center gap-2 px-2 py-1.5 rounded text-sm ${r.id === tx.id ? 'bg-accent-subtle/40 border border-accent/30' : ''}`}
                  >
                    <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
                      r.type === 'income' ? 'bg-success-subtle text-success' : 'bg-danger-subtle text-danger'
                    }`}>{r.type === 'income' ? 'income' : 'expense'}</span>
                    <span className="text-fg-muted text-xs flex-1 truncate">{r.category}</span>
                    <span className={`font-mono tabular-nums text-sm ${r.type === 'income' ? 'text-success' : 'text-danger'}`}>
                      {r.type === 'income' ? '+' : '−'}{fmt(r.amount)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Notes */}
          {tx.notes && (
            <div className="bg-muted/40 border border-border-subtle rounded-lg p-4">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-subtle mb-2">Notes</p>
              <p className="text-xs text-fg-muted leading-relaxed whitespace-pre-wrap">{tx.notes}</p>
            </div>
          )}

          {/* Identifiers */}
          <div className="text-[10px] text-fg-subtle font-mono pt-1 border-t border-border-subtle space-y-0.5">
            <div>Transaction ID: {tx.id}</div>
            {tx.importId && <div>Import ID: {tx.importId}</div>}
            {tx.source && <div>Source: {tx.source}</div>}
          </div>
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border bg-muted/20 sticky bottom-0">
          <button
            onClick={() => { onDelete(tx.id); onClose(); }}
            className="px-3 py-1.5 text-xs text-danger hover:bg-danger-subtle rounded-md transition-colors"
          >
            Delete
          </button>
          <button
            onClick={() => { onEdit(tx); onClose(); }}
            className="px-3 py-1.5 text-xs border border-border text-fg-muted hover:bg-muted/40 rounded-md transition-colors inline-flex items-center gap-1"
          >
            <Edit2 className="size-3" /> Edit
          </button>
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs bg-primary text-white rounded-md hover:bg-primary/90 transition-colors"
          >
            Close
          </button>
        </div>
      </motion.div>
    </div>
  );
}

function TransactionsTab({ transactions, lots, onAdd, onEdit, onDelete, initialCategoryFilter, onCategoryFilterClear }) {
  const [typeFilter, setTypeFilter]   = useState('all');
  const [catFilter, setCatFilter]     = useState(initialCategoryFilter || '');
  const [search, setSearch]           = useState('');
  const [monthFilter, setMonthFilter] = useState('');

  // Sync inbound category filter (e.g., user clicked a category-mix row in
  // the hero zone). Clears the parent-side state if the user changes the
  // dropdown back to "all categories".
  useEffect(() => {
    if (initialCategoryFilter && initialCategoryFilter !== catFilter) {
      setCatFilter(initialCategoryFilter);
    }
  }, [initialCategoryFilter]);
  useEffect(() => {
    if (!catFilter && initialCategoryFilter) onCategoryFilterClear?.();
  }, [catFilter]);
  const [deleteConfirmId, setDeleteConfirmId] = useState(null);
  const [detailTx, setDetailTx]       = useState(null);
  const [viewMode, setViewMode]       = useState('flat'); // 'flat' | 'grouped'
  const [expandedGroup, setExpandedGroup] = useState(null);
  const PG_SIZE = 50;

  const months = useMemo(() => {
    const s = new Set(transactions.map(t => t.date.slice(0, 7)));
    return [...s].sort().reverse();
  }, [transactions]);

  const filtered = useMemo(() => {
    return transactions
      .filter(t => typeFilter === 'all' || t.type === typeFilter)
      .filter(t => !catFilter  || t.category === catFilter)
      .filter(t => !monthFilter || t.date.startsWith(monthFilter))
      .filter(t => {
        if (!search) return true;
        const q = search.toLowerCase();
        // Match description, notes, sku, supplier, importId, and the new
        // explicit orderId field. Auto rows now stamp the eBay order number
        // there so a search by "21-14528-55882" finds all 4 related rows.
        return (
          (t.description || '').toLowerCase().includes(q)
          || (t.notes || '').toLowerCase().includes(q)
          || (t.sku || '').toLowerCase().includes(q)
          || (t.supplier || '').toLowerCase().includes(q)
          || (t.importId || '').toLowerCase().includes(q)
          || (t.orderId || '').toLowerCase().includes(q)
        );
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [transactions, typeFilter, catFilter, monthFilter, search]);

  const allCats = typeFilter === 'income' ? INCOME_CATS : typeFilter === 'expense' ? EXPENSE_CATS : [...INCOME_CATS, ...EXPENSE_CATS];

  // ── Grouped view: condense each sale's auto rows into one summary row ────
  // Auto rows share an importId pattern like `auto[_kind]:{itemId}:{soldAt}`,
  // so we group by `{itemId}:{soldAt}`. Manual rows / CSV imports / orphan
  // auto rows show as standalone single-row groups, preserving the "every
  // entry is visible" guarantee while collapsing 4-row sales into 1 line.
  const grouped = useMemo(() => {
    const map = new Map();
    const orphans = [];
    for (const t of filtered) {
      const m = t.importId && t.importId.match(/^auto[_a-z]*:([^:]+):(.*)$/);
      if (!m) { orphans.push(t); continue; }
      const anchor = `${m[1]}:${m[2]}`;
      if (!map.has(anchor)) {
        map.set(anchor, {
          kind: 'group',
          anchor,
          date: t.date,
          description: '',
          sku: t.sku || '',
          rows: [],
          income: 0,
          fees: 0,
          adfee: 0,
          shipping: 0,
          otherIncome: 0,
          otherExpense: 0,
        });
      }
      const g = map.get(anchor);
      g.rows.push(t);
      const amt = Number(t.amount) || 0;
      if (t.source === 'auto_sale' || t.source === 'auto_ticket_sale') {
        g.description = g.description || t.description;
        g.sku = g.sku || t.sku || '';
        g.income += amt;
      } else if (t.source === 'auto_fees') {
        g.fees += amt;
      } else if (t.source === 'auto_adfee') {
        g.adfee += amt;
      } else if (t.source === 'auto_shipping') {
        g.shipping += amt;
      } else if (t.source === 'auto_ticket_purchase') {
        g.otherExpense += amt;
      } else if (t.type === 'income') {
        g.otherIncome += amt;
      } else {
        g.otherExpense += amt;
      }
      // Earliest date wins for the group (cluster around the sale date).
      if (t.date && (!g.date || t.date < g.date)) g.date = t.date;
    }
    const groups = [];
    for (const g of map.values()) {
      if (!g.description) g.description = g.rows[0]?.description || 'Sale';
      g.totalExpenses = g.fees + g.adfee + g.shipping + g.otherExpense;
      g.totalIncome   = g.income + g.otherIncome;
      g.net           = Math.round((g.totalIncome - g.totalExpenses) * 100) / 100;
      groups.push(g);
    }
    const orphanItems = orphans.map((t) => ({ kind: 'orphan', date: t.date, tx: t }));
    return [...groups, ...orphanItems].sort((a, b) => {
      const da = a.kind === 'group' ? a.date : a.tx.date;
      const db = b.kind === 'group' ? b.date : b.tx.date;
      return (db || '').localeCompare(da || '');
    });
  }, [filtered]);

  const flatItems = filtered;
  const items     = viewMode === 'grouped' ? grouped : flatItems;
  const { page, pageItems, totalPages, next, prev, setPage } = usePagination(items, PG_SIZE);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        <div className="flex rounded-lg border border-border overflow-hidden text-sm">
          {['all','income','expense'].map(t => (
            <button key={t} onClick={() => { setTypeFilter(t); setCatFilter(''); }}
              className={`px-3 py-1.5 font-medium capitalize transition-colors
                ${typeFilter === t ? 'bg-primary text-white' : 'text-fg-muted hover:bg-muted/40'}`}>
              {t}
            </button>
          ))}
        </div>
        <Select value={catFilter} onChange={e => setCatFilter(e.target.value)} className="min-w-40">
          <option value="">All categories</option>
          {allCats.map(c => <option key={c}>{c}</option>)}
        </Select>
        <Select value={monthFilter} onChange={e => setMonthFilter(e.target.value)} className="min-w-32">
          <option value="">All months</option>
          {months.map(m => <option key={m} value={m}>{m}</option>)}
        </Select>
        <input type="text" placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)}
          className="border border-border rounded-lg px-3 py-1.5 text-sm flex-1 min-w-36 focus:outline-none focus:ring-2 focus:ring-secondary/30" />
        {/* View mode toggle */}
        <div className="flex rounded-lg border border-border overflow-hidden text-sm">
          {[
            { id: 'flat',    label: 'Flat'    },
            { id: 'grouped', label: 'Grouped' },
          ].map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setViewMode(m.id)}
              className={`px-3 py-1.5 font-medium transition-colors
                ${viewMode === m.id ? 'bg-primary text-white' : 'text-fg-muted hover:bg-muted/40'}`}
              title={m.id === 'grouped'
                ? 'Group each sale\'s auto rows (income + fees + ad fee + label) into one row'
                : 'Show every transaction as a separate row'}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="No transactions match these filters"
          description={transactions.length === 0
            ? "Add your first transaction or import eBay orders to get started."
            : "Try widening the date range, clearing filters, or searching a different term."}
          action={transactions.length === 0 ? onAdd : undefined}
          actionLabel={transactions.length === 0 ? 'Add a transaction' : undefined}
        />
      ) : viewMode === 'grouped' ? (
        <div className="bg-surface rounded-xl border border-border-subtle shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-subtle bg-muted/40 text-[10px] font-semibold text-fg-muted uppercase tracking-wider">
                <th className="px-3 py-1.5 text-left">Date</th>
                <th className="px-3 py-1.5 text-left">Item / Description</th>
                <th className="px-3 py-1.5 text-right">Income</th>
                <th className="px-3 py-1.5 text-right">Fees</th>
                <th className="px-3 py-1.5 text-right">Ad fee</th>
                <th className="px-3 py-1.5 text-right">Label</th>
                <th className="px-3 py-1.5 text-right">Net</th>
                <th className="px-3 py-1.5 text-right w-12"></th>
              </tr>
            </thead>
            <tbody>
              {pageItems.map((g, i) => {
                if (g.kind === 'orphan') {
                  // Manual / CSV / one-off transactions — render as a single
                  // line so they're visible alongside grouped sales.
                  const t = g.tx;
                  return (
                    <tr
                      key={`orphan-${t.id}`}
                      onClick={() => setDetailTx(t)}
                      className={`group cursor-pointer transition-colors ${i % 2 === 0 ? 'bg-surface' : 'bg-muted/40'} hover:bg-accent-subtle/30`}
                    >
                      <td className="px-3 py-1.5 text-fg-muted font-mono text-xs whitespace-nowrap">{t.date}</td>
                      <td className="px-3 py-1.5 text-fg max-w-xs">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="truncate">{t.description}</span>
                          <span className="text-[10px] bg-muted text-fg-muted rounded px-1">{t.category}</span>
                          {t.source === 'manual'      && <span className="text-[10px] bg-muted text-fg rounded px-1">manual</span>}
                          {t.source === 'csv_import'  && <span className="text-[10px] bg-accent/10 text-accent rounded px-1">csv</span>}
                          {t.source === 'ebay_import' && <span className="text-[10px] bg-secondary/10 text-secondary rounded px-1">eBay</span>}
                        </div>
                      </td>
                      <td className={`px-3 py-1.5 text-right font-mono text-sm tabular-nums ${t.type === 'income' ? 'text-success font-semibold' : 'text-fg-subtle'}`}>
                        {t.type === 'income' ? `+${fmt(t.amount)}` : '—'}
                      </td>
                      <td className="px-3 py-1.5 text-right text-fg-subtle">—</td>
                      <td className="px-3 py-1.5 text-right text-fg-subtle">—</td>
                      <td className="px-3 py-1.5 text-right text-fg-subtle">—</td>
                      <td className={`px-3 py-1.5 text-right font-mono text-sm font-semibold tabular-nums ${t.type === 'income' ? 'text-success' : 'text-danger'}`}>
                        {t.type === 'income' ? '+' : '−'}{fmt(t.amount)}
                      </td>
                      <td className="px-3 py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          <button onClick={() => onEdit(t)} className="p-1 text-fg-subtle hover:text-secondary rounded" title="Edit">
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          {deleteConfirmId === t.id ? (
                            <span className="flex items-center gap-1">
                              <button onClick={() => { onDelete(t.id); setDeleteConfirmId(null); }} className="px-1.5 py-0.5 text-xs bg-danger text-white rounded hover:bg-danger/90">
                                Yes
                              </button>
                              <button onClick={() => setDeleteConfirmId(null)} className="px-1.5 py-0.5 text-xs border border-border text-fg-muted rounded hover:bg-muted/40">
                                No
                              </button>
                            </span>
                          ) : (
                            <button onClick={() => setDeleteConfirmId(t.id)} className="p-1 text-fg-subtle hover:text-danger rounded" title="Delete">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                }
                // Grouped sale: one summary row, click to expand the
                // underlying auto rows so the user can verify each piece.
                const isOpen = expandedGroup === g.anchor;
                return (
                  <React.Fragment key={`grp-${g.anchor}`}>
                    <tr
                      onClick={() => setExpandedGroup(isOpen ? null : g.anchor)}
                      className={`group cursor-pointer transition-colors ${i % 2 === 0 ? 'bg-surface' : 'bg-muted/40'} hover:bg-accent-subtle/30`}
                    >
                      <td className="px-3 py-1.5 text-fg-muted font-mono text-xs whitespace-nowrap">
                        <span className="inline-flex items-center gap-1">
                          {isOpen ? <ChevronLeft size={11} className="rotate-90" /> : <ChevronRight size={11} />}
                          {g.date}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-fg max-w-xs">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="truncate">{g.description}</span>
                          {g.sku && (
                            <span className="text-[10px] font-mono bg-muted/60 text-fg-muted border border-border-subtle rounded px-1 inline-flex items-center gap-0.5">
                              <Tag className="size-2" /> {g.sku}
                            </span>
                          )}
                          <span className="text-[10px] bg-accent-subtle text-accent rounded px-1">
                            {g.rows.length} rows
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-sm font-semibold tabular-nums text-success">
                        {g.totalIncome > 0 ? `+${fmt(g.totalIncome)}` : '—'}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-xs tabular-nums text-danger">
                        {g.fees > 0 ? `−${fmt(g.fees)}` : '—'}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-xs tabular-nums text-danger">
                        {g.adfee > 0 ? `−${fmt(g.adfee)}` : '—'}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-xs tabular-nums text-danger">
                        {g.shipping > 0 ? `−${fmt(g.shipping)}` : '—'}
                      </td>
                      <td className={`px-3 py-1.5 text-right font-mono text-sm font-bold tabular-nums ${g.net >= 0 ? 'text-success' : 'text-danger'}`}>
                        {g.net >= 0 ? '+' : '−'}{fmt(Math.abs(g.net))}
                      </td>
                      <td className="px-3 py-1.5"></td>
                    </tr>
                    {isOpen && g.rows.sort((a, b) => (a.source || '').localeCompare(b.source || '')).map((r) => (
                      <tr key={`grp-${g.anchor}-${r.id}`} className="bg-subtle/70 text-[12px]">
                        <td className="pl-8 pr-3 py-1 text-fg-subtle font-mono text-[10px]">↳ {r.source || 'manual'}</td>
                        <td className="px-3 py-1 text-fg-muted">
                          <span className="truncate">{r.description}</span>
                          {r.notes && <span className="block text-[10px] text-fg-subtle truncate italic">{r.notes}</span>}
                        </td>
                        <td className="px-3 py-1 text-right font-mono text-fg-subtle tabular-nums">
                          {r.type === 'income' ? `+${fmt(r.amount)}` : ''}
                        </td>
                        <td className="px-3 py-1 text-right font-mono text-fg-subtle tabular-nums">
                          {r.source === 'auto_fees' ? `−${fmt(r.amount)}` : ''}
                        </td>
                        <td className="px-3 py-1 text-right font-mono text-fg-subtle tabular-nums">
                          {r.source === 'auto_adfee' ? `−${fmt(r.amount)}` : ''}
                        </td>
                        <td className="px-3 py-1 text-right font-mono text-fg-subtle tabular-nums">
                          {r.source === 'auto_shipping' ? `−${fmt(r.amount)}` : ''}
                        </td>
                        <td className="px-3 py-1"></td>
                        <td className="px-3 py-1 text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1">
                            <button onClick={() => onEdit(r)} className="p-1 text-fg-subtle hover:text-secondary rounded" title="Edit">
                              <Edit2 className="w-3 h-3" />
                            </button>
                            <button onClick={() => setDetailTx(r)} className="p-1 text-fg-subtle hover:text-secondary rounded" title="View detail">
                              <Search className="w-3 h-3" />
                            </button>
                            {deleteConfirmId === r.id ? (
                              <span className="flex items-center gap-1 ml-1">
                                <button onClick={() => { onDelete(r.id); setDeleteConfirmId(null); }} className="px-1.5 py-0.5 text-[10px] bg-danger text-white rounded hover:bg-danger/90">
                                  Yes
                                </button>
                                <button onClick={() => setDeleteConfirmId(null)} className="px-1.5 py-0.5 text-[10px] border border-border text-fg-muted rounded hover:bg-muted/40">
                                  No
                                </button>
                              </span>
                            ) : (
                              <button onClick={() => setDeleteConfirmId(r.id)} className="p-1 text-fg-subtle hover:text-danger rounded" title="Delete this row">
                                <Trash2 className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {isOpen && g.rows.length > 1 && (
                      <tr className="bg-muted/70 text-[11px]">
                        <td colSpan={7} className="px-3 py-1.5 text-right text-fg-muted">
                          Delete this entire sale group ({g.rows.length} row{g.rows.length !== 1 ? 's' : ''})?
                        </td>
                        <td className="px-3 py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                          {deleteConfirmId === `grp-${g.anchor}` ? (
                            <span className="inline-flex items-center gap-1">
                              <button
                                onClick={() => {
                                  for (const r of g.rows) onDelete(r.id);
                                  setDeleteConfirmId(null);
                                  setExpandedGroup(null);
                                }}
                                className="px-2 py-0.5 text-[11px] bg-danger text-white rounded hover:bg-danger/90"
                              >
                                Confirm
                              </button>
                              <button onClick={() => setDeleteConfirmId(null)} className="px-2 py-0.5 text-[11px] border border-border text-fg-muted rounded hover:bg-muted/40">
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <button
                              onClick={() => setDeleteConfirmId(`grp-${g.anchor}`)}
                              className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] text-danger border border-danger/40 rounded hover:bg-danger/5"
                              title="Delete every row in this sale group"
                            >
                              <Trash2 className="w-3 h-3" /> Delete group
                            </button>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
          <div className="px-4 py-2 border-t border-border-subtle flex items-center justify-between text-xs text-fg-muted">
            <span>{items.length} entr{items.length !== 1 ? 'ies' : 'y'} ({filtered.length} underlying transaction{filtered.length !== 1 ? 's' : ''}){totalPages > 1 ? ` · page ${page + 1} of ${totalPages}` : ''}</span>
            {totalPages > 1 && (
              <div className="flex items-center gap-1">
                <button onClick={prev} disabled={page === 0} className="p-1 rounded hover:bg-muted disabled:opacity-30"><ChevronLeft size={14} /></button>
                {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                  let p = i;
                  if (totalPages > 7) {
                    if (page < 4) p = i;
                    else if (page > totalPages - 5) p = totalPages - 7 + i;
                    else p = page - 3 + i;
                  }
                  return (
                    <button key={p} onClick={() => setPage(p)} className={`w-6 h-6 rounded text-xs font-medium ${p === page ? 'bg-primary text-white' : 'hover:bg-muted text-fg-muted'}`}>
                      {p + 1}
                    </button>
                  );
                })}
                <button onClick={next} disabled={page >= totalPages - 1} className="p-1 rounded hover:bg-muted disabled:opacity-30"><ChevronRight size={14} /></button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="bg-surface rounded-xl border border-border-subtle shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-subtle bg-muted/40 text-[10px] font-semibold text-fg-muted uppercase tracking-wider">
                <th className="px-3 py-1.5 text-left">Date</th>
                <th className="px-3 py-1.5 text-left">Description</th>
                <th className="px-3 py-1.5 text-left">Supplier</th>
                <th className="px-3 py-1.5 text-left">Category</th>
                <th className="px-3 py-1.5 text-right">Amount</th>
                <th className="px-3 py-1.5 text-right w-16"></th>
              </tr>
            </thead>
            <tbody>
              {pageItems.map((t, i) => (
                <tr
                  key={t.id}
                  onClick={() => setDetailTx(t)}
                  className={`group cursor-pointer transition-colors ${i % 2 === 0 ? 'bg-surface' : 'bg-muted/40'} hover:bg-accent-subtle/30`}
                  title="Click for full details"
                >
                  <td className="px-3 py-1.5 text-fg-muted font-mono text-xs whitespace-nowrap">{t.date}</td>
                  <td className="px-3 py-1.5 text-fg max-w-xs">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="truncate">{t.description}</span>
                      {t.sku && (
                        <span
                          className="text-[10px] font-mono bg-muted/60 text-fg-muted border border-border-subtle rounded px-1 inline-flex items-center gap-0.5"
                          title={`SKU: ${t.sku}`}
                        >
                          <Tag className="size-2" /> {t.sku}
                        </span>
                      )}
                      {t.paymentMethod && <span className="text-[10px] bg-muted text-fg-muted rounded px-1">{t.paymentMethod}</span>}
                      {t.source === 'ebay_import' && <span className="text-[10px] bg-secondary/10 text-secondary rounded px-1">eBay</span>}
                      {t.source === 'csv_import'  && <span className="text-[10px] bg-accent/10 text-accent rounded px-1">CSV</span>}
                      {(t.source === 'auto_sale' || t.source === 'auto_fees' || t.source === 'auto_shipping') && (
                        <span className="text-[10px] bg-accent-subtle text-accent rounded px-1 inline-flex items-center gap-0.5">
                          <Tag className="size-2" /> auto
                        </span>
                      )}
                    </div>
                    {t.notes && <span className="block text-[11px] text-fg-muted truncate">{t.notes}</span>}
                  </td>
                  <td className="px-3 py-1.5 text-fg-muted text-xs">{t.supplier || <span className="text-fg-subtle">—</span>}</td>
                  <td className="px-3 py-1.5 text-fg-muted text-xs">{t.category}</td>
                  <td className={`px-3 py-1.5 text-right font-mono text-sm font-semibold tabular-nums ${t.type === 'income' ? 'text-success' : 'text-danger'}`}>
                    {t.type === 'income' ? '+' : '−'}{fmt(t.amount)}
                  </td>
                  <td className="px-3 py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => onEdit(t)} className="p-1 text-fg-subtle hover:text-secondary rounded" title="Edit">
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      {deleteConfirmId === t.id ? (
                        <span className="flex items-center gap-1">
                          <button onClick={() => { onDelete(t.id); setDeleteConfirmId(null); }} className="px-1.5 py-0.5 text-xs bg-danger text-white rounded hover:bg-danger/90 transition-colors">
                            Yes
                          </button>
                          <button onClick={() => setDeleteConfirmId(null)} className="px-1.5 py-0.5 text-xs border border-border text-fg-muted rounded hover:bg-muted/40 transition-colors">
                            No
                          </button>
                        </span>
                      ) : (
                        <button onClick={() => setDeleteConfirmId(t.id)} className="p-1 text-fg-subtle hover:text-danger rounded" title="Delete">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-4 py-2 border-t border-border-subtle flex items-center justify-between text-xs text-fg-muted">
            <span>{filtered.length} transaction{filtered.length !== 1 ? 's' : ''}{filtered.length > PG_SIZE ? ` (page ${page + 1} of ${totalPages})` : ''}</span>
            {totalPages > 1 && (
              <div className="flex items-center gap-1">
                <button onClick={prev} disabled={page === 0}
                  className="p-1 rounded hover:bg-muted disabled:opacity-30"><ChevronLeft size={14} /></button>
                {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                  let p = i;
                  if (totalPages > 7) {
                    if (page < 4) p = i;
                    else if (page > totalPages - 5) p = totalPages - 7 + i;
                    else p = page - 3 + i;
                  }
                  return (
                    <button key={p} onClick={() => setPage(p)}
                      className={`w-6 h-6 rounded text-xs font-medium ${p === page ? 'bg-primary text-white' : 'hover:bg-muted text-fg-muted'}`}>
                      {p + 1}
                    </button>
                  );
                })}
                <button onClick={next} disabled={page >= totalPages - 1}
                  className="p-1 rounded hover:bg-muted disabled:opacity-30"><ChevronRight size={14} /></button>
              </div>
            )}
          </div>
        </div>
      )}

      <TransactionDetailModal
        tx={detailTx}
        transactions={transactions}
        lots={lots}
        onClose={() => setDetailTx(null)}
        onEdit={onEdit}
        onDelete={onDelete}
      />
    </div>
  );
}

// ─── Reports Tab ──────────────────────────────────────────────────────────────

function ReportsTab({ transactions, year }) {
  const yearly = transactions.filter(t => t.date.startsWith(String(year)));

  // Monthly P&L table
  const monthlyRows = MONTHS.map((month, i) => {
    const pfx = `${year}-${String(i + 1).padStart(2, '0')}`;
    const inc = yearly.filter(t => t.type === 'income'  && t.date.startsWith(pfx)).reduce((s, t) => s + t.amount, 0);
    const exp = yearly.filter(t => t.type === 'expense' && t.date.startsWith(pfx)).reduce((s, t) => s + t.amount, 0);
    return { month, income: inc, expenses: exp, net: inc - exp };
  });

  // Cumulative series for top-of-card sparklines
  const incSeries = monthlyRows.map(r => r.income);
  const expSeries = monthlyRows.map(r => r.expenses);
  const netSeries = monthlyRows.map(r => r.net);
  let cumNet = 0;
  const cumNetSeries = monthlyRows.map(r => (cumNet += r.net, cumNet));

  // Schedule C summary
  const schedCMap = {};
  yearly.filter(t => t.type === 'expense').forEach(t => {
    const line = SCHED_C[t.category] || 'Line 27a – Other Expenses';
    schedCMap[line] = (schedCMap[line] || 0) + t.amount;
  });
  const schedCRows = Object.entries(schedCMap).sort((a, b) => b[1] - a[1]);

  const totalIncome   = yearly.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const totalExpenses = yearly.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  const netProfit     = totalIncome - totalExpenses;

  return (
    <div className="space-y-6">
      {/* Monthly P&L */}
      <div className="bg-surface rounded-xl shadow-sm border border-border-subtle overflow-hidden">
        <div className="px-5 py-4 border-b border-border-subtle">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <h3 className="font-semibold text-fg">Monthly P&L — {year}</h3>
            <div className="flex items-center gap-4 flex-wrap">
              <div className="flex items-center gap-1.5">
                <Sparkline data={incSeries} color="var(--success)" width={56} height={18} />
                <span className="text-[10px] uppercase tracking-wider text-fg-muted font-semibold">Income</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Sparkline data={expSeries} color="var(--danger)" width={56} height={18} />
                <span className="text-[10px] uppercase tracking-wider text-fg-muted font-semibold">Expenses</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Sparkline data={cumNetSeries} color="var(--accent)" width={56} height={18} />
                <span className="text-[10px] uppercase tracking-wider text-fg-muted font-semibold">Cumulative</span>
              </div>
            </div>
          </div>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/40 border-b border-border-subtle text-xs font-semibold text-fg-muted uppercase tracking-wide">
              <th className="px-4 py-3 text-left">Month</th>
              <th className="px-4 py-3 text-right">Income</th>
              <th className="px-4 py-3 text-right">Expenses</th>
              <th className="px-4 py-3 text-right">Net</th>
            </tr>
          </thead>
          <tbody>
            {monthlyRows.map((r, i) => (
              <tr key={r.month} className={i % 2 === 0 ? 'bg-surface' : 'bg-muted/40'}>
                <td className="px-4 py-2.5 font-medium text-fg">{r.month}</td>
                <td className="px-4 py-2.5 text-right font-mono text-success">{r.income > 0 ? fmt(r.income) : '—'}</td>
                <td className="px-4 py-2.5 text-right font-mono text-danger">{r.expenses > 0 ? fmt(r.expenses) : '—'}</td>
                <td className={`px-4 py-2.5 text-right font-mono font-semibold ${profitCls(r.net)}`}>
                  {r.income > 0 || r.expenses > 0 ? fmt(r.net) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-border bg-muted font-semibold">
              <td className="px-4 py-3 text-fg">Total</td>
              <td className="px-4 py-3 text-right font-mono text-success">{fmt(totalIncome)}</td>
              <td className="px-4 py-3 text-right font-mono text-danger">{fmt(totalExpenses)}</td>
              <td className={`px-4 py-3 text-right font-mono ${profitCls(netProfit)}`}>{fmt(netProfit)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Schedule C summary */}
      {schedCRows.length > 0 && (
        <div className="bg-surface rounded-xl shadow-sm border border-border-subtle overflow-hidden">
          <div className="px-5 py-4 border-b border-border-subtle">
            <h3 className="font-semibold text-fg">Schedule C — Expense Summary</h3>
            <p className="text-xs text-fg-muted mt-0.5">Approximate line mapping for your tax preparer. Not a substitute for professional advice.</p>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/40 border-b border-border-subtle text-xs font-semibold text-fg-muted uppercase tracking-wide">
                <th className="px-4 py-3 text-left">Schedule C Line</th>
                <th className="px-4 py-3 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {schedCRows.map(([line, amt], i) => (
                <tr key={line} className={i % 2 === 0 ? 'bg-surface' : 'bg-muted/40'}>
                  <td className="px-4 py-2.5 text-fg">{line}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-danger">{fmt(amt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Tax Tab ──────────────────────────────────────────────────────────────────

function TaxTab({ transactions, year }) {
  const yearly    = transactions.filter(t => t.date.startsWith(String(year)));
  const income    = yearly.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const expenses  = yearly.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  const netProfit = income - expenses;
  const tax       = estimateTax(netProfit, year);

  const currentMonth = new Date().getFullYear() === year ? new Date().getMonth() + 1 : 12;
  const dueQ = [
    { q: 'Q1', due: `${year}-04-15`, months: [1,2,3] },
    { q: 'Q2', due: `${year}-06-17`, months: [4,5,6] },
    { q: 'Q3', due: `${year}-09-16`, months: [7,8,9] },
    { q: 'Q4', due: `${year+1}-01-15`, months: [10,11,12] },
  ];

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="bg-warning-subtle border border-warning/30 rounded-xl px-5 py-4 text-sm text-warning">
        <strong>Estimate only.</strong> Uses {tax.year} federal brackets + standard deduction for a single filer with no other income. Consult a tax professional for your actual liability.
      </div>

      {/* P&L summary */}
      <div className="bg-surface rounded-xl shadow-sm border border-border-subtle p-5 space-y-3">
        <h3 className="font-semibold text-fg">Business Summary — {year}</h3>
        {[
          { label: 'Gross Revenue',          value: income,                cls: 'text-success' },
          { label: 'Total Expenses (COGS + OpEx)', value: expenses,        cls: 'text-danger'  },
          { label: 'Net Profit (Schedule C Line 31)', value: netProfit,    cls: profitCls(netProfit) },
        ].map(({ label, value, cls }) => (
          <div key={label} className="flex justify-between items-center border-b border-border-subtle pb-2 last:border-0 last:pb-0">
            <span className="text-sm text-fg-muted">{label}</span>
            <span className={`font-mono font-semibold ${cls}`}>{fmt(value)}</span>
          </div>
        ))}
      </div>

      {/* Tax estimate */}
      {netProfit > 0 && (
        <div className="bg-surface rounded-xl shadow-sm border border-border-subtle p-5 space-y-3">
          <h3 className="font-semibold text-fg">Estimated Tax Liability</h3>
          {[
            { label: 'Self-Employment Tax (15.3%)',   value: tax.seTax     },
            { label: 'Estimated Federal Income Tax',  value: tax.incomeTax },
            { label: 'Total Estimated Tax',           value: tax.total,  bold: true },
            { label: 'Quarterly Payment (÷ 4)',        value: tax.quarterly, accent: true },
          ].map(({ label, value, bold, accent }) => (
            <div key={label} className={`flex justify-between items-center border-b border-border-subtle pb-2 last:border-0 last:pb-0 ${bold ? 'pt-1' : ''}`}>
              <span className={`text-sm ${bold ? 'font-semibold text-fg' : 'text-fg-muted'}`}>{label}</span>
              <span className={`font-mono font-semibold ${accent ? 'text-accent text-lg' : bold ? 'text-danger' : 'text-fg'}`}>{fmt(value)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Quarterly due dates */}
      <div className="bg-surface rounded-xl shadow-sm border border-border-subtle p-5">
        <h3 className="font-semibold text-fg mb-3">Quarterly Due Dates — {year}</h3>
        <div className="grid grid-cols-2 gap-3">
          {dueQ.map(({ q, due, months }) => {
            const isPast    = new Date(due) < new Date();
            const isCurrent = months.includes(currentMonth);
            return (
              <div key={q} className={`rounded-lg px-4 py-3 border ${isCurrent ? 'border-accent bg-accent/5' : 'border-border-subtle bg-muted/40'}`}>
                <p className={`text-xs font-semibold uppercase tracking-wide ${isCurrent ? 'text-accent' : 'text-fg-muted'}`}>{q}</p>
                <p className={`text-sm font-mono font-bold mt-0.5 ${isPast ? 'text-fg-muted line-through' : 'text-fg'}`}>{due}</p>
                <p className="text-xs text-fg-muted mt-0.5">{fmt(tax.quarterly)} due</p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Cash Flow Tab ────────────────────────────────────────────────────────────

function CashFlowTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-surface border border-border rounded-lg shadow-lg px-3 py-2.5 text-xs space-y-1 min-w-[160px]">
      <p className="font-semibold text-fg mb-1">{label}</p>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex justify-between gap-4">
          <span style={{ color: p.color }}>{p.name}</span>
          <span className="font-mono font-semibold" style={{ color: p.color }}>{fmt(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

function CashFlowTab({ transactions, year }) {
  const yearly = useMemo(
    () => transactions.filter((t) => t.date.startsWith(String(year))),
    [transactions, year],
  );

  // Build month-by-month rows with running balance
  const rows = useMemo(() => {
    let runningBalance = 0;
    return MONTHS.map((month, i) => {
      const pfx     = `${year}-${String(i + 1).padStart(2, '0')}`;
      const inflow  = yearly.filter((t) => t.type === 'income'  && t.date.startsWith(pfx)).reduce((s, t) => s + t.amount, 0);
      const outflow = yearly.filter((t) => t.type === 'expense' && t.date.startsWith(pfx)).reduce((s, t) => s + t.amount, 0);
      const net     = inflow - outflow;
      runningBalance += net;
      return {
        month,
        inflow:  Math.round(inflow  * 100) / 100,
        outflow: Math.round(outflow * 100) / 100,
        net:     Math.round(net     * 100) / 100,
        balance: Math.round(runningBalance * 100) / 100,
        hasData: inflow > 0 || outflow > 0,
      };
    });
  }, [yearly, year]);

  const totalInflow  = rows.reduce((s, r) => s + r.inflow,  0);
  const totalOutflow = rows.reduce((s, r) => s + r.outflow, 0);
  const netCash      = totalInflow - totalOutflow;
  const activeMonths = rows.filter((r) => r.hasData).length || 1;
  const avgMonthNet  = netCash / activeMonths;

  const hasAnyData = rows.some((r) => r.hasData);

  // Category-level breakdown for inflows and outflows
  const inflowByCategory = useMemo(() => {
    const map = {};
    yearly.filter((t) => t.type === 'income').forEach((t) => {
      map[t.category] = (map[t.category] || 0) + t.amount;
    });
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  }, [yearly]);

  const outflowByCategory = useMemo(() => {
    const map = {};
    yearly.filter((t) => t.type === 'expense').forEach((t) => {
      map[t.category] = (map[t.category] || 0) + t.amount;
    });
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  }, [yearly]);

  return (
    <div className="space-y-6">
      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          {
            label: 'Total Inflows',
            value: totalInflow,
            intent: 'success',
            sub: `${year} YTD`,
            spark: rows.map(r => r.inflow),
          },
          {
            label: 'Total Outflows',
            value: totalOutflow,
            intent: 'danger',
            sub: `${year} YTD`,
            spark: rows.map(r => r.outflow),
          },
          {
            label: 'Net Cash Flow',
            value: netCash,
            intent: netCash >= 0 ? 'success' : 'danger',
            sub: 'Running balance',
            spark: rows.map(r => r.balance),
          },
          {
            label: 'Avg Monthly Net',
            value: avgMonthNet,
            intent: avgMonthNet >= 0 ? 'success' : 'danger',
            sub: `Over ${activeMonths} active month${activeMonths !== 1 ? 's' : ''}`,
            spark: rows.map(r => r.net),
          },
        ].map(({ label, value, intent, sub, spark }, i) => (
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
                sub={sub}
              />
            </Card>
          </motion.div>
        ))}
      </div>

      {/* Combined inflow/outflow bars + cumulative balance line */}
      <div className="bg-surface rounded-xl p-5 shadow-sm border border-border-subtle">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-fg">Cash Flow — {year}</h3>
          <div className="flex items-center gap-4 text-xs text-fg-muted">
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-success/70 inline-block" /> Inflow</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-danger/70 inline-block" /> Outflow</span>
            <span className="flex items-center gap-1.5"><span className="w-5 h-0.5 bg-primary inline-block" /> Balance</span>
          </div>
        </div>
        {hasAnyData ? (
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={rows} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis
                yAxisId="bars"
                tick={{ fontSize: 11 }}
                tickFormatter={(v) => '$' + (Math.abs(v) >= 1000 ? (v / 1000).toFixed(0) + 'k' : v)}
              />
              <YAxis
                yAxisId="line"
                orientation="right"
                tick={{ fontSize: 11 }}
                tickFormatter={(v) => '$' + (Math.abs(v) >= 1000 ? (v / 1000).toFixed(0) + 'k' : v)}
              />
              <Tooltip content={<CashFlowTooltip />} />
              <ReferenceLine yAxisId="bars" y={0} stroke="var(--fg-subtle)" strokeWidth={1} />
              <Bar yAxisId="bars" dataKey="inflow"  name="Inflow"   fill="var(--success)" fillOpacity={0.75} radius={[3,3,0,0]} />
              <Bar yAxisId="bars" dataKey="outflow" name="Outflow"  fill="var(--danger)" fillOpacity={0.75} radius={[3,3,0,0]} />
              <Line
                yAxisId="line"
                type="monotone"
                dataKey="balance"
                name="Cumulative Balance"
                stroke="var(--accent)"
                strokeWidth={2.5}
                dot={{ r: 3, fill: 'var(--accent)', strokeWidth: 0 }}
                activeDot={{ r: 5 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <EmptyState
            icon={TrendingUp}
            title={`No cash flow yet for ${year}`}
            description="Income and expenses will populate this chart as transactions are logged."
          />
        )}
      </div>

      {/* Net cash per month — waterfall-style area */}
      <div className="bg-surface rounded-xl p-5 shadow-sm border border-border-subtle">
        <h3 className="text-sm font-semibold text-fg mb-4">Monthly Net Cash Flow</h3>
        {hasAnyData ? (
          <ResponsiveContainer width="100%" height={180}>
            <ComposedChart data={rows} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis
                tick={{ fontSize: 11 }}
                tickFormatter={(v) => '$' + (Math.abs(v) >= 1000 ? (v / 1000).toFixed(0) + 'k' : v)}
              />
              <Tooltip content={<CashFlowTooltip />} />
              <ReferenceLine y={0} stroke="var(--fg-subtle)" strokeDasharray="4 2" strokeWidth={1} />
              <Bar
                dataKey="net"
                name="Net"
                radius={[3, 3, 0, 0]}
                // Colour each bar based on sign
                fill="var(--success)"
              >
                {rows.map((r, i) => (
                  <Cell key={i} fill={r.net >= 0 ? 'var(--success)' : 'var(--danger)'} fillOpacity={0.8} />
                ))}
              </Bar>
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <div className="text-center py-12 px-6">
            <div className="size-10 rounded-xl bg-muted flex items-center justify-center mx-auto mb-2">
              <Calendar className="size-4 text-fg-muted" />
            </div>
            <p className="text-sm font-medium text-fg">No activity in this window</p>
            <p className="text-xs text-fg-muted mt-1">Transactions in the selected date range will show here.</p>
          </div>
        )}
      </div>

      {/* Running balance table + category breakdown side-by-side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Running balance table */}
        <div className="bg-surface rounded-xl shadow-sm border border-border-subtle overflow-hidden">
          <div className="px-5 py-4 border-b border-border-subtle">
            <h3 className="text-sm font-semibold text-fg">Running Balance — {year}</h3>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/40 border-b border-border-subtle text-xs font-semibold text-fg-muted uppercase tracking-wide">
                <th className="px-4 py-2.5 text-left">Month</th>
                <th className="px-4 py-2.5 text-right">In</th>
                <th className="px-4 py-2.5 text-right">Out</th>
                <th className="px-4 py-2.5 text-right">Net</th>
                <th className="px-4 py-2.5 text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={r.month}
                  className={`${!r.hasData ? 'opacity-30' : ''} ${i % 2 === 0 ? 'bg-surface' : 'bg-muted/40'}`}
                >
                  <td className="px-4 py-2 font-medium text-fg">{r.month}</td>
                  <td className="px-4 py-2 text-right font-mono text-success text-xs">{r.inflow > 0 ? fmt(r.inflow) : '—'}</td>
                  <td className="px-4 py-2 text-right font-mono text-danger text-xs">{r.outflow > 0 ? fmt(r.outflow) : '—'}</td>
                  <td className={`px-4 py-2 text-right font-mono text-xs font-semibold ${r.hasData ? profitCls(r.net) : ''}`}>
                    {r.hasData ? fmt(r.net) : '—'}
                  </td>
                  <td className={`px-4 py-2 text-right font-mono text-xs font-bold ${profitCls(r.balance)}`}>
                    {r.hasData || r.balance !== 0 ? fmt(r.balance) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-border bg-muted font-semibold">
                <td className="px-4 py-2.5 text-fg text-sm">Total</td>
                <td className="px-4 py-2.5 text-right font-mono text-success text-xs">{fmt(totalInflow)}</td>
                <td className="px-4 py-2.5 text-right font-mono text-danger text-xs">{fmt(totalOutflow)}</td>
                <td className={`px-4 py-2.5 text-right font-mono text-xs font-bold ${profitCls(netCash)}`}>{fmt(netCash)}</td>
                <td className="px-4 py-2.5" />
              </tr>
            </tfoot>
          </table>
        </div>

        {/* Category breakdown — inflows + outflows */}
        <div className="space-y-4">
          {/* Inflow sources */}
          <div className="bg-surface rounded-xl shadow-sm border border-border-subtle overflow-hidden">
            <div className="px-5 py-3 border-b border-border-subtle flex items-center justify-between">
              <h3 className="text-sm font-semibold text-fg">Inflow Sources</h3>
              <span className="text-xs text-success font-mono font-semibold">{fmt(totalInflow)}</span>
            </div>
            {inflowByCategory.length === 0 ? (
              <p className="text-xs text-fg-muted px-5 py-4">Nothing here yet — recorded income will show up by category.</p>
            ) : (
              <div className="divide-y divide-border">
                {inflowByCategory.map(([cat, amt], i) => {
                  const pct = totalInflow > 0 ? (amt / totalInflow) * 100 : 0;
                  return (
                    <div key={cat} className="row-hover px-5 py-2.5">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs text-fg font-medium truncate max-w-[180px]">{cat}</span>
                        <span className="text-xs font-mono text-success font-semibold">{fmt(amt)}</span>
                      </div>
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                        <motion.div
                          className="h-full bg-success/60 rounded-full"
                          initial={{ width: 0 }}
                          animate={{ width: `${pct}%` }}
                          transition={{ duration: 0.7, delay: 0.05 + i * 0.03, ease: [0.16, 1, 0.3, 1] }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Outflow destinations */}
          <div className="bg-surface rounded-xl shadow-sm border border-border-subtle overflow-hidden">
            <div className="px-5 py-3 border-b border-border-subtle flex items-center justify-between">
              <h3 className="text-sm font-semibold text-fg">Outflow Destinations</h3>
              <span className="text-xs text-danger font-mono font-semibold">{fmt(totalOutflow)}</span>
            </div>
            {outflowByCategory.length === 0 ? (
              <p className="text-xs text-fg-muted px-5 py-4">Nothing here yet — recorded expenses will show up by category.</p>
            ) : (
              <div className="divide-y divide-border">
                {outflowByCategory.map(([cat, amt], i) => {
                  const pct = totalOutflow > 0 ? (amt / totalOutflow) * 100 : 0;
                  return (
                    <div key={cat} className="row-hover px-5 py-2.5">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs text-fg font-medium truncate max-w-[180px]">{cat}</span>
                        <span className="text-xs font-mono text-danger font-semibold">{fmt(amt)}</span>
                      </div>
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                        <motion.div
                          className="h-full bg-danger/50 rounded-full"
                          initial={{ width: 0 }}
                          animate={{ width: `${pct}%` }}
                          transition={{ duration: 0.7, delay: 0.05 + i * 0.03, ease: [0.16, 1, 0.3, 1] }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Category Manager Modal ───────────────────────────────────────────────────
// Lightweight editor for income/expense category lists. Defaults are baked
// into the code and always show; the user can add custom categories alongside
// them. Defaults can't be removed (prevents the user from accidentally
// orphaning auto-recorded sale rows whose category resolves to "eBay Sales").
function CategoryManagerModal({ incomeCats, expenseCats, onSave, onClose }) {
  const [income, setIncome] = useState(incomeCats);
  const [expense, setExpense] = useState(expenseCats);
  const [newIncome, setNewIncome] = useState('');
  const [newExpense, setNewExpense] = useState('');

  const isDefault = (kind, name) => {
    const base = kind === 'income' ? DEFAULT_INCOME_CATS : DEFAULT_EXPENSE_CATS;
    return base.some(d => d.toLowerCase() === name.toLowerCase());
  };

  const addIncome = () => {
    const v = newIncome.trim();
    if (!v) return;
    if (income.some(c => c.toLowerCase() === v.toLowerCase())) return;
    setIncome([...income, v]);
    setNewIncome('');
  };
  const addExpense = () => {
    const v = newExpense.trim();
    if (!v) return;
    if (expense.some(c => c.toLowerCase() === v.toLowerCase())) return;
    setExpense([...expense, v]);
    setNewExpense('');
  };
  const removeIncome  = (name) => setIncome(income.filter(c => c !== name));
  const removeExpense = (name) => setExpense(expense.filter(c => c !== name));

  return (
    <motion.div {...modalBackdrop} className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
      <motion.div {...modalPanel} onClick={(e) => e.stopPropagation()} className="glossy-elevated w-full max-w-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle flex-shrink-0">
          <div>
            <h3 className="font-semibold text-fg flex items-center gap-2"><Tag className="w-4 h-4 text-accent" /> Manage Bookkeeping Categories</h3>
            <p className="text-[11px] text-fg-muted">Default categories can't be removed — they're load-bearing for auto-recorded rows. Add custom ones below.</p>
          </div>
          <button onClick={onClose} className="p-1 text-fg-subtle hover:text-fg-muted rounded"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-5 overflow-y-auto">
          {/* Income */}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-success mb-2">Income Categories</h4>
            <div className="space-y-1 mb-3 max-h-[40vh] overflow-y-auto">
              {income.map((c) => {
                const locked = isDefault('income', c);
                return (
                  <div key={c} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-md border border-border-subtle bg-muted/30 text-xs">
                    <span className="truncate text-fg">{c}</span>
                    {locked ? (
                      <span className="text-[10px] text-fg-subtle uppercase tracking-wide">default</span>
                    ) : (
                      <button onClick={() => removeIncome(c)} className="text-fg-subtle hover:text-danger" title="Remove">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="flex gap-2">
              <Input
                type="text"
                value={newIncome}
                onChange={(e) => setNewIncome(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addIncome(); } }}
                placeholder="e.g. Etsy Sales"
                className="flex-1"
              />
              <Button type="button" variant="secondary" size="sm" onClick={addIncome}><Plus /> Add</Button>
            </div>
          </div>

          {/* Expense */}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-danger mb-2">Expense Categories</h4>
            <div className="space-y-1 mb-3 max-h-[40vh] overflow-y-auto">
              {expense.map((c) => {
                const locked = isDefault('expense', c);
                return (
                  <div key={c} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-md border border-border-subtle bg-muted/30 text-xs">
                    <span className="truncate text-fg">{c}</span>
                    {locked ? (
                      <span className="text-[10px] text-fg-subtle uppercase tracking-wide">default</span>
                    ) : (
                      <button onClick={() => removeExpense(c)} className="text-fg-subtle hover:text-danger" title="Remove">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="flex gap-2">
              <Input
                type="text"
                value={newExpense}
                onChange={(e) => setNewExpense(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addExpense(); } }}
                placeholder="e.g. Tax Prep Software"
                className="flex-1"
              />
              <Button type="button" variant="secondary" size="sm" onClick={addExpense}><Plus /> Add</Button>
            </div>
          </div>
        </div>
        <div className="flex gap-2 px-5 py-4 border-t border-border-subtle">
          <Button type="button" variant="secondary" onClick={onClose} className="flex-1">Cancel</Button>
          <Button type="button" variant="accent" onClick={() => { onSave(income, expense); onClose(); }} className="flex-1">Save</Button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ─── Lot Purchase Quick-Add Modal ─────────────────────────────────────────────
// Streamlined entry for liquidation lot purchases. Pre-fills category as
// Cost of Goods (Lots) and supplier as Liquidation.com so the user can record
// a lot in two fields (amount + description) without touching the type/category
// dropdowns. Creates the bookkeeping row AND an inventory Lot in one shot so
// the user doesn't have to enter the same purchase twice.
function LotPurchaseModal({ onSave, onClose }) {
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    date: today,
    supplier: 'Liquidation.com',
    customSupplier: '',
    description: '',
    amount: '',
    paymentMethod: 'PayPal Credit Card',
    customPayment: '',
    createInventoryLot: true,
    itemCount: '',
    notes: '',
  });
  const [error, setError] = useState('');

  function upd(k, v) { setForm(f => ({ ...f, [k]: v })); }

  function submit(e) {
    e.preventDefault();
    const amt = parseFloat(form.amount);
    if (!form.description.trim()) { setError('What did you buy? Description is required.'); return; }
    if (isNaN(amt) || amt <= 0) { setError('Enter a purchase amount greater than 0.'); return; }
    setError('');
    const supplier = form.supplier === 'Other' && form.customSupplier ? form.customSupplier : form.supplier;
    const paymentMethod = form.paymentMethod === 'Other' && form.customPayment ? form.customPayment : form.paymentMethod;
    onSave({
      date: form.date,
      type: 'expense',
      category: 'Cost of Goods (Lots)',
      supplier,
      description: form.description,
      amount: amt,
      paymentMethod,
      notes: form.notes,
      createInventoryLot: form.createInventoryLot,
      itemCount: parseInt(form.itemCount) || 0,
    });
  }

  return (
    <motion.div {...modalBackdrop} className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
      <motion.div {...modalPanel} onClick={(e) => e.stopPropagation()} className="glossy-elevated w-full max-w-md flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle flex-shrink-0">
          <div>
            <h3 className="font-semibold text-fg flex items-center gap-2"><Package className="w-4 h-4 text-accent" /> Add Lot Purchase</h3>
            <p className="text-[11px] text-fg-muted">Records a Cost of Goods expense + optionally creates the inventory lot</p>
          </div>
          <button onClick={onClose} className="p-1 text-fg-subtle hover:text-fg-muted rounded"><X className="w-4 h-4" /></button>
        </div>
        <form onSubmit={submit} className="p-5 space-y-3 overflow-y-auto">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Purchase Date</Label>
              <DatePicker value={form.date} onChange={v => upd('date', v)} />
            </div>
            <div>
              <Label>Amount ($)</Label>
              <Input type="number" min="0.01" step="0.01" value={form.amount} onChange={e => upd('amount', e.target.value)} placeholder="0.00" className="font-mono" />
            </div>
          </div>

          <div>
            <Label>Description (e.g. "ThinkPad lot — 10 units")</Label>
            <Input type="text" value={form.description} onChange={e => upd('description', e.target.value)} placeholder="What's in the lot?" autoFocus />
          </div>

          <div>
            <Label>Supplier</Label>
            <Select value={form.supplier} onChange={e => upd('supplier', e.target.value)}>
              {SUPPLIERS.map(s => <option key={s} value={s}>{s}</option>)}
            </Select>
            {form.supplier === 'Other' && (
              <Input className="mt-1.5" type="text" value={form.customSupplier} onChange={e => upd('customSupplier', e.target.value)} placeholder="Type supplier name…" />
            )}
          </div>

          <div>
            <Label>Payment Method</Label>
            <Select value={form.paymentMethod} onChange={e => upd('paymentMethod', e.target.value)}>
              {PAYMENT_METHODS.map(p => <option key={p} value={p}>{p}</option>)}
            </Select>
            {form.paymentMethod === 'Other' && (
              <Input className="mt-1.5" type="text" value={form.customPayment} onChange={e => upd('customPayment', e.target.value)} placeholder="Type payment method…" />
            )}
          </div>

          <div className="rounded-lg border border-border-subtle bg-muted/30 p-3 space-y-2">
            <label className="flex items-start gap-2 text-xs cursor-pointer">
              <input type="checkbox" checked={form.createInventoryLot} onChange={e => upd('createInventoryLot', e.target.checked)} className="mt-0.5" />
              <span>
                <span className="block font-medium text-fg">Also create inventory lot</span>
                <span className="block text-[10px] text-fg-subtle">Adds an empty lot you can populate later from Inventory or the Won Lot Importer.</span>
              </span>
            </label>
            {form.createInventoryLot && (
              <div>
                <Label>Item Count (optional)</Label>
                <Input type="number" min="0" step="1" value={form.itemCount} onChange={e => upd('itemCount', e.target.value)} placeholder="How many units?" className="font-mono" />
              </div>
            )}
          </div>

          <div>
            <Label>Notes (optional)</Label>
            <Input type="text" value={form.notes} onChange={e => upd('notes', e.target.value)} placeholder="Auction ID, manifest link, etc." />
          </div>

          {error && (
            <div className="text-xs font-medium text-danger bg-danger-subtle border border-danger/20 rounded-md px-3 py-1.5">
              {error}
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={onClose} className="flex-1">Cancel</Button>
            <Button type="submit" variant="accent" className="flex-1">Record Purchase</Button>
          </div>
        </form>
      </motion.div>
    </motion.div>
  );
}

// ─── Per-Event eBay Finances Ledger ──────────────────────────────────────────
// Diagnostic surface: every raw eBay Finances API event as its own row, so
// the user can trace a specific charge, multi-label shipment, or partial
// refund. The aggregation that feeds bookkeeping rows (in useSyncAll) is
// unchanged — this is purely additive.

const FINANCES_EVENTS_KEY = 'noltech:ebay:finances-events';
const FINANCES_TYPE_INTENT = {
  NON_SALE_CHARGE: 'warning',
  SHIPPING_LABEL:  'info',
  REFUND:          'danger',
  CREDIT:          'danger',
  DISPUTE:         'danger',
};

function PerEventLedgerTab({ year, transactions }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState('all');
  const [orderQuery, setOrderQuery] = useState('');
  const [page, setPage] = useState(0);
  const PG_SIZE = 100;

  const load = useCallback(() => {
    window.storage.get(FINANCES_EVENTS_KEY)
      .then((data) => setEvents(Array.isArray(data) ? data : []))
      .catch((e) => console.error('[PerEventLedger] load failed:', e))
      .finally(() => setLoading(false));
  }, []);

  // Refresh on sync completion so the tab stays fresh after a Sync All run.
  // Synchronous subscription via the top-level eventBus import — no race
  // on fast unmount, which the dynamic import() pattern had.
  useEffect(() => {
    load();
    const unsub = eventBus.on('ebay:orders-synced', load);
    return () => unsub?.();
  }, [load]);

  // Build the set of orderIds already covered by a bookkeeping row so we
  // can flag events that didn't land — typical "Run Sync All" gap.
  const bookedOrderIds = useMemo(() => {
    const out = new Set();
    for (const t of transactions) if (t.orderId) out.add(String(t.orderId));
    return out;
  }, [transactions]);

  const filtered = useMemo(() => {
    const yearStr = String(year);
    return events
      .filter((e) => (e.date || '').startsWith(yearStr))
      .filter((e) => typeFilter === 'all' || e.type === typeFilter)
      .filter((e) => {
        if (!orderQuery) return true;
        const q = orderQuery.toLowerCase();
        return (
          (e.orderId || '').toLowerCase().includes(q)
          || (e.orderLineItemId || '').toLowerCase().includes(q)
          || (e.id || '').toLowerCase().includes(q)
          || (e.feeType || '').toLowerCase().includes(q)
          || (e.memo || '').toLowerCase().includes(q)
        );
      })
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }, [events, year, typeFilter, orderQuery]);

  const pageItems = useMemo(() => filtered.slice(page * PG_SIZE, (page + 1) * PG_SIZE), [filtered, page]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PG_SIZE));

  const typeCounts = useMemo(() => {
    const out = { all: 0 };
    for (const e of events) {
      if (!(e.date || '').startsWith(String(year))) continue;
      out.all++;
      out[e.type] = (out[e.type] || 0) + 1;
    }
    return out;
  }, [events, year]);

  if (loading) {
    return <div className="h-32 shimmer rounded-xl" />;
  }
  if (events.length === 0) {
    return (
      <Card padding="lg" radius="lg" className="text-center py-8">
        <Receipt className="w-10 h-10 text-fg-subtle mx-auto mb-3" />
        <h3 className="text-base font-semibold text-fg">No eBay Finances events yet</h3>
        <p className="text-xs text-fg-muted mt-1 max-w-md mx-auto">
          Per-event ledger appears after a Sync All run pulls fee, label, and refund events from the
          eBay Finances API. Each event shows up here as its own row — useful when you want to trace
          a specific charge, multi-label shipment, or partial refund.
        </p>
        <p className="mt-4 text-[11px] text-fg-subtle">
          Run <span className="font-medium text-fg-muted">Hub → Sync All</span> to populate this view.
        </p>
      </Card>
    );
  }

  const typeChips = [
    { id: 'all',              label: `All · ${typeCounts.all || 0}` },
    { id: 'NON_SALE_CHARGE',  label: `Charges · ${typeCounts.NON_SALE_CHARGE || 0}` },
    { id: 'SHIPPING_LABEL',   label: `Labels · ${typeCounts.SHIPPING_LABEL || 0}` },
    { id: 'REFUND',           label: `Refunds · ${typeCounts.REFUND || 0}` },
    { id: 'CREDIT',           label: `Credits · ${typeCounts.CREDIT || 0}` },
    { id: 'DISPUTE',          label: `Disputes · ${typeCounts.DISPUTE || 0}` },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Tabs size="sm" value={typeFilter} onChange={(v) => { setTypeFilter(v); setPage(0); }} items={typeChips} />
        <Input
          type="text"
          placeholder="Search orderId, lineItem, fee type, or memo…"
          value={orderQuery}
          onChange={(e) => { setOrderQuery(e.target.value); setPage(0); }}
          className="flex-1 min-w-[240px]"
        />
        <span className="text-xs text-fg-muted">{filtered.length} of {events.length} events</span>
      </div>

      <Card padding="none" radius="lg">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border-subtle bg-muted/40 text-[10px] font-semibold text-fg-muted uppercase tracking-wider">
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Type</th>
                <th className="px-3 py-2 text-left">Order</th>
                <th className="px-3 py-2 text-left hidden lg:table-cell">Line Item</th>
                <th className="px-3 py-2 text-left hidden md:table-cell">Fee Type</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2 text-left">Memo</th>
                <th className="px-3 py-2 text-left hidden lg:table-cell">Tx ID</th>
                <th className="px-3 py-2 text-left">Booked?</th>
              </tr>
            </thead>
            <tbody>
              {pageItems.map((e, i) => {
                const intent = FINANCES_TYPE_INTENT[e.type] || 'neutral';
                const booked = e.orderId && bookedOrderIds.has(String(e.orderId));
                return (
                  <tr key={e.id || `${e.orderId}-${i}`} className={`row-hover ${i % 2 === 0 ? 'bg-surface' : 'bg-muted/40'}`}>
                    <td className="px-3 py-1.5 font-mono text-[11px] text-fg-muted whitespace-nowrap">{(e.date || '').slice(0, 10)}</td>
                    <td className="px-3 py-1.5">
                      <Badge intent={intent} size="xs">{e.type.replace(/_/g, ' ').toLowerCase()}</Badge>
                    </td>
                    <td className="px-3 py-1.5">
                      {e.orderId ? (
                        <button
                          type="button"
                          onClick={() => setOrderQuery(e.orderId)}
                          className="font-mono text-[11px] text-fg hover:text-accent"
                          title="Filter to this order"
                        >
                          {e.orderId}
                        </button>
                      ) : <span className="text-fg-subtle">—</span>}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-[10px] text-fg-muted hidden lg:table-cell">
                      {e.orderLineItemId || <span className="text-fg-subtle">—</span>}
                    </td>
                    <td className="px-3 py-1.5 hidden md:table-cell">
                      {e.feeType ? <Badge intent="neutral" size="xs">{e.feeType.replace(/_/g, ' ').toLowerCase()}</Badge> : <span className="text-fg-subtle">—</span>}
                    </td>
                    <td className={`px-3 py-1.5 text-right font-mono tabular-nums ${(Number(e.amount) || 0) < 0 ? 'text-success' : 'text-danger'}`}>
                      {(Number(e.amount) || 0) >= 0 ? '−' : '+'}{fmt(Math.abs(Number(e.amount) || 0))}
                    </td>
                    <td className="px-3 py-1.5 text-fg-muted max-w-[180px] truncate" title={e.memo || ''}>
                      {e.memo || <span className="text-fg-subtle">—</span>}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-[10px] text-fg-subtle hidden lg:table-cell" title={e.id || ''}>
                      {(e.id || '').slice(0, 12)}{e.id && e.id.length > 12 ? '…' : ''}
                    </td>
                    <td className="px-3 py-1.5">
                      {e.orderId
                        ? (booked
                            ? <Badge intent="success" size="xs">linked</Badge>
                            : <Badge intent="warning" size="xs">gap</Badge>)
                        : <span className="text-fg-subtle">—</span>}
                    </td>
                  </tr>
                );
              })}
              {pageItems.length === 0 && (
                <tr><td colSpan={9} className="px-3 py-6 text-center text-fg-muted">No events match these filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div className="px-4 py-2 border-t border-border-subtle flex items-center justify-between text-xs text-fg-muted">
            <span>page {page + 1} of {totalPages}</span>
            <div className="flex items-center gap-1">
              <button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0} className="p-1 rounded hover:bg-muted disabled:opacity-30">
                <ChevronLeft size={14} />
              </button>
              <button onClick={() => setPage(Math.min(totalPages - 1, page + 1))} disabled={page >= totalPages - 1} className="p-1 rounded hover:bg-muted disabled:opacity-30">
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

// ─── 1099-K Reconciliation Card ──────────────────────────────────────────────
// Sits ABOVE the existing Tax tab content. Lets the user enter their
// 1099-K Box 1a (gross) + Box 4 (backup withholding), shows the threshold
// progress, and surfaces a waterfall + discrepancy list comparing the
// bookkeeping gross against eBay's reported figure.

function ReconciliationCard({ year, transactions }) {
  const [box1a, setBox1a] = useState('');
  const [box4, setBox4] = useState('');
  const [saved, setSaved] = useState(false);

  const storageKey = `noltech:tax:1099k`;

  useEffect(() => {
    window.storage.get(storageKey).then((data) => {
      const byYear = (data && typeof data === 'object') ? data : {};
      const y = byYear[year] || {};
      setBox1a(String(y.box1a ?? ''));
      setBox4(String(y.box4 ?? ''));
    }).catch(() => {});
  }, [year]);

  const persist = async (b1a, b4) => {
    const data = await window.storage.get(storageKey).catch(() => null) || {};
    data[year] = {
      box1a: parseFloat(b1a) || 0,
      box4:  parseFloat(b4)  || 0,
      updatedAt: new Date().toISOString(),
    };
    await window.storage.set(storageKey, data);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const data = useMemo(() => {
    const inYear = transactions.filter((t) => (t.date || '').startsWith(`${year}-`));
    const sumBy = (rows, pred) => rows.filter(pred).reduce((s, t) => s + (Number(t.amount) || 0), 0);
    const bookkeepingGross = sumBy(inYear, (t) => t.type === 'income');
    const refunds = sumBy(inYear, (t) => t.type === 'expense' && t.category === REFUND_CATEGORY);
    const fees    = sumBy(inYear, (t) => t.type === 'expense' && (t.category === 'eBay Fees' || t.category === 'eBay Ad Fees' || t.category === 'Mercari Fees' || t.category === 'Platform Fees'));
    const labels  = sumBy(inYear, (t) => t.type === 'expense' && (t.category === 'Shipping' || t.category === 'Postage & Freight'));
    const cogs    = sumBy(inYear, (t) => t.type === 'expense' && t.category === COGS_CATEGORY);
    const opex    = sumBy(inYear, (t) => t.type === 'expense' && t.category !== COGS_CATEGORY && t.category !== REFUND_CATEGORY && t.category !== 'eBay Fees' && t.category !== 'eBay Ad Fees' && t.category !== 'Mercari Fees' && t.category !== 'Platform Fees' && t.category !== 'Shipping' && t.category !== 'Postage & Freight');
    const txnCount = inYear.filter((t) => t.type === 'income' && (t.source === 'auto_sale' || t.source === 'manual' || t.source === 'ebay_import' || t.source === 'csv_import')).length;
    const netProfit = bookkeepingGross - refunds - fees - labels - cogs - opex;
    return { bookkeepingGross, refunds, fees, labels, cogs, opex, txnCount, netProfit };
  }, [transactions, year]);

  const threshold = getThreshold1099K(year);
  const ebayGross = parseFloat(box1a) || 0;
  const delta = ebayGross - data.bookkeepingGross;
  const deltaPct = data.bookkeepingGross !== 0 ? (delta / data.bookkeepingGross) * 100 : 0;
  const deltaIntent = Math.abs(delta) < 50 ? 'success' : Math.abs(delta) < 500 ? 'warning' : 'danger';
  const grossThresholdPct = Math.min(100, (data.bookkeepingGross / threshold.gross) * 100);
  const txnThresholdPct = Math.min(100, (data.txnCount / threshold.txn) * 100);
  // IRS rule: ">$20,000 AND >200 transactions" — both are STRICT inequalities
  // on the transaction count side. At exactly 200 transactions the seller is
  // under, not at, the threshold. Gross side uses >= because the published
  // language is "$20,000 or more" for the SE-tax-paper boundary.
  const meetsThreshold = data.bookkeepingGross >= threshold.gross && data.txnCount > threshold.txn;

  // Discrepancy flag list
  const flags = [];
  if (ebayGross > 0 && Math.abs(delta) > 50) {
    flags.push({
      intent: deltaIntent,
      title: `${fmt(Math.abs(delta))} delta vs 1099-K`,
      detail: ebayGross > data.bookkeepingGross
        ? 'Bookkeeping gross is LOWER than 1099-K. Likely cause: sales tax / buyer shipping not recorded as income, or auto-rows missing for some orders.'
        : 'Bookkeeping gross is HIGHER than 1099-K. Likely cause: duplicate auto rows, or a sale was recorded twice.',
    });
  }
  if (ebayGross > 0 && !meetsThreshold) {
    flags.push({
      intent: 'info',
      title: 'Threshold not met — no federal 1099-K expected',
      detail: `Federal threshold is ${fmt(threshold.gross)} AND >${threshold.txn} transactions. You're at ${fmt(data.bookkeepingGross)} / ${data.txnCount}. Income is still reportable on Schedule C.`,
    });
  }
  if (parseFloat(box4) > 0) {
    flags.push({
      intent: 'warning',
      title: `Backup withholding: ${fmt(parseFloat(box4))}`,
      detail: 'Credit Box 4 against income tax on Form 1040 — do NOT deduct it as a business expense.',
    });
  }

  return (
    <Card padding="lg" radius="lg" className="mb-4">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-base font-semibold text-fg flex items-center gap-2">
          <FileText className="w-4 h-4 text-accent" /> 1099-K Reconciliation
        </h3>
        <span className="text-[10px] text-fg-subtle">{year} · thresholds via tax1099k.js</span>
      </div>

      {/* Box 1a + Box 4 input row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        <div>
          <Label>1099-K Box 1a · gross payments</Label>
          <Input
            type="number"
            min="0"
            step="0.01"
            value={box1a}
            onChange={(e) => { setBox1a(e.target.value); persist(e.target.value, box4); }}
            placeholder="0.00"
            className="font-mono"
          />
        </div>
        <div>
          <Label>1099-K Box 4 · federal withholding</Label>
          <Input
            type="number"
            min="0"
            step="0.01"
            value={box4}
            onChange={(e) => { setBox4(e.target.value); persist(box1a, e.target.value); }}
            placeholder="0.00"
            className="font-mono"
          />
        </div>
        <div className="rounded-xl border border-border-subtle bg-muted/30 p-3">
          <span className="ui-eyebrow text-fg-subtle">Bookkeeping gross</span>
          <p className="text-lg font-mono tabular-nums text-fg mt-0.5">{fmt(data.bookkeepingGross)}</p>
          {ebayGross > 0 && (
            <p className={`text-[11px] mt-1 font-mono tabular-nums ${deltaIntent === 'success' ? 'text-success' : deltaIntent === 'warning' ? 'text-warning' : 'text-danger'}`}>
              {delta >= 0 ? '+' : '−'}{fmt(Math.abs(delta))} delta ({deltaPct.toFixed(1)}%)
            </p>
          )}
        </div>
      </div>
      {saved && <p className="text-[11px] text-success mb-3">Saved.</p>}

      {/* Threshold tiles */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <div className="rounded-xl border border-border-subtle p-3">
          <div className="flex items-baseline justify-between mb-1.5">
            <span className="ui-eyebrow text-fg-subtle">Gross payments</span>
            <span className="text-[11px] font-mono text-fg-muted">{fmt(data.bookkeepingGross)} / {fmt(threshold.gross)}</span>
          </div>
          <div className="h-2 bg-muted/60 rounded-full overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${grossThresholdPct}%` }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
              className={`h-full rounded-full ${grossThresholdPct >= 100 ? 'bg-success' : 'bg-accent'}`}
            />
          </div>
        </div>
        <div className="rounded-xl border border-border-subtle p-3">
          <div className="flex items-baseline justify-between mb-1.5">
            <span className="ui-eyebrow text-fg-subtle">Transaction count</span>
            <span className="text-[11px] font-mono text-fg-muted">{data.txnCount} / {threshold.txn}</span>
          </div>
          <div className="h-2 bg-muted/60 rounded-full overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${txnThresholdPct}%` }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
              className={`h-full rounded-full ${txnThresholdPct >= 100 ? 'bg-success' : 'bg-accent'}`}
            />
          </div>
        </div>
      </div>
      <p className="text-[11px] text-fg-subtle mb-3">
        Per the One Big Beautiful Bill Act (signed Jul 4, 2025), the federal 1099-K threshold is{' '}
        {fmt(threshold.gross)} <strong>and</strong> &gt;{threshold.txn} transactions for {year}.
        {meetsThreshold
          ? ' You should expect a 1099-K from eBay.'
          : ' You are under the threshold — no federal 1099-K expected, but income is still reportable on Schedule C.'}
      </p>

      {/* Adjustment waterfall */}
      <div className="rounded-xl border border-border-subtle p-3 mb-4 space-y-1.5">
        <div className="flex items-baseline justify-between text-xs">
          <span className="text-fg-muted">1099-K Box 1a (gross)</span>
          <span className="font-mono tabular-nums text-fg">{fmt(ebayGross)}</span>
        </div>
        <div className="flex items-baseline justify-between text-xs text-danger">
          <span>− Refunds &amp; returns</span>
          <span className="font-mono tabular-nums">−{fmt(data.refunds)}</span>
        </div>
        <div className="flex items-baseline justify-between text-xs text-danger">
          <span>− Platform fees (eBay / Mercari)</span>
          <span className="font-mono tabular-nums">−{fmt(data.fees)}</span>
        </div>
        <div className="flex items-baseline justify-between text-xs text-danger">
          <span>− Shipping labels</span>
          <span className="font-mono tabular-nums">−{fmt(data.labels)}</span>
        </div>
        <div className="flex items-baseline justify-between text-xs text-danger">
          <span>− Cost of Goods</span>
          <span className="font-mono tabular-nums">−{fmt(data.cogs)}</span>
        </div>
        <div className="flex items-baseline justify-between text-xs text-danger">
          <span>− Operating expenses</span>
          <span className="font-mono tabular-nums">−{fmt(data.opex)}</span>
        </div>
        <div className="border-t border-border-subtle pt-1.5 flex items-baseline justify-between text-sm font-semibold">
          <span className="text-fg">Net profit (Schedule C Line 31)</span>
          <span className={`font-mono tabular-nums ${profitCls(data.netProfit)}`}>{fmt(data.netProfit)}</span>
        </div>
      </div>

      {/* Discrepancy flags */}
      {flags.length > 0 && (
        <div className="space-y-1.5 mb-3">
          {flags.map((f, i) => (
            <div key={i} className={`flex items-start gap-2 p-2.5 rounded-md border text-xs
              ${f.intent === 'danger'  ? 'border-danger/30 bg-danger-subtle text-danger' : ''}
              ${f.intent === 'warning' ? 'border-warning/30 bg-warning-subtle text-warning' : ''}
              ${f.intent === 'success' ? 'border-success/30 bg-success-subtle text-success' : ''}
              ${f.intent === 'info'    ? 'border-info/30 bg-info-subtle text-info' : ''}
            `}>
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">{f.title}</p>
                <p className="opacity-90 mt-0.5">{f.detail}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Sources */}
      <details className="text-[11px] text-fg-subtle">
        <summary className="cursor-pointer hover:text-fg-muted">Sources</summary>
        <ul className="mt-1 space-y-0.5 ml-3">
          {SOURCE_LINKS.map((s) => (
            <li key={s.url}>
              <a href={s.url} target="_blank" rel="noreferrer" className="hover:underline">{s.label}</a>
            </li>
          ))}
        </ul>
      </details>
    </Card>
  );
}

// Category constants used by ReconciliationCard's waterfall computation.
const COGS_CATEGORY = 'Cost of Goods (Lots)';
const REFUND_CATEGORY = 'Returns & Refunds';

// ─── Root Component ───────────────────────────────────────────────────────────

export default function Bookkeeping() {
  const { state: appState, dispatch } = useApp();
  const [transactions, setTransactions] = useState([]);
  const [year, setYear]                 = useState(currentYear());
  const [showForm, setShowForm]         = useState(false);
  const [editingTx, setEditingTx]       = useState(null);
  const [showImport, setShowImport]     = useState(false);
  const [showLotPurchase, setShowLotPurchase] = useState(false);
  const [showTools, setShowTools]       = useState(false);
  const [showCatManager, setShowCatManager] = useState(false);
  const [incomeCats, setIncomeCats]   = useState(DEFAULT_INCOME_CATS);
  const [expenseCats, setExpenseCats] = useState(DEFAULT_EXPENSE_CATS);

  // Load saved custom categories. Empty / missing key falls back to defaults.
  // The DEFAULTS are not stored; only the user's overrides are persisted, so
  // adding a new bookkeeping default in a future release automatically
  // surfaces without needing a migration. We merge defaults + custom so the
  // user can't accidentally lose access to the canonical eBay Sales / Cost
  // of Goods options.
  useEffect(() => {
    window.storage.get(CATEGORIES_KEY).then(saved => {
      if (!saved || typeof saved !== 'object') return;
      const merged = (defaults, overrides) => {
        if (!Array.isArray(overrides)) return defaults;
        const seen = new Set();
        const out = [];
        for (const c of [...defaults, ...overrides]) {
          const key = (c || '').trim();
          if (!key || seen.has(key.toLowerCase())) continue;
          seen.add(key.toLowerCase());
          out.push(key);
        }
        return out;
      };
      setIncomeCats(merged(DEFAULT_INCOME_CATS, saved.income));
      setExpenseCats(merged(DEFAULT_EXPENSE_CATS, saved.expense));
    }).catch(e => console.error('[Bookkeeping] categories load failed:', e));
  }, []);

  const persistCategories = useCallback(async (nextIncome, nextExpense) => {
    setIncomeCats(nextIncome);
    setExpenseCats(nextExpense);
    // Persist ONLY the user's additions (anything not in defaults) so that
    // future default additions show up automatically without conflicting
    // with custom names.
    const extras = (defaults, current) => current.filter(c => !defaults.some(d => d.toLowerCase() === c.toLowerCase()));
    await window.storage.set(CATEGORIES_KEY, {
      income:  extras(DEFAULT_INCOME_CATS, nextIncome),
      expense: extras(DEFAULT_EXPENSE_CATS, nextExpense),
    });
  }, []);
  const [importMsg, setImportMsg]       = useState('');
  const [loading, setLoading]           = useState(true);
  const csvInputRef                     = useRef(null);
  const toolsRef                        = useRef(null);

  // Close Tools dropdown when clicking outside.
  useEffect(() => {
    if (!showTools) return;
    const onDown = (e) => {
      if (toolsRef.current && !toolsRef.current.contains(e.target)) setShowTools(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [showTools]);

  // Load from storage + listen for cloud sync updates
  useEffect(() => {
    let cancelled = false;
    let unsubSync = null;
    let unsubLocal = null;

    const load = () => {
      window.storage.get(STORAGE_KEY).then(data => {
        if (cancelled) return;
        if (Array.isArray(data)) setTransactions(data);
      }).catch(e => console.error('[Bookkeeping] transactions load failed:', e)).finally(() => {
        if (!cancelled) setLoading(false);
      });
    };
    load();

    // Import eventBus dynamically to avoid circular import.
    // The previous version `return unsub` inside .then() — which just
    // returned from the Promise chain, not from the useEffect — so the
    // listener was never torn down on unmount, leaking subscriptions.
    import('../../services/eventBus').then(({ default: eventBus }) => {
      if (cancelled) return;
      unsubSync  = eventBus.on('sync:array-updated', ({ storageKey }) => {
        if (storageKey === STORAGE_KEY) load();
      });
      // Auto-written rows from useEventBridge (sale:recorded, lot:added,
      // refunds, etc.) fire this event so the open Bookkeeping view picks
      // them up without a full reload.
      unsubLocal = eventBus.on('books:transactions-changed', () => load());
    });

    return () => {
      cancelled = true;
      if (typeof unsubSync  === 'function') unsubSync();
      if (typeof unsubLocal === 'function') unsubLocal();
    };
  }, []);

  async function persist(next) {
    setTransactions(next);
    await window.storage.set(STORAGE_KEY, next);
  }

  function handleSave(form) {
    if (editingTx) {
      persist(transactions.map(t => t.id === editingTx.id ? { ...t, ...form } : t));
    } else {
      persist([{ id: uid(), source: 'manual', ...form }, ...transactions]);
    }
    setShowForm(false);
    setEditingTx(null);
  }

  function handleEdit(tx) { setEditingTx(tx); setShowForm(true); }

  function handleDelete(id) {
    persist(transactions.filter(t => t.id !== id));
  }

  // Quick-add a liquidation lot purchase. Always writes the expense row.
  // Optionally also creates an empty inventory Lot so the manifest can be
  // populated later from Inventory / WonLotImporter without re-entering
  // the cost. Both writes share an importId so dedupe doesn't double them
  // up when the lot:added event fires for the auto-created lot.
  function handleLotPurchase(payload) {
    const { createInventoryLot, itemCount, ...txFields } = payload;
    const lotId = createInventoryLot ? crypto.randomUUID() : null;
    const importId = lotId ? `auto_lot:${lotId}` : null;
    const tx = {
      id: uid(),
      source: lotId ? 'auto_lot_purchase' : 'manual',
      ...(importId ? { importId, lotId } : {}),
      ...txFields,
    };
    persist([tx, ...transactions]);
    if (lotId) {
      // Dispatch a new inventory Lot. The lot:added event the AppContext
      // emits will NOT re-mirror to bookkeeping because we tagged this row
      // with the same importId the bridge will look for.
      dispatch({
        type: 'ADD_LOT',
        lot: {
          id: lotId,
          source: (payload.supplier || '').toLowerCase().includes('liquidation') ? 'liquidation.com'
                : (payload.supplier || '').toLowerCase().includes('techliq') ? 'techliquidators'
                : 'other',
          sourceName: payload.supplier || 'Lot',
          purchaseDate: payload.date,
          cost: payload.amount,
          itemCount: itemCount || 0,
          status: 'received',
          notes: payload.description + (payload.notes ? ` — ${payload.notes}` : ''),
          items: [],
        },
        // Tells useEventBridge that bookkeeping is already recorded for this
        // lot so the lot:added handler should NOT add a second COGS row.
        _bookkeepingRecorded: true,
      });
    }
    setShowLotPurchase(false);
    setImportMsg(lotId ? 'Lot purchase recorded + inventory lot created.' : 'Lot purchase recorded.');
    setTimeout(() => setImportMsg(''), 4000);
  }

  function handleEbayImport(orders) {
    const existingImportIds = new Set(transactions.filter(t => t.importId).map(t => t.importId));
    let added = 0;
    const newTxs = [];
    for (const o of orders) {
      const importId = `${o.orderId}|${o.sku || o.title}`;
      if (existingImportIds.has(importId)) continue;
      newTxs.push({
        id: uid(), source: 'ebay_import', importId,
        date: o.date ? o.date.slice(0, 10) : new Date().toISOString().slice(0, 10),
        type: 'income', category: 'eBay Sales',
        description: o.title || `Order ${o.orderId}`,
        amount: o.netPayout || o.price,
        notes: o.sku ? `SKU: ${o.sku}` : '',
      });
      added++;
    }
    persist([...newTxs, ...transactions]);
    setShowImport(false);
    setImportMsg(`Imported ${added} order${added !== 1 ? 's' : ''} (${orders.length - added} skipped as duplicates).`);
    setTimeout(() => setImportMsg(''), 5000);
  }

  // Rebuild all auto-recorded sale rows from the immutable sales history log.
  // Old single-row format (gross − fees as income, shipping as separate expense)
  // gets replaced with the three-row format (gross income + fees expense +
  // shipping expense) that matches the eBay 1099-K + "Order earnings" view.
  async function handleRebuildAutoRows() {
    const AUTO_SOURCES = new Set(['auto_sale', 'auto_shipping', 'auto_fees', 'auto_adfee', 'auto_ticket_sale', 'auto_ticket_purchase']);
    const existingAuto = transactions.filter(t => AUTO_SOURCES.has(t.source));
    if (!existingAuto.length) {
      if (!confirm('No auto-recorded rows found. Rebuild anyway from sales history?')) return;
    } else if (!confirm(
      `Rebuild ${existingAuto.length} auto-recorded row${existingAuto.length !== 1 ? 's' : ''} from sales history?\n\n` +
      'Manual rows and CSV imports will NOT be touched. Existing auto rows will be replaced with the corrected gross-income / fees / shipping format.'
    )) return;

    setImportMsg('Rebuilding auto-recorded rows…');
    try {
      // 1) Strip existing auto rows, but first capture importId → id so the
      //    rebuilt rows can REUSE those ids. Otherwise rebuild generates fresh
      //    UUIDs for the same logical importId, which (a) churns Supabase
      //    needlessly and (b) trips the unique constraint on import_id when
      //    the cloud sync queue hasn't yet deleted the old row.
      const existingIdByImportId = {};
      // Capture existing auto_sale descriptions so we can preserve them when
      // the inventory item's brand/model are now empty (e.g. user edited them
      // out, or item was deleted from inventory and rebuild falls back to
      // sales:history which has stale empty brand/model). Without this the
      // rebuild would dump every row to "Item Sale" instead of the real
      // product name.
      const existingDescByItemAnchor = {};
      for (const t of transactions) {
        if (AUTO_SOURCES.has(t.source) && t.importId && t.id) {
          existingIdByImportId[t.importId] = t.id;
        }
        // auto_sale rows: importId is `auto:{itemId}:{soldAt}`.
        // Index by `itemId|soldDate` (date-only) so the lookup survives the
        // soldAt format change from date-only string to full ISO timestamp.
        // Skip rows where the description IS the fallback ("Item Sale") —
        // those came from a previous broken rebuild and would re-poison the
        // map if we trusted them.
        if (t.source === 'auto_sale' && t.description && t.description !== 'Item Sale' && t.importId) {
          const m = t.importId.match(/^auto:([^:]+):(.*)$/);
          if (m) {
            const itemId = m[1];
            const dateOnly = String(m[2] || '').slice(0, 10);
            existingDescByItemAnchor[`${itemId}|${dateOnly}`] = t.description;
          }
        }
      }
      const manualOnly = transactions.filter(t => !AUTO_SOURCES.has(t.source));

      // 2) Build payload list from CURRENT inventory (the live, up-to-date
      //    sale data). We used to read from noltech:sales:history but that
      //    log is only appended on first sale-record events — Finances API
      //    updates (ad fees, real label cost) and any subsequent sale edit
      //    only touch the live inventory record, not the history. Reading
      //    from history meant Rebuild wiped freshly-synced data and replaced
      //    it with stale initial values. Live inventory is the source of truth.
      const skuByItemId = {};
      const livePayloads = [];
      (appState.lots || []).forEach((l) => (l.items || []).forEach((i) => {
        skuByItemId[i.id] = i.sku || i.serialNumber || null;
        if ((i.status === 'sold' || i.sale) && i.sale) {
          livePayloads.push({
            itemId: i.id,
            sale:   i.sale,
            brand:  i.brand,
            model:  i.model,
            sku:    i.sku || i.serialNumber || null,
          });
        }
      }));
      // Fallback: pull anything from sales:history that isn't already
      // covered by live inventory (e.g., items that were deleted from
      // inventory but whose sale history we want to keep visible).
      const liveItemIds = new Set(livePayloads.map((p) => p.itemId));
      const salesHistory = await window.storage.get('noltech:sales:history').catch(() => []) || [];
      const historyOnly = salesHistory.filter((p) => p?.itemId && !liveItemIds.has(p.itemId));
      const allPayloads = [...livePayloads, ...historyOnly];

      // Build a per-item recovery map of brand/model captured at sale time.
      // sales:history rows preserve `brand` and `model` from the original
      // sale:recorded event payload — useful when the live inventory item's
      // brand/model fields are empty but the sale record from years ago had
      // them. The map keeps the last-recorded values per itemId.
      const historyNamesByItemId = {};
      for (const h of salesHistory) {
        if (!h?.itemId) continue;
        const b = (h.brand || '').trim();
        const m = (h.model || '').trim();
        if (b || m) historyNamesByItemId[h.itemId] = { brand: b, model: m };
      }

      // 3) Rebuild with the new 3-row format. Revenue = salePrice (already
      //    incl. buyer-paid shipping). Expenses = platform fees + seller's
      //    actual label cost. If labelCost is unknown (0 and not flagged),
      //    skip the shipping expense row — user will enter it from
      //    Shipping Queue later.
      const seen = new Set();
      const rebuilt = [];
      let missingLabel = 0;
      for (const payload of allPayloads) {
        const { itemId, sale, brand, model } = payload || {};
        if (!sale) continue;
        // Keep importId format in lockstep with useEventBridge.buildAutoRowsForSale.
        // Order-first key — same scheme as the live event-bridge path so a
        // rebuild reuses the existing rows' importIds instead of forking
        // them under a different key (which used to silently leave duplicates).
        const orderKey       = String(sale.id || sale.orderId || '');
        const transactionKey = sale.transactionId ? `:${sale.transactionId}` : '';
        const legacyAnchor   = `${itemId}:${sale.soldAt || ''}`;
        const dedupAnchor    = orderKey ? `${orderKey}${transactionKey}` : legacyAnchor;
        const importId = `auto:${dedupAnchor}`;
        if (seen.has(importId)) continue;
        seen.add(importId);

        // Resolve the most informative description we can. Five-step chain
        // because earlier in the project's life, broken rebuilds wiped some
        // descriptions and we need every available recovery source:
        //   1. Live brand+model from inventory (best — current truth)
        //   2. sale.itemName captured from the eBay order title at sync time
        //   3. Brand+model captured in sales:history at sale time (recovers
        //      cases where inventory was edited and the original names live
        //      only in the sale-history log)
        //   4. The previous auto_sale row's description (preserves user's
        //      hand-edited labels when nothing else has the name)
        //   5. "Item Sale" fallback
        const liveName = `${brand || ''} ${model || ''}`.trim();
        const histRec  = historyNamesByItemId[itemId];
        const histName = histRec ? `${histRec.brand || ''} ${histRec.model || ''}`.trim() : '';
        const dateOnlyForLookup = String(sale.soldAt || '').slice(0, 10);
        const itemName = liveName
          || (sale.itemName || '').trim()
          || histName
          || existingDescByItemAnchor[`${itemId}|${dateOnlyForLookup}`]
          || 'Item Sale';
        const txDate = localDateStr(sale.soldAt) || localDateStr(new Date());
        const platform = sale.platform || 'ebay';
        // SKU: prefer payload.sku (newer events), then sale.sku, then current inventory lookup
        const skuVal = (payload.sku || sale.sku || skuByItemId[itemId] || '').toString().trim() || null;
        const gross         = parseFloat(sale.salePrice) || 0;
        const buyerShipping = parseFloat(sale.buyerShipping) || 0;
        const fees          = parseFloat(sale.platformFees) || 0;
        // Prefer explicit labelCost; legacy shippingCost as fallback
        const labelCost     = parseFloat(sale.labelCost) || parseFloat(sale.shippingCost) || 0;
        const labelCostKnown = !!sale.labelCostKnown || labelCost > 0;
        const labelCostFromFinances = sale.labelCostSource === 'finances';
        const labelLooksEstimated   = labelCostKnown && !labelCostFromFinances
          && Math.abs(labelCost - buyerShipping) < 0.01 && buyerShipping > 0;

        // Split ad-fee buckets out of platform fees so they show as their own
        // bookkeeping row (mirrors useEventBridge.buildAutoRowsForSale).
        const rawBreakdown = (sale.feeBreakdown && typeof sale.feeBreakdown === 'object')
          ? sale.feeBreakdown : {};
        const isAdFeeKey = (k) => /^(ad[_ ]?fee|promot|promoted)/i.test(k);
        const adFeeBreakdown = {};
        const platformFeeBreakdown = {};
        for (const [k, v] of Object.entries(rawBreakdown)) {
          const amt = Number(v) || 0;
          if (amt <= 0) continue;
          if (isAdFeeKey(k)) adFeeBreakdown[k] = amt;
          else               platformFeeBreakdown[k] = amt;
        }
        const adFeeAmount     = Math.round(Object.values(adFeeBreakdown).reduce((s, v) => s + v, 0) * 100) / 100;
        const platformFeesNet = Math.max(0, Math.round((fees - adFeeAmount) * 100) / 100);

        const incomeCategory =
          platform === 'ebay'    ? 'eBay Sales' :
          platform === 'mercari' ? 'Mercari Sales' :
          platform === 'facebook'? 'Facebook Marketplace' :
                                   'Other Income';
        const feeCategory =
          platform === 'ebay'    ? 'eBay Fees' :
          platform === 'mercari' ? 'Mercari Fees' :
                                   'Platform Fees';
        const adFeeCategory =
          platform === 'ebay'    ? 'eBay Ad Fees' :
                                   'Advertising';

        if (gross > 0) {
          const orderTotal = parseFloat(sale.orderTotal) || 0;
          const salesTax   = parseFloat(sale.salesTax)   || 0;
          const subtotal   = parseFloat(sale.subtotal)   || 0;
          const vatAmount  = parseFloat(sale.vatAmount)  || 0;
          const gstAmount  = parseFloat(sale.gstAmount)  || 0;
          const taxBreakdown = (sale.taxBreakdown && typeof sale.taxBreakdown === 'object') ? sale.taxBreakdown : {};
          const taxBreakdownEntries = Object.entries(taxBreakdown).filter(([, v]) => Number(v) > 0);
          const taxLabel = taxBreakdownEntries.length > 1
            ? taxBreakdownEntries.map(([k, v]) => `${k} $${Number(v).toFixed(2)}`).join(' + ')
            : (vatAmount > 0
                ? `VAT $${vatAmount.toFixed(2)}`
                : gstAmount > 0
                  ? `GST $${gstAmount.toFixed(2)}`
                  : `tax $${salesTax.toFixed(2)}`);
          const shipNote = buyerShipping > 0
            ? `includes $${buyerShipping.toFixed(2)} buyer-paid shipping`
            : 'no buyer-paid shipping';
          const labelNote = labelCostKnown
            ? `label $${labelCost.toFixed(2)}`
            : 'label cost TBD (enter from Shipping Queue)';
          const orderTotalNote = orderTotal > 0
            ? `Order total $${orderTotal.toFixed(2)} (subtotal $${subtotal.toFixed(2)} + ship $${buyerShipping.toFixed(2)} + ${taxLabel} eBay-remitted). `
            : '';
          rebuilt.push({
            id: existingIdByImportId[importId] || crypto.randomUUID(),
            source: 'auto_sale',
            importId,
            date: txDate,
            type: 'income',
            category: incomeCategory,
            description: itemName,
            sku: skuVal,
            amount: gross,
            notes: `Auto-recorded. ${orderTotalNote}Seller revenue $${gross.toFixed(2)} (${shipNote}) · fees $${fees.toFixed(2)} · ${labelNote} · net earnings $${(gross - fees - labelCost).toFixed(2)}.`,
          });
        }
        const platformFeeAmountForRow = Object.keys(platformFeeBreakdown).length
          ? platformFeesNet
          : Math.max(0, Math.round((fees - adFeeAmount) * 100) / 100);
        if (platformFeeAmountForRow > 0) {
          const fmtBreakdown = (obj) => Object.entries(obj)
            .filter(([, v]) => Number(v) > 0)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${k} $${Number(v).toFixed(2)}`)
            .join(' · ');
          const breakdown = fmtBreakdown(platformFeeBreakdown);
          // Same order-first anchor as the income row above (and as
          // useEventBridge.buildAutoRowsForSale). Important: changing
          // only one of these keys leaves the others under the old format
          // and the live + rebuild paths drift apart again.
          const feesImportId = `auto_fees:${dedupAnchor}`;
          rebuilt.push({
            id: existingIdByImportId[feesImportId] || crypto.randomUUID(),
            source: 'auto_fees',
            importId: feesImportId,
            date: txDate,
            type: 'expense',
            category: feeCategory,
            description: `${platform === 'ebay' ? 'eBay' : platform} fees — ${itemName}`,
            sku: skuVal,
            amount: platformFeeAmountForRow,
            notes: breakdown
              ? `Breakdown: ${breakdown}.${adFeeAmount > 0 ? ` Ad fees ($${adFeeAmount.toFixed(2)}) recorded separately.` : ''}`
              : (adFeeAmount > 0
                  ? `Auto-recorded platform fee. Ad fees ($${adFeeAmount.toFixed(2)}) recorded separately.`
                  : 'Auto-recorded platform fee for order.'),
          });
        }
        if (adFeeAmount > 0) {
          const fmtAd = Object.entries(adFeeBreakdown)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${k} $${Number(v).toFixed(2)}`)
            .join(' · ');
          const adfeeImportId = `auto_adfee:${dedupAnchor}`;
          rebuilt.push({
            id: existingIdByImportId[adfeeImportId] || crypto.randomUUID(),
            source: 'auto_adfee',
            importId: adfeeImportId,
            date: txDate,
            type: 'expense',
            category: adFeeCategory,
            description: `${platform === 'ebay' ? 'eBay' : platform} ad fee — ${itemName}`,
            sku: skuVal,
            amount: adFeeAmount,
            notes: fmtAd
              ? `Promoted Listings / Ad Fee breakdown: ${fmtAd}.`
              : 'Auto-recorded eBay advertising fee from Finances API.',
          });
        }
        if (labelCostKnown && labelCost > 0) {
          const labelNote = labelLooksEstimated
            ? `⚠ Estimated label cost — matches buyer-paid shipping ($${buyerShipping.toFixed(2)}). Real seller cost arrives via the Finances API on next sync. Verify in Shipping Queue if it doesn't update.`
            : labelCostFromFinances
              ? `Seller label cost (from eBay Finances API).${buyerShipping > 0 ? ` Buyer paid $${buyerShipping.toFixed(2)} for shipping.` : ''}`
              : (buyerShipping > 0
                  ? `Seller label cost. Buyer paid $${buyerShipping.toFixed(2)} for shipping.`
                  : 'Auto-recorded shipping label expense.');
          const shipImportId = `auto_ship:${dedupAnchor}`;
          rebuilt.push({
            id: existingIdByImportId[shipImportId] || crypto.randomUUID(),
            source: 'auto_shipping',
            importId: shipImportId,
            date: txDate,
            type: 'expense',
            category: 'Shipping',
            description: `Shipping label — ${itemName}`,
            sku: skuVal,
            amount: labelCost,
            notes: labelNote,
          });
        } else if (gross > 0) {
          missingLabel++;
        }
      }

      const next = [...rebuilt, ...manualOnly].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      await persist(next);
      const tail = missingLabel > 0
        ? ` · ${missingLabel} sale${missingLabel !== 1 ? 's' : ''} missing label cost — enter from Shipping Queue.`
        : '';
      setImportMsg(`Rebuilt ${rebuilt.length} auto row${rebuilt.length !== 1 ? 's' : ''} from ${salesHistory.length} sale${salesHistory.length !== 1 ? 's' : ''}. Removed ${existingAuto.length} old auto row${existingAuto.length !== 1 ? 's' : ''}.${tail}`);
      setTimeout(() => setImportMsg(''), 9000);
    } catch (e) {
      console.error('[Bookkeeping] rebuild failed:', e);
      setImportMsg(`Rebuild failed: ${e.message}`);
      setTimeout(() => setImportMsg(''), 6000);
    }
  }

  // Clean up stub items that an earlier (now-reverted) "auto-create from
  // eBay order" feature added to the eBay Sync lot. They're flagged with
  // `autoCreatedFromOrder: true`. Removes the inventory items AND their
  // associated auto bookkeeping rows in one shot. Manual rows untouched.
  async function handleCleanupAutoStubs() {
    const stubs = [];
    for (const lot of appState.lots || []) {
      for (const item of (lot.items || [])) {
        if (item.autoCreatedFromOrder) stubs.push(item);
      }
    }
    if (stubs.length === 0) {
      setImportMsg('No auto-created stub items found.');
      setTimeout(() => setImportMsg(''), 5000);
      return;
    }
    const sample = stubs.slice(0, 5).map((s) => `· ${(s.brand || '')} ${(s.model || '')}`.trim() || `· ${s.id}`).join('\n');
    if (!confirm(
      `Found ${stubs.length} auto-created stub item${stubs.length !== 1 ? 's' : ''} in inventory.\n\n` +
      `Sample:\n${sample}${stubs.length > 5 ? `\n· …and ${stubs.length - 5} more` : ''}\n\n` +
      `This will delete:\n` +
      `  • The inventory items themselves\n` +
      `  • Their auto bookkeeping rows (auto_sale, auto_fees, auto_adfee, auto_shipping)\n\n` +
      `Manual rows and any non-stub items will NOT be touched.\n\nContinue?`
    )) return;

    setImportMsg(`Cleaning up ${stubs.length} stub${stubs.length !== 1 ? 's' : ''}…`);
    try {
      // Build the set of importIds that point at these stubs.
      const stubIds = new Set(stubs.map((s) => s.id));
      const importIdsToDelete = new Set();
      for (const stub of stubs) {
        const soldAt = stub.sale?.soldAt || '';
        importIdsToDelete.add(`auto:${stub.id}:${soldAt}`);
        importIdsToDelete.add(`auto_fees:${stub.id}:${soldAt}`);
        importIdsToDelete.add(`auto_adfee:${stub.id}:${soldAt}`);
        importIdsToDelete.add(`auto_ship:${stub.id}:${soldAt}`);
      }
      // Filter bookkeeping by importId match — and as a belt-and-suspenders,
      // also drop any lingering rows whose extracted itemId portion matches
      // a stub (covers slight format drift across versions).
      const filteredTxs = transactions.filter((t) => {
        if (!t.importId) return true;
        if (importIdsToDelete.has(t.importId)) return false;
        const m = t.importId.match(/^auto[_a-z]*:([^:]+):/);
        if (m && stubIds.has(m[1])) return false;
        return true;
      });
      const txsRemoved = transactions.length - filteredTxs.length;
      await persist(filteredTxs);

      // Delete the inventory items themselves.
      for (const stub of stubs) {
        dispatch({ type: 'DELETE_ITEM', id: stub.id });
      }

      setImportMsg(`Removed ${stubs.length} stub item${stubs.length !== 1 ? 's' : ''} and ${txsRemoved} bookkeeping row${txsRemoved !== 1 ? 's' : ''}.`);
      setTimeout(() => setImportMsg(''), 6000);
    } catch (e) {
      console.error('[Bookkeeping] cleanup failed:', e);
      setImportMsg(`Cleanup failed: ${e.message}`);
      setTimeout(() => setImportMsg(''), 6000);
    }
  }

  // Find inventory items that share the same eBay order ID — that's a true
  // duplicate (one buyer + one order can only correspond to one physical item
  // sold). For each duplicate group, picks the "best" item to keep (most
  // metadata populated, oldest dateAdded as tiebreaker) and deletes the rest
  // plus their bookkeeping rows.
  async function handleCleanupDuplicateSales() {
    const byOrderId = new Map();
    for (const lot of appState.lots || []) {
      for (const item of (lot.items || [])) {
        const orderId = item.sale?.id;
        if (!orderId) continue;
        if (!byOrderId.has(orderId)) byOrderId.set(orderId, []);
        byOrderId.get(orderId).push(item);
      }
    }
    const duplicates = [];
    for (const [orderId, items] of byOrderId) {
      if (items.length > 1) duplicates.push({ orderId, items });
    }
    if (duplicates.length === 0) {
      setImportMsg('No duplicate sales found — every eBay order ID maps to a single inventory item.');
      setTimeout(() => setImportMsg(''), 5000);
      return;
    }

    // Score each item by how "complete" it is — favor items with real data
    // over stubs/minimal entries.
    const score = (item) => {
      let s = 0;
      if (item.brand) s += 2;
      if (item.model) s += 2;
      if (item.sku || item.serialNumber) s += 2;
      if ((item.costBasis || 0) > 0) s += 3;
      if (!item.autoCreatedFromOrder) s += 5;
      return s;
    };

    const plan = duplicates.map(({ orderId, items }) => {
      const sorted = [...items].sort((a, b) => {
        const ds = score(b) - score(a);
        if (ds !== 0) return ds;
        return (a.dateAdded || '').localeCompare(b.dateAdded || '');
      });
      return { orderId, keeper: sorted[0], losers: sorted.slice(1) };
    });

    const totalLosers = plan.reduce((s, p) => s + p.losers.length, 0);
    const samples = plan.slice(0, 5).map((p) => {
      const k = `${p.keeper.brand || ''} ${p.keeper.model || ''}`.trim() || p.keeper.id.slice(0, 8);
      return `· ${p.orderId}: keep "${k.length > 50 ? k.slice(0, 50) + '…' : k}" → delete ${p.losers.length} duplicate${p.losers.length !== 1 ? 's' : ''}`;
    }).join('\n');

    if (!confirm(
      `Found ${plan.length} duplicate eBay order ID${plan.length !== 1 ? 's' : ''} ` +
      `across ${totalLosers + plan.length} inventory items.\n\n` +
      `${samples}${plan.length > 5 ? `\n· …and ${plan.length - 5} more` : ''}\n\n` +
      `For each duplicate group, the most complete item is kept; the rest will be deleted along with their bookkeeping rows.\n\nContinue?`
    )) return;

    setImportMsg(`Cleaning up ${totalLosers} duplicate item${totalLosers !== 1 ? 's' : ''}…`);
    try {
      const loserIds = new Set();
      const importIdsToDelete = new Set();
      for (const { losers } of plan) {
        for (const loser of losers) {
          loserIds.add(loser.id);
          const soldAt = loser.sale?.soldAt || '';
          importIdsToDelete.add(`auto:${loser.id}:${soldAt}`);
          importIdsToDelete.add(`auto_fees:${loser.id}:${soldAt}`);
          importIdsToDelete.add(`auto_adfee:${loser.id}:${soldAt}`);
          importIdsToDelete.add(`auto_ship:${loser.id}:${soldAt}`);
        }
      }
      const filteredTxs = transactions.filter((t) => {
        if (!t.importId) return true;
        if (importIdsToDelete.has(t.importId)) return false;
        const m = t.importId.match(/^auto[_a-z]*:([^:]+):/);
        if (m && loserIds.has(m[1])) return false;
        return true;
      });
      const txsRemoved = transactions.length - filteredTxs.length;
      await persist(filteredTxs);
      for (const id of loserIds) {
        dispatch({ type: 'DELETE_ITEM', id });
      }
      setImportMsg(`Removed ${loserIds.size} duplicate item${loserIds.size !== 1 ? 's' : ''} and ${txsRemoved} bookkeeping row${txsRemoved !== 1 ? 's' : ''}.`);
      setTimeout(() => setImportMsg(''), 6000);
    } catch (e) {
      console.error('[Bookkeeping] dedupe failed:', e);
      setImportMsg(`Dedupe failed: ${e.message}`);
      setTimeout(() => setImportMsg(''), 6000);
    }
  }

  function handleCSVImport(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const txs = parseImportCSV(ev.target.result);
      if (txs.length === 0) {
        setImportMsg('No valid transactions found in that file.');
        setTimeout(() => setImportMsg(''), 5000);
        return;
      }
      const next = [...txs, ...transactions];
      persist(next);
      setImportMsg(`Imported ${txs.length} transaction${txs.length !== 1 ? 's' : ''} from CSV.`);
      setTimeout(() => setImportMsg(''), 6000);
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  // ── Cleanup duplicate transaction rows (the rendered list, not items) ──
  // Caused by an old bug where the importId dedup key was based on soldAt
  // instead of orderId; rows were re-created on every sync that produced a
  // slightly-different soldAt timestamp. Groups rows by an exact-match
  // signature, keeps the oldest, deletes the rest.
  async function handleCleanupDuplicateTransactions() {
    const KEY = 'noltech:books:transactions';
    const all = await window.storage.get(KEY) || [];
    if (!all.length) {
      setImportMsg('No transactions to dedupe.');
      setTimeout(() => setImportMsg(''), 4000);
      return;
    }

    // Group by signature: type + date + amount + description + source +
    // category. Two rows are duplicates only if ALL of these match. This
    // catches the auto-row dupes from the importId bug without false-
    // positiving on legitimate same-amount entries (those would differ on
    // description and/or source).
    const sigKey = (t) => [
      t.type || '',
      t.date || '',
      Number(t.amount || 0).toFixed(2),
      (t.description || '').trim(),
      t.source || '',
      t.category || '',
    ].join('|');

    const groups = new Map();
    for (const t of all) {
      if (!t || !t.id) continue;
      const k = sigKey(t);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }

    const toDelete = new Set();
    let groupsWithDupes = 0;
    for (const [, rows] of groups) {
      if (rows.length <= 1) continue;
      groupsWithDupes++;
      // Keep the first (lowest index in array). Mark the rest for deletion.
      const [keep, ...losers] = rows;
      for (const l of losers) toDelete.add(l.id);
    }

    if (toDelete.size === 0) {
      setImportMsg('No duplicates found — bookkeeping is clean.');
      setTimeout(() => setImportMsg(''), 5000);
      return;
    }

    if (!window.confirm(
      `Found ${toDelete.size} duplicate transaction${toDelete.size !== 1 ? 's' : ''} ` +
      `across ${groupsWithDupes} order${groupsWithDupes !== 1 ? 's' : ''}. ` +
      `Keep the oldest of each set and delete the rest?`,
    )) return;

    const cleaned = all.filter((t) => !toDelete.has(t.id));
    await window.storage.set(KEY, cleaned);
    setImportMsg(`Removed ${toDelete.size} duplicate transaction${toDelete.size !== 1 ? 's' : ''}.`);
    setTimeout(() => setImportMsg(''), 6000);
  }

  // ── Dedupe by eBay order ID ─────────────────────────────────────────────
  // Targeted remediation for the importId bug where auto rows were keyed by
  // `auto:<itemId>:<orderId>` instead of just `<orderId>`. When an order got
  // matched to inventory item A on one sync and stub item B on another, two
  // bookkeeping rows survived (different importIds, same orderId).
  //
  // Strategy:
  //   1. Group auto rows by (orderId, source). source = auto_sale / auto_fees
  //      / auto_adfee / auto_shipping — each kind should have exactly one
  //      row per order.
  //   2. For groups with > 1 row, keep the BEST representative:
  //        - prefer the row whose importId uses the new order-first format
  //          (no itemId segment, so it'll survive the next rebuild without
  //          drifting)
  //        - then prefer non-zero amount over zero
  //        - then keep the most recent by id (UUIDs aren't ordered, but
  //          we fall through to "first encountered").
  //   3. Delete the rest. Manual rows (no auto_* source) are never touched.
  async function handleDedupeByOrder() {
    const KEY = 'noltech:books:transactions';
    const all = await window.storage.get(KEY) || [];
    if (!all.length) {
      setImportMsg('No transactions to dedupe.');
      setTimeout(() => setImportMsg(''), 4000);
      return;
    }

    // True iff importId matches the new order-first format we now write.
    // Old format: `auto:<itemId>:<orderId>` (3 segments, itemId is a UUID
    //   with dashes — e.g. auto:a1b2-...-cdef:05-14627-86195 → 5 segments
    //   once you count the dashes in the UUID and orderId).
    // New format: `auto:<orderId>` (2 segments) or `auto:<orderId>:<txId>`
    //   (3 segments where the second segment is the orderId not an item).
    // We can't tell perfectly from the importId alone, but rows with a
    // matching `orderId` column equal to the FIRST segment after `auto:`
    // are definitely new-format.
    const looksNewFormat = (row) => {
      if (!row?.importId || !row?.orderId) return false;
      const m = row.importId.match(/^auto[_a-z]*:([^:]+)(?::(.+))?$/);
      if (!m) return false;
      return m[1] === String(row.orderId);
    };

    // Group auto rows by (orderId, source). Skip rows without an orderId —
    // those can't be safely grouped (manual entries, legacy pre-orderId
    // auto rows). Use `handleCleanupDuplicateTransactions` for those.
    const groups = new Map();
    for (const t of all) {
      if (!t || !t.id) continue;
      if (!t.source || !t.source.startsWith('auto_')) continue;
      if (!t.orderId) continue;
      const k = `${t.orderId}|${t.source}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }

    const toDelete = new Set();
    let groupsWithDupes = 0;
    for (const [, rows] of groups) {
      if (rows.length <= 1) continue;
      groupsWithDupes++;
      // Score each row; the highest wins (kept), the rest get deleted.
      const scored = rows.map((r) => ({
        row: r,
        score:
          (looksNewFormat(r) ? 100 : 0) +
          (Number(r.amount) > 0 ? 10 : 0) +
          (r.notes && r.notes.length > 20 ? 1 : 0),
      }));
      scored.sort((a, b) => b.score - a.score);
      const [keep, ...losers] = scored;
      for (const l of losers) toDelete.add(l.row.id);
    }

    if (toDelete.size === 0) {
      setImportMsg('No duplicate auto rows found per order.');
      setTimeout(() => setImportMsg(''), 5000);
      return;
    }

    if (!window.confirm(
      `Found ${toDelete.size} duplicate auto row${toDelete.size !== 1 ? 's' : ''} ` +
      `across ${groupsWithDupes} eBay order${groupsWithDupes !== 1 ? 's' : ''}.\n\n` +
      `For each (order, row type) pair, the most up-to-date row is kept and the rest are deleted. ` +
      `Manual transactions are not touched.\n\nContinue?`,
    )) return;

    const cleaned = all.filter((t) => !toDelete.has(t.id));
    await window.storage.set(KEY, cleaned);
    setImportMsg(`Removed ${toDelete.size} duplicate auto row${toDelete.size !== 1 ? 's' : ''} across ${groupsWithDupes} order${groupsWithDupes !== 1 ? 's' : ''}.`);
    setTimeout(() => setImportMsg(''), 6000);
  }

  const years = useMemo(() => {
    const s = new Set(transactions.map(t => parseInt(t.date.slice(0, 4))).filter(Boolean));
    s.add(currentYear());
    return [...s].sort().reverse();
  }, [transactions]);

  // Year KPIs powering the summary strip
  const yearStats = useMemo(() => {
    const inYear = transactions.filter(t => t.date?.startsWith(`${year}-`));
    const income  = inYear.filter(t => t.type === 'income').reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
    const expense = inYear.filter(t => t.type === 'expense').reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
    const net = income - expense;
    // This month
    const ym = new Date().toISOString().slice(0, 7);
    const inMonth = inYear.filter(t => t.date?.startsWith(ym));
    const mtdIncome  = inMonth.filter(t => t.type === 'income').reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
    const mtdExpense = inMonth.filter(t => t.type === 'expense').reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
    return { income, expense, net, mtdIncome, mtdExpense, count: inYear.length };
  }, [transactions, year]);

  // Top-level view selector. Previously this was a dead `tab` state plus
  // six modal triggers; collapsing the modals into real tabs eliminates the
  // close-loses-context problem the user kept hitting.
  const [tab, setTab] = useState('ledger'); // 'ledger' | 'cashflow' | 'reports' | 'tax' | 'ebay-match' | 'monthly'
  const [ledgerCategoryFilter, setLedgerCategoryFilter] = useState(null);
  const [monthlyFocus, setMonthlyFocus] = useState(null); // 'YYYY-MM' string for Monthly Summary deep-link
  const [financesSubTab, setFinancesSubTab] = useState('per-event'); // 'per-event' | 'monthly-match'

  // Ledger-scoped date range. Tax / Reports / Overview / CashFlow remain
  // year-scoped (their charts assume a full 12-month bucket set). The range
  // picker only narrows the Ledger table — that's where drilling into a
  // specific month / quarter / custom window is actually useful.
  const [range, setRange] = useState(() => ({ mode: 'year' })); // { mode: 'year' | 'quarter' | 'month' | 'custom', quarter?, month?, from?, to? }

  const inLedgerRange = useCallback((dateStr) => {
    if (!dateStr) return false;
    if (!dateStr.startsWith(`${year}-`)) return false;
    if (range.mode === 'year') return true;
    if (range.mode === 'quarter') {
      const m = parseInt(dateStr.slice(5, 7), 10);
      const q = Math.ceil(m / 3);
      return q === (range.quarter || 1);
    }
    if (range.mode === 'month') {
      return dateStr.startsWith(`${year}-${String(range.month || 1).padStart(2, '0')}`);
    }
    if (range.mode === 'custom') {
      if (range.from && dateStr < range.from) return false;
      if (range.to   && dateStr > range.to)   return false;
      return true;
    }
    return true;
  }, [range, year]);

  const ledgerScoped = useMemo(
    () => transactions.filter(t => inLedgerRange(t.date)),
    [transactions, inLedgerRange],
  );

  const rangeLabel = useMemo(() => {
    if (range.mode === 'quarter') return `Q${range.quarter || 1} ${year}`;
    if (range.mode === 'month')   return `${MONTHS[(range.month || 1) - 1]} ${year}`;
    if (range.mode === 'custom') {
      if (range.from && range.to) return `${range.from} → ${range.to}`;
      if (range.from)             return `from ${range.from}`;
      if (range.to)               return `through ${range.to}`;
      return `Custom range — ${year}`;
    }
    return `${year}`;
  }, [range, year]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h1 className="text-xl md:text-2xl font-semibold text-fg tracking-tight flex items-center gap-2">
            <BookOpen className="w-5 h-5 text-accent" /> Bookkeeping
          </h1>
          <p className="text-xs text-fg-muted hidden md:block">Income, expenses, and tax estimates</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {years.length > 1 ? (
            <Tabs
              size="sm"
              value={year}
              onChange={(v) => setYear(parseInt(v))}
              items={years.map(y => ({ id: y, label: String(y) }))}
            />
          ) : (
            <Select value={year} onChange={e => setYear(parseInt(e.target.value))} className="w-24">
              {years.map(y => <option key={y}>{y}</option>)}
            </Select>
          )}
          <Button variant="secondary" size="sm" onClick={() => exportCSV(transactions, year)} title={`Export ${year} transactions as CSV`}>
            <Download /> Export
          </Button>
          <Button variant="secondary" size="sm" onClick={() => csvInputRef.current?.click()}>
            <Upload /> CSV
          </Button>
          <input ref={csvInputRef} type="file" accept=".csv" className="hidden" onChange={handleCSVImport} />
          <Button variant="secondary" size="sm" onClick={() => setShowImport(true)}>
            <Upload /> eBay
          </Button>

          {/* Tools dropdown — bundles the five destructive cleanup commands
              that used to clutter the header. Each one rewrites or removes
              transactions, so they're tucked behind a click to prevent
              accidental fires. */}
          <div className="relative" ref={toolsRef}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowTools(v => !v)}
              title="Maintenance tools — rebuild auto rows, dedupe, cleanup"
            >
              <Wrench /> Tools <ChevronDown className="w-3 h-3 -ml-0.5" />
            </Button>
            {showTools && (
              <div className="absolute right-0 top-full mt-1 z-40 w-64 bg-surface border border-border-subtle rounded-lg shadow-lg overflow-hidden">
                <button
                  type="button"
                  onClick={() => { setShowTools(false); setShowCatManager(true); }}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-muted/40 flex items-start gap-2"
                  title="Add custom income / expense categories alongside the defaults."
                >
                  <Tag className="w-3.5 h-3.5 mt-0.5 text-fg-muted shrink-0" />
                  <span>
                    <span className="block font-medium text-fg">Manage Categories</span>
                    <span className="block text-[10px] text-fg-subtle">Add custom income / expense categories</span>
                  </span>
                </button>
                <div className="border-t border-border-subtle" />
                <button
                  type="button"
                  onClick={() => { setShowTools(false); handleRebuildAutoRows(); }}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-muted/40 flex items-start gap-2"
                  title="Rewrite every auto-recorded sale row with correct gross/fees/shipping split. Manual rows untouched."
                >
                  <RefreshCw className="w-3.5 h-3.5 mt-0.5 text-fg-muted shrink-0" />
                  <span>
                    <span className="block font-medium text-fg">Rebuild auto rows</span>
                    <span className="block text-[10px] text-fg-subtle">Rewrite from sales history</span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => { setShowTools(false); handleCleanupAutoStubs(); }}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-muted/40 flex items-start gap-2"
                  title="Remove stub inventory items (and their bookkeeping rows) that were auto-created from eBay orders during a now-reverted sync experiment."
                >
                  <Trash2 className="w-3.5 h-3.5 mt-0.5 text-fg-muted shrink-0" />
                  <span>
                    <span className="block font-medium text-fg">Cleanup stubs</span>
                    <span className="block text-[10px] text-fg-subtle">Remove auto-stub inventory + rows</span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => { setShowTools(false); handleCleanupDuplicateSales(); }}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-muted/40 flex items-start gap-2"
                  title="Find inventory items that share the same eBay order ID. Keeps the most complete one; removes the rest along with their bookkeeping rows."
                >
                  <Trash2 className="w-3.5 h-3.5 mt-0.5 text-fg-muted shrink-0" />
                  <span>
                    <span className="block font-medium text-fg">Dedupe sales</span>
                    <span className="block text-[10px] text-fg-subtle">Items sharing an order ID</span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => { setShowTools(false); handleCleanupDuplicateTransactions(); }}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-muted/40 flex items-start gap-2"
                  title="Find duplicate transaction rows (same date, amount, description, source). Keeps the oldest of each duplicate set."
                >
                  <Trash2 className="w-3.5 h-3.5 mt-0.5 text-fg-muted shrink-0" />
                  <span>
                    <span className="block font-medium text-fg">Dedupe rows</span>
                    <span className="block text-[10px] text-fg-subtle">Exact-match transaction dupes</span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => { setShowTools(false); handleDedupeByOrder(); }}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-muted/40 flex items-start gap-2"
                  title="Find auto-recorded rows where the same eBay order ID appears more than once per row type. Keeps the most up-to-date row per (order, type)."
                >
                  <Trash2 className="w-3.5 h-3.5 mt-0.5 text-fg-muted shrink-0" />
                  <span>
                    <span className="block font-medium text-fg">Dedupe by order</span>
                    <span className="block text-[10px] text-fg-subtle">Auto rows duplicated per order</span>
                  </span>
                </button>
              </div>
            )}
          </div>

          <Button variant="secondary" size="sm" onClick={() => setShowLotPurchase(true)} title="Quick entry for a liquidation / sourcing lot purchase">
            <Package /> Add Lot Purchase
          </Button>
          <Button variant="accent" size="sm" onClick={() => { setEditingTx(null); setShowForm(true); }}>
            <Plus /> Add
          </Button>
        </div>
      </div>

      {/* Summary strip — 4 compact KPI tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card padding="sm" radius="lg" className="card-hover">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">{year} Income</p>
          <p className="text-lg font-semibold font-mono text-success tabular-nums mt-0.5">
            <FlashOnChange value={Math.round(yearStats.income * 100)}>
              <AnimatedNumber value={yearStats.income} format={(v) => fmt(v)} />
            </FlashOnChange>
          </p>
          <p className="text-[10px] text-fg-subtle">{fmt(yearStats.mtdIncome)} this month</p>
        </Card>
        <Card padding="sm" radius="lg" className="card-hover">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">{year} Expenses</p>
          <p className="text-lg font-semibold font-mono text-danger tabular-nums mt-0.5">
            <FlashOnChange value={Math.round(yearStats.expense * 100)}>
              <AnimatedNumber value={yearStats.expense} format={(v) => fmt(v)} />
            </FlashOnChange>
          </p>
          <p className="text-[10px] text-fg-subtle">{fmt(yearStats.mtdExpense)} this month</p>
        </Card>
        <Card padding="sm" radius="lg" className="card-hover">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">Net</p>
          <p className={`text-lg font-semibold font-mono tabular-nums mt-0.5 ${profitCls(yearStats.net)}`}>
            <FlashOnChange value={Math.round(yearStats.net * 100)}>
              <AnimatedNumber value={yearStats.net} format={(v) => fmt(v)} />
            </FlashOnChange>
          </p>
          <p className="text-[10px] text-fg-subtle">{yearStats.count} transaction{yearStats.count !== 1 ? 's' : ''}</p>
        </Card>
        <Card padding="sm" radius="lg" className="card-hover">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">Est. Tax Due</p>
          <p className="text-lg font-semibold font-mono text-warning tabular-nums mt-0.5">
            <FlashOnChange value={Math.round(estimateTax(yearStats.net, year).total)}>
              <AnimatedNumber value={estimateTax(yearStats.net, year).total} format={(v) => fmt(v)} />
            </FlashOnChange>
          </p>
          <p className="text-[10px] text-fg-subtle">~{fmt(estimateTax(yearStats.net, year).quarterly)} quarterly</p>
        </Card>
      </div>

      {importMsg && (
        <div className="bg-success-subtle border border-success/20 rounded-lg px-4 py-2.5 text-sm text-success-fg font-medium">
          {importMsg}
        </div>
      )}

      {/* Tab bar — real tabs replacing the modal triggers. Closing a modal
          used to lose context (scroll, filters); the tabs persist. The
          ledger remains the default landing tab. */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="overflow-x-auto -mx-1 px-1">
          <Tabs
            size="sm"
            value={tab}
            onChange={setTab}
            items={[
              { id: 'ledger',      label: 'Ledger',          icon: BookOpen },
              { id: 'overview',    label: 'Overview',        icon: PieIcon },
              { id: 'cashflow',    label: 'Cash Flow',       icon: TrendingUp },
              { id: 'reports',     label: 'Reports',         icon: FileBarChart },
              { id: 'tax',         label: 'Tax',             icon: Receipt },
              { id: 'ebay-match',  label: 'eBay Finances',   icon: ClipboardCheck },
              { id: 'monthly',     label: 'Monthly Summary', icon: FileText },
            ]}
          />
        </div>

        {/* Range picker — only useful on the Ledger; hidden elsewhere so the
            yearly chart/report views don't appear to be filtered when
            they're actually showing the full year. */}
        {tab === 'ledger' && (
          <div className="flex items-center gap-2 text-xs flex-wrap">
            <span className="text-fg-subtle uppercase tracking-wider text-[10px] font-semibold">View</span>
            <Select size="sm" value={range.mode} onChange={(e) => {
              const mode = e.target.value;
              setRange(prev => ({
                mode,
                quarter: prev.quarter || (Math.ceil((new Date().getMonth() + 1) / 3)),
                month:   prev.month   || (new Date().getMonth() + 1),
                from:    prev.from    || `${year}-01-01`,
                to:      prev.to      || `${year}-12-31`,
              }));
            }} className="w-24">
              <option value="year">Year</option>
              <option value="quarter">Quarter</option>
              <option value="month">Month</option>
              <option value="custom">Custom</option>
            </Select>
            {range.mode === 'quarter' && (
              <Select size="sm" value={range.quarter || 1} onChange={(e) => setRange(r => ({ ...r, quarter: parseInt(e.target.value) }))} className="w-20">
                <option value={1}>Q1</option>
                <option value={2}>Q2</option>
                <option value={3}>Q3</option>
                <option value={4}>Q4</option>
              </Select>
            )}
            {range.mode === 'month' && (
              <Select size="sm" value={range.month || 1} onChange={(e) => setRange(r => ({ ...r, month: parseInt(e.target.value) }))} className="w-24">
                {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </Select>
            )}
            {range.mode === 'custom' && (
              <>
                <DatePicker value={range.from || ''} onChange={(v) => setRange(r => ({ ...r, from: v }))} />
                <span className="text-fg-subtle">→</span>
                <DatePicker value={range.to || ''} onChange={(v) => setRange(r => ({ ...r, to: v }))} />
              </>
            )}
            <span className="text-fg-muted">· {ledgerScoped.length} row{ledgerScoped.length !== 1 ? 's' : ''}</span>
          </div>
        )}
      </div>

      {/* Primary view */}
      {loading ? (
        <div className="space-y-3">
          <div className="h-8 w-48 shimmer rounded-lg" />
          <div className="h-32 shimmer rounded-xl" />
          <div className="h-64 shimmer rounded-xl" />
        </div>
      ) : (
        <>
          {tab === 'ledger' && (
            <TransactionsTab
              transactions={ledgerScoped}
              lots={appState.lots}
              onAdd={() => setShowForm(true)}
              onEdit={handleEdit}
              onDelete={handleDelete}
              initialCategoryFilter={ledgerCategoryFilter}
              onCategoryFilterClear={() => setLedgerCategoryFilter(null)}
            />
          )}
          {tab === 'overview' && (
            <Card padding="lg" radius="lg">
              <div className="mb-4">
                <h2 className="text-base font-semibold text-fg">{year} Overview</h2>
                <p className="text-xs text-fg-muted">Charts and category breakdown — full year</p>
              </div>
              <OverviewTab transactions={transactions} year={year} />
            </Card>
          )}
          {tab === 'cashflow' && (
            <Card padding="lg" radius="lg">
              <div className="mb-4">
                <h2 className="text-base font-semibold text-fg">{year} Cash Flow</h2>
                <p className="text-xs text-fg-muted">Monthly income vs expenses</p>
              </div>
              <CashFlowTab transactions={transactions} year={year} />
            </Card>
          )}
          {tab === 'reports' && (
            <Card padding="lg" radius="lg">
              <div className="mb-4">
                <h2 className="text-base font-semibold text-fg">{year} Reports</h2>
                <p className="text-xs text-fg-muted">Category-level P&L summary</p>
              </div>
              <ReportsTab transactions={transactions} year={year} />
            </Card>
          )}
          {tab === 'tax' && (
            <div className="space-y-3">
              <ReconciliationCard year={year} transactions={transactions} />
              <Card padding="lg" radius="lg">
                <div className="mb-4">
                  <h2 className="text-base font-semibold text-fg">{year} Tax Estimate</h2>
                  <p className="text-xs text-fg-muted">Federal income + self-employment tax projection</p>
                </div>
                <TaxTab transactions={transactions} year={year} />
              </Card>
            </div>
          )}
          {tab === 'ebay-match' && (
            <Card padding="lg" radius="lg">
              <div className="mb-4 flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <h2 className="text-base font-semibold text-fg">eBay Finances</h2>
                  <p className="text-xs text-fg-muted">Per-event ledger from the eBay Finances API + monthly summary cross-reference</p>
                </div>
                <Tabs
                  size="sm"
                  value={financesSubTab}
                  onChange={setFinancesSubTab}
                  items={[
                    { id: 'per-event',     label: 'Per-Event Ledger' },
                    { id: 'monthly-match', label: 'Monthly Match' },
                  ]}
                />
              </div>
              {financesSubTab === 'per-event' && (
                <PerEventLedgerTab year={year} transactions={transactions} />
              )}
              {financesSubTab === 'monthly-match' && (
                <EbayMatchTab transactions={transactions} lots={appState.lots} />
              )}
            </Card>
          )}
          {tab === 'monthly' && (
            <Card padding="lg" radius="lg">
              <div className="mb-4">
                <h2 className="text-base font-semibold text-fg">Import Monthly Summary</h2>
                <p className="text-xs text-fg-muted">Manually enter the totals from eBay's official monthly statement. This locks the month so auto-sync won't add per-sale rows on top.</p>
              </div>
              <MonthlySummaryTab onSaved={() => setTab('ledger')} initialMonth={monthlyFocus} />
            </Card>
          )}
        </>
      )}

      {showForm && (
        <TxModal
          initial={editingTx}
          onSave={handleSave}
          onClose={() => { setShowForm(false); setEditingTx(null); }}
          incomeCats={incomeCats}
          expenseCats={expenseCats}
        />
      )}
      {showCatManager && (
        <CategoryManagerModal
          incomeCats={incomeCats}
          expenseCats={expenseCats}
          onSave={(nextIncome, nextExpense) => persistCategories(nextIncome, nextExpense)}
          onClose={() => setShowCatManager(false)}
        />
      )}
      {showImport && (
        <EbayImportModal
          onImport={handleEbayImport}
          onClose={() => setShowImport(false)}
        />
      )}
      {showLotPurchase && (
        <LotPurchaseModal
          onSave={handleLotPurchase}
          onClose={() => setShowLotPurchase(false)}
        />
      )}
    </div>
  );
}
