import { createContext, useContext, useReducer, useEffect, useRef } from 'react';
import { parseManifest, valuateItems } from '../services/ai';
import { today } from '../utils/formatters';
import { ANALYZER_STORAGE_KEY, API_KEY_STORAGE, SETTINGS_KEY } from '../utils/constants';
import { encrypt, decrypt } from '../services/crypto';

export function blankLot() {
  return {
    id:            crypto.randomUUID(),
    name:          '',
    purchasePrice: '',
    source:        '',
    date:          today(),
    manifest:      '',
    parsedItems:   [],
    status:        'draft',
  };
}

const initialState = {
  apiKey:   '',
  view:     'wizard',
  step:     1,
  lot:      blankLot(),
  savedLots:[],
  settings: { targetMargin: 40, avgShipping: 8 },
  isParsing:      false, parseError:      null,
  isValuing:      false, valuationError:  null,
  isLoading:      true,
};

function reducer(state, action) {
  switch (action.type) {
    case 'HYDRATE':
      return { ...state, apiKey: action.apiKey ?? state.apiKey, savedLots: action.savedLots ?? state.savedLots,
        settings: { ...state.settings, ...(action.settings ?? {}) }, isLoading: false };
    case 'SET_API_KEY':        return { ...state, apiKey: action.key };
    case 'SET_VIEW':           return { ...state, view: action.view };
    case 'SET_STEP':           return { ...state, step: action.step };
    case 'UPDATE_LOT_META':    return { ...state, lot: { ...state.lot, ...action.updates } };
    case 'RESET_WIZARD':       return { ...state, lot: blankLot(), step: 1, parseError: null, valuationError: null };
    case 'PARSE_START':        return { ...state, isParsing: true, parseError: null };
    case 'PARSE_SUCCESS':      return { ...state, isParsing: false, parseError: null,
      lot: { ...state.lot, parsedItems: action.items, status: 'parsed' }, step: 2 };
    case 'PARSE_ERROR':        return { ...state, isParsing: false, parseError: action.error };
    case 'UPDATE_ITEM':        return { ...state, lot: { ...state.lot,
      parsedItems: state.lot.parsedItems.map((it) => it.id === action.id ? { ...it, ...action.updates } : it) } };
    case 'ADD_ITEM':           return { ...state, lot: { ...state.lot,
      parsedItems: [...state.lot.parsedItems, action.item] } };
    case 'DELETE_ITEM':        return { ...state, lot: { ...state.lot,
      parsedItems: state.lot.parsedItems.filter((it) => it.id !== action.id) } };
    case 'REORDER_ITEMS':      return { ...state, lot: { ...state.lot, parsedItems: action.items } };
    case 'VALUATION_START':    return { ...state, isValuing: true, valuationError: null };
    case 'VALUATION_SUCCESS': {
      const updatedItems = state.lot.parsedItems.map((item, idx) => {
        const v = action.valuations.find((x) => x.index === idx);
        if (!v) return item;
        return { ...item, estimatedValue: v.estimatedValue ?? null, lowValue: v.lowValue ?? null,
          highValue: v.highValue ?? null, confidence: v.confidence ?? null,
          valuationNotes: v.valuationNotes ?? null, yourValue: item.yourValue ?? v.estimatedValue ?? null };
      });
      return { ...state, isValuing: false, valuationError: null,
        lot: { ...state.lot, parsedItems: updatedItems, status: 'valued' }, step: 3 };
    }
    case 'VALUATION_ERROR':    return { ...state, isValuing: false, valuationError: action.error };
    case 'SAVE_LOT': {
      const saved = { ...state.lot, status: 'saved', savedAt: new Date().toISOString() };
      const existing = state.savedLots.findIndex((l) => l.id === saved.id);
      const updated = existing >= 0
        ? state.savedLots.map((l) => l.id === saved.id ? saved : l)
        : [saved, ...state.savedLots];
      return { ...state, savedLots: updated };
    }
    case 'DELETE_SAVED_LOT':   return { ...state, savedLots: state.savedLots.filter((l) => l.id !== action.id) };
    case 'LOAD_SAVED_LOT':     return { ...state, lot: { ...action.lot },
      step: action.lot.status === 'valued' || action.lot.status === 'saved' ? 4 : 2,
      view: 'wizard', parseError: null, valuationError: null };
    case 'UPDATE_SETTINGS':    return { ...state, settings: { ...state.settings, ...action.updates } };
    default: return state;
  }
}

const AnalyzerContext = createContext(null);

export function AnalyzerProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const firstRender = useRef(true);

  useEffect(() => {
    (async () => {
      try {
        const [rawApiKey, savedLots, settings] = await Promise.all([
          window.storage.get(API_KEY_STORAGE),
          window.storage.get(ANALYZER_STORAGE_KEY),
          window.storage.get(SETTINGS_KEY),
        ]);
        const apiKey = rawApiKey ? await decrypt(rawApiKey) : '';
        dispatch({ type: 'HYDRATE', apiKey, savedLots: Array.isArray(savedLots) ? savedLots : [],
          settings: settings || {} });
      } catch (err) {
        dispatch({ type: 'HYDRATE', apiKey: '', savedLots: [], settings: {} });
      }
    })();
  }, []);

  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    if (state.isLoading) return;
    window.storage.set(ANALYZER_STORAGE_KEY, state.savedLots).catch(console.error);
    window.storage.set(SETTINGS_KEY, state.settings).catch(console.error);
  }, [state.savedLots, state.settings, state.isLoading]);

  const setApiKey = async (key) => {
    dispatch({ type: 'SET_API_KEY', key });
    await window.storage.set(API_KEY_STORAGE, await encrypt(key)).catch(console.error);
  };

  const runParseManifest = async () => {
    if (!state.lot.manifest.trim()) return;
    dispatch({ type: 'PARSE_START' });
    try {
      const items = await parseManifest(state.apiKey, state.lot.manifest);
      dispatch({ type: 'PARSE_SUCCESS', items });
    } catch (err) {
      dispatch({ type: 'PARSE_ERROR', error: err.message });
    }
  };

  const runValuation = async () => {
    if (!state.lot.parsedItems.length) return;
    dispatch({ type: 'VALUATION_START' });
    try {
      const valuations = await valuateItems(state.apiKey, state.lot.parsedItems);
      dispatch({ type: 'VALUATION_SUCCESS', valuations });
    } catch (err) {
      dispatch({ type: 'VALUATION_ERROR', error: err.message });
    }
  };

  const saveLot         = () => dispatch({ type: 'SAVE_LOT' });
  const deleteSavedLot  = (id) => dispatch({ type: 'DELETE_SAVED_LOT', id });

  return (
    <AnalyzerContext.Provider value={{ state, dispatch, setApiKey, runParseManifest, runValuation, saveLot, deleteSavedLot }}>
      {children}
    </AnalyzerContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AnalyzerContext);
  if (!ctx) throw new Error('useApp must be used within AnalyzerProvider');
  return ctx;
}
