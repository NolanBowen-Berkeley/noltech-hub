// ─── useHiddenLots ────────────────────────────────────────────────────────────
// Reads the per-device hidden-lot list from window.storage and exposes:
//   - hiddenLots: Set<string>  (lot IDs the user has hidden in Operations)
//   - isHidden(lotId): boolean
//   - filterVisible(lots): Lot[]  (helper that drops hidden lots)
//
// The list is set via the Operations → Process tab. This hook is for any
// other view (TestingChecklist, PhotoWorkflow, BatchUpdater, etc.) that
// should respect that hide preference.
//
// Storage key: noltech:operations:hidden-lots (per-device, not synced).

import { useEffect, useState, useCallback } from 'react';

const HIDDEN_LOTS_KEY = 'noltech:operations:hidden-lots';

export function useHiddenLots() {
  const [hiddenLots, setHiddenLots] = useState(() => new Set());

  useEffect(() => {
    let alive = true;
    const load = () => window.storage.get(HIDDEN_LOTS_KEY)
      .then((v) => { if (alive && Array.isArray(v)) setHiddenLots(new Set(v)); })
      .catch((e) => console.error('[useHiddenLots] load failed:', e));
    load();
    // Some storage engines fire `storage` events when other tabs/windows
    // change the underlying value. We re-read on those, plus on a custom
    // event we'll fire from LotProcessor when the user toggles a hide.
    const handler = () => load();
    window.addEventListener('noltech:hidden-lots-changed', handler);
    return () => {
      alive = false;
      window.removeEventListener('noltech:hidden-lots-changed', handler);
    };
  }, []);

  const isHidden = useCallback((lotId) => hiddenLots.has(lotId), [hiddenLots]);

  const filterVisible = useCallback(
    (lots) => (Array.isArray(lots) ? lots.filter((l) => l && !hiddenLots.has(l.id)) : []),
    [hiddenLots],
  );

  return { hiddenLots, isHidden, filterVisible };
}

export { HIDDEN_LOTS_KEY };
