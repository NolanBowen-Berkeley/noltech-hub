// ─── MonthlySummaryTab ───────────────────────────────────────────────────────
// Replaces per-sale auto-rows with rolled-up totals from eBay's official
// monthly statement. Used when the user doesn't trust the auto-imported
// Finance API data for a given month and wants the eBay-published numbers
// of record.
//
// Flow:
//   1. User picks YYYY-MM (typically a past month)
//   2. Enters: gross sales, platform fees, ad fees, shipping label cost,
//      refunds (optional)
//   3. Clicks Save → creates 4-5 summary transactions tagged with
//      source: 'manual_summary' on the last day of that month, AND locks
//      the month so future auto-syncs skip it.
//   4. If the month already had auto rows, offers to remove them first.

import { useState, useEffect, useMemo } from 'react';
import { Lock, Unlock, AlertCircle, Save, Trash2 } from 'lucide-react';
import { Button, Input, Label } from '../../components/ui';
import { fmt } from '../../utils/formatters';
import { lockMonth, unlockMonth, getLockedMonths, subscribeLockedMonths } from '../../utils/lockedMonths';
import eventBus from '../../services/eventBus';

const KEY = 'noltech:books:transactions';

function uid() {
  return crypto.randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2));
}

// Last day of a YYYY-MM as YYYY-MM-DD. Used as the date stamp for all
// summary rows so they sort to the end of the month they cover.
function lastDayOf(yyyymm) {
  if (!/^\d{4}-\d{2}$/.test(yyyymm)) return null;
  const [y, m] = yyyymm.split('-').map(Number);
  const d = new Date(y, m, 0).getDate();   // m=4 → April → 30
  return `${yyyymm}-${String(d).padStart(2, '0')}`;
}

// Pretty month label (e.g., "January 2026")
function formatYM(yyyymm) {
  if (!/^\d{4}-\d{2}$/.test(yyyymm)) return yyyymm;
  const [y, m] = yyyymm.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

const inputCls =
  'w-full border border-border rounded-lg px-3 py-2.5 text-sm text-fg bg-surface ' +
  'focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors';

export default function MonthlySummaryTab({ onSaved, initialMonth }) {
  // Default to the most recent fully-completed month, OR an upstream-supplied
  // YYYY-MM if the user deep-linked here from the Locked Months strip.
  const defaultMonth = useMemo(() => {
    if (initialMonth && /^\d{4}-\d{2}$/.test(initialMonth)) return initialMonth;
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }, [initialMonth]);

  const [month, setMonth]                   = useState(defaultMonth);

  // When parent supplies a new initialMonth (locked-months chip click), jump
  // to that month AND clear the form. The previous version only swapped the
  // month — typed draft values stuck around and would overwrite the wrong
  // YYYY-MM bucket if the user pressed Save. Resetting on every jump is the
  // safe default; the user can always retype.
  const [grossSales, setGrossSales]         = useState('');
  const [platformFees, setPlatformFees]     = useState('');
  const [adFees, setAdFees]                 = useState('');
  const [shippingLabels, setShippingLabels] = useState('');
  const [refunds, setRefunds]               = useState('');
  const [notes, setNotes]                   = useState('');

  const [lockedMonths, setLockedMonths] = useState([]);
  const [existingAutoRows, setExistingAutoRows] = useState({ count: 0, total: 0 });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    getLockedMonths().then(setLockedMonths);
    return subscribeLockedMonths(setLockedMonths);
  }, []);

  // initialMonth jump from parent (LockedMonthsStrip chip click). Updates
  // the picker AND clears every form field so a draft from the prior month
  // can't accidentally be saved against the wrong YYYY-MM. Status banner
  // also clears so the user sees a fresh slate, not stale "Saved!" copy.
  useEffect(() => {
    if (!initialMonth) return;
    setMonth(initialMonth);
    setGrossSales('');
    setPlatformFees('');
    setAdFees('');
    setShippingLabels('');
    setRefunds('');
    setNotes('');
    setStatus(null);
  }, [initialMonth]);

  // When the user picks a month, scan existing transactions to see if
  // there are already auto-imported rows there. We surface the count so
  // they can decide whether to wipe + replace, or keep both.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const all = (await window.storage.get(KEY)) || [];
      if (cancelled) return;
      const isAutoSource = (s) => /^auto_/.test(String(s || '')) || s === 'auto_sale';
      const matching = all.filter((t) =>
        t?.date?.startsWith(`${month}-`) && isAutoSource(t.source),
      );
      const total = matching.reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
      setExistingAutoRows({ count: matching.length, total });
    })().catch(() => {});
    return () => { cancelled = true; };
  }, [month]);

  const isLocked = lockedMonths.includes(month);

  async function handleSave({ removeExisting }) {
    if (!/^\d{4}-\d{2}$/.test(month)) {
      setStatus({ type: 'error', msg: 'Pick a valid month' });
      return;
    }

    const gross = parseFloat(grossSales) || 0;
    const fees  = parseFloat(platformFees) || 0;
    const ads   = parseFloat(adFees) || 0;
    const ship  = parseFloat(shippingLabels) || 0;
    const refs  = parseFloat(refunds) || 0;

    if (gross <= 0 && fees <= 0 && ship <= 0 && ads <= 0 && refs <= 0) {
      setStatus({ type: 'error', msg: 'Enter at least one total to import' });
      return;
    }

    setBusy(true);
    try {
      const all = (await window.storage.get(KEY)) || [];
      const date = lastDayOf(month);
      const monthLabel = formatYM(month);
      const importBatch = `manual_summary:${month}`;

      let working = all.slice();

      // Remove existing auto rows for this month if requested. Manual rows
      // and other-source rows are NEVER touched.
      if (removeExisting) {
        working = working.filter((t) => {
          const inMonth = t?.date?.startsWith(`${month}-`);
          const isAuto = /^auto_/.test(String(t?.source || '')) || t?.source === 'auto_sale';
          return !(inMonth && isAuto);
        });
      }

      // Also wipe any prior manual_summary rows for this same month so the
      // user can re-save with corrected numbers without ending up with two
      // sets of summary rows.
      working = working.filter((t) => t?.importId !== `${importBatch}:income`
        && t?.importId !== `${importBatch}:fees`
        && t?.importId !== `${importBatch}:adfees`
        && t?.importId !== `${importBatch}:shipping`
        && t?.importId !== `${importBatch}:refunds`);

      const newRows = [];
      const newRow = (data) => ({
        id: uid(),
        source: 'manual_summary',
        date,
        notes: notes ? `${notes}` : `eBay official monthly summary for ${monthLabel}.`,
        ...data,
      });

      if (gross > 0) newRows.push(newRow({
        importId: `${importBatch}:income`,
        type: 'income',
        category: 'eBay Sales',
        description: `eBay gross sales — ${monthLabel}`,
        amount: Math.round(gross * 100) / 100,
      }));
      if (fees > 0) newRows.push(newRow({
        importId: `${importBatch}:fees`,
        type: 'expense',
        category: 'eBay Fees',
        description: `eBay platform fees — ${monthLabel}`,
        amount: Math.round(fees * 100) / 100,
      }));
      if (ads > 0) newRows.push(newRow({
        importId: `${importBatch}:adfees`,
        type: 'expense',
        category: 'eBay Ad Fees',
        description: `eBay ad / promoted listing fees — ${monthLabel}`,
        amount: Math.round(ads * 100) / 100,
      }));
      if (ship > 0) newRows.push(newRow({
        importId: `${importBatch}:shipping`,
        type: 'expense',
        category: 'Shipping',
        description: `eBay shipping label expenses — ${monthLabel}`,
        amount: Math.round(ship * 100) / 100,
      }));
      if (refs > 0) newRows.push(newRow({
        importId: `${importBatch}:refunds`,
        type: 'expense',
        category: 'Refunds',
        description: `Buyer refunds — ${monthLabel}`,
        amount: Math.round(refs * 100) / 100,
      }));

      working = [...newRows, ...working];
      await window.storage.set(KEY, working);

      // Lock the month so future syncs skip it
      await lockMonth(month);

      // Notify the Bookkeeping component (and any other transactions
      // listeners — Dashboard, Reports, charts) that the data changed so
      // they reload from storage. Without this, the saved rows sit in
      // IndexedDB but the rendered list keeps the stale state.
      eventBus.emit('sync:array-updated', { storageKey: KEY });

      const removedNote = removeExisting && existingAutoRows.count > 0
        ? ` Removed ${existingAutoRows.count} prior auto row${existingAutoRows.count !== 1 ? 's' : ''}.`
        : '';
      setStatus({
        type: 'success',
        msg: `Saved ${newRows.length} summary row${newRows.length !== 1 ? 's' : ''} for ${monthLabel} and locked the month.${removedNote}`,
      });
      setTimeout(() => onSaved?.(), 1800);
    } catch (e) {
      setStatus({ type: 'error', msg: e.message || String(e) });
    } finally {
      setBusy(false);
    }
  }

  const total = (parseFloat(grossSales) || 0)
    - (parseFloat(platformFees) || 0)
    - (parseFloat(adFees) || 0)
    - (parseFloat(shippingLabels) || 0)
    - (parseFloat(refunds) || 0);

  return (
    <div className="space-y-5">
      {/* Lock status pill */}
      <div className="flex items-center gap-2 text-xs">
        {isLocked ? (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-success-subtle text-success font-medium">
            <Lock size={12} /> {formatYM(month)} is locked — auto-sync won't add rows for this month
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-muted text-fg-muted font-medium">
            <Unlock size={12} /> {formatYM(month)} is currently unlocked
          </span>
        )}
        {isLocked && (
          <button
            onClick={async () => {
              await unlockMonth(month);
              setStatus({ type: 'info', msg: `Unlocked ${formatYM(month)} — auto-sync will write rows for this month again.` });
            }}
            className="text-xs text-fg-muted hover:text-danger transition-colors"
          >
            Unlock
          </button>
        )}
      </div>

      {/* Existing auto rows warning */}
      {existingAutoRows.count > 0 && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-warning-subtle border border-warning/30 text-xs">
          <AlertCircle size={14} className="text-warning shrink-0 mt-0.5" />
          <div>
            <p className="font-medium text-fg">
              {existingAutoRows.count} auto-imported transaction{existingAutoRows.count !== 1 ? 's' : ''} already exist for {formatYM(month)}
            </p>
            <p className="text-fg-muted mt-0.5">
              Total: {fmt(Math.abs(existingAutoRows.total))}. Use the "Save & replace auto rows" button below to remove them so you don't double-count.
            </p>
          </div>
        </div>
      )}

      {/* Month picker */}
      <div>
        <Label>Month to import</Label>
        <input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className={inputCls + ' max-w-xs'}
        />
      </div>

      {/* Numbers grid — match eBay's monthly statement labels */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Gross sales (income)" placeholder="6543.21" value={grossSales} onChange={setGrossSales} />
        <Field label="Platform fees (expense)" placeholder="612.45" value={platformFees} onChange={setPlatformFees} />
        <Field label="Ad / promoted fees (expense)" placeholder="84.20" value={adFees} onChange={setAdFees} />
        <Field label="Shipping labels (expense)" placeholder="430.10" value={shippingLabels} onChange={setShippingLabels} />
        <Field label="Refunds issued (expense)" placeholder="0.00" value={refunds} onChange={setRefunds} />
      </div>

      {/* Optional note */}
      <div>
        <Label>Note (optional)</Label>
        <Input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. From eBay Payments → Reports → Monthly statement"
        />
      </div>

      {/* Net preview */}
      {(parseFloat(grossSales) || parseFloat(platformFees) || parseFloat(adFees) || parseFloat(shippingLabels) || parseFloat(refunds)) > 0 && (
        <div className="rounded-lg bg-muted/50 p-3 text-sm">
          <span className="text-fg-muted">Net for {formatYM(month)}: </span>
          <span className={`font-mono font-semibold ${total >= 0 ? 'text-success' : 'text-danger'}`}>
            {fmt(total)}
          </span>
        </div>
      )}

      {/* Status */}
      {status && (
        <div className={`text-xs p-2.5 rounded-lg ${
          status.type === 'success' ? 'bg-success-subtle text-success' :
          status.type === 'error' ? 'bg-danger-subtle text-danger' :
          'bg-muted text-fg-muted'
        }`}>
          {status.msg}
        </div>
      )}

      {/* Save buttons */}
      <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-border-subtle">
        {existingAutoRows.count > 0 && (
          <Button
            variant="danger"
            size="sm"
            disabled={busy}
            onClick={() => handleSave({ removeExisting: true })}
            title="Replace this month's existing auto rows with the manual summary"
          >
            <Trash2 /> Save &amp; replace auto rows
          </Button>
        )}
        <Button
          variant="primary"
          size="sm"
          disabled={busy}
          onClick={() => handleSave({ removeExisting: false })}
        >
          <Save /> {existingAutoRows.count > 0 ? 'Save (keep existing)' : 'Save monthly summary'}
        </Button>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder }) {
  return (
    <div>
      <Label>{label}</Label>
      <Input
        type="number"
        step="0.01"
        min="0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="font-mono tabular-nums"
      />
    </div>
  );
}
