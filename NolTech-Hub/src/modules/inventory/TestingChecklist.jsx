import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  ClipboardCheck, CheckCircle2, XCircle, MinusCircle, Search,
  Printer, Save, RotateCcw, ChevronDown, Package, StickyNote,
  ChevronLeft, ChevronRight, Layers,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { CATEGORIES } from '../../utils/constants';
import { formatDate } from '../../utils/formatters';
import eventBus from '../../services/eventBus';
import { useHiddenLots } from '../../hooks/useHiddenLots';

// ─── Storage key ─────────────────────────────────────────────────────────────
const CHECKLIST_KEY = 'noltech:testing:checklists';

// ─── Checklist templates by category ─────────────────────────────────────────

// Each test can have: label (string), valueField (optional input type), critical (boolean)
const CHECKLISTS = {
  laptop: [
    { label: 'Power on', critical: true },
    { label: 'BIOS access' },
    { label: 'Battery holds charge' },
    { label: 'Battery health', valueField: 'number', valuePlaceholder: '%', valueSuffix: '%' },
    { label: 'Screen (dead pixels, backlight bleed)', critical: true },
    { label: 'Keyboard (all keys)' },
    { label: 'Trackpad' },
    { label: 'WiFi connects' },
    { label: 'Bluetooth' },
    { label: 'USB ports (each)' },
    { label: 'HDMI/DisplayPort output' },
    { label: 'Webcam' },
    { label: 'Speakers' },
    { label: 'Microphone' },
    { label: 'Storage detected', valueField: 'text', valuePlaceholder: 'e.g. 256GB SSD' },
    { label: 'RAM detected', valueField: 'text', valuePlaceholder: 'e.g. 16GB DDR4' },
    { label: 'OS boots' },
    { label: 'Fan noise normal' },
    { label: 'Hinges tight' },
    { label: 'Cosmetic grade (A/B/C/D)' },
  ],
  desktop: [
    { label: 'Power on', critical: true },
    { label: 'BIOS access' },
    { label: 'RAM detected', valueField: 'text', valuePlaceholder: 'e.g. 32GB DDR4' },
    { label: 'Storage detected', valueField: 'text', valuePlaceholder: 'e.g. 512GB NVMe' },
    { label: 'GPU output' },
    { label: 'USB ports (front + back)' },
    { label: 'Audio output' },
    { label: 'Network port' },
    { label: 'WiFi (if equipped)' },
    { label: 'Fan noise' },
    { label: 'Cosmetic grade' },
  ],
  tablet: [
    { label: 'Power on', critical: true },
    { label: 'Screen touch responsive', critical: true },
    { label: 'Screen (cracks, dead pixels)' },
    { label: 'Battery health', valueField: 'number', valuePlaceholder: '%', valueSuffix: '%' },
    { label: 'Camera (front + rear)' },
    { label: 'Speakers' },
    { label: 'Charging port' },
    { label: 'WiFi' },
    { label: 'Bluetooth' },
    { label: 'Buttons (volume, power)' },
    { label: 'Cosmetic grade' },
  ],
  phone: [
    { label: 'Power on', critical: true },
    { label: 'Screen touch responsive', critical: true },
    { label: 'Screen (cracks, dead pixels)' },
    { label: 'Battery health', valueField: 'number', valuePlaceholder: '%', valueSuffix: '%' },
    { label: 'Face ID / Touch ID' },
    { label: 'Camera (front + rear)' },
    { label: 'Speakers' },
    { label: 'Earpiece' },
    { label: 'Microphone' },
    { label: 'Charging port' },
    { label: 'SIM tray' },
    { label: 'WiFi' },
    { label: 'Bluetooth' },
    { label: 'Carrier lock check' },
    { label: 'IMEI clean check', critical: true },
    { label: 'Cosmetic grade' },
  ],
  gpu: [
    { label: 'Fans spin', critical: true },
    { label: 'Display output', critical: true },
    { label: 'No artifacts under load', critical: true },
    { label: 'VRAM detected', valueField: 'text', valuePlaceholder: 'e.g. 8GB GDDR6' },
    { label: 'PCIe connector clean' },
    { label: 'Cosmetic grade' },
  ],
  monitor: [
    { label: 'Powers on', critical: true },
    { label: 'No dead pixels', valueField: 'number', valuePlaceholder: 'count' },
    { label: 'No backlight bleed' },
    { label: 'All inputs work (HDMI, DP, VGA)' },
    { label: 'Buttons/OSD work' },
    { label: 'Stand included' },
    { label: 'Cosmetic grade' },
  ],
};

const DEFAULT_CHECKLIST = [
  { label: 'Powers on', critical: true },
  { label: 'Basic functionality test' },
  { label: 'Cosmetic grade' },
  { label: 'Notes' },
];

function buildChecklist(category) {
  const items = CHECKLISTS[category] || DEFAULT_CHECKLIST;
  return items.map((item, i) => {
    const tpl = typeof item === 'string' ? { label: item } : item;
    return {
      id: `${category || 'general'}-${i}`,
      label: tpl.label,
      status: 'pending',
      notes: '',
      value: '',
      valueField: tpl.valueField || null,
      valuePlaceholder: tpl.valuePlaceholder || '',
      valueSuffix: tpl.valueSuffix || '',
      critical: tpl.critical || false,
    };
  });
}

// ─── Status helpers ──────────────────────────────────────────────────────────

const STATUS_CYCLE = ['pending', 'pass', 'fail', 'skip'];

const STATUS_CONFIG = {
  pending: { icon: MinusCircle, color: 'text-fg-subtle', bg: 'bg-muted/40 border-border', label: 'Pending' },
  pass:    { icon: CheckCircle2, color: 'text-success', bg: 'bg-success-subtle border-success/30', label: 'Pass' },
  fail:    { icon: XCircle, color: 'text-danger', bg: 'bg-danger-subtle border-danger/30', label: 'Fail' },
  skip:    { icon: MinusCircle, color: 'text-warning', bg: 'bg-warning-subtle border-warning/30', label: 'Skip' },
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function TestingChecklist({ itemId: propItemId, category: propCategory, itemName: propItemName }) {
  const { state, dispatch } = useApp();
  const { isHidden } = useHiddenLots();

  // ── State ────────────────────────────────────────────────────────────────
  const [selectedCategory, setSelectedCategory] = useState(propCategory || '');
  const [checklist, setChecklist] = useState([]);
  const [itemId, setItemId] = useState(propItemId || '');
  const [itemName, setItemName] = useState(propItemName || '');
  const [savedChecklists, setSavedChecklists] = useState({});
  const [searchQuery, setSearchQuery] = useState('');
  const [saveStatus, setSaveStatus] = useState(null); // 'saving' | 'saved' | 'error'
  const [loadedId, setLoadedId] = useState(null);
  const [showNotes, setShowNotes] = useState({});
  const [isPrintView, setIsPrintView] = useState(false);

  // ── Lot Mode ──────────────────────────────────────────────────────────────
  const [lotMode, setLotMode] = useState(false);
  const [selectedLotId, setSelectedLotId] = useState('');
  const [lotItemIndex, setLotItemIndex] = useState(0);

  const selectedLot = useMemo(() => state.lots.find(l => l.id === selectedLotId), [state.lots, selectedLotId]);
  const lotItems = useMemo(() => (selectedLot?.items || []), [selectedLot]);
  const currentLotItem = lotItems[lotItemIndex] || null;

  // Get completion status for each item in the lot
  const lotItemStatuses = useMemo(() => {
    return lotItems.map(item => {
      const saved = savedChecklists[item.id];
      if (!saved) return 'pending';
      const allDone = saved.items.every(t => t.status !== 'pending');
      const hasFail = saved.items.some(t => t.status === 'fail');
      if (allDone && hasFail) return 'fail';
      if (allDone) return 'pass';
      return 'in_progress';
    });
  }, [lotItems, savedChecklists]);

  const lotCompletedCount = lotItemStatuses.filter(s => s === 'pass' || s === 'fail').length;

  // When selecting a lot, load the first item
  const selectLot = (lotId) => {
    setSelectedLotId(lotId);
    setLotItemIndex(0);
    setLotMode(true);
    const lot = state.lots.find(l => l.id === lotId);
    if (lot?.items?.length) {
      const firstItem = lot.items[0];
      loadItem(firstItem);
    }
  };

  // Navigate to a specific item in the lot queue
  const goToLotItem = (idx) => {
    if (idx < 0 || idx >= lotItems.length) return;
    setLotItemIndex(idx);
    const item = lotItems[idx];
    loadItem(item);
  };

  // Auto-save current item and advance to next
  const saveAndNext = async () => {
    if (itemId) await saveChecklist();
    if (lotItemIndex < lotItems.length - 1) goToLotItem(lotItemIndex + 1);
  };

  const saveAndPrev = async () => {
    if (itemId) await saveChecklist();
    if (lotItemIndex > 0) goToLotItem(lotItemIndex - 1);
  };

  // ── Load saved checklists from storage ────────────────────────────────────
  useEffect(() => {
    window.storage.get(CHECKLIST_KEY)
      .then((data) => setSavedChecklists(data && typeof data === 'object' ? data : {}))
      .catch(() => setSavedChecklists({}));
  }, []);

  // ── Auto-detect category from item data ───────────────────────────────────
  useEffect(() => {
    if (propItemId && state.lots) {
      for (const lot of state.lots) {
        const item = (lot.items || []).find((i) => i.id === propItemId);
        if (item) {
          if (item.category && !propCategory) setSelectedCategory(item.category);
          if (!propItemName) setItemName(item.model || item.brand || '');
          break;
        }
      }
    }
  }, [propItemId, propCategory, propItemName, state.lots]);

  // ── Generate checklist when category changes ──────────────────────────────
  useEffect(() => {
    if (selectedCategory) {
      // If we have a saved checklist for this item, load it instead
      if (itemId && savedChecklists[itemId]) {
        setChecklist(savedChecklists[itemId].items);
        setLoadedId(itemId);
      } else {
        setChecklist(buildChecklist(selectedCategory));
        setLoadedId(null);
      }
    }
  }, [selectedCategory]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── All items flattened for search ────────────────────────────────────────
  const allItems = useMemo(() =>
    state.lots.flatMap((lot) =>
      (lot.items || []).map((item) => ({
        ...item,
        lotName: lot.sourceName || `Lot ${lot.id.slice(0, 6)}`,
        lotDate: lot.purchaseDate,
      }))
    ),
    [state.lots]
  );

  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    return allItems.filter((item) =>
      (item.model || '').toLowerCase().includes(q) ||
      (item.brand || '').toLowerCase().includes(q) ||
      (item.serialNumber || '').toLowerCase().includes(q) ||
      (item.lotName || '').toLowerCase().includes(q) ||
      item.id.toLowerCase().includes(q)
    ).slice(0, 10);
  }, [searchQuery, allItems]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  const cycleStatus = useCallback((id) => {
    setChecklist((prev) => prev.map((item) => {
      if (item.id !== id) return item;
      const idx = STATUS_CYCLE.indexOf(item.status);
      return { ...item, status: STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length] };
    }));
  }, []);

  const setStatus = useCallback((id, status) => {
    setChecklist((prev) => prev.map((item) =>
      item.id === id ? { ...item, status } : item
    ));
  }, []);

  const updateValue = useCallback((id, value) => {
    setChecklist((prev) => prev.map((item) =>
      item.id === id ? { ...item, value } : item
    ));
  }, []);

  // Keyboard navigation
  const [focusedIdx, setFocusedIdx] = useState(0);

  useEffect(() => {
    const handler = (e) => {
      // Don't capture if typing in an input/textarea
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
      if (!checklist.length) return;

      const focused = checklist[focusedIdx];
      if (!focused) return;

      if (e.key === 'p' || e.key === 'P') { e.preventDefault(); setStatus(focused.id, 'pass'); }
      else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); setStatus(focused.id, 'fail'); }
      else if (e.key === 's' || e.key === 'S') { e.preventDefault(); setStatus(focused.id, 'skip'); }
      else if (e.key === 'ArrowDown' || e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        setFocusedIdx(i => Math.min(i + 1, checklist.length - 1));
      }
      else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
        e.preventDefault();
        setFocusedIdx(i => Math.max(i - 1, 0));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [checklist, focusedIdx, setStatus]);

  const updateNote = useCallback((id, notes) => {
    setChecklist((prev) => prev.map((item) =>
      item.id === id ? { ...item, notes } : item
    ));
  }, []);

  const toggleNotes = (id) => {
    setShowNotes((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const loadItem = (item) => {
    setItemId(item.id);
    setItemName(item.model || item.brand || '');
    setSearchQuery('');
    if (item.category) setSelectedCategory(item.category);
    // Check for saved checklist
    if (savedChecklists[item.id]) {
      setChecklist(savedChecklists[item.id].items);
      setLoadedId(item.id);
    } else if (item.category) {
      setChecklist(buildChecklist(item.category));
      setLoadedId(null);
    }
  };

  const saveChecklist = async () => {
    if (!itemId) return;
    setSaveStatus('saving');
    try {
      const updated = {
        ...savedChecklists,
        [itemId]: {
          items: checklist,
          category: selectedCategory,
          itemName,
          savedAt: new Date().toISOString(),
        },
      };
      await window.storage.set(CHECKLIST_KEY, updated);
      setSavedChecklists(updated);
      setLoadedId(itemId);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(null), 2000);

      const passCount = checklist.filter(t => t.status === 'pass').length;
      const failCount = checklist.filter(t => t.status === 'fail').length;
      const total = checklist.filter(t => t.status !== 'skip').length;
      const passRate = total > 0 ? passCount / total : 0;
      const criticalFails = checklist.filter(t => t.critical && t.status === 'fail');
      // Cap grade at D if any critical test failed
      let grade = passRate >= 0.95 ? 'A' : passRate >= 0.85 ? 'B' : passRate >= 0.70 ? 'C' : passRate >= 0.50 ? 'D' : 'F';
      if (criticalFails.length > 0 && ['A', 'B', 'C'].includes(grade)) grade = 'D';

      eventBus.emit('test:completed', { itemId, results: checklist, overallPass: failCount === 0 && passCount > 0, grade, passRate });

      // Auto-set item status to 'testing' if currently 'received'
      const currentItem = state.lots.flatMap(l => l.items || []).find(i => i.id === itemId);
      if (currentItem?.status === 'received') {
        dispatch({ type: 'UPDATE_ITEM', id: itemId, updates: { status: 'testing' } });
      }
    } catch (err) {
      console.error('Failed to save checklist:', err);
      setSaveStatus('error');
      setTimeout(() => setSaveStatus(null), 3000);
    }
  };

  const [resetConfirm, setResetConfirm] = useState(false);
  const resetChecklist = () => {
    setChecklist(buildChecklist(selectedCategory));
    setLoadedId(null);
    setResetConfirm(false);
  };

  const handlePrint = () => {
    setIsPrintView(true);
    setTimeout(() => {
      window.print();
      setIsPrintView(false);
    }, 100);
  };

  // ── Summary stats ─────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const total = checklist.length;
    const pass = checklist.filter((i) => i.status === 'pass').length;
    const fail = checklist.filter((i) => i.status === 'fail').length;
    const skip = checklist.filter((i) => i.status === 'skip').length;
    const pending = checklist.filter((i) => i.status === 'pending').length;
    return { total, pass, fail, skip, pending };
  }, [checklist]);

  // ── CSS helpers ────────────────────────────────────────────────────────────
  const inputCls =
    'w-full border border-border rounded-lg px-3 py-2 text-sm text-fg bg-surface ' +
    'focus:outline-none focus:ring-2 focus:ring-secondary/30 focus:border-secondary transition-colors';
  const labelCls = 'block text-xs font-semibold text-fg-muted uppercase tracking-wide mb-1';

  // ── Print view ────────────────────────────────────────────────────────────
  if (isPrintView) {
    return (
      <div className="print-checklist p-8 bg-surface text-black">
        <div className="text-center mb-6">
          <h1 className="text-xl font-bold">NolTech Testing Checklist</h1>
          {itemName && <p className="text-sm mt-1">{itemName}</p>}
          {itemId && <p className="text-xs text-fg-muted font-mono">{itemId}</p>}
          <p className="text-xs text-fg-muted mt-1">
            {CATEGORIES.find((c) => c.value === selectedCategory)?.label || 'General'} &middot; {formatDate(new Date().toISOString())}
          </p>
        </div>
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b-2 border-black">
              <th className="text-left py-1 w-8">#</th>
              <th className="text-left py-1">Test</th>
              <th className="text-center py-1 w-16">Pass</th>
              <th className="text-center py-1 w-16">Fail</th>
              <th className="text-center py-1 w-16">Skip</th>
              <th className="text-left py-1 w-48">Notes</th>
            </tr>
          </thead>
          <tbody>
            {checklist.map((item, idx) => (
              <tr key={item.id} className="border-b border-border-strong">
                <td className="py-1.5 text-fg-muted">{idx + 1}</td>
                <td className="py-1.5 font-medium">{item.label}</td>
                <td className="text-center py-1.5">
                  {item.status === 'pass' ? '\u2713' : '\u25A1'}
                </td>
                <td className="text-center py-1.5">
                  {item.status === 'fail' ? '\u2717' : '\u25A1'}
                </td>
                <td className="text-center py-1.5">
                  {item.status === 'skip' ? '\u2014' : '\u25A1'}
                </td>
                <td className="py-1.5 text-xs text-fg-muted">{item.notes}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-6 text-xs text-fg-muted flex justify-between">
          <span>Tested by: ___________________</span>
          <span>Date: ___________________</span>
        </div>
      </div>
    );
  }

  // ── Main render ───────────────────────────────────────────────────────────
  return (
    <div className="p-6 max-w-screen-xl">
      {/* Header */}
      <div className="flex items-start justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-fg tracking-tight flex items-center gap-2">
            <ClipboardCheck className="w-6 h-6 text-primary" />
            Testing Checklist
          </h1>
          <p className="text-sm text-fg-muted mt-0.5">
            Auto-generated checklists by device category
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-6 items-start">

        {/* ── Left Panel: Setup ── */}
        <div className="space-y-4">

          {/* Lot Mode Selector */}
          <div className="bg-surface rounded-xl border border-border shadow-sm p-5">
            <h3 className="text-sm font-semibold text-fg mb-3 flex items-center gap-1.5">
              <Layers className="w-4 h-4 text-primary" /> Test Entire Lot
            </h3>
            <select
              value={selectedLotId}
              onChange={(e) => e.target.value ? selectLot(e.target.value) : setLotMode(false)}
              className={inputCls}
            >
              <option value="">Select a lot...</option>
              {state.lots.filter(l => l.items?.length > 0 && !isHidden(l.id)).map(lot => (
                <option key={lot.id} value={lot.id}>
                  {lot.sourceName || lot.source || 'Lot'} — {lot.items.length} items ({lot.purchaseDate || ''})
                </option>
              ))}
            </select>

            {/* Quick "Resume next untested" — scans visible lots for the
                first item without a complete pass/fail checklist and jumps
                straight to it. Saves the click-through-and-skip dance. */}
            <button
              type="button"
              onClick={() => {
                for (const lot of state.lots) {
                  if (!lot.items?.length || isHidden(lot.id)) continue;
                  for (let i = 0; i < lot.items.length; i++) {
                    const it = lot.items[i];
                    const saved = savedChecklists[it.id];
                    const isDone = saved && saved.items.every(t => t.status !== 'pending');
                    if (!isDone) {
                      setSelectedLotId(lot.id);
                      setLotItemIndex(i);
                      setLotMode(true);
                      loadItem(it);
                      return;
                    }
                  }
                }
                eventBus.emit('notification:push', {
                  type: 'success',
                  title: 'All caught up',
                  message: 'Every visible item has a completed checklist',
                });
              }}
              className="mt-2 w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition-colors"
            >
              <ChevronRight size={14} /> Resume next untested item
            </button>

            {/* Lot item queue */}
            {lotMode && lotItems.length > 0 && (
              <div className="mt-3 space-y-2">
                <div className="flex items-center justify-between text-xs text-fg-muted">
                  <span>Item {lotItemIndex + 1} of {lotItems.length}</span>
                  <span className="text-success font-semibold">{lotCompletedCount}/{lotItems.length} done</span>
                </div>

                {/* Progress bar */}
                <div className="h-2 bg-muted rounded-full overflow-hidden flex">
                  {lotItemStatuses.map((s, i) => (
                    <div key={i} className={`h-full ${
                      s === 'pass' ? 'bg-success' :
                      s === 'fail' ? 'bg-danger' :
                      s === 'in_progress' ? 'bg-warning' : 'bg-muted'
                    }`} style={{ width: `${100 / lotItems.length}%` }} />
                  ))}
                </div>

                {/* Prev / Next navigation */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={saveAndPrev}
                    disabled={lotItemIndex === 0}
                    className="flex-1 flex items-center justify-center gap-1 px-3 py-2 border border-border text-sm font-medium rounded-lg text-fg-muted hover:bg-muted/40 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ChevronLeft size={14} /> Prev
                  </button>
                  <button
                    onClick={saveAndNext}
                    disabled={lotItemIndex >= lotItems.length - 1}
                    className="flex-1 flex items-center justify-center gap-1 px-3 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    Save & Next <ChevronRight size={14} />
                  </button>
                </div>

                {/* Item list with clickable rows */}
                <div className="max-h-48 overflow-y-auto rounded-lg border border-border-subtle divide-y divide-border">
                  {lotItems.map((item, idx) => {
                    const st = lotItemStatuses[idx];
                    const StIcon = st === 'pass' ? CheckCircle2 : st === 'fail' ? XCircle : st === 'in_progress' ? MinusCircle : MinusCircle;
                    const stColor = st === 'pass' ? 'text-success' : st === 'fail' ? 'text-danger' : st === 'in_progress' ? 'text-warning' : 'text-fg-subtle';
                    return (
                      <button
                        key={item.id}
                        onClick={() => goToLotItem(idx)}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs hover:bg-info-subtle/50 transition-colors ${
                          idx === lotItemIndex ? 'bg-primary/5 border-l-2 border-primary' : ''
                        }`}
                      >
                        <StIcon size={13} className={`shrink-0 ${stColor}`} />
                        <span className="flex-1 truncate text-fg">
                          {item.model || item.brand || `Item ${idx + 1}`}
                        </span>
                        <span className="text-fg-muted text-[10px]">
                          {CATEGORIES.find(c => c.value === item.category)?.label || ''}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Item Lookup */}
          <div className="bg-surface rounded-xl border border-border shadow-sm p-5">
            <h3 className="text-sm font-semibold text-fg mb-3 flex items-center gap-1.5">
              <Search className="w-4 h-4 text-secondary" /> Item Lookup
            </h3>
            <div className="relative">
              <input
                type="text"
                placeholder="Search by name, SKU, lot ID..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className={inputCls}
              />
              {searchResults.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-surface border border-border rounded-lg shadow-lg z-20 max-h-64 overflow-y-auto">
                  {searchResults.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => loadItem(item)}
                      className="w-full text-left px-3 py-2 hover:bg-muted/40 transition-colors border-b border-border-subtle last:border-0"
                    >
                      <p className="text-sm font-medium text-fg truncate">
                        {item.model || item.brand || 'Unnamed Item'}
                      </p>
                      <p className="text-xs text-fg-muted">
                        {item.lotName} &middot; {CATEGORIES.find((c) => c.value === item.category)?.label || 'Other'}
                        {item.serialNumber && <span className="font-mono ml-1">({item.serialNumber})</span>}
                      </p>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Current item display */}
            {itemId && (
              <div className="mt-3 px-3 py-2 bg-primary/5 border border-primary/20 rounded-lg">
                <p className="text-xs text-fg-muted">Testing:</p>
                <p className="text-sm font-semibold text-fg">{itemName || 'Unnamed'}</p>
                <p className="text-xs font-mono text-fg-muted">{itemId.slice(0, 12)}...</p>
                {loadedId === itemId && (
                  <span className="inline-block mt-1 text-[10px] font-semibold text-success bg-success-subtle px-1.5 py-0.5 rounded">
                    Saved checklist loaded
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Category Selector */}
          <div className="bg-surface rounded-xl border border-border shadow-sm p-5">
            <label className={labelCls}>Device Category</label>
            <select
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              className={inputCls}
            >
              <option value="">Select a category...</option>
              {CATEGORIES.map((cat) => (
                <option key={cat.value} value={cat.value}>{cat.label}</option>
              ))}
            </select>
            {selectedCategory && (
              <p className="text-xs text-fg-muted mt-2">
                {checklist.length} test{checklist.length !== 1 ? 's' : ''} in this checklist
              </p>
            )}
          </div>

          {/* Item ID (manual) */}
          {!propItemId && (
            <div className="bg-surface rounded-xl border border-border shadow-sm p-5">
              <label className={labelCls}>Item ID (optional)</label>
              <input
                type="text"
                placeholder="Paste item UUID or leave blank"
                value={itemId}
                onChange={(e) => setItemId(e.target.value)}
                className={inputCls}
              />
              <label className={`${labelCls} mt-3`}>Item Name</label>
              <input
                type="text"
                placeholder="e.g. ThinkPad T480"
                value={itemName}
                onChange={(e) => setItemName(e.target.value)}
                className={inputCls}
              />
            </div>
          )}

          {/* Summary Stats */}
          {checklist.length > 0 && (
            <div className="bg-surface rounded-xl border border-border shadow-sm p-5">
              <h3 className="text-sm font-semibold text-fg mb-3">Results Summary</h3>
              <div className="grid grid-cols-2 gap-3">
                <div className="text-center p-2 bg-success-subtle rounded-lg border border-success/30">
                  <p className="text-lg font-bold text-success">{stats.pass}</p>
                  <p className="text-[10px] uppercase font-semibold text-success">Pass</p>
                </div>
                <div className="text-center p-2 bg-danger-subtle rounded-lg border border-danger/30">
                  <p className="text-lg font-bold text-danger">{stats.fail}</p>
                  <p className="text-[10px] uppercase font-semibold text-danger">Fail</p>
                </div>
                <div className="text-center p-2 bg-warning-subtle rounded-lg border border-warning/30">
                  <p className="text-lg font-bold text-warning">{stats.skip}</p>
                  <p className="text-[10px] uppercase font-semibold text-warning">Skip</p>
                </div>
                <div className="text-center p-2 bg-muted/40 rounded-lg border border-border">
                  <p className="text-lg font-bold text-fg-muted">{stats.pending}</p>
                  <p className="text-[10px] uppercase font-semibold text-fg-muted">Pending</p>
                </div>
              </div>
              {/* Progress bar */}
              <div className="mt-3 h-2 bg-muted rounded-full overflow-hidden flex">
                {stats.pass > 0 && (
                  <div className="bg-success h-full" style={{ width: `${(stats.pass / stats.total) * 100}%` }} />
                )}
                {stats.fail > 0 && (
                  <div className="bg-danger h-full" style={{ width: `${(stats.fail / stats.total) * 100}%` }} />
                )}
                {stats.skip > 0 && (
                  <div className="bg-warning h-full" style={{ width: `${(stats.skip / stats.total) * 100}%` }} />
                )}
              </div>
              <p className="text-xs text-fg-muted mt-1 text-center">
                {stats.total - stats.pending} / {stats.total} completed
              </p>

              {/* Live grade preview */}
              {(() => {
                const tested = checklist.filter(t => t.status !== 'skip' && t.status !== 'pending');
                if (tested.length === 0) return null;
                const passCount = checklist.filter(t => t.status === 'pass').length;
                const total = checklist.filter(t => t.status !== 'skip').length;
                const rate = total > 0 ? passCount / total : 0;
                const pct = Math.round(rate * 100);
                const critFails = checklist.filter(t => t.critical && t.status === 'fail');
                let grade = rate >= 0.95 ? 'A' : rate >= 0.85 ? 'B' : rate >= 0.70 ? 'C' : rate >= 0.50 ? 'D' : 'F';
                if (critFails.length > 0 && ['A', 'B', 'C'].includes(grade)) grade = 'D';
                const gradeColor = grade === 'A' ? 'text-success bg-success-subtle' : grade === 'B' ? 'text-info bg-info-subtle' : grade === 'C' ? 'text-warning bg-warning-subtle' : 'text-danger bg-danger-subtle';
                return (
                  <div className="mt-3 space-y-2">
                    <div className={`flex items-center justify-between px-3 py-2 rounded-lg ${gradeColor}`}>
                      <span className="text-sm font-semibold">Grade: {grade} ({pct}% pass)</span>
                      <span className="text-[10px] text-fg-muted">A: 95%+ | B: 85%+ | C: 70%+ | D: 50%+</span>
                    </div>
                    {critFails.length > 0 && (
                      <div className="flex items-start gap-2 px-3 py-2 bg-danger-subtle border border-danger/30 rounded-lg text-xs text-danger">
                        <XCircle size={14} className="shrink-0 mt-0.5" />
                        <div>
                          <span className="font-semibold">Critical test failed</span>
                          <span> — grade capped at D. Failed: {critFails.map(t => t.label).join(', ')}</span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          )}

          {/* Keyboard shortcut hint */}
          <div className="text-[10px] text-fg-muted text-center py-2">
            Shortcuts: <span className="font-mono font-semibold">P</span> pass, <span className="font-mono font-semibold">F</span> fail, <span className="font-mono font-semibold">S</span> skip, <span className="font-mono font-semibold">arrows</span> navigate
          </div>

          {/* Saved Checklists Browser */}
          {Object.keys(savedChecklists).length > 0 && (
            <div className="bg-surface rounded-xl border border-border shadow-sm p-5">
              <h3 className="text-sm font-semibold text-fg mb-3">
                Saved Checklists ({Object.keys(savedChecklists).length})
              </h3>
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {Object.entries(savedChecklists).map(([id, data]) => (
                  <button
                    key={id}
                    onClick={() => {
                      setItemId(id);
                      setItemName(data.itemName || '');
                      if (data.category) setSelectedCategory(data.category);
                      setChecklist(data.items);
                      setLoadedId(id);
                    }}
                    className={`w-full text-left px-3 py-2 rounded-lg border transition-colors text-xs ${
                      loadedId === id
                        ? 'bg-primary/5 border-primary/20'
                        : 'border-border-subtle hover:bg-muted/40'
                    }`}
                  >
                    <p className="font-medium text-fg truncate">{data.itemName || id.slice(0, 12)}</p>
                    <p className="text-fg-muted">
                      {CATEGORIES.find((c) => c.value === data.category)?.label || 'General'} &middot; {formatDate(data.savedAt)}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── Right Panel: Checklist ── */}
        <div>
          {!selectedCategory ? (
            <div className="bg-surface rounded-xl border border-border shadow-sm p-12 text-center">
              <ClipboardCheck className="w-12 h-12 mx-auto mb-3 text-fg-subtle" />
              <p className="text-fg-muted text-sm font-medium">Select a category to generate a checklist</p>
              <p className="text-fg-muted/70 text-xs mt-1">
                Or search for an item to load a saved checklist
              </p>
            </div>
          ) : (
            <>
              {/* Action bar */}
              <div className="flex flex-wrap items-center gap-2 mb-4">
                <button
                  onClick={saveChecklist}
                  disabled={!itemId || saveStatus === 'saving'}
                  className="flex items-center gap-1.5 px-3 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Save className="w-3.5 h-3.5" />
                  {saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved!' : 'Save Results'}
                </button>
                <button
                  onClick={handlePrint}
                  className="flex items-center gap-1.5 px-3 py-2 border border-border text-fg-muted text-sm rounded-lg hover:bg-muted/40 transition-colors"
                >
                  <Printer className="w-3.5 h-3.5" /> Print
                </button>
                <button
                  onClick={resetChecklist}
                  className="flex items-center gap-1.5 px-3 py-2 border border-border text-fg-muted text-sm rounded-lg hover:bg-muted/40 transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" /> Reset
                </button>

                {/* Quick-set all buttons */}
                <div className="ml-auto flex items-center gap-1.5">
                  <span className="text-xs text-fg-muted mr-1">Set all:</span>
                  {['pass', 'fail', 'skip', 'pending'].map((s) => {
                    const cfg = STATUS_CONFIG[s];
                    return (
                      <button
                        key={s}
                        onClick={() => setChecklist((prev) => prev.map((item) => ({ ...item, status: s })))}
                        className={`px-2 py-1 text-xs rounded border ${cfg.bg} ${cfg.color} hover:opacity-80 transition-colors`}
                        title={`Set all to ${cfg.label}`}
                      >
                        {cfg.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {saveStatus === 'error' && (
                <div className="mb-4 px-3 py-2 bg-danger-subtle border border-danger/30 rounded-lg text-sm text-danger">
                  Couldn't save. Try again.
                </div>
              )}

              {!itemId && (
                <div className="mb-4 px-3 py-2 bg-warning-subtle border border-warning/30 rounded-lg text-sm text-warning">
                  No item selected. Enter an Item ID or search for an item to enable saving.
                </div>
              )}

              {/* Checklist items */}
              <div className="bg-surface rounded-xl border border-border shadow-sm divide-y divide-border-subtle">
                {checklist.map((item, idx) => {
                  const cfg = STATUS_CONFIG[item.status];
                  const Icon = cfg.icon;
                  return (
                    <div key={item.id} className={`group ${focusedIdx === idx ? 'ring-1 ring-primary/30 rounded-lg' : ''}`} onClick={() => setFocusedIdx(idx)}>
                      <div className="flex items-center gap-3 px-4 py-3">
                        {/* Number */}
                        <span className="text-xs font-mono text-fg-muted w-5 text-right flex-shrink-0">
                          {idx + 1}
                        </span>

                        {/* Status icon (click to cycle) */}
                        <button
                          onClick={() => cycleStatus(item.id)}
                          className={`flex-shrink-0 ${cfg.color} hover:opacity-70 transition-opacity`}
                          title="Tap to cycle status"
                        >
                          <Icon className="w-5 h-5" />
                        </button>

                        {/* Label + critical badge */}
                        <span className={`flex-1 text-sm font-medium ${
                          item.status === 'pass' ? 'text-fg' :
                          item.status === 'fail' ? 'text-danger' :
                          item.status === 'skip' ? 'text-fg-muted line-through' :
                          'text-fg'
                        }`}>
                          {item.label}
                          {item.critical && <span className="ml-1.5 text-[9px] font-bold text-danger uppercase">CRITICAL</span>}
                        </span>

                        {/* Value field (if defined) */}
                        {item.valueField && (
                          <input
                            type={item.valueField}
                            value={item.value || ''}
                            onChange={e => updateValue(item.id, e.target.value)}
                            placeholder={item.valuePlaceholder || ''}
                            className="w-24 text-xs font-mono border border-border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary/30"
                          />
                        )}

                        {/* Quick status buttons — always visible so they
                            work on touch devices and don't hide the primary
                            action of the screen. */}
                        <div className="flex items-center gap-1">
                          {['pass', 'fail', 'skip'].map((s) => (
                            <button
                              key={s}
                              onClick={() => setStatus(item.id, s)}
                              className={`px-2 py-0.5 text-[10px] font-semibold uppercase rounded border transition-colors ${
                                item.status === s
                                  ? STATUS_CONFIG[s].bg + ' ' + STATUS_CONFIG[s].color
                                  : 'border-border text-fg-muted hover:bg-muted/40'
                              }`}
                            >
                              {STATUS_CONFIG[s].label}
                            </button>
                          ))}
                        </div>

                        {/* Notes toggle */}
                        <button
                          onClick={() => toggleNotes(item.id)}
                          className={`p-1 rounded transition-colors ${
                            item.notes
                              ? 'text-accent hover:text-accent/70'
                              : 'text-fg-subtle hover:text-fg-muted'
                          }`}
                          title="Add notes"
                        >
                          <StickyNote className="w-4 h-4" />
                        </button>
                      </div>

                      {/* Notes field */}
                      {(showNotes[item.id] || item.notes) && (
                        <div className="px-4 pb-3 pl-14">
                          <input
                            type="text"
                            placeholder="Add notes for this test..."
                            value={item.notes}
                            onChange={(e) => updateNote(item.id, e.target.value)}
                            className="w-full border border-border rounded px-2.5 py-1.5 text-xs text-fg bg-muted/40 focus:outline-none focus:ring-1 focus:ring-secondary/30 focus:border-secondary transition-colors"
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Print-only styles */}
      <style>{`
        @media print {
          body * { visibility: hidden; }
          .print-checklist, .print-checklist * { visibility: visible; }
          .print-checklist { position: absolute; top: 0; left: 0; width: 100%; }
        }
      `}</style>
    </div>
  );
}
