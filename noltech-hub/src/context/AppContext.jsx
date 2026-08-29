import { createContext, useContext, useReducer, useEffect, useRef, useCallback } from 'react';
import { STORAGE_KEY } from '../utils/constants';
import eventBus from '../services/eventBus';
import useEventBridge from '../hooks/useEventBridge';
import * as syncEngine from '../services/syncEngine';
import { startSoldCompsAutoPrewarm, stopSoldCompsAutoPrewarm } from '../services/soldCompsAutoPrewarm';
import { withErrorToast } from '../utils/withErrorToast';

const initialState = { lots: [], loading: true, error: null };

function reducer(state, action) {
  switch (action.type) {
    case 'INIT':
      return { ...state, lots: action.lots || [], loading: false, error: null };
    case 'INIT_ERROR':
      return { ...state, loading: false, error: action.error };
    case 'ADD_LOT':
      return { ...state, lots: [action.lot, ...state.lots] };
    case 'UPDATE_LOT':
      return { ...state, lots: state.lots.map((l) => l.id === action.id ? { ...l, ...action.updates } : l) };
    case 'DELETE_LOT':
      return { ...state, lots: state.lots.filter((l) => l.id !== action.id) };
    case 'ADD_ITEM':
      return { ...state, lots: state.lots.map((l) =>
        l.id === action.item.lotId ? { ...l, items: [...(l.items || []), action.item] } : l) };
    case 'UPDATE_ITEM': {
      // Find the item and apply updates
      let movedItem = null;
      const lotsAfterRemove = state.lots.map((l) => {
        const idx = (l.items || []).findIndex((item) => item.id === action.id);
        if (idx === -1) return l;
        const updated = { ...l.items[idx], ...action.updates };
        if (!action.updates.lotId || updated.lotId === l.id) {
          // Same lot — update in place
          return { ...l, items: l.items.map((item) => item.id === action.id ? updated : item) };
        }
        // lotId changed — remove from this lot and remember the item
        movedItem = updated;
        return { ...l, items: l.items.filter((item) => item.id !== action.id) };
      });
      if (!movedItem) return { ...state, lots: lotsAfterRemove };
      // Add item to its new lot
      return { ...state, lots: lotsAfterRemove.map((l) =>
        l.id === movedItem.lotId ? { ...l, items: [...(l.items || []), movedItem] } : l
      )};
    }
    case 'DELETE_ITEM':
      return { ...state, lots: state.lots.map((l) => ({
        ...l, items: (l.items || []).filter((item) => item.id !== action.id),
      })) };
    // Reassign all items whose SKU matches a lot's overlay pattern
    case 'REMATCH_ITEMS_BY_SKU': {
      const { overlay } = action; // { [lotId]: { skuPrefix, skuSuffix } }
      const findLot = (sku) => {
        if (!sku) return null;
        const u = sku.toUpperCase();
        return action.lots.find((l) => {
          const pre = overlay[l.id]?.skuPrefix?.trim().toUpperCase();
          const suf = overlay[l.id]?.skuSuffix?.trim().toUpperCase();
          if (pre && suf) return u.startsWith(pre) && u.endsWith(suf);
          if (pre)        return u.startsWith(pre);
          if (suf)        return u.endsWith(suf);
          return false;
        }) || null;
      };
      // Collect all items, reassign lotId where SKU matches
      const allItems = state.lots.flatMap((l) => (l.items || []).map((i) => {
        const match = findLot(i.serialNumber);
        return match && match.id !== i.lotId ? { ...i, lotId: match.id } : i;
      }));
      // Rebuild lots with reassigned items
      const itemsByLot = allItems.reduce((acc, i) => {
        (acc[i.lotId] = acc[i.lotId] || []).push(i);
        return acc;
      }, {});
      return { ...state, lots: state.lots.map((l) => ({ ...l, items: itemsByLot[l.id] || [] })) };
    }
    default:
      return state;
  }
}

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [state, rawDispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const isFirstRender = useRef(true);

  // ── Event-emitting dispatch wrapper ────────────────────────────────────
  // Intercepts actions, runs the reducer, then emits cross-module events.
  const dispatch = useCallback((action) => {
    const prevState = stateRef.current;
    rawDispatch(action);

    // Push to cloud sync (skips if not running or if action came from sync itself)
    syncEngine.onAction(action);

    // Emit events based on action type (runs after React processes the dispatch)
    setTimeout(() => {
      try {
        if (action.type === 'ADD_LOT' && action.lot) {
          // Lot creation event — used by useEventBridge to mirror a Cost of
          // Goods (Lots) row into bookkeeping. Senders that already wrote
          // the bookkeeping row themselves (e.g. the Bookkeeping "Add Lot
          // Purchase" quick-add) pass `_bookkeepingRecorded: true` on the
          // action so the bridge skips the auto row. `fromSync` flags
          // sync-replayed dispatches so the bridge doesn't double-write
          // a row whose mirror is independently syncing via the
          // transactions key.
          eventBus.emit('lot:added', {
            lot: action.lot,
            bookkeepingRecorded: !!action._bookkeepingRecorded,
            fromSync: !!action._fromSync,
            origin: action._origin || 'unknown',
          });
        }

        if (action.type === 'UPDATE_LOT' && action.id && action.updates) {
          eventBus.emit('lot:updated', {
            lotId: action.id,
            updates: action.updates,
            bookkeepingRecorded: !!action._bookkeepingRecorded,
            fromSync: !!action._fromSync,
          });
        }

        if (action.type === 'DELETE_LOT' && action.id) {
          eventBus.emit('lot:deleted', { lotId: action.id, fromSync: !!action._fromSync });
        }

        if (action.type === 'UPDATE_ITEM' && action.id && action.updates) {
          // Detect status change
          const oldItem = prevState.lots
            .flatMap(l => l.items || [])
            .find(i => i.id === action.id);
          if (oldItem) {
            const newStatus = action.updates.status;
            const oldStatus = oldItem.status;
            if (newStatus && newStatus !== oldStatus) {
              // Special: if sold with sale data, emit sale:recorded
              if (newStatus === 'sold' && (action.updates.sale || oldItem.sale)) {
                const sale = action.updates.sale || oldItem.sale;
                // Prefer brand/model from THIS dispatch (the backfill case
                // where useSyncAll fills in brand+model from the order title
                // in the same UPDATE_ITEM call as flipping status to sold).
                // Falling back to oldItem would emit empty values and the
                // bookkeeping row would label as "Item Sale" instead of the
                // real product name.
                const newBrand = action.updates.brand !== undefined ? action.updates.brand : oldItem.brand;
                const newModel = action.updates.model !== undefined ? action.updates.model : oldItem.model;
                const newSku   = action.updates.sku   !== undefined ? action.updates.sku   : (oldItem.sku || oldItem.serialNumber || '');
                eventBus.emit('sale:recorded', {
                  itemId: action.id,
                  lotId: oldItem.lotId,
                  sale,
                  brand: newBrand,
                  model: newModel,
                  sku: newSku,
                });
              }
            }
            // Sale data updated on an ALREADY-sold item (e.g. label cost
            // backfilled from Shipping Queue, ad fees pulled from Finances
            // API on a re-sync). Emit sale:updated so bookkeeping can keep
            // its auto rows in sync. Skip when status flipped to sold this
            // tick — sale:recorded already covered that case.
            if (action.updates.sale && oldItem.status === 'sold' && (!newStatus || newStatus === 'sold')) {
              eventBus.emit('sale:updated', {
                itemId: action.id,
                lotId: oldItem.lotId,
                sale: action.updates.sale,
                brand: oldItem.brand,
                model: oldItem.model,
                sku: oldItem.sku || oldItem.serialNumber || '',
              });
            }
          }

        }
      } catch (e) { console.error('[AppContext] event emission error:', e); }
    }, 0);
  }, []);

  // ── Central event bridge — subscribes to events and dispatches actions ──
  useEventBridge(dispatch);

  // ── Sold-comps auto-prewarm — listens for `manifest:priced`, queues a
  // background sold-comps lookup for each item that isn't already cached.
  // No-op when cloud sync or the Lambda isn't configured.
  useEffect(() => {
    startSoldCompsAutoPrewarm();
    return () => stopSoldCompsAutoPrewarm();
  }, []);

  // ── Start cloud sync engine ──
  // Also stops the engine on cloud:signed-out (e.g., the user just deleted
  // their workspace) so we don't keep retrying writes against a workspace
  // that no longer exists. WorkspaceSettings clears the local active-
  // workspace pointer in the same handler, so re-mount is a no-op until the
  // user explicitly re-attaches.
  useEffect(() => {
    let stopped = false;
    let unsubSignout = () => {};
    (async () => {
      try {
        const activeWs = await window.storage.get('noltech:cloud:active-workspace').catch(() => null);
        if (!activeWs || stopped) return;
        await syncEngine.start({ workspaceId: activeWs, dispatch });
      } catch (e) { console.error('[AppContext] sync start failed:', e); }
    })();
    unsubSignout = eventBus.on('cloud:signed-out', () => {
      try { syncEngine.stop(); } catch (e) { console.error('[AppContext] sync stop failed:', e); }
    });
    return () => {
      stopped = true;
      unsubSignout();
      try { syncEngine.stop(); } catch {}
    };
  }, [dispatch]);

  useEffect(() => {
    window.storage.get(STORAGE_KEY)
      .then((lots) => rawDispatch({ type: 'INIT', lots: Array.isArray(lots) ? lots : [] }))
      .catch((err) => rawDispatch({ type: 'INIT_ERROR', error: err.message || 'Storage load failed' }));
  }, []);

  useEffect(() => {
    if (state.loading) return;
    if (isFirstRender.current) { isFirstRender.current = false; return; }
    // Highest-stakes write in the app — losing this silently means the
    // user's inventory edits disappear on reload. withErrorToast surfaces
    // a quota / Electron-storage failure as a visible error toast.
    withErrorToast(
      () => window.storage.set(STORAGE_KEY, state.lots),
      { title: 'Inventory save failed', tag: 'AppContext:lots' },
    );
  }, [state.lots, state.loading]);

  return <AppContext.Provider value={{ state, dispatch }}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
