// ─── Bid alerts ──────────────────────────────────────────────────────────────
// Watches the user's active bids and fires a toast (via notification:push,
// which also surfaces a desktop notification when permission has been
// granted) when a lot is in its final 30 minutes AND the current asking
// price is still at-or-below the user's bid ceiling — i.e. it's still a
// good deal and you should jump.
//
// Anti-spam: at most one alert per lot per session. Stored in a Set in
// memory so the count resets on app restart (Wanting to be re-pinged after
// a relaunch is fine — you might have closed the app and need a fresh nudge).

import { useEffect, useRef } from 'react';
import eventBus from '../services/eventBus';
import { logError } from '../services/errorLog';
import { sendPhoneAlert } from '../services/phoneAlerts';

const BIDS_KEY = 'noltech:arbitrage:bids';
const BROWSE_KEY = 'noltech:arbitrage:browse-lots';

const WINDOW_MS = 30 * 60 * 1000;   // 30 minutes
const POLL_MS = 60 * 1000;          // re-check every minute

async function readActiveBids() {
  try {
    const v = await window.storage.get(BIDS_KEY);
    if (!Array.isArray(v)) return [];
    return v.filter((b) => b && b.status === 'active');
  } catch {
    return [];
  }
}

async function readScrapedLots() {
  try {
    const v = await window.storage.get(BROWSE_KEY);
    return Array.isArray(v?.lots) ? v.lots : [];
  } catch {
    return [];
  }
}

// Try to request notification permission once. Silently ignores environments
// (Electron) where Notification might not be available.
function tryRequestNotificationPermission() {
  try {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  } catch {}
}

function fireAlert(lot, bid, minutesLeft) {
  const ceilingLabel = bid.bidCeiling != null ? `$${Number(bid.bidCeiling).toLocaleString()}` : 'your ceiling';
  const askingLabel = `$${Number(lot.price || 0).toLocaleString()}`;
  const title = `Bid closing in ${minutesLeft}m`;
  const message = `${(lot.title || 'Lot').slice(0, 80)} — asking ${askingLabel} (ceiling ${ceilingLabel}).`;
  try {
    eventBus.emit('notification:push', { type: 'info', title, message });
  } catch {}
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const n = new Notification(title, { body: message, tag: `bid-${bid.lotId || bid.id}` });
      n.onclick = () => { try { n.close(); } catch {} };
    }
  } catch {}
  // Phone push (ntfy.sh / Discord webhook / custom). Fire-and-forget — a
  // failed phone push must never crash the alert flow.
  sendPhoneAlert(title, message).catch(() => {});
}

export default function useBidAlerts() {
  const alertedRef = useRef(new Set());   // lotIds we've already alerted for this session

  useEffect(() => {
    tryRequestNotificationPermission();

    let cancelled = false;
    const check = async () => {
      try {
        const [bids, lots] = await Promise.all([readActiveBids(), readScrapedLots()]);
        if (cancelled || bids.length === 0 || lots.length === 0) return;
        const lotsById = new Map();
        for (const l of lots) {
          if (l?.id) lotsById.set(l.id, l);
          if (l?.lotId) lotsById.set(l.lotId, l);
        }
        const now = Date.now();
        for (const bid of bids) {
          const lotKey = bid.lotId || bid.id;
          if (!lotKey || alertedRef.current.has(lotKey)) continue;
          const lot = lotsById.get(lotKey) || lotsById.get(bid.lotId) || lotsById.get(bid.id);
          if (!lot) continue;
          const endsAt = lot.auction?.endsAt || lot.endsAt;
          if (!endsAt) continue;
          const endTs = Date.parse(endsAt);
          if (!Number.isFinite(endTs)) continue;
          const msLeft = endTs - now;
          if (msLeft <= 0 || msLeft > WINDOW_MS) continue;   // outside the 30-min window
          const ceiling = parseFloat(bid.bidCeiling);
          const asking = Number(lot.price ?? lot.auction?.currentPrice ?? 0);
          if (Number.isFinite(ceiling) && ceiling > 0 && asking > ceiling) continue;   // already over budget
          const minutesLeft = Math.max(1, Math.round(msLeft / 60000));
          fireAlert(lot, bid, minutesLeft);
          alertedRef.current.add(lotKey);
        }
      } catch (e) {
        await logError('bid-alerts', e);
      }
    };

    // Run once shortly after mount, then on a 1-min interval.
    const initial = setTimeout(check, 5000);
    const interval = setInterval(check, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, []);
}
