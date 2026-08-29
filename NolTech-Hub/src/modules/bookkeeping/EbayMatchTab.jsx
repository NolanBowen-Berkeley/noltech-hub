// ─── eBay Match Tab ──────────────────────────────────────────────────────────
// Monthly summary view that mirrors eBay's seller dashboard "Earnings"
// breakdown. Lets the user cross-reference NolTech Hub bookkeeping totals
// against eBay's reported numbers during testing — same four stat cards
// (Order proceeds, Refunds, Expenses, Net transfers) and a weekly trend chart.

import { useMemo, useState, useEffect, useRef } from 'react';
import { Upload, Check, AlertTriangle, X as XIcon } from 'lucide-react';
import { Card } from '../../components/ui';
import { fmt, localDateStr } from '../../utils/formatters';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function formatMonthLabel(year, monthIdx) {
  return `${MONTH_NAMES[monthIdx]} ${year}`;
}

function pad2(n) { return String(n).padStart(2, '0'); }

function dateRangeLabel(year, monthIdx) {
  const first = `${MONTH_NAMES[monthIdx].slice(0, 3)} 01, ${year}`;
  const lastDay = new Date(year, monthIdx + 1, 0).getDate();
  const last = `${MONTH_NAMES[monthIdx].slice(0, 3)} ${pad2(lastDay)}, ${year}`;
  return `${first} - ${last}`;
}

// Parse a date input into a YYYY-MM-DD value matched against the seller's
// LOCAL calendar — so calendar-month math here lines up with what eBay's
// seller UI shows. eBay's Trading API returns soldAt as a UTC ISO timestamp;
// the seller-UI label is in seller-local time. Bookkeeping rows already
// store local-converted YYYY-MM-DD, so those pass through unchanged.
function parseYMD(input) {
  const local = localDateStr(input);
  if (!local) return null;
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return {
    year:  parseInt(m[1], 10),
    month: parseInt(m[2], 10) - 1, // 0-indexed to match Date.getMonth()
    day:   parseInt(m[3], 10),
    raw:   local,
  };
}

// Pull a granular sale record from any input shape (live inventory item or
// sales:history entry). Returns null if the sale isn't in the requested
// month or isn't an eBay sale.
function buildSaleRow({ itemId, sale, brand, model, sku, year, monthIdx, fromHistory = false }) {
  if (!sale) return null;
  if ((sale.platform || 'ebay') !== 'ebay') return null;
  const ymd = parseYMD(sale.soldAt);
  if (!ymd) return null;
  if (ymd.year !== year || ymd.month !== monthIdx) return null;
  return {
    itemId,
    fromHistory,    // true when the row was sourced from sales:history rather
                    // than the live inventory item — likely a stale record if
                    // there's no matching live inventory.
    date:          new Date(ymd.year, ymd.month, ymd.day), // local-time, matches the YYYY-MM-DD slice
    day:           ymd.day,
    title:         `${brand || ''} ${model || ''}`.trim() || sale.itemName || 'Item Sale',
    sku:           sku || sale.sku || '',
    orderId:       sale.id || '',
    subtotal:      Number(sale.subtotal)      || 0,
    buyerShipping: Number(sale.buyerShipping) || 0,
    salesTax:      Number(sale.salesTax)      || 0,
    platformFees:  Number(sale.platformFees)  || 0,
    labelCost:     Number(sale.labelCost)     || Number(sale.shippingCost) || 0,
    labelCostFromFinances: sale.labelCostSource === 'finances',
    labelCostKnown: !!sale.labelCostKnown || (Number(sale.labelCost) > 0),
    salePrice:     Number(sale.salePrice)     || 0,
    feeBreakdown:  sale.feeBreakdown || {},
    adFee: (() => {
      const fb = sale.feeBreakdown || {};
      let ad = 0;
      for (const [k, v] of Object.entries(fb)) {
        if (/^(ad[_ ]?fee|promot|promoted)/i.test(k)) ad += Number(v) || 0;
      }
      return Math.round(ad * 100) / 100;
    })(),
  };
}

// Walk every sold inventory item AND every sales:history record, pull eBay
// sales whose soldAt falls in the requested month. Live inventory wins on
// financial fields (Finances API updates land there); sales:history fills
// in cases where the inventory item was deleted or never had brand/model.
// Names fall through brand+model → sale.itemName → history brand+model.
//
// History-only rows (item not in live inventory) are gated by `validItemIds`:
// only those that have a matching auto_sale bookkeeping row are shown.
// That way the eBay sales table mirrors what's actually in bookkeeping
// instead of surfacing stale/orphaned history entries from earlier testing.
function collectEbaySalesInMonth(lots, salesHistory, year, monthIdx, validHistoryItemIds) {
  // Build a history map keyed by itemId for name fallback on live items.
  const historyByItemId = {};
  for (const h of salesHistory || []) {
    if (!h?.itemId) continue;
    historyByItemId[h.itemId] = h;
  }

  const seen = new Set();
  const out = [];

  // 1) Live inventory — preferred source for current sale data.
  for (const lot of lots || []) {
    for (const item of lot.items || []) {
      if (!item.sale) continue;
      const histRec = historyByItemId[item.id];
      // Name fallback: live brand/model first, history brand/model when empty.
      const brand = (item.brand && item.brand.trim()) || (histRec?.brand || '').trim();
      const model = (item.model && item.model.trim()) || (histRec?.model || '').trim();
      const row = buildSaleRow({
        itemId: item.id,
        sale: item.sale,
        brand,
        model,
        sku: item.sku || item.serialNumber,
        year,
        monthIdx,
      });
      if (row) {
        out.push(row);
        seen.add(item.id);
      }
    }
  }

  // 2) sales:history — for items that were deleted from inventory but still
  //    have a matching bookkeeping auto_sale row. Flagged with
  //    fromHistory=true so the UI marks them as "history-only" recovery rows.
  //    Skip ones that DON'T have a bookkeeping auto_sale anchor — those are
  //    stale records from earlier testing/syncs that the user already pruned
  //    from bookkeeping (or that never made it in), so showing them here
  //    would just diverge the eBay-match table from the ledger.
  for (const h of salesHistory || []) {
    if (!h?.itemId || seen.has(h.itemId)) continue;
    if (validHistoryItemIds && !validHistoryItemIds.has(h.itemId)) continue;
    const row = buildSaleRow({
      itemId: h.itemId,
      sale: h.sale,
      brand: h.brand,
      model: h.model,
      sku: h.sku,
      year,
      monthIdx,
      fromHistory: true,
    });
    if (row) {
      out.push(row);
      seen.add(h.itemId);
    }
  }

  return out.sort((a, b) => a.date - b.date);
}

// ─── eBay CSV reconciliation ────────────────────────────────────────────────
// Parse an eBay-exported CSV (Earnings / Transaction / Order report). Column
// names vary across report types and over time, so detect them by pattern
// instead of hard-coding indices.

function parseCSVLineLocal(line) {
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

function parseEbayCSV(text) {
  if (!text || typeof text !== 'string') throw new Error('Empty CSV');
  // Strip UTF-8 BOM if present (eBay's exports start with one).
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = text.split(/\r?\n/).map((l) => l).filter((l) => l.length > 0);
  if (!lines.length) throw new Error('CSV has no rows');

  // Find the header row — eBay reports have title/account-info rows above
  // the actual headers. Scan the first 20 rows for one containing an
  // order-number column.
  let headerIdx = -1;
  for (let i = 0; i < Math.min(20, lines.length); i++) {
    const cells = parseCSVLineLocal(lines[i]).map((c) => c.toLowerCase());
    if (cells.some((c) => /\border\s*(number|no\.?|id)\b/i.test(c))) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) throw new Error('Could not find an "Order number" column. This may not be an eBay report CSV.');

  const headers = parseCSVLineLocal(lines[headerIdx]).map((h) => h.toLowerCase().trim());

  const findCol = (...patterns) => {
    for (const pat of patterns) {
      const idx = headers.findIndex((h) => pat.test(h));
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const cols = {
    date:        findCol(/transaction creation date/, /^date$/, /transaction date/, /paid (on|date)/, /sold (on|date)/),
    type:        findCol(/^type$/, /transaction type/),
    orderId:     findCol(/order number/, /order no\.?$/, /\border id\b/),
    title:       findCol(/item title/, /item name/, /^description$/),
    buyer:       findCol(/buyer username/, /^buyer$/),
    gross:       findCol(/gross (transaction )?amount/, /^gross$/),
    subtotal:    findCol(/item subtotal/, /^subtotal$/),
    shipping:    findCol(/shipping(?: and| &)? handling/, /^shipping$/, /^postage$/),
    refunds:     findCol(/^refunds?$/, /refund amount/),
    fvfFixed:    findCol(/final value fee.*fixed/, /final value fee$/, /fvf$/, /^fee$/),
    fvfVariable: findCol(/final value fee.*variable/, /fvf.*variable/, /variable.*fee/),
    regFee:      findCol(/regulatory operating fee/, /regulatory.*fee/),
    intFee:      findCol(/international fee/, /cross.?border/),
    deposit:     findCol(/deposit processing fee/),
    inadFee:     findCol(/very high.*item not as described/, /not as described.*fee/),
    perfFee:     findCol(/below standard performance fee/),
    netAmount:   findCol(/order net amount/, /^net amount/, /order earnings/, /^net$/),
  };

  const num = (cells, idx) => {
    if (idx < 0 || idx >= cells.length) return 0;
    const v = String(cells[idx] || '').replace(/[$,\s]/g, '').trim();
    if (!v || v === '--' || v === '-') return 0;
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  };

  const cellAt = (cells, idx) => (idx >= 0 && idx < cells.length) ? String(cells[idx] || '').trim() : '';
  const isPlaceholder = (s) => !s || s === '--' || s === '-';

  // Pass 1 — find every orderId that has an "Order" type row in this export.
  // Orphan rows (e.g. a Shipping label whose Order row was in a previous
  // month's report) are skipped from per-order reconciliation.
  const orderRowIds = new Set();
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = parseCSVLineLocal(lines[i]);
    if (cells.length < 3) continue;
    const type    = cellAt(cells, cols.type).toLowerCase();
    const orderId = cellAt(cells, cols.orderId);
    if (isPlaceholder(orderId)) continue;
    if (type === 'order') orderRowIds.add(orderId);
  }

  // Pass 2 — aggregate by orderId, using row TYPE to decide which fields
  // each row contributes to. eBay's Transaction report splits each order
  // across 3+ rows: one "Order" row (gross/subtotal/shipping/column fees),
  // one or more "Shipping label" rows (negative gross = label cost), and
  // "Other fee" rows for Promoted Listings / regulatory adjustments.
  const byOrderId = new Map();
  let parsedRowCount = 0;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = parseCSVLineLocal(lines[i]);
    if (cells.length < 3) continue;
    const orderId = cellAt(cells, cols.orderId);
    if (isPlaceholder(orderId)) continue;
    if (!orderRowIds.has(orderId)) continue; // orphan row — skip
    parsedRowCount++;

    const type     = cellAt(cells, cols.type).toLowerCase();
    const grossAmt = num(cells, cols.gross); // signed (Order row positive, fee/label rows negative)

    if (!byOrderId.has(orderId)) {
      byOrderId.set(orderId, {
        orderId,
        date: '', type: '', title: '', buyer: '',
        gross: 0, subtotal: 0, shipping: 0,
        fees: 0, label: 0, refunds: 0,
        netAmount: 0, rowCount: 0,
        // Itemize fees so the user can audit which buckets contributed.
        feeBreakdown: { fvfFixed: 0, fvfVariable: 0, intFee: 0, regFee: 0, adFee: 0, otherFee: 0 },
      });
    }
    const agg = byOrderId.get(orderId);
    agg.rowCount += 1;

    if (type === 'order') {
      // Authoritative row — captures the order's totals.
      agg.gross    = grossAmt;
      agg.subtotal = num(cells, cols.subtotal);
      agg.shipping = num(cells, cols.shipping);
      agg.date     = cellAt(cells, cols.date)  || agg.date;
      agg.title    = cellAt(cells, cols.title) || agg.title;
      agg.buyer    = cellAt(cells, cols.buyer) || agg.buyer;
      agg.type     = type;
      // Column-based fees (always negative — flip with abs):
      const fvfF = Math.abs(num(cells, cols.fvfFixed));
      const fvfV = Math.abs(num(cells, cols.fvfVariable));
      const reg  = Math.abs(num(cells, cols.regFee));
      const intl = Math.abs(num(cells, cols.intFee));
      const dep  = Math.abs(num(cells, cols.deposit));
      const inad = Math.abs(num(cells, cols.inadFee));
      const perf = Math.abs(num(cells, cols.perfFee));
      agg.feeBreakdown.fvfFixed    += fvfF;
      agg.feeBreakdown.fvfVariable += fvfV;
      agg.feeBreakdown.intFee      += intl;
      agg.feeBreakdown.regFee      += reg;
      agg.feeBreakdown.otherFee    += dep + inad + perf;
      agg.fees += fvfF + fvfV + reg + intl + dep + inad + perf;
      agg.netAmount = num(cells, cols.netAmount);
    } else if (/shipping label/i.test(type)) {
      agg.label += Math.abs(grossAmt);
    } else if (/other fee/i.test(type) || /^fee$/i.test(type)) {
      // Promoted Listings ad fees, regulatory adjustments, etc. — appear as
      // separate rows. Their cost is the magnitude of gross.
      const amt = Math.abs(grossAmt);
      agg.fees += amt;
      agg.feeBreakdown.adFee += amt;
    } else if (/refund/i.test(type)) {
      agg.refunds += Math.abs(grossAmt);
    }
    // Other types (payout, transfer, hold, etc.) ignored intentionally.
  }

  if (parsedRowCount === 0) throw new Error('Header row found but no order rows matched. Is this the right report?');

  // Round for display stability.
  const r2 = (n) => Math.round(n * 100) / 100;
  const orders = Array.from(byOrderId.values()).map((o) => ({
    ...o,
    gross:    r2(o.gross),
    subtotal: r2(o.subtotal),
    shipping: r2(o.shipping),
    fees:     r2(o.fees),
    label:    r2(o.label),
    refunds:  r2(o.refunds),
    netAmount: r2(o.netAmount),
    feeBreakdown: Object.fromEntries(Object.entries(o.feeBreakdown).map(([k, v]) => [k, r2(v)])),
  }));
  return { orders, parsedRowCount, detectedColumns: cols };
}

// Diff NolTech sales (one per item; multiple rows can share an orderId for
// multi-quantity orders) against eBay CSV orders (one per orderId).
function reconcileSales(noltechSales, ebayOrders) {
  // Aggregate NolTech sales by orderId so multi-quantity orders match a
  // single eBay row.
  const noltechByOrderId = new Map();
  for (const s of noltechSales || []) {
    if (!s.orderId) continue;
    if (!noltechByOrderId.has(s.orderId)) {
      noltechByOrderId.set(s.orderId, { orderId: s.orderId, items: [], gross: 0, subtotal: 0, shipping: 0, fees: 0, label: 0, earnings: 0 });
    }
    const agg = noltechByOrderId.get(s.orderId);
    agg.items.push(s);
    agg.subtotal += s.subtotal;
    agg.shipping += s.buyerShipping;
    agg.fees     += s.platformFees;
    agg.label    += s.labelCost;
  }
  for (const v of noltechByOrderId.values()) {
    v.gross    = Math.round((v.subtotal + v.shipping) * 100) / 100;
    v.earnings = Math.round((v.gross - v.fees - v.label) * 100) / 100;
    v.subtotal = Math.round(v.subtotal * 100) / 100;
    v.shipping = Math.round(v.shipping * 100) / 100;
    v.fees     = Math.round(v.fees * 100) / 100;
    v.label    = Math.round(v.label * 100) / 100;
  }

  const ebayByOrderId = new Map(ebayOrders.map((o) => [o.orderId, o]));

  const allOrderIds = new Set([
    ...noltechByOrderId.keys(),
    ...ebayByOrderId.keys(),
  ]);

  const result = [];
  for (const orderId of allOrderIds) {
    const noltech = noltechByOrderId.get(orderId) || null;
    const ebay    = ebayByOrderId.get(orderId)    || null;

    let status; // 'match' | 'mismatch' | 'noltech-only' | 'ebay-only'
    const diffs = [];

    if (noltech && ebay) {
      // Compare gross / fees / label separately. Tolerate $0.01 rounding.
      const grossDiff = Math.round((noltech.gross - ebay.gross) * 100) / 100;
      const feesDiff  = Math.round((noltech.fees  - ebay.fees)  * 100) / 100;
      const labelDiff = Math.round((noltech.label - ebay.label) * 100) / 100;
      if (Math.abs(grossDiff) > 0.01) diffs.push({ field: 'gross', delta: grossDiff });
      if (Math.abs(feesDiff)  > 0.01) diffs.push({ field: 'fees',  delta: feesDiff });
      if (Math.abs(labelDiff) > 0.01) diffs.push({ field: 'label', delta: labelDiff });
      status = diffs.length ? 'mismatch' : 'match';
    } else if (noltech) {
      status = 'noltech-only';
    } else {
      status = 'ebay-only';
    }

    result.push({ orderId, status, noltech, ebay, diffs });
  }

  // Sort: mismatches first, then ebay-only, then noltech-only, then matches.
  const order = { mismatch: 0, 'ebay-only': 1, 'noltech-only': 2, match: 3 };
  result.sort((a, b) => order[a.status] - order[b.status]);

  return result;
}

// Tag every transaction in the month with which bucket (if any) it
// contributes to in the eBay-match summary.
function classifyTx(t) {
  if (t.source === 'auto_fees' || t.source === 'auto_adfee') return 'Fees';
  if (t.source === 'auto_shipping') return 'Shipping label';
  if (/returns? *(&|and)? *refund/i.test(t.category || '')) return 'Refund';
  if (/claim/i.test(t.category || ''))   return 'Claim';
  if (/dispute/i.test(t.category || '')) return 'Dispute';
  if (t.source !== 'auto_fees' && t.source !== 'auto_adfee'
      && /(ebay|platform).*(fee)|fee.*(ebay|platform)|ad fee/i.test(`${t.category || ''} ${t.description || ''}`)
      && t.type === 'expense') return 'Fees';
  if (t.source !== 'auto_shipping'
      && /(postage|freight|shipping label|usps|ups|fedex)/i.test(`${t.category || ''} ${t.description || ''}`)
      && t.type === 'expense'
      && /ebay/i.test(t.supplier || '')) return 'Shipping label';
  if (t.source === 'auto_sale') return 'Sale (income)';
  return null; // not used in the eBay-match calculation
}

// Filter transactions to a given calendar month — match by YYYY-MM-DD string
// to stay consistent with how bookkeeping stores dates (no timezone drift).
function txsInMonth(transactions, year, monthIdx) {
  return (transactions || []).filter((t) => {
    const ymd = parseYMD(t?.date);
    if (!ymd) return false;
    return ymd.year === year && ymd.month === monthIdx;
  });
}

// Sum amounts on transactions matching a predicate.
function sumIf(txs, pred) {
  let s = 0;
  for (const t of txs) {
    if (pred(t)) s += Number(t.amount) || 0;
  }
  return Math.round(s * 100) / 100;
}

// Bucket sales into 6 weekly windows that match eBay's chart breakdown
// (Apr 1-4, Apr 5-11, Apr 12-18, Apr 19-25, Apr 26-end). Returns an array of
// { range, subtotal, shipping, tax, total } for charting.
function bucketWeekly(year, monthIdx, sales) {
  const lastDay = new Date(year, monthIdx + 1, 0).getDate();
  const firstDow = new Date(year, monthIdx, 1).getDay(); // 0 = Sun
  // eBay's pattern: first bucket = day 1 → first Sunday; subsequent buckets =
  // Mon-Sun runs; final bucket = last Mon → end of month.
  const buckets = [];
  let cursor = 1;
  // First partial week ends on the next Sunday (or day 7 max).
  const firstSunday = firstDow === 0 ? 1 : (8 - firstDow);
  const firstEnd = Math.min(lastDay, firstSunday);
  buckets.push({ start: 1, end: firstEnd });
  cursor = firstEnd + 1;
  while (cursor <= lastDay) {
    const end = Math.min(lastDay, cursor + 6);
    buckets.push({ start: cursor, end });
    cursor = end + 1;
  }
  return buckets.map((b) => {
    const monthShort = MONTH_NAMES[monthIdx].slice(0, 3);
    const inBucket = sales.filter((s) => s.day >= b.start && s.day <= b.end);
    const subtotal = inBucket.reduce((s, x) => s + x.subtotal, 0);
    const shipping = inBucket.reduce((s, x) => s + x.buyerShipping, 0);
    const tax      = inBucket.reduce((s, x) => s + x.salesTax, 0);
    return {
      range: `${monthShort} ${b.start} - ${b.start === b.end ? b.end : b.end}`,
      label: `${monthShort} ${b.start}${b.start === b.end ? '' : `-${b.end}`}`,
      total: Math.round((subtotal + shipping) * 100) / 100,
      subtotal: Math.round(subtotal * 100) / 100,
      shipping: Math.round(shipping * 100) / 100,
      tax:      Math.round(tax * 100) / 100,
    };
  });
}

export default function EbayMatchTab({ transactions, lots }) {
  const today = new Date();
  const [year, setYear]                 = useState(today.getFullYear());
  const [monthIdx, setMonthIdx]         = useState(today.getMonth());
  const [salesHistory, setSalesHistory] = useState([]);
  const [skippedLog, setSkippedLog]     = useState({ syncedAt: null, orders: [] });
  const [csvOrders, setCsvOrders]       = useState(null);   // parsed eBay rows
  const [csvFileName, setCsvFileName]   = useState('');
  const [csvError, setCsvError]         = useState('');
  const csvInputRef                     = useRef(null);

  // Year options — span 2 years back through next year to keep it tight.
  const years = [];
  for (let y = today.getFullYear() - 2; y <= today.getFullYear() + 1; y++) years.push(y);

  // Sales-history is the recovery source for items deleted from inventory and
  // for naming items whose live brand/model fields are empty.
  useEffect(() => {
    window.storage.get('noltech:sales:history')
      .then((v) => { if (Array.isArray(v)) setSalesHistory(v); })
      .catch((e) => console.error('[EbayMatchTab] sales history load failed:', e));
  }, []);

  // Skipped-orders log gets rewritten on every Sync All. Reload after each
  // sync so the user sees the latest gap analysis without manually refreshing.
  useEffect(() => {
    const load = () => {
      window.storage.get('noltech:sync:skipped-orders')
        .then((v) => {
          if (v && typeof v === 'object' && Array.isArray(v.orders)) setSkippedLog(v);
          else setSkippedLog({ syncedAt: null, orders: [] });
        })
        .catch((e) => console.error('[EbayMatchTab] skipped log load failed:', e));
    };
    load();
    import('../../services/eventBus').then(({ default: eventBus }) => {
      const unsub = eventBus.on('sync:all-complete', load);
      return unsub;
    });
  }, []);

  const skippedForMonth = useMemo(() => {
    return (skippedLog.orders || []).filter((o) => {
      const ymd = parseYMD(o.date);
      if (!ymd) return false;
      return ymd.year === year && ymd.month === monthIdx;
    });
  }, [skippedLog, year, monthIdx]);

  // ── eBay CSV upload + reconciliation ───────────────────────────────────
  const handleCsvUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCsvError('');
    setCsvFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const { orders } = parseEbayCSV(String(ev.target.result || ''));
        setCsvOrders(orders);
      } catch (err) {
        console.error('[EbayMatchTab] CSV parse failed:', err);
        setCsvError(err.message || 'Could not parse the CSV.');
        setCsvOrders(null);
      }
    };
    reader.onerror = () => {
      setCsvError('Could not read the file.');
      setCsvOrders(null);
    };
    reader.readAsText(file);
    // Reset the input so the same file can be re-uploaded after edits.
    e.target.value = '';
  };

  const clearCsv = () => {
    setCsvOrders(null);
    setCsvFileName('');
    setCsvError('');
  };

  const monthTxs = useMemo(() => txsInMonth(transactions, year, monthIdx), [transactions, year, monthIdx]);

  // Build the set of itemIds that have a matching auto_sale bookkeeping row
  // for the current month. We only surface sales:history-only rows whose
  // itemId is in this set — that keeps the eBay sales table consistent with
  // what bookkeeping actually has, instead of leaking orphaned history rows.
  const validHistoryItemIds = useMemo(() => {
    const ids = new Set();
    for (const t of monthTxs) {
      if (t.source !== 'auto_sale' || !t.importId) continue;
      const m = t.importId.match(/^auto:([^:]+):/);
      if (m) ids.add(m[1]);
    }
    return ids;
  }, [monthTxs]);

  const sales = useMemo(
    () => collectEbaySalesInMonth(lots, salesHistory, year, monthIdx, validHistoryItemIds),
    [lots, salesHistory, year, monthIdx, validHistoryItemIds],
  );

  // Reconciliation result, scoped to the currently selected month — both
  // sides are filtered already (NolTech via `sales`, eBay via the CSV's date
  // matching the selected month if a date column was detected; if not we
  // compare every CSV row against every NolTech sale, since eBay reports
  // are usually exported for a single month already).
  const csvOrdersForMonth = useMemo(() => {
    if (!csvOrders) return [];
    return csvOrders.filter((o) => {
      if (!o.date) return true; // no date column — assume the export is already filtered
      const ymd = parseYMD(o.date);
      if (!ymd) return true;
      return ymd.year === year && ymd.month === monthIdx;
    });
  }, [csvOrders, year, monthIdx]);

  const reconciliation = useMemo(
    () => csvOrders ? reconcileSales(sales, csvOrdersForMonth) : null,
    [csvOrders, csvOrdersForMonth, sales],
  );

  const reconStats = useMemo(() => {
    if (!reconciliation) return null;
    const stats = { match: 0, mismatch: 0, 'noltech-only': 0, 'ebay-only': 0 };
    for (const r of reconciliation) stats[r.status]++;
    return stats;
  }, [reconciliation]);

  // ── Order proceeds ─ (item subtotal + shipping + seller-collected tax) ────
  // eBay's "Order proceeds" sums everything the buyer paid that flows through
  // the seller account, before refunds/expenses come out. For US sellers eBay
  // remits sales tax directly so seller-collected tax is typically $0.
  const itemSubtotal      = Math.round(sales.reduce((s, x) => s + x.subtotal, 0) * 100) / 100;
  const shippingHandling  = Math.round(sales.reduce((s, x) => s + x.buyerShipping, 0) * 100) / 100;
  const sellerCollectedTax = 0; // eBay remits — never the seller
  const discount          = 0; // not currently tracked
  const orderProceeds = Math.round((itemSubtotal + shippingHandling + sellerCollectedTax + discount) * 100) / 100;

  // ── Refunds ───────────────────────────────────────────────────────────────
  // Transactions categorized as Returns & Refunds (manual or auto). eBay
  // splits gross refunds / claims / payment disputes — we don't categorize
  // that finely yet, so claims and disputes default to $0 unless the user has
  // tagged them via category.
  const grossRefunds = sumIf(monthTxs, (t) => /(refund|return)/i.test(t.category || ''));
  const grossClaims = sumIf(monthTxs, (t) => /claim/i.test(t.category || ''));
  const grossDisputes = sumIf(monthTxs, (t) => /dispute/i.test(t.category || ''));
  const refundsTotal = -Math.round((grossRefunds + grossClaims + grossDisputes) * 100) / 100;

  // ── Expenses ──────────────────────────────────────────────────────────────
  // Fees (auto_fees + auto_adfee + any manual eBay-Fees rows) and shipping
  // label cost (auto_shipping + manual postage rows when supplier is eBay).
  const feesFromAuto    = sumIf(monthTxs, (t) => t.source === 'auto_fees' || t.source === 'auto_adfee');
  const feesFromManual  = sumIf(monthTxs, (t) => t.source !== 'auto_fees' && t.source !== 'auto_adfee'
    && /(ebay|platform).*(fee)|fee.*(ebay|platform)|ad fee/i.test(`${t.category || ''} ${t.description || ''}`)
    && t.type === 'expense');
  const totalFees = Math.round((feesFromAuto + feesFromManual) * 100) / 100;

  const labelsFromAuto = sumIf(monthTxs, (t) => t.source === 'auto_shipping');
  const labelsFromManual = sumIf(monthTxs, (t) => t.source !== 'auto_shipping'
    && /(postage|freight|shipping label|usps|ups|fedex)/i.test(`${t.category || ''} ${t.description || ''}`)
    && t.type === 'expense'
    && /ebay/i.test(t.supplier || ''));
  const totalLabels = Math.round((labelsFromAuto + labelsFromManual) * 100) / 100;

  const expensesTotal = -Math.round((totalFees + totalLabels) * 100) / 100;

  // ── Net transfers ─────────────────────────────────────────────────────────
  // Approximated as: Order proceeds + Refunds + Expenses (i.e. what should
  // flow to the bank). eBay shows it as "Charges" + "Payouts"; we don't track
  // a direct payout feed inside Bookkeeping, so this is a derived figure.
  const charges = 0;
  const payouts = -(orderProceeds + refundsTotal + expensesTotal);
  const netTransfers = Math.round((charges + payouts) * 100) / 100;

  const weekly = useMemo(() => bucketWeekly(year, monthIdx, sales), [year, monthIdx, sales]);

  return (
    <div className="space-y-4">
      {/* Date range selector */}
      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={monthIdx}
          onChange={(e) => setMonthIdx(parseInt(e.target.value, 10))}
          className="text-xs border border-border rounded-lg px-2.5 py-1.5 bg-surface"
        >
          {MONTH_NAMES.map((m, i) => <option key={m} value={i}>{m}</option>)}
        </select>
        <select
          value={year}
          onChange={(e) => setYear(parseInt(e.target.value, 10))}
          className="text-xs border border-border rounded-lg px-2.5 py-1.5 bg-surface"
        >
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <span className="text-xs text-fg-muted ml-1">{dateRangeLabel(year, monthIdx)}</span>
        <span className="text-xs text-fg-subtle ml-auto">
          {sales.length} eBay sale{sales.length !== 1 ? 's' : ''} · {monthTxs.length} bookkeeping row{monthTxs.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Four stat cards — mirrors eBay's earnings dashboard */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        {/* Order proceeds */}
        <Card padding="md" radius="lg" className="border-2 border-primary/40 ring-1 ring-primary/10">
          <p className="text-sm font-semibold text-fg">Order proceeds</p>
          <p className="text-2xl font-bold font-mono text-fg mt-1 mb-3">{fmt(orderProceeds)}</p>
          <div className="space-y-1 text-xs">
            <Row label="Item subtotal"         value={fmt(itemSubtotal)} />
            <Row label="Discount"              value={fmt(discount)} />
            <Row label="Seller collected tax"  value={fmt(sellerCollectedTax)} />
            <Row label="Shipping and handling" value={fmt(shippingHandling)} />
          </div>
        </Card>

        {/* Refunds */}
        <Card padding="md" radius="lg">
          <p className="text-sm font-semibold text-fg">Refunds</p>
          <p className="text-2xl font-bold font-mono text-danger mt-1 mb-3">{fmt(refundsTotal)}</p>
          <div className="space-y-1 text-xs">
            <Row label="Gross refunds"          value={fmt(-grossRefunds)} />
            <Row label="Gross claims"           value={fmt(-grossClaims)} />
            <Row label="Gross payment disputes" value={fmt(-grossDisputes)} />
          </div>
        </Card>

        {/* Expenses */}
        <Card padding="md" radius="lg">
          <p className="text-sm font-semibold text-fg">Expenses</p>
          <p className="text-2xl font-bold font-mono text-danger mt-1 mb-3">{fmt(expensesTotal)}</p>
          <div className="space-y-1 text-xs">
            <Row label="Fees"            value={fmt(-totalFees)} />
            <Row label="Shipping labels" value={fmt(-totalLabels)} />
          </div>
        </Card>

        {/* Net transfers */}
        <Card padding="md" radius="lg">
          <p className="text-sm font-semibold text-fg">Net transfers</p>
          <p className={`text-2xl font-bold font-mono mt-1 mb-3 ${netTransfers >= 0 ? 'text-fg' : 'text-danger'}`}>{fmt(netTransfers)}</p>
          <div className="space-y-1 text-xs">
            <Row label="Charges" value={fmt(charges)} />
            <Row label="Payouts" value={fmt(payouts)} />
          </div>
          <p className="text-[10px] text-fg-subtle mt-2 italic">Derived: proceeds + refunds + expenses</p>
        </Card>
      </div>

      {/* Order proceeds detail + weekly chart */}
      <Card padding="md" radius="lg">
        <div className="flex items-baseline justify-between mb-3">
          <div>
            <p className="text-sm font-semibold text-fg">Order proceeds</p>
            <p className="text-2xl font-bold font-mono text-fg">{fmt(orderProceeds)}</p>
          </div>
          <p className="text-[11px] text-fg-muted">{formatMonthLabel(year, monthIdx)}</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-[180px_1fr] gap-4">
          <div className="space-y-1.5 text-xs border-r border-border-subtle pr-4">
            <p className="text-[10px] uppercase tracking-wide text-fg-subtle mb-1.5">{formatMonthLabel(year, monthIdx)}</p>
            <Row label="Item subtotal"         value={fmt(itemSubtotal)} />
            <Row label="Discount"              value={fmt(discount)} />
            <Row label="Seller collected…"     value={fmt(sellerCollectedTax)} />
            <Row label="Shipping and ha…"      value={fmt(shippingHandling)} />
          </div>
          <div className="h-56">
            {weekly.some((w) => w.total > 0) ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={weekly} margin={{ top: 8, right: 24, bottom: 8, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="label" stroke="#64748b" fontSize={11} />
                  <YAxis stroke="#64748b" fontSize={11} tickFormatter={(v) => `$${v >= 1000 ? `${Math.round(v / 1000)}K` : v}`} />
                  <Tooltip
                    formatter={(v) => fmt(v)}
                    labelFormatter={(l) => l}
                    contentStyle={{ fontSize: 12 }}
                  />
                  <Line type="linear" dataKey="total" stroke="#2E86C1" strokeWidth={2} dot={{ r: 3 }} name={formatMonthLabel(year, monthIdx)} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-xs text-fg-muted">
                No sales recorded for {formatMonthLabel(year, monthIdx)}.
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* Source items breakdown — every sale + transaction the totals were built from */}
      <Card padding="md" radius="lg">
        <div className="flex items-baseline justify-between mb-3">
          <p className="text-sm font-semibold text-fg">Source items</p>
          <p className="text-[11px] text-fg-muted">
            {sales.length} sale{sales.length !== 1 ? 's' : ''} · {monthTxs.filter((t) => classifyTx(t)).length} contributing transaction{monthTxs.filter((t) => classifyTx(t)).length !== 1 ? 's' : ''}
          </p>
        </div>

        {/* eBay sales — drives Order proceeds */}
        {sales.length > 0 ? (
          <div className="mb-4">
            <p className="text-[10px] uppercase tracking-wide text-fg-subtle mb-1.5">
              eBay sales (drives Order proceeds) — order ID column should match the Order no. on eBay's report
            </p>
            <div className="border border-border-subtle rounded-lg overflow-hidden">
              <div className="grid grid-cols-14 gap-2 px-2.5 py-1.5 bg-subtle text-[10px] uppercase tracking-wide text-fg-muted font-semibold" style={{ gridTemplateColumns: 'repeat(14, minmax(0, 1fr))' }}>
                <span className="col-span-1">Date</span>
                <span className="col-span-2">Order ID</span>
                <span className="col-span-3">Item</span>
                <span className="col-span-1 text-right">Sub</span>
                <span className="col-span-1 text-right">Ship</span>
                <span className="col-span-1 text-right">Fees</span>
                <span className="col-span-1 text-right">AdFee</span>
                <span className="col-span-1 text-right">Label</span>
                <span className="col-span-1 text-right">Gross</span>
                <span className="col-span-2 text-right">Earnings</span>
              </div>
              <div className="divide-y divide-border max-h-64 overflow-auto">
                {sales.map((s, i) => {
                  const grossAmt = s.subtotal + s.buyerShipping;
                  const expenses = s.platformFees + s.labelCost;
                  const earnings = Math.round((grossAmt - expenses) * 100) / 100;
                  const phantom  = !s.orderId; // a sale with no eBay order ID is suspect
                  const rowBg = s.fromHistory
                    ? 'bg-warning-subtle/60'   // came from sales:history, not in live inventory
                    : phantom
                      ? 'bg-warning-subtle/60'  // missing order ID
                      : '';
                  return (
                    <div
                      key={s.itemId || i}
                      className={`grid gap-2 px-2.5 py-1.5 text-[11px] items-center ${rowBg}`}
                      style={{ gridTemplateColumns: 'repeat(14, minmax(0, 1fr))' }}
                    >
                      <span className="col-span-1 text-fg-muted">{s.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                      <span className="col-span-2 font-mono text-[10px] truncate" title={s.orderId || 'No eBay order ID — likely phantom record'}>
                        {s.orderId || <span className="text-warning font-semibold">⚠ no order ID</span>}
                      </span>
                      <span className="col-span-3 truncate text-fg flex items-center gap-1" title={s.title}>
                        <span className="truncate">{s.title}</span>
                        {s.fromHistory && (
                          <span
                            className="shrink-0 text-[9px] px-1 py-0.5 bg-warning-subtle text-warning rounded font-semibold"
                            title="From sales:history — the inventory item no longer exists. Probably a stale record from earlier syncs/testing if there's no matching eBay order."
                          >
                            history
                          </span>
                        )}
                      </span>
                      <span className="col-span-1 text-right font-mono">{fmt(s.subtotal)}</span>
                      <span className="col-span-1 text-right font-mono text-fg-muted">{fmt(s.buyerShipping)}</span>
                      <span className="col-span-1 text-right font-mono text-danger">{fmt(s.platformFees - s.adFee)}</span>
                      <span className="col-span-1 text-right font-mono text-danger">{fmt(s.adFee)}</span>
                      <span className="col-span-1 text-right font-mono text-danger" title={s.labelCostFromFinances ? 'From eBay Finances API' : (s.labelCostKnown ? 'Estimated (matches buyer-paid shipping)' : 'Unknown')}>
                        {fmt(s.labelCost)}{!s.labelCostFromFinances && s.labelCostKnown && <span className="text-warning ml-0.5">~</span>}
                      </span>
                      <span className="col-span-1 text-right font-mono">{fmt(grossAmt)}</span>
                      <span className={`col-span-2 text-right font-mono font-semibold ${earnings >= 0 ? 'text-success' : 'text-danger'}`}>
                        {fmt(earnings)}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div className="grid gap-2 px-2.5 py-1.5 bg-subtle text-[11px] font-semibold border-t border-border" style={{ gridTemplateColumns: 'repeat(14, minmax(0, 1fr))' }}>
                <span className="col-span-6 text-fg">Total ({sales.length} sale{sales.length !== 1 ? 's' : ''})</span>
                <span className="col-span-1 text-right font-mono">{fmt(itemSubtotal)}</span>
                <span className="col-span-1 text-right font-mono">{fmt(shippingHandling)}</span>
                <span className="col-span-1 text-right font-mono text-danger">{fmt(sales.reduce((s, x) => s + (x.platformFees - x.adFee), 0))}</span>
                <span className="col-span-1 text-right font-mono text-danger">{fmt(sales.reduce((s, x) => s + x.adFee, 0))}</span>
                <span className="col-span-1 text-right font-mono text-danger">{fmt(sales.reduce((s, x) => s + x.labelCost, 0))}</span>
                <span className="col-span-1 text-right font-mono">{fmt(sales.reduce((s, x) => s + x.subtotal + x.buyerShipping, 0))}</span>
                <span className="col-span-2 text-right font-mono">{fmt(sales.reduce((s, x) => s + x.subtotal + x.buyerShipping - x.platformFees - x.labelCost, 0))}</span>
              </div>
            </div>
            {sales.some((s) => !s.orderId) && (
              <p className="text-[11px] text-warning mt-1 font-medium">
                ⚠ {sales.filter((s) => !s.orderId).length} sale{sales.filter((s) => !s.orderId).length !== 1 ? 's' : ''} ha{sales.filter((s) => !s.orderId).length === 1 ? 's' : 've'} no eBay order ID — these probably aren't real eBay orders. Check the inventory item, mark as "not sold", or delete the orphaned sale record.
              </p>
            )}
            {sales.some((s) => s.fromHistory) && (
              <div className="mt-2 px-3 py-2 bg-warning-subtle border border-warning/30 rounded-lg text-[11px] text-warning">
                <p className="font-semibold mb-0.5">
                  {sales.filter((s) => s.fromHistory).length} row{sales.filter((s) => s.fromHistory).length !== 1 ? 's' : ''} marked &quot;history&quot; — inventory item no longer exists
                </p>
                <p className="leading-relaxed mb-1.5">
                  These came from <code className="font-mono text-[10px] bg-surface/60 px-1 rounded">noltech:sales:history</code>, an append-only log of every sale event. If they don&apos;t match an order on eBay&apos;s Earnings report, they&apos;re likely stale records from earlier testing or syncs and can be cleaned up.
                </p>
                <button
                  type="button"
                  onClick={async () => {
                    const stale = sales.filter((s) => s.fromHistory);
                    if (!stale.length) return;
                    if (!confirm(
                      `Delete ${stale.length} stale sales:history record${stale.length !== 1 ? 's' : ''} from ${MONTH_NAMES[monthIdx]} ${year}?\n\n` +
                      `These are sales whose inventory items no longer exist. Bookkeeping rows are NOT touched — only the sales:history log is cleaned up.\n\n` +
                      `Sales to be removed:\n` +
                      stale.map((s) => `· ${s.title} — ${s.orderId || '(no order id)'}`).join('\n')
                    )) return;
                    try {
                      const removeIds = new Set(stale.map((s) => s.itemId));
                      const removeOrderIds = new Set(stale.map((s) => s.orderId).filter(Boolean));
                      const next = (salesHistory || []).filter((h) => {
                        if (h?.itemId && removeIds.has(h.itemId)) return false;
                        if (h?.sale?.id && removeOrderIds.has(h.sale.id)) return false;
                        return true;
                      });
                      await window.storage.set('noltech:sales:history', next);
                      setSalesHistory(next);
                    } catch (e) {
                      console.error('[EbayMatchTab] cleanup failed:', e);
                      alert(`Cleanup failed: ${e.message}`);
                    }
                  }}
                  className="text-[11px] px-2 py-1 bg-warning text-white rounded hover:bg-warning/90 font-medium"
                >
                  Clean up {sales.filter((s) => s.fromHistory).length} stale history record{sales.filter((s) => s.fromHistory).length !== 1 ? 's' : ''}
                </button>
              </div>
            )}
            {sales.some((s) => s.labelCostKnown && !s.labelCostFromFinances) && (
              <p className="text-[10px] text-warning mt-1 flex items-center gap-1">
                <span className="font-mono">~</span> = label cost is an estimate (buyer-paid shipping). Run Sync All so the Finances API can supply the real figure.
              </p>
            )}
          </div>
        ) : (
          <div className="text-xs text-fg-muted italic mb-4">No eBay sales for this month yet.</div>
        )}

        {/* Bookkeeping transactions — drives Refunds + Expenses */}
        <div>
          <p className="text-[10px] uppercase tracking-wide text-fg-subtle mb-1.5">Bookkeeping transactions (drives Refunds + Expenses)</p>
          <div className="border border-border-subtle rounded-lg overflow-hidden">
            <div className="grid grid-cols-12 gap-2 px-2.5 py-1.5 bg-subtle text-[10px] uppercase tracking-wide text-fg-muted font-semibold">
              <span className="col-span-2">Date</span>
              <span className="col-span-2">Source</span>
              <span className="col-span-2">Category</span>
              <span className="col-span-3">Description</span>
              <span className="col-span-2">Bucket</span>
              <span className="col-span-1 text-right">Amount</span>
            </div>
            <div className="divide-y divide-border max-h-56 overflow-auto">
              {monthTxs.filter((t) => classifyTx(t)).sort((a, b) => (a.date || '').localeCompare(b.date || '')).map((t) => {
                const bucket = classifyTx(t);
                const bucketCls =
                  bucket === 'Sale (income)'   ? 'bg-success-subtle text-success'   :
                  bucket === 'Fees'            ? 'bg-danger-subtle text-danger'       :
                  bucket === 'Shipping label'  ? 'bg-warning-subtle text-warning' :
                  bucket === 'Refund'          ? 'bg-warning-subtle text-warning'   :
                  bucket === 'Claim'           ? 'bg-warning-subtle text-warning'   :
                  bucket === 'Dispute'         ? 'bg-warning-subtle text-warning'   :
                                                 'bg-muted text-fg';
                return (
                  <div key={t.id} className="grid grid-cols-12 gap-2 px-2.5 py-1.5 text-[11px] items-center">
                    <span className="col-span-2 text-fg-muted">{(() => {
                      const ymd = parseYMD(t.date);
                      if (!ymd) return t.date || '';
                      return new Date(ymd.year, ymd.month, ymd.day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                    })()}</span>
                    <span className="col-span-2 text-[10px] font-mono text-fg-subtle truncate" title={t.source}>{t.source || 'manual'}</span>
                    <span className="col-span-2 text-fg truncate" title={t.category}>{t.category || '—'}</span>
                    <span className="col-span-3 text-fg-muted truncate" title={t.description}>{t.description}</span>
                    <span className="col-span-2">
                      <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${bucketCls}`}>{bucket}</span>
                    </span>
                    <span className={`col-span-1 text-right font-mono ${t.type === 'income' ? 'text-success' : 'text-danger'}`}>
                      {t.type === 'income' ? '+' : '-'}{fmt(Math.abs(Number(t.amount) || 0))}
                    </span>
                  </div>
                );
              })}
              {monthTxs.filter((t) => classifyTx(t)).length === 0 && (
                <div className="px-2.5 py-3 text-xs text-fg-muted italic text-center">
                  No bookkeeping rows contribute to refunds / expenses this month.
                </div>
              )}
            </div>
          </div>
        </div>
      </Card>

      {/* Skipped orders — surfaces gaps where Sync All couldn't link an order */}
      <Card padding="md" radius="lg" className={skippedForMonth.length > 0 ? 'border-warning/30 bg-warning-subtle/30' : ''}>
        <div className="flex items-baseline justify-between mb-2 flex-wrap gap-2">
          <div>
            <p className="text-sm font-semibold text-fg flex items-center gap-1.5">
              {skippedForMonth.length > 0 && <AlertTriangle size={14} className="text-warning" />}
              Skipped orders
              {skippedForMonth.length > 0 && (
                <span className="text-[10px] px-1.5 py-0.5 bg-warning-subtle text-warning rounded-full font-bold">
                  {skippedForMonth.length}
                </span>
              )}
            </p>
            <p className="text-[11px] text-fg-muted">
              eBay orders that Sync All couldn&apos;t link to an inventory item (no SKU or eBay item ID match) — no bookkeeping rows created.
            </p>
          </div>
          {skippedLog.syncedAt && (
            <p className="text-[10px] text-fg-subtle">
              Captured {new Date(skippedLog.syncedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            </p>
          )}
        </div>

        {!skippedLog.syncedAt && (
          <div className="bg-subtle border border-dashed border-border rounded-lg p-3 text-center">
            <p className="text-[11px] text-fg-muted">
              No sync log yet. Run <span className="font-semibold text-fg">Sync All</span> to populate this list.
            </p>
          </div>
        )}

        {skippedLog.syncedAt && skippedForMonth.length === 0 && (
          <div className="bg-success-subtle border border-success/30 rounded-lg p-3 text-center">
            <p className="text-[11px] text-success font-medium">
              ✓ Every {formatMonthLabel(year, monthIdx)} eBay order matched an inventory item.
            </p>
          </div>
        )}

        {skippedForMonth.length > 0 && (
          <>
            <div className="border border-border-subtle rounded-lg overflow-hidden bg-surface">
              <div className="grid gap-2 px-2.5 py-1.5 bg-subtle text-[10px] uppercase tracking-wide text-fg-muted font-semibold" style={{ gridTemplateColumns: '70px 130px 1fr 110px 90px 1fr' }}>
                <span>Date</span>
                <span>Order ID</span>
                <span>Item title</span>
                <span>SKU</span>
                <span className="text-right">Gross</span>
                <span>Reason</span>
              </div>
              <div className="divide-y divide-border max-h-64 overflow-auto">
                {skippedForMonth.map((o, i) => {
                  const ymd = parseYMD(o.date);
                  const dateLabel = ymd
                    ? new Date(ymd.year, ymd.month, ymd.day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                    : '—';
                  return (
                    <div key={o.orderId || i} className="grid gap-2 px-2.5 py-1.5 text-[11px] items-center" style={{ gridTemplateColumns: '70px 130px 1fr 110px 90px 1fr' }}>
                      <span className="text-fg-muted">{dateLabel}</span>
                      <span className="font-mono text-[10px] truncate" title={o.orderId}>{o.orderId || '—'}</span>
                      <span className="truncate text-fg" title={o.title}>{o.title || '—'}</span>
                      <span className="font-mono text-[10px] truncate" title={o.sku || o.ebayItemId}>
                        {o.sku || (o.ebayItemId ? `item ${o.ebayItemId}` : <span className="text-fg-subtle italic">none</span>)}
                      </span>
                      <span className="text-right font-mono">{fmt(o.gross)}</span>
                      <span className="text-fg-muted truncate text-[10px]" title={o.reason}>{o.reason}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="flex items-baseline justify-between mt-2">
              <p className="text-[10px] text-warning leading-relaxed">
                Fix by adding inventory items with the right SKU (Inventory module → Add item),
                or by re-running Active Listings Sync to auto-create them from your live eBay listings.
                After that, the next Sync All will pick them up.
              </p>
              <p className="text-[10px] font-mono font-semibold text-warning ml-3 shrink-0">
                Total {fmt(skippedForMonth.reduce((s, o) => s + (o.gross || 0), 0))}
              </p>
            </div>
          </>
        )}
      </Card>

      {/* eBay CSV reconciliation */}
      <Card padding="md" radius="lg">
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <div>
            <p className="text-sm font-semibold text-fg">eBay CSV reconciliation</p>
            <p className="text-[11px] text-fg-muted">Upload eBay&apos;s Earnings/Transaction CSV — every order is checked against your bookkeeping.</p>
          </div>
          <div className="flex items-center gap-2">
            {csvFileName && (
              <span className="text-[11px] text-fg-muted truncate max-w-[200px]" title={csvFileName}>
                {csvFileName}
              </span>
            )}
            {csvOrders && (
              <button
                type="button"
                onClick={clearCsv}
                className="text-[11px] px-2 py-1 rounded border border-border bg-surface text-fg-muted hover:bg-muted/40"
              >
                Clear
              </button>
            )}
            <button
              type="button"
              onClick={() => csvInputRef.current?.click()}
              className="inline-flex items-center gap-1 text-xs px-3 py-1.5 bg-primary text-white rounded-lg hover:bg-primary/90"
            >
              <Upload size={12} /> {csvOrders ? 'Replace CSV' : 'Upload eBay CSV'}
            </button>
            <input
              ref={csvInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={handleCsvUpload}
            />
          </div>
        </div>

        {csvError && (
          <div className="bg-danger-subtle border border-danger/30 text-danger-fg text-[11px] px-3 py-2 rounded mb-2">
            {csvError}
          </div>
        )}

        {!csvOrders && !csvError && (
          <div className="bg-subtle border border-dashed border-border rounded-lg p-4 text-center">
            <p className="text-[11px] text-fg-muted leading-relaxed">
              On eBay: <span className="font-semibold text-fg">Seller Hub → Payments → Reports → Transaction report</span>.<br />
              Pick {formatMonthLabel(year, monthIdx)}, export as CSV, drop it in here. The app diffs every order against your bookkeeping.
            </p>
          </div>
        )}

        {csvOrders && reconStats && (
          <>
            {/* Summary stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
              <ReconStat label="Matched"    count={reconStats.match}          color="success" Icon={Check} />
              <ReconStat label="Mismatch"   count={reconStats.mismatch}       color="warning" Icon={AlertTriangle} />
              <ReconStat label="On eBay only" count={reconStats['ebay-only']}    color="danger"  Icon={XIcon} />
              <ReconStat label="In NolTech only" count={reconStats['noltech-only']} color="danger" Icon={XIcon} />
            </div>

            {/* Per-order diff table */}
            <div className="border border-border-subtle rounded-lg overflow-hidden">
              <div className="grid gap-2 px-2.5 py-1.5 bg-subtle text-[10px] uppercase tracking-wide text-fg-muted font-semibold" style={{ gridTemplateColumns: '90px 130px 1fr 80px 80px 80px 80px 80px 80px 90px' }}>
                <span>Status</span>
                <span>Order ID</span>
                <span>Item / Notes</span>
                <span className="text-right">eBay gross</span>
                <span className="text-right">Hub gross</span>
                <span className="text-right">eBay fees</span>
                <span className="text-right">Hub fees</span>
                <span className="text-right">eBay label</span>
                <span className="text-right">Hub label</span>
                <span className="text-right">Δ</span>
              </div>
              <div className="divide-y divide-border max-h-96 overflow-auto">
                {reconciliation.length === 0 ? (
                  <div className="px-2.5 py-3 text-xs text-fg-muted italic text-center">
                    Nothing to reconcile.
                  </div>
                ) : reconciliation.map((r) => {
                  const e = r.ebay;
                  const n = r.noltech;
                  // Net delta — positive when Hub over-counts net (Hub gross
                  // higher OR Hub expenses lower than eBay).
                  const totalDelta = (n?.gross || 0) - (e?.gross || 0)
                                   + (e?.fees  || 0) - (n?.fees  || 0)
                                   + (e?.label || 0) - (n?.label || 0);
                  let bg = '';
                  let StatusBadge;
                  if (r.status === 'match') {
                    bg = '';
                    StatusBadge = (<span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-success-subtle text-success font-semibold"><Check size={10} />Match</span>);
                  } else if (r.status === 'mismatch') {
                    bg = 'bg-warning-subtle/60';
                    StatusBadge = (<span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-warning-subtle text-warning font-semibold"><AlertTriangle size={10} />Diff</span>);
                  } else if (r.status === 'ebay-only') {
                    bg = 'bg-danger-subtle/60';
                    StatusBadge = (<span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-danger-subtle text-danger font-semibold"><XIcon size={10} />eBay only</span>);
                  } else {
                    bg = 'bg-danger-subtle/60';
                    StatusBadge = (<span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-danger-subtle text-danger font-semibold"><XIcon size={10} />Hub only</span>);
                  }
                  const note = r.diffs.length
                    ? r.diffs.map((d) => `${d.field} Δ ${fmt(d.delta)}`).join(' · ')
                    : (r.status === 'ebay-only'
                        ? 'Order on eBay but no matching bookkeeping row — sync may have missed it'
                        : r.status === 'noltech-only'
                          ? 'Bookkeeping has this order but eBay export does not — phantom or wrong month'
                          : '');
                  const itemTitle = (e?.title || n?.items?.[0]?.title || '').trim() || '—';
                  return (
                    <div key={r.orderId} className={`grid gap-2 px-2.5 py-1.5 text-[11px] items-center ${bg}`} style={{ gridTemplateColumns: '90px 130px 1fr 80px 80px 80px 80px 80px 80px 90px' }}>
                      <span>{StatusBadge}</span>
                      <span className="font-mono text-[10px] truncate" title={r.orderId}>{r.orderId}</span>
                      <span className="truncate">
                        <span className="text-fg" title={itemTitle}>{itemTitle}</span>
                        {note && <span className="text-fg-muted ml-1">· {note}</span>}
                      </span>
                      <span className="text-right font-mono">{e ? fmt(e.gross) : '—'}</span>
                      <span className="text-right font-mono">{n ? fmt(n.gross) : '—'}</span>
                      <span className="text-right font-mono text-danger">{e ? fmt(e.fees) : '—'}</span>
                      <span className="text-right font-mono text-danger">{n ? fmt(n.fees) : '—'}</span>
                      <span className="text-right font-mono text-danger">{e ? fmt(e.label) : '—'}</span>
                      <span className="text-right font-mono text-danger">{n ? fmt(n.label) : '—'}</span>
                      <span className={`text-right font-mono font-semibold ${Math.abs(totalDelta) > 0.01 ? 'text-warning' : 'text-fg-muted'}`}>
                        {Math.abs(totalDelta) > 0.01 ? (totalDelta > 0 ? '+' : '') + fmt(totalDelta) : '—'}
                      </span>
                    </div>
                  );
                })}
              </div>
              {/* Totals footer */}
              <div className="grid gap-2 px-2.5 py-1.5 bg-subtle text-[11px] font-semibold border-t border-border" style={{ gridTemplateColumns: '90px 130px 1fr 80px 80px 80px 80px 80px 80px 90px' }}>
                <span></span>
                <span className="text-fg">Totals</span>
                <span></span>
                <span className="text-right font-mono">{fmt(csvOrdersForMonth.reduce((s, o) => s + o.gross, 0))}</span>
                <span className="text-right font-mono">{fmt(sales.reduce((s, x) => s + x.subtotal + x.buyerShipping, 0))}</span>
                <span className="text-right font-mono text-danger">{fmt(csvOrdersForMonth.reduce((s, o) => s + o.fees, 0))}</span>
                <span className="text-right font-mono text-danger">{fmt(sales.reduce((s, x) => s + x.platformFees, 0))}</span>
                <span className="text-right font-mono text-danger">{fmt(csvOrdersForMonth.reduce((s, o) => s + o.label, 0))}</span>
                <span className="text-right font-mono text-danger">{fmt(sales.reduce((s, x) => s + x.labelCost, 0))}</span>
                <span></span>
              </div>
            </div>

            <p className="text-[10px] text-fg-muted mt-2">
              Loaded {csvOrders.length} eBay order{csvOrders.length !== 1 ? 's' : ''} from CSV
              {csvOrders.length !== csvOrdersForMonth.length && ` · ${csvOrdersForMonth.length} fall in ${formatMonthLabel(year, monthIdx)}`}.
              The Δ column is positive when bookkeeping over-counts net (Hub gross higher OR Hub fees lower than eBay).
            </p>
          </>
        )}
      </Card>

      {/* Cross-reference helper */}
      <Card padding="md" radius="lg" className="bg-warning-subtle/50 border-warning/30">
        <p className="text-xs font-semibold text-warning mb-1">Testing tip</p>
        <p className="text-[11px] text-warning leading-relaxed">
          Open eBay → Payments → Reports → "Earnings" report for {formatMonthLabel(year, monthIdx)} and compare each card here side-by-side.
          Order proceeds + Refunds + Expenses + Net transfers should sum to <span className="font-semibold">$0</span> on eBay
          (it's their accounting identity). Discrepancies usually mean missing label costs (run Sync All to pull Finances API data) or
          unmapped ad fees.
        </p>
      </Card>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-fg-muted truncate">{label}</span>
      <span className="font-mono text-fg shrink-0">{value}</span>
    </div>
  );
}

function ReconStat({ label, count, color, Icon }) {
  const tint =
    color === 'success' ? 'bg-success-subtle border-success/30 text-success' :
    color === 'warning' ? 'bg-warning-subtle border-warning/30 text-warning' :
    color === 'danger'  ? 'bg-danger-subtle border-danger/30 text-danger' :
                          'bg-subtle border-border text-fg';
  return (
    <div className={`border rounded-lg px-3 py-2 ${tint}`}>
      <div className="flex items-center gap-1.5">
        <Icon size={12} />
        <p className="text-[10px] uppercase tracking-wide font-semibold">{label}</p>
      </div>
      <p className="text-xl font-bold font-mono mt-0.5">{count}</p>
    </div>
  );
}
