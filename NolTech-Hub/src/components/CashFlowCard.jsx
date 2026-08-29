// ─── Cash Flow / Pending Payouts ──────────────────────────────────────────────
// Pulls eBay's scheduled payouts via the Finances API and shows what's
// expected to land in your bank, plus the most recent successful payout.
// Cached for 30 minutes — payouts don't change minute to minute.

import { useEffect, useState } from 'react';
import { Wallet, ArrowUpRight, AlertCircle, Loader2 } from 'lucide-react';
import { fmt } from '../utils/formatters';
import { PIPELINE_BASE, EBAY_TOKEN_KEY } from '../utils/constants';
import { decryptObject } from '../services/crypto';
import { getEbayAccessToken } from '../services/ebayAuth';
import eventBus from '../services/eventBus';

const CACHE_KEY = 'noltech:hub:cash-flow-cache';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function relativeDay(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const days = Math.round((t - Date.now()) / 86400000);
  if (days === 0)  return 'today';
  if (days === 1)  return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days > 1)    return `in ${days}d`;
  return `${Math.abs(days)}d ago`;
}

export default function CashFlowCard() {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  const load = async ({ force = false } = {}) => {
    setError(null);
    // Try cache first
    if (!force) {
      try {
        const cached = await window.storage.get(CACHE_KEY);
        if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < CACHE_TTL_MS) {
          setData(cached);
          setLoading(false);
          return;
        }
      } catch {}
    }
    setLoading(true);
    try {
      const credsRaw = await window.storage.get(EBAY_TOKEN_KEY).catch(() => null);
      const creds = await decryptObject(credsRaw || {});
      if (!creds?.token) { setLoading(false); return; }
      const accessToken = await getEbayAccessToken(creds);
      if (!accessToken) {
        setError('No OAuth access token available — set up eBay credentials.');
        setLoading(false);
        return;
      }
      const r = await fetch(`${PIPELINE_BASE}/api/ebay/finances/payouts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oauthUserToken: accessToken }),
        signal: AbortSignal.timeout(15000),
      });
      const d = await r.json();
      if (!d.success) { setError(d.error || 'Payouts fetch failed'); setLoading(false); return; }

      // "Pending" = every status that represents money not yet landed in the
      // bank. Filter values eBay accepts on the API side are INITIATED /
      // RETRYABLE_FAILED / SUCCEEDED, but a response can still surface
      // PENDING / DELAYED, so we accept those here too. The "money sitting
      // in your eBay balance not yet scheduled as a payout" gap is filled
      // via seller_funds_summary below.
      const PENDING_STATUSES = new Set(['INITIATED', 'PENDING', 'DELAYED', 'RETRYABLE_FAILED']);
      const pending = (d.payouts || []).filter((p) => PENDING_STATUSES.has(p.status));
      // Sort succeeded payouts by date desc BEFORE slicing — eBay's API
      // doesn't guarantee ordering, so the previous .slice(0,5) was picking
      // an arbitrary 5 instead of the most recent.
      const recent = (d.payouts || [])
        .filter((p) => p.status === 'SUCCEEDED')
        .sort((a, b) => new Date(b.payoutDate) - new Date(a.payoutDate))
        .slice(0, 5);
      const failed  = (d.payouts || []).filter((p) => p.status === 'RETRYABLE_FAILED').length;
      const fundsSummary = d.fundsSummary || null;

      const scheduledTotal = pending.reduce((s, p) => s + p.amount, 0);
      const nextPayout = pending.length
        ? pending.reduce((earliest, p) => !earliest || new Date(p.payoutDate) < new Date(earliest.payoutDate) ? p : earliest, null)
        : null;
      const lastPayout = recent[0] || null;

      // Total "expected to land" sums every bucket of money that will reach
      // your bank in the normal payout cycle:
      //   - Scheduled payouts (INITIATED / RETRYABLE_FAILED — in flight)
      //   - processingFunds      (payout being processed, not yet INITIATED)
      //   - fundsAwaitingPayout  (locked in for the next cycle)
      //   - availableFunds       (cleared, ready for next payout)
      // On-hold and restricted funds are excluded — they won't land soon.
      const awaitingPayout = fundsSummary?.totalAwaitingPayout || 0;
      const availableNow   = fundsSummary?.totalAvailable      || 0;
      const processing     = fundsSummary?.totalProcessing     || 0;
      const onHold         = fundsSummary?.totalOnHold         || 0;
      const restricted     = fundsSummary?.totalRestricted     || 0;
      const pendingTotal   = scheduledTotal + processing + awaitingPayout + availableNow;

      const next = {
        fetchedAt: new Date().toISOString(),
        pending,
        recent,
        failed,
        scheduledTotal,
        processing,
        awaitingPayout,
        availableNow,
        onHold,
        restricted,
        pendingTotal,
        fundsSummary,
        nextPayout,
        lastPayout,
      };
      setData(next);
      await window.storage.set(CACHE_KEY, next).catch((e) => console.error('[CashFlow] cache save failed:', e));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // When a Sync All completes we want fresh payout + funds-summary numbers,
  // not the 30-min cached snapshot — the user just paid the round-trip cost
  // of refreshing eBay data and expects this card to follow.
  useEffect(() => {
    const unsub = eventBus.on('sync:all-complete', () => load({ force: true }));
    return unsub;
  }, []);

  // Show only if we got data OR there's an error worth surfacing
  if (loading && !data) {
    return (
      <div className="rounded-xl border border-border bg-surface shadow-sm p-4 mb-3 flex items-center gap-2 text-xs text-fg-muted">
        <Loader2 size={12} className="animate-spin" /> Loading cash flow…
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-xl border border-warning/30 bg-warning-subtle shadow-sm p-3 mb-3 flex items-start gap-2 text-xs text-warning">
        <AlertCircle size={13} className="shrink-0 mt-0.5" />
        <div>
          <p className="font-semibold">Cash-flow lookup failed</p>
          <p className="text-warning">{error}</p>
        </div>
      </div>
    );
  }
  if (!data) return null;
  if (data.pending.length === 0 && data.recent.length === 0) return null;

  return (
    <div className="rounded-xl border border-border bg-surface shadow-sm p-4 mb-3">
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Wallet size={16} className="text-fg-muted" />
          <p className="text-sm font-semibold text-fg">Cash flow · eBay payouts</p>
        </div>
        <button
          type="button"
          onClick={() => load({ force: true })}
          className="text-[11px] text-primary hover:underline"
        >
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="bg-success/5 border border-success/20 rounded-lg p-3"
          title={
            data.fundsSummary
              ? `Scheduled payouts (in flight): ${fmt(data.scheduledTotal)}\n` +
                `Processing (payout being generated): ${fmt(data.processing)}\n` +
                `Funds awaiting payout (locked for next cycle): ${fmt(data.awaitingPayout)}\n` +
                `Available balance (ready for next payout): ${fmt(data.availableNow)}\n` +
                `On-hold (excluded): ${fmt(data.onHold)}\n` +
                `Restricted (excluded): ${fmt(data.restricted)}`
              : 'Sum of all scheduled payouts not yet delivered to your bank.\n(Live balance unavailable — seller_funds_summary endpoint returned no data.)'
          }
        >
          <p className="text-[10px] uppercase tracking-wide text-fg-muted">Expected to land</p>
          <p className="text-2xl font-bold font-mono text-success">{fmt(data.pendingTotal)}</p>
          {(() => {
            // Build a breakdown sub-line listing only the buckets with > $0 in them
            const parts = [];
            if (data.scheduledTotal > 0) parts.push(`${fmt(data.scheduledTotal)} in flight`);
            if (data.processing > 0)     parts.push(`${fmt(data.processing)} processing`);
            if (data.awaitingPayout > 0) parts.push(`${fmt(data.awaitingPayout)} awaiting`);
            if (data.availableNow !== 0) parts.push(`${fmt(data.availableNow)} available`);
            if (parts.length) {
              return <p className="text-[11px] text-fg-muted mt-0.5">{parts.join(' · ')}</p>;
            }
            if (data.nextPayout) {
              return (
                <p className="text-[11px] text-fg-muted mt-0.5">
                  Next payout {relativeDay(data.nextPayout.payoutDate)}{' '}
                  <span className="text-fg-subtle">({data.pending.length} pending{data.failed ? `, ${data.failed} retrying` : ''})</span>
                </p>
              );
            }
            return (
              <p className="text-[11px] text-fg-muted mt-0.5">
                No pending payouts
                {!data.fundsSummary && <span className="text-fg-subtle"> · live balance unavailable</span>}
              </p>
            );
          })()}
          {(data.onHold > 0 || data.restricted > 0) && (
            <p className="text-[10px] text-fg-subtle mt-1">
              {data.onHold > 0    && <>{fmt(data.onHold)} on hold</>}
              {data.onHold > 0 && data.restricted > 0 && ' · '}
              {data.restricted > 0 && <>{fmt(data.restricted)} restricted</>}
              <span className="opacity-70"> (excluded)</span>
            </p>
          )}
        </div>

        <div className="bg-muted/30 border border-border-subtle rounded-lg p-3">
          <p className="text-[10px] uppercase tracking-wide text-fg-muted">Most recent payout</p>
          {data.lastPayout ? (
            <>
              <p className="text-2xl font-bold font-mono text-fg">{fmt(data.lastPayout.amount)}</p>
              <p className="text-[11px] text-fg-muted mt-0.5">
                <ArrowUpRight size={10} className="inline" /> Sent {relativeDay(data.lastPayout.payoutDate)}
                {data.lastPayout.bankReference && <span className="text-fg-subtle"> · *{data.lastPayout.bankReference}</span>}
                {data.lastPayout.transactionCount > 0 && <span className="text-fg-subtle"> · {data.lastPayout.transactionCount} txns</span>}
              </p>
            </>
          ) : (
            <p className="text-sm text-fg-muted mt-2">No recent payouts</p>
          )}
        </div>
      </div>
    </div>
  );
}
