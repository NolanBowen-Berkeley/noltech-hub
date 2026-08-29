import { useState, useEffect, useCallback } from 'react';

const KEY = 'noltech:lotprofit:overlay';

/**
 * Shared hook for SKU prefix/suffix overlay.
 * Returns the overlay map and a function to update a single lot's entry.
 * Both LotManager and LotProfitTracker use this so they stay in sync.
 */
export function useSkuOverlay() {
  const [overlay, setOverlay] = useState({});

  useEffect(() => {
    window.storage.get(KEY)
      .then((v) => { if (v && typeof v === 'object' && !Array.isArray(v)) setOverlay(v); })
      .catch(e => console.error('[sku overlay] storage error:', e));
  }, []);

  const setLotSku = useCallback(async (lotId, skuPrefix, skuSuffix) => {
    setOverlay((prev) => {
      const next = { ...prev, [lotId]: { skuPrefix: skuPrefix || '', skuSuffix: skuSuffix || '' } };
      window.storage.set(KEY, next).catch(console.error);
      return next;
    });
  }, []);

  const removeLotSku = useCallback(async (lotId) => {
    setOverlay((prev) => {
      const next = { ...prev };
      delete next[lotId];
      window.storage.set(KEY, next).catch(console.error);
      return next;
    });
  }, []);

  // Replace entire overlay (used by LotProfitTracker bulk operations)
  const setFullOverlay = useCallback(async (newOverlay) => {
    setOverlay(newOverlay);
    window.storage.set(KEY, newOverlay).catch(console.error);
  }, []);

  return { overlay, setLotSku, removeLotSku, setFullOverlay };
}
