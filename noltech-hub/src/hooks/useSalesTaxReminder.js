// ─── Quarterly sales-tax filing reminder ─────────────────────────────────────
// Fires a one-time notification ~14 days before each quarterly deadline.
// Prevents duplicate fires by recording the last quarter we reminded for.
//
// CA CDTFA-401-A quarterly deadlines (most states are similar — last day of
// the month following the quarter's close):
//   Q1 (Jan–Mar) → April 30
//   Q2 (Apr–Jun) → July 31
//   Q3 (Jul–Sep) → October 31
//   Q4 (Oct–Dec) → January 31 (next year)
//
// User can dismiss the reminder; we won't re-fire for the same quarter.

import { useEffect } from 'react';
import eventBus from '../services/eventBus';

const KEY_LAST_REMINDED = 'noltech:sales-tax:last-reminded';
const LEAD_DAYS = 14;

function quarterDeadlineFor(year, quarter) {
  // Returns the deadline date for the given quarter (1–4) of the given year
  switch (quarter) {
    case 1: return new Date(year,     3, 30); // Apr 30
    case 2: return new Date(year,     6, 31); // Jul 31
    case 3: return new Date(year,     9, 31); // Oct 31
    case 4: return new Date(year + 1, 0, 31); // Jan 31 next year
    default: return null;
  }
}

function nextQuarterReminder(now = new Date()) {
  // For each quarter starting with the most recently closed, find the first
  // deadline within LEAD_DAYS (and not past the deadline).
  const candidates = [];
  const year = now.getFullYear();
  for (const yr of [year - 1, year, year + 1]) {
    for (const q of [1, 2, 3, 4]) {
      const d = quarterDeadlineFor(yr, q);
      if (!d) continue;
      candidates.push({ year: yr, quarter: q, deadline: d });
    }
  }
  // Pick the soonest upcoming deadline that's within LEAD_DAYS
  const nowMs = now.getTime();
  for (const c of candidates) {
    const d = c.deadline.getTime();
    const diffDays = (d - nowMs) / 86400000;
    if (diffDays >= 0 && diffDays <= LEAD_DAYS) return c;
  }
  return null;
}

export default function useSalesTaxReminder() {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const due = nextQuarterReminder();
      if (!due) return;
      const reminderKey = `${due.year}-Q${due.quarter}`;

      const last = await window.storage.get(KEY_LAST_REMINDED).catch(() => null);
      if (last === reminderKey) return; // already reminded for this quarter
      if (cancelled) return;

      const daysLeft = Math.max(0, Math.ceil((due.deadline.getTime() - Date.now()) / 86400000));
      const dl = due.deadline.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

      eventBus.emit('notification:push', {
        id: `sales-tax-${reminderKey}`,
        type: 'info',
        title: `Sales tax return due in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`,
        message: `Q${due.quarter} ${due.year} deadline is ${dl}. Open Profit & Finance → Sales Tax to grab the number.`,
        ts: new Date().toISOString(),
        // Optional UI hint — apps that read 'action' can deep-link
        action: { type: 'open-view', view: 'finance', tab: 'sales-tax' },
      });

      // Mark as reminded so we don't fire again until the next quarter
      await window.storage.set(KEY_LAST_REMINDED, reminderKey).catch(() => {});
    })();
    return () => { cancelled = true; };
  }, []);
}
