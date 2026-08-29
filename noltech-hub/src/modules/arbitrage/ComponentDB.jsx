import { useState, useEffect, useCallback } from 'react';
import {
  Search,
  Plus,
  Pencil,
  Trash2,
  X,
  Check,
  Database,
  ChevronDown,
  Barcode,
  Clock,
  RefreshCw,
  Sparkles,
  Wand2,
  Loader2,
  DollarSign,
  Cpu,
} from 'lucide-react';
import EmptyState from '../../components/EmptyState';
import { fmt } from '../../utils/formatters';
import { PIPELINE_BASE } from '../../utils/constants';
import { COMPONENT_SEED } from './componentData.js';
import { cleanTitles as geminiCleanTitles, GEMINI_KEY_STORAGE, loadGeminiTierConfig } from '../../services/gemini';
import { pullSoldCompsByUpc, resetSoldCompsPullCursor } from '../../services/soldCompsPull';
import { isCloudEnabled } from '../../services/supabase';
import { decrypt, decryptObject } from '../../services/crypto';
import eventBus from '../../services/eventBus';
import { EBAY_TOKEN_KEY } from '../../utils/constants';
import { KEY_LAMBDA_URL, KEY_AUTH_SECRET } from '../../services/soldComps';

// ─── Constants ────────────────────────────────────────────────────────────────

const STORAGE_KEY   = 'noltech:arbitrage:components';
const UPC_CACHE_KEY = 'noltech:arbitrage:upc-cache';

const CATEGORY_LABELS = {
  screen:       'Screen',
  ram:          'RAM',
  ssd:          'SSD',
  hdd:          'HDD',
  cpu_mobile:   'CPU (Mobile)',
  cpu_desktop:  'CPU (Desktop)',
  gpu:          'GPU',
  battery:      'Battery',
  charger:      'Charger',
  keyboard:     'Keyboard',
  motherboard:  'Motherboard',
  other:        'Other',
};

const CATEGORY_FILTER_ORDER = [
  'all', 'screen', 'ram', 'ssd', 'hdd', 'cpu_mobile',
  'cpu_desktop', 'gpu', 'battery', 'charger', 'keyboard', 'motherboard', 'other',
];

const DEMAND_STYLES = {
  high:   'bg-success-subtle text-success',
  medium: 'bg-warning-subtle text-warning',
  low:    'bg-muted text-fg-muted',
};

const EMPTY_FORM = {
  name:       '',
  category:   'screen',
  valueLow:   '',
  valueMid:   '',
  valueHigh:  '',
  demand:     'medium',
  notes:      '',
};

// ─── Subcomponents ────────────────────────────────────────────────────────────

function DemandBadge({ demand }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium capitalize ${DEMAND_STYLES[demand] || DEMAND_STYLES.medium}`}>
      {demand}
    </span>
  );
}

function CategoryBadge({ category }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-info-subtle text-info">
      {CATEGORY_LABELS[category] || category}
    </span>
  );
}

function ComponentFormModal({ initial, onSave, onClose }) {
  const [form, setForm] = useState(initial || EMPTY_FORM);
  const [errors, setErrors] = useState({});

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
    setErrors((e) => ({ ...e, [field]: undefined }));
  }

  function validate() {
    const errs = {};
    if (!form.name.trim()) errs.name = 'Name is required';
    if (form.valueLow === '' || isNaN(Number(form.valueLow)) || Number(form.valueLow) < 0)
      errs.valueLow = 'Required';
    if (form.valueMid === '' || isNaN(Number(form.valueMid)) || Number(form.valueMid) < 0)
      errs.valueMid = 'Required';
    if (form.valueHigh === '' || isNaN(Number(form.valueHigh)) || Number(form.valueHigh) < 0)
      errs.valueHigh = 'Required';
    return errs;
  }

  function handleSubmit(e) {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    onSave({
      ...form,
      valueLow:  Number(form.valueLow),
      valueMid:  Number(form.valueMid),
      valueHigh: Number(form.valueHigh),
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-surface rounded-xl shadow-xl w-full max-w-lg">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h3 className="text-base font-semibold text-fg">
            {initial ? 'Edit Component' : 'Add Component'}
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-muted text-fg-muted"
          >
            <X size={18} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-fg mb-1">
              Component Name
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder='e.g. DDR4 16GB SO-DIMM (laptop)'
              className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 ${errors.name ? 'border-danger' : 'border-border'}`}
            />
            {errors.name && <p className="text-xs text-danger mt-1">{errors.name}</p>}
          </div>

          {/* Category + Demand */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-fg mb-1">Category</label>
              <div className="relative">
                <select
                  value={form.category}
                  onChange={(e) => set('category', e.target.value)}
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm appearance-none focus:outline-none focus:ring-2 focus:ring-primary/30 pr-8"
                >
                  {Object.entries(CATEGORY_LABELS).map(([val, label]) => (
                    <option key={val} value={val}>{label}</option>
                  ))}
                </select>
                <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-fg mb-1">Demand</label>
              <div className="relative">
                <select
                  value={form.demand}
                  onChange={(e) => set('demand', e.target.value)}
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm appearance-none focus:outline-none focus:ring-2 focus:ring-primary/30 pr-8"
                >
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
                <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none" />
              </div>
            </div>
          </div>

          {/* Value Range */}
          <div>
            <label className="block text-sm font-medium text-fg mb-1">
              eBay Sold Price Range ($)
            </label>
            <div className="grid grid-cols-3 gap-2">
              {[['valueLow', 'Low'], ['valueMid', 'Mid'], ['valueHigh', 'High']].map(([field, label]) => (
                <div key={field}>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={form[field]}
                    onChange={(e) => set(field, e.target.value)}
                    placeholder={label}
                    className={`w-full border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 ${errors[field] ? 'border-danger' : 'border-border'}`}
                  />
                  <p className="text-xs text-fg-muted mt-0.5 text-center">{label}</p>
                </div>
              ))}
            </div>
            {(errors.valueLow || errors.valueMid || errors.valueHigh) && (
              <p className="text-xs text-danger mt-1">All three price fields are required</p>
            )}
          </div>

          {/* Notes */}
          <div>
            <label className="block text-sm font-medium text-fg mb-1">
              Notes <span className="text-fg-muted font-normal">(optional)</span>
            </label>
            <input
              type="text"
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
              placeholder='e.g. T470/T480 compatible, fast seller'
              className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-2">
            <button
              type="submit"
              className="flex-1 bg-primary text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-primary-dark transition-colors flex items-center justify-center gap-2"
            >
              <Check size={15} />
              {initial ? 'Save Changes' : 'Add Component'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-border text-fg-muted rounded-lg text-sm hover:bg-bg transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins < 2)   return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

// ─── UPC Category auto-detect ─────────────────────────────────────────────────

const UPC_CATEGORIES = {
  laptop:      'Laptop',
  desktop:     'Desktop',
  tablet:      'Tablet',
  phone:       'Phone',
  gpu:         'GPU',
  monitor:     'Monitor',
  headphones:  'Headphones',
  camera:      'Camera',
  gaming:      'Gaming',
  accessories: 'Accessories',
  storage:     'Storage',
  networking:  'Networking',
  wearable:    'Wearable',
  other:       'Other',
};

const UPC_CAT_RULES = [
  [/macbook|thinkpad|latitude|elitebook|chromebook|laptop|notebook/i, 'laptop'],
  [/optiplex|thinkcentre|desktop|imac|mac mini|nuc/i, 'desktop'],
  [/ipad|tablet|surface go|galaxy tab/i, 'tablet'],
  [/iphone|galaxy s\d|pixel \d|phone|smartphone/i, 'phone'],
  [/rtx|gtx|radeon|geforce|graphics|gpu|video card/i, 'gpu'],
  [/monitor|display panel|cinema display/i, 'monitor'],
  [/airpod|earbud|headphone|headset|beats|earphone/i, 'headphones'],
  [/gopro|camera|drone|dji|ring cam|blink/i, 'camera'],
  [/playstation|xbox|nintendo|switch|controller|gaming|dualsense/i, 'gaming'],
  [/ssd|hdd|hard drive|flash drive|memory card|nas|storage/i, 'storage'],
  [/router|modem|switch|networking|mesh|wifi|access point/i, 'networking'],
  [/watch|fitbit|garmin|tracker|wearable|band/i, 'wearable'],
  [/case|cable|charger|adapter|mount|stand|protector|keyboard|mouse|hub|dock|stylus|pen|strap|band|cover|sleeve|film|screen protect/i, 'accessories'],
];

function detectUpcCategory(title) {
  if (!title) return 'other';
  for (const [re, cat] of UPC_CAT_RULES) {
    if (re.test(title)) return cat;
  }
  return 'other';
}

// ─── UPC Edit Modal ───────────────────────────────────────────────────────────

const EMPTY_UPC_FORM = { upc: '', title: '', category: 'other', avgPrice: '', lowPrice: '', highPrice: '', numSales: '' };

function UPCEditModal({ initial, isNew, onSave, onClose }) {
  const [form, setForm] = useState(
    initial
      ? { upc: initial.upc || '', title: initial.title || '', category: initial.category || detectUpcCategory(initial.title), avgPrice: initial.avgPrice ?? '', lowPrice: initial.lowPrice ?? '', highPrice: initial.highPrice ?? '', numSales: initial.numSales ?? '' }
      : { ...EMPTY_UPC_FORM }
  );
  const [errors, setErrors] = useState({});

  function set(field, value) {
    setForm(f => {
      const updated = { ...f, [field]: value };
      // Auto-detect category when title changes
      if (field === 'title') updated.category = detectUpcCategory(value) || f.category;
      return updated;
    });
    setErrors(e => ({ ...e, [field]: undefined }));
  }

  function handleSubmit(e) {
    e.preventDefault();
    const errs = {};
    if (isNew && !form.upc.trim()) errs.upc = 'UPC is required';
    if (isNew && form.upc.trim() && !/^\d{12,13}$/.test(form.upc.trim())) errs.upc = 'Must be 12 or 13 digits';
    if (!form.title.trim()) errs.title = 'Title is required';
    if (form.avgPrice === '' || isNaN(Number(form.avgPrice))) errs.avgPrice = 'Required';
    if (Object.keys(errs).length) { setErrors(errs); return; }
    onSave({
      upc:      form.upc.trim(),
      title:    form.title.trim(),
      category: form.category,
      avgPrice: Number(form.avgPrice),
      lowPrice: form.lowPrice !== '' ? Number(form.lowPrice) : Number(form.avgPrice),
      highPrice:form.highPrice !== '' ? Number(form.highPrice) : Number(form.avgPrice),
      numSales: form.numSales !== '' ? Number(form.numSales) : 0,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-surface rounded-xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h3 className="text-base font-semibold text-fg">{isNew ? 'Add UPC Price' : 'Edit UPC Price'}</h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-muted text-fg-muted"><X size={18} /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* UPC */}
          <div>
            <label className="block text-sm font-medium text-fg mb-1">UPC</label>
            <input
              type="text"
              value={form.upc}
              onChange={e => set('upc', e.target.value)}
              disabled={!isNew}
              placeholder="012345678901"
              className={`w-full border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 ${errors.upc ? 'border-danger' : 'border-border'} ${!isNew ? 'bg-muted/40 text-fg-muted' : ''}`}
            />
            {errors.upc && <p className="text-xs text-danger mt-1">{errors.upc}</p>}
          </div>
          {/* Title */}
          <div>
            <label className="block text-sm font-medium text-fg mb-1">Product Title</label>
            <input
              type="text"
              value={form.title}
              onChange={e => set('title', e.target.value)}
              placeholder="e.g. Apple MacBook Air M1 8GB 256GB"
              className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 ${errors.title ? 'border-danger' : 'border-border'}`}
            />
            {errors.title && <p className="text-xs text-danger mt-1">{errors.title}</p>}
          </div>
          {/* Category */}
          <div>
            <label className="block text-sm font-medium text-fg mb-1">Category</label>
            <div className="relative">
              <select
                value={form.category}
                onChange={e => set('category', e.target.value)}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm appearance-none focus:outline-none focus:ring-2 focus:ring-primary/30 pr-8"
              >
                {Object.entries(UPC_CATEGORIES).map(([val, label]) => (
                  <option key={val} value={val}>{label}</option>
                ))}
              </select>
              <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none" />
            </div>
          </div>
          {/* Prices */}
          <div>
            <label className="block text-sm font-medium text-fg mb-1">eBay Sold Prices ($)</label>
            <div className="grid grid-cols-3 gap-2">
              {[['lowPrice', 'Low'], ['avgPrice', 'Avg *'], ['highPrice', 'High']].map(([field, label]) => (
                <div key={field}>
                  <input
                    type="number" min="0" step="0.01"
                    value={form[field]}
                    onChange={e => set(field, e.target.value)}
                    placeholder={label}
                    className={`w-full border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 ${errors[field] ? 'border-danger' : 'border-border'}`}
                  />
                  <p className="text-xs text-fg-muted mt-0.5 text-center">{label}</p>
                </div>
              ))}
            </div>
            {errors.avgPrice && <p className="text-xs text-danger mt-1">Avg price is required</p>}
          </div>
          {/* Num Sales */}
          <div>
            <label className="block text-sm font-medium text-fg mb-1"># Sales <span className="text-fg-muted font-normal">(optional)</span></label>
            <input
              type="number" min="0"
              value={form.numSales}
              onChange={e => set('numSales', e.target.value)}
              placeholder="0"
              className="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          {/* Actions */}
          <div className="flex gap-2 pt-2">
            <button type="submit" className="flex-1 bg-primary text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-primary-dark transition-colors flex items-center justify-center gap-2">
              <Check size={15} /> {isNew ? 'Add' : 'Save'}
            </button>
            <button type="button" onClick={onClose} className="px-4 py-2 border border-border text-fg-muted rounded-lg text-sm hover:bg-bg transition-colors">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── UPC Cache Panel ──────────────────────────────────────────────────────────

function UPCCachePanel() {
  const [cache, setCache]           = useState({});   // { upc: { title, avgPrice, lowPrice, highPrice, numSales, cachedAt } }
  const [loading, setLoading]       = useState(true);
  const [search, setSearch]         = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [clearConfirm, setClearConfirm]   = useState(false);
  const [editingUpc, setEditingUpc] = useState(null);  // upc string being edited, or '__new__' for add
  const [catFilter, setCatFilter]   = useState('all');


  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const raw = await window.storage.get(UPC_CACHE_KEY);
      setCache(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {});
    } catch (e) { console.error('[ComponentDB] UPC cache load failed:', e); }
    setLoading(false);
  }, []);

  // Two-way sync between Hub IndexedDB cache and scraper file cache.
  // Pushes our cache to the scraper, then pulls back its merged state so
  // both end up identical (with newest entry winning on conflicts).
  const [syncStatus, setSyncStatus] = useState(null);
  const [syncing, setSyncing] = useState(false);

  const syncWithScraper = useCallback(async (silent = false) => {
    if (syncing) return;
    setSyncing(true);
    if (!silent) setSyncStatus({ type: 'info', msg: 'Syncing both caches…' });
    try {
      const local = (await window.storage.get(UPC_CACHE_KEY)) || {};
      // 1) Push Hub → scraper. Smart-merges by cachedAt server-side.
      const pushResp = await fetch(`${PIPELINE_BASE}/api/upc-cache/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cache: local }),
        signal: AbortSignal.timeout(30000),
      });
      const pushData = await pushResp.json();

      // 2) Pull scraper → Hub. Server now has the union.
      const pullResp = await fetch(`${PIPELINE_BASE}/api/upc-cache`, {
        signal: AbortSignal.timeout(15000),
      });
      const pullData = await pullResp.json();
      if (pullData?.success && pullData.cache) {
        await window.storage.set(UPC_CACHE_KEY, pullData.cache);
        setCache(pullData.cache);
      }

      if (!silent) {
        setSyncStatus({
          type: 'success',
          msg: `Synced. Pushed ${pushData.added || 0} new + ${pushData.updated || 0} updated. Cache size now ${Object.keys(pullData.cache || {}).length}.`,
        });
        setTimeout(() => setSyncStatus(null), 5000);
      }
    } catch (e) {
      console.error('[ComponentDB] cache sync failed:', e);
      if (!silent) {
        setSyncStatus({ type: 'error', msg: 'Sync failed: ' + (e.message || e) });
        setTimeout(() => setSyncStatus(null), 5000);
      }
    } finally {
      setSyncing(false);
    }
  }, [syncing]);

  // Initial load + auto-sync on mount so the scraper picks up any Hub-side
  // entries it doesn't have yet (e.g. manually-added UPCs, entries from
  // before the scraper restarted, entries another device pushed via cloud
  // sync). Silent — user can trigger explicit sync via the button.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await reload();
      if (cancelled) return;
      // Run silently after a short delay so reload() finishes painting first
      setTimeout(() => { if (!cancelled) syncWithScraper(true); }, 500);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Cloud pull (sold_comps with UPC tag) ─────────────────────────────
  // Different from the bidirectional scraper sync above. This pulls UPC-
  // tagged sold_comps from Supabase directly into local IndexedDB,
  // covering the case where the AWS sync-agent priced items that the
  // local scraper never saw.
  const [pullRunning, setPullRunning] = useState(false);
  const [pullResult, setPullResult] = useState(null);

  async function pullFromCloud({ force = false } = {}) {
    if (pullRunning) return;
    setPullRunning(true);
    setPullResult(null);
    try {
      if (force) await resetSoldCompsPullCursor();
      const r = await pullSoldCompsByUpc({ force });
      if (r.error) {
        setPullResult({ type: 'error', msg: `Pull failed: ${r.error}` });
      } else if (r.pulled === 0) {
        setPullResult({ type: 'info', msg: 'Cloud cache is already in sync — nothing new.' });
      } else {
        setPullResult({
          type: 'success',
          msg: `Pulled ${r.pulled} sold-comp rows. Merged ${r.merged} new UPCs into local cache.`,
        });
        reload();
      }
      setTimeout(() => setPullResult(null), 6000);
    } catch (e) {
      setPullResult({ type: 'error', msg: e.message || String(e) });
    } finally {
      setPullRunning(false);
    }
  }

  // Live-refresh: when other modules merge new cache entries into IndexedDB
  // (BrowseLotsView after enrichment, useAutoSync, enrichmentService), they
  // emit `sync:array-updated` for the upc-cache key. Reload so the panel
  // picks up the new entries without requiring the user to close + reopen.
  useEffect(() => {
    const unsub = eventBus.on('sync:array-updated', (payload) => {
      if (payload?.storageKey === UPC_CACHE_KEY) reload();
    });
    return () => { unsub?.(); };
  }, [reload]);

  async function deleteEntry(upc) {
    const updated = { ...cache };
    delete updated[upc];
    setCache(updated);
    setDeleteConfirm(null);
    try { await window.storage.set(UPC_CACHE_KEY, updated); } catch (e) { console.error('[ComponentDB] UPC cache delete failed:', e); }
    // Also delete from server cache
    try { await fetch(`${PIPELINE_BASE}/api/upc-cache/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ upc }), signal: AbortSignal.timeout(10000) }); } catch (e) { console.error('[ComponentDB] server UPC delete failed:', e); }
  }

  async function clearAll() {
    setCache({});
    setClearConfirm(false);
    try { await window.storage.set(UPC_CACHE_KEY, {}); } catch (e) { console.error('[ComponentDB] UPC cache clear failed:', e); }
    // Also clear server-side cache so prices are re-fetched fresh
    try { await fetch(`${PIPELINE_BASE}/api/upc-cache/clear`, { method: 'POST', signal: AbortSignal.timeout(10000) }); } catch (e) { console.error('[ComponentDB] server UPC clear failed:', e); }
  }

  // ── Clean all titles: strip junk/redundant phrases from UPC names ──
  const [cleanedCount, setCleanedCount] = useState(null);

  async function cleanAllTitles() {
    // Phrases to strip entirely
    const STRIP_PHRASES = [
      /\bread\s+desc(?:ription)?\b/gi,
      /\bsee\s+desc(?:ription)?\b/gi,
      /\bplease\s+read\b/gi,
      /\blook\s+at\s+photos?\b/gi,
      /\bsee\s+photos?\b/gi,
      /\bsee\s+pictures?\b/gi,
      /\bcheck\s+photos?\b/gi,
      /\bas[\s-]*is\b/gi,
      /\bfor\s+parts\b/gi,
      /\bparts\s+only\b/gi,
      /\bnot\s+working\b/gi,
      /\bnot\s+tested\b/gi,
      /\buntested\b/gi,
      /\bno\s+returns?\b/gi,
      /\bfree\s+shipping\b/gi,
      /\bfast\s+ship(?:ping)?\b/gi,
      /\bships?\s+fast\b/gi,
      /\bship(?:s|ped)?\s+free\b/gi,
      /\bbrand\s+new\s+sealed\b/gi,
      /\bsealed\s+new\b/gi,
      /\bfactory\s+sealed\b/gi,
      /\bnew\s+in\s+box\b/gi,
      /\bnew\s+open\s+box\b/gi,
      /\bopen\s+box\b/gi,
      /\b100%\s+authentic\b/gi,
      /\bauthentic\b/gi,
      /\bgenuine\b/gi,
      /\boem\b/gi,
      /\blot\s+of\s+\d+\b/gi,
      /\bbundle\b/gi,
      /\bgreat\s+condition\b/gi,
      /\bgood\s+condition\b/gi,
      /\bexcellent\s+condition\b/gi,
      /\bmint\s+condition\b/gi,
      /\blike\s+new\b/gi,
      /\bvery\s+good\b/gi,
      /\blightly\s+used\b/gi,
      /\bgently\s+used\b/gi,
      /\bpre[\s-]*owned\b/gi,
      /\bused\b/gi,
      /\brefurbished\b/gi,
      /\brenewed\b/gi,
      /\b(?:empty\s+)?box\s+only\b/gi,
      /\bempty\s+box\b/gi,
      /\bno\s+box\b/gi,
      /\bwith\s+box\b/gi,
      /\bin\s+box\b/gi,
      /\bw\/\s*box\b/gi,
      /\bNEW!+\b/gi,
      /\bSALE!*\b/gi,
      /\bWOW!*\b/gi,
      /\bHOT!*\b/gi,
      /\bRARE!*\b/gi,
      /\bL@@K!*\b/gi,
      /\bLOOK!*\b/gi,
    ];

    // Clean up patterns
    const CLEANUP = [
      /\s*-{2,}\s*/g,          // multiple dashes: "iPad -- 64GB" → "iPad 64GB"
      /\s*~+\s*/g,             // tildes
      /\s*\*+\s*/g,            // asterisks
      /\s*!+\s*/g,             // trailing exclamation marks
      /\(\s*\)/g,              // empty parens
      /\[\s*\]/g,              // empty brackets
      /\s{2,}/g,               // multiple spaces
      /^[\s\-·•|,]+/,          // leading junk chars
      /[\s\-·•|,]+$/,          // trailing junk chars
    ];

    const updated = { ...cache };
    let count = 0;

    for (const [upc, entry] of Object.entries(updated)) {
      if (!entry.title) continue;
      let t = entry.title;
      for (const re of STRIP_PHRASES) t = t.replace(re, ' ');
      for (const re of CLEANUP) t = t.replace(re, ' ');
      t = t.trim();
      if (t !== entry.title) {
        updated[upc] = { ...entry, title: t };
        count++;
      }
    }

    if (count > 0) {
      setCache(updated);
      try { await window.storage.set(UPC_CACHE_KEY, updated); } catch (e) { console.error('[ComponentDB] cleaned titles save failed:', e); }
      try { await fetch(`${PIPELINE_BASE}/api/upc-cache/clear`, { method: 'POST', signal: AbortSignal.timeout(10000) }); } catch (e) { console.error('[ComponentDB] server cache clear after clean failed:', e); }
    }
    setCleanedCount(count);
    setTimeout(() => setCleanedCount(null), 3000);
  }

  // ── Clean ALL titles with Gemini ──────────────────────────────────────
  // Higher-quality cousin of cleanAllTitles. Batches all entries with raw
  // titles through Gemini to rewrite them into clean, listing-ready titles.
  // Overwrites entry.title in place (this UI manages the cache directly,
  // so there's no separate cleanTitle field to worry about).
  const [geminiRunning, setGeminiRunning] = useState(false);
  const [geminiProgress, setGeminiProgress] = useState({ done: 0, total: 0, batch: 0, totalBatches: 0 });
  const [geminiStatus, setGeminiStatus] = useState('');  // human-readable current step
  const [geminiResultCount, setGeminiResultCount] = useState(null);

  async function cleanAllTitlesGemini() {
    if (geminiRunning) return;

    // Collect every entry that has a title — the user wants ALL of them
    // cleaned, not just ones missing a clean version.
    const items = [];
    for (const [upc, entry] of Object.entries(cache)) {
      if (!entry?.title) continue;
      items.push({ upc, rawTitle: entry.title });
    }

    if (items.length === 0) {
      eventBus.emit('notification:push', {
        type: 'info',
        title: 'Nothing to clean',
        message: 'The UPC cache is empty.',
      });
      return;
    }

    // Verify the Gemini API key
    const rawKey = await window.storage.get(GEMINI_KEY_STORAGE).catch(() => null);
    if (!rawKey) {
      eventBus.emit('notification:push', {
        type: 'error',
        title: 'No Gemini API key',
        message: 'Add your key in Settings → Connections → Google Gemini API Key.',
      });
      return;
    }
    let apiKey;
    try { apiKey = await decrypt(rawKey); } catch { apiKey = null; }
    if (!apiKey) {
      eventBus.emit('notification:push', {
        type: 'error',
        title: 'Gemini key failed to decrypt',
        message: 'Re-enter your Gemini API key in Settings.',
      });
      return;
    }

    // Tier-aware config: Free pace 6.5s + 60 batch + 1 concurrent.
    // Paid Tier 1 paces 200ms + 80 batch + 4 concurrent. Tier 2 = 0 pace
    // + 100 batch + 8 concurrent. The user picks tier in Settings.
    const tierCfg = await loadGeminiTierConfig();
    const BATCH = tierCfg.batchSize;
    const PACE_MS = tierCfg.paceMs;
    const CONCURRENCY = tierCfg.concurrency;
    const totalBatches = Math.ceil(items.length / BATCH);

    setGeminiRunning(true);
    setGeminiProgress({ done: 0, total: items.length, batch: 0, totalBatches });
    setGeminiStatus(`Tier: ${tierCfg.tier} · ${CONCURRENCY > 1 ? `${CONCURRENCY} parallel batches` : 'sequential'} · starting…`);

    const cleaned = {};
    let completedBatches = 0;
    let completedItems = 0;

    // Slice into batches up front so the parallel scheduler has a fixed
    // queue to work through.
    const batches = [];
    for (let i = 0; i < items.length; i += BATCH) {
      batches.push({ idx: Math.floor(i / BATCH) + 1, slice: items.slice(i, i + BATCH) });
    }

    // Process one batch — wraps geminiCleanTitles + status callback.
    const processBatch = async ({ idx, slice }) => {
      const onStatus = (state, meta) => {
        if (state === 'sending') {
          const attempt = meta?.attempt ?? 0;
          setGeminiStatus(
            attempt > 0
              ? `Retrying batch ${idx}/${totalBatches} (attempt ${attempt + 1})…`
              : `Sending batch ${idx}/${totalBatches} (${slice.length} titles)…`,
          );
        } else if (state === 'waiting') {
          const sec = Math.ceil((meta?.ms ?? 0) / 1000);
          const why = meta?.reason === 429 ? 'rate-limited' : 'transient error';
          setGeminiStatus(`Batch ${idx}/${totalBatches} ${why} — waiting ${sec}s before retry`);
        } else if (state === 'parsing') {
          setGeminiStatus(`Parsing response from batch ${idx}/${totalBatches}…`);
        }
      };
      const results = await geminiCleanTitles(apiKey, slice, { onStatus });
      for (const r of results) {
        if (r.upc && r.cleanTitle) cleaned[r.upc] = r.cleanTitle;
      }
      completedBatches++;
      completedItems += slice.length;
      setGeminiProgress({
        done: Math.min(completedItems, items.length),
        total: items.length,
        batch: completedBatches,
        totalBatches,
      });
    };

    // Schedule batches with N-way concurrency. Each "lane" pulls the next
    // batch off the queue when it finishes its previous one. PACE_MS adds
    // a tiny gap between successive starts within a lane (mostly relevant
    // on Free tier; near-zero on paid).
    let nextIdx = 0;
    const runLane = async () => {
      for (;;) {
        const myBatch = nextIdx < batches.length ? batches[nextIdx++] : null;
        if (!myBatch) return;
        await processBatch(myBatch);
        if (PACE_MS > 0 && nextIdx < batches.length) {
          await new Promise((r) => setTimeout(r, PACE_MS));
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: CONCURRENCY }, () => runLane()));
    } catch (err) {
      eventBus.emit('notification:push', {
        type: 'error',
        title: 'Gemini cleaning failed',
        message: err.message,
      });
      setGeminiRunning(false);
      setGeminiStatus('');
      return;
    }

    // Apply the rewrites — only update entries where Gemini actually changed
    // the title (saves a re-render and avoids dirtying cachedAt-equivalents).
    const updated = { ...cache };
    let changedCount = 0;
    for (const [upc, newTitle] of Object.entries(cleaned)) {
      const existing = updated[upc];
      if (!existing || !newTitle || newTitle === existing.title) continue;
      updated[upc] = { ...existing, title: newTitle, cleanedAt: new Date().toISOString() };
      changedCount++;
    }

    if (changedCount > 0) {
      setCache(updated);
      try {
        await window.storage.set(UPC_CACHE_KEY, updated);
      } catch (e) {
        console.error('[ComponentDB] Gemini cleaned titles save failed:', e);
      }
    }

    setGeminiRunning(false);
    setGeminiStatus('');
    setGeminiResultCount(changedCount);
    setTimeout(() => setGeminiResultCount(null), 4000);
    eventBus.emit('notification:push', {
      type: 'success',
      title: 'Gemini cleaning complete',
      message: `Rewrote ${changedCount} of ${items.length} title${items.length !== 1 ? 's' : ''}.`,
    });
  }

  // ── Reprice cache entries that are missing avgPrice ──────────────────────
  // Calls the scraper's /api/upc-cache/reprice endpoint with the UPCs that
  // have null/0 avgPrice. The endpoint deletes those entries from the cache,
  // re-runs the sold-comps Lambda (or eBay Browse API fallback) for each,
  // and returns the fresh prices. We merge the results back into cache state.
  const [repriceRunning, setRepriceRunning] = useState(false);
  const [repriceProgress, setRepriceProgress] = useState({ done: 0, total: 0 });
  const [repriceResultCount, setRepriceResultCount] = useState(null);

  // UPCs with no usable avgPrice — drives the "Reprice missing (N)" button.
  const missingPriceCount = Object.values(cache).filter(
    (v) => !v.avgPrice || Number(v.avgPrice) <= 0,
  ).length;

  async function repriceMissing() {
    if (repriceRunning) return;

    // Collect entries needing a reprice — pass title + brand as query hints.
    const items = [];
    for (const [upc, entry] of Object.entries(cache)) {
      if (entry.avgPrice && Number(entry.avgPrice) > 0) continue;
      if (!/^\d{12,13}$/.test(upc)) continue;  // need a valid UPC
      items.push({ upc, title: entry.title || '', brand: entry.brand || '' });
    }

    if (items.length === 0) {
      eventBus.emit('notification:push', {
        type: 'info',
        title: 'No missing prices',
        message: 'Every cached UPC already has a price.',
      });
      return;
    }

    // Load credentials. Prefer sold-comps (Lambda) since that's what /enrich
    // uses by default; fall back to eBay Browse API if sold-comps not set up.
    let soldCompsCfg = null;
    try {
      const url = (await window.storage.get(KEY_LAMBDA_URL)) || '';
      const secEnc = (await window.storage.get(KEY_AUTH_SECRET)) || '';
      const secret = secEnc ? await decrypt(secEnc) : '';
      if (url && secret) {
        soldCompsCfg = { url, secret };
      }
    } catch (e) { console.warn('[ComponentDB] sold-comps cred load:', e); }

    let ebayCreds = {};
    try {
      const rawCreds = await window.storage.get(EBAY_TOKEN_KEY);
      if (rawCreds) ebayCreds = await decryptObject(rawCreds);
    } catch (e) { console.warn('[ComponentDB] eBay cred load:', e); }

    if (!soldCompsCfg && !ebayCreds.appId) {
      eventBus.emit('notification:push', {
        type: 'error',
        title: 'No pricing credentials',
        message: 'Set up sold-comps in Settings → Connections, or add an eBay App ID.',
      });
      return;
    }

    setRepriceRunning(true);
    setRepriceProgress({ done: 0, total: items.length });

    // Chunk client-side so the user sees progress on big runs. The scraper
    // also chunks internally, but a single 1000-UPC POST would block the
    // progress bar at 0/1000 for the whole run.
    const CHUNK = 80;
    const updated = { ...cache };
    let foundCount = 0;
    let processed = 0;

    try {
      for (let i = 0; i < items.length; i += CHUNK) {
        const batch = items.slice(i, i + CHUNK);
        const resp = await fetch(`${PIPELINE_BASE}/api/upc-cache/reprice`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: batch,
            appId: ebayCreds.appId || null,
            certId: ebayCreds.certId || null,
            soldComps: soldCompsCfg,
            // Always force UPC → Browse API title resolution. The cached
            // titles for missing-price entries are usually corrupted (that's
            // why they couldn't be priced the first time), so we throw them
            // out and let the scraper resolve a fresh canonical title from
            // the UPC itself before querying sold-comps.
            forceUpcResolution: true,
          }),
          signal: AbortSignal.timeout(5 * 60 * 1000),  // 5 min per chunk
        });
        const data = await resp.json();
        if (!data.success) throw new Error(data.error || `reprice HTTP ${resp.status}`);

        for (const r of (data.results || [])) {
          if (!r || !r.upc) continue;
          const existing = updated[r.upc] || {};
          if (r.found && r.avgPrice != null) {
            updated[r.upc] = {
              ...existing,
              title:     r.title || existing.title || '',
              avgPrice:  r.avgPrice,
              lowPrice:  r.lowPrice,
              highPrice: r.highPrice,
              numSales:  r.numSales || 0,
              priceSource: r.source || existing.priceSource,
              cachedAt: new Date().toISOString(),
            };
            foundCount++;
          }
          // For not-found, we leave the entry alone (still missing avgPrice).
          // The user can manually delete or re-edit those.
        }

        processed += batch.length;
        setRepriceProgress({ done: processed, total: items.length });
      }
    } catch (err) {
      eventBus.emit('notification:push', {
        type: 'error',
        title: 'Reprice failed',
        message: err.message,
      });
      setRepriceRunning(false);
      return;
    }

    // Persist & update state
    setCache(updated);
    try {
      await window.storage.set(UPC_CACHE_KEY, updated);
    } catch (e) {
      console.error('[ComponentDB] reprice save failed:', e);
    }

    setRepriceRunning(false);
    setRepriceResultCount(foundCount);
    setTimeout(() => setRepriceResultCount(null), 5000);
    eventBus.emit('notification:push', {
      type: 'success',
      title: 'Reprice complete',
      message: `Found prices for ${foundCount} of ${items.length} entries.`,
    });
  }

  async function handleSaveUpc(formData) {
    const updated = { ...cache };
    updated[formData.upc] = {
      title:    formData.title,
      category: formData.category,
      avgPrice: formData.avgPrice,
      lowPrice: formData.lowPrice,
      highPrice:formData.highPrice,
      numSales: formData.numSales,
      cachedAt: cache[formData.upc]?.cachedAt || new Date().toISOString(),
    };
    setCache(updated);
    setEditingUpc(null);
    try { await window.storage.set(UPC_CACHE_KEY, updated); } catch (e) { console.error('[ComponentDB] UPC save failed:', e); }
  }

  // Auto-assign categories to entries that don't have one
  const entries = Object.entries(cache).map(([upc, v]) => [
    upc,
    { ...v, category: v.category || detectUpcCategory(v.title) },
  ]);
  const q = search.toLowerCase();
  const filtered = entries.filter(([upc, v]) => {
    if (catFilter !== 'all' && (v.category || 'other') !== catFilter) return false;
    if (q && !upc.includes(q) && !(v.title || '').toLowerCase().includes(q)) return false;
    return true;
  });

  // Compute category counts for filter pills
  const catCounts = {};
  entries.forEach(([, v]) => {
    const c = v.category || 'other';
    catCounts[c] = (catCounts[c] || 0) + 1;
  });
  const activeCats = Object.keys(catCounts).sort((a, b) => (catCounts[b] - catCounts[a]));

  if (loading) {
    return (
      <div className="animate-pulse space-y-3">
        <div className="h-8 bg-muted rounded-lg w-1/3" />
        <div className="h-48 bg-muted rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-fg-muted text-sm">
          <Barcode size={15} />
          <span>{entries.length} cached UPCs</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={cleanAllTitles}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              cleanedCount !== null
                ? 'bg-success-subtle border border-success/30 text-success'
                : 'border border-border text-fg-muted hover:bg-warning-subtle hover:text-warning hover:border-warning/30'
            }`}
            title="Remove junk phrases like 'Read Description', 'Free Shipping', 'Empty Box', etc. from all titles"
          >
            <Sparkles size={13} />
            {cleanedCount !== null ? `Cleaned ${cleanedCount} titles` : 'Clean Titles'}
          </button>
          <button
            onClick={() => syncWithScraper(false)}
            disabled={syncing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border border-border text-fg-muted hover:bg-info-subtle hover:text-info hover:border-info/30 disabled:opacity-50"
            title="Two-way sync: pushes Hub's cache to the scraper, pulls scraper's cache back. Both sides converge."
          >
            <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Syncing…' : 'Sync caches'}
          </button>
          {isCloudEnabled && (
            <button
              onClick={() => pullFromCloud()}
              disabled={pullRunning}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border border-border text-fg-muted hover:bg-accent-subtle hover:text-accent hover:border-accent/30 disabled:opacity-50"
              title="Pull all UPC-tagged sold_comps from Supabase into local IndexedDB. Mirrors AWS-priced data so you don't need to manually re-price."
            >
              <Database size={13} className={pullRunning ? 'animate-pulse' : ''} />
              {pullRunning ? 'Pulling…' : 'Pull from cloud'}
            </button>
          )}
          {missingPriceCount > 0 && (
            <button
              onClick={repriceMissing}
              disabled={repriceRunning}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                repriceResultCount !== null
                  ? 'bg-success-subtle border border-success/30 text-success'
                  : 'border border-warning/40 bg-warning-subtle text-warning hover:brightness-95'
              }`}
              title="Re-fetch prices for cached UPCs that have no avgPrice. Uses sold-comps Lambda or eBay Browse API."
            >
              {repriceRunning ? (
                <>
                  <Loader2 size={13} className="animate-spin" />
                  Repricing {repriceProgress.done}/{repriceProgress.total}…
                </>
              ) : repriceResultCount !== null ? (
                <>
                  <DollarSign size={13} />
                  Repriced {repriceResultCount}
                </>
              ) : (
                <>
                  <DollarSign size={13} />
                  Reprice missing ({missingPriceCount})
                </>
              )}
            </button>
          )}
          <button
            onClick={cleanAllTitlesGemini}
            disabled={geminiRunning || entries.length === 0}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              geminiResultCount !== null
                ? 'bg-success-subtle border border-success/30 text-success'
                : 'border border-primary/40 bg-primary/5 text-primary hover:bg-primary/10'
            }`}
            title="Use Google Gemini to rewrite every cached title into a clean, listing-ready format. Requires a Gemini API key in Settings."
          >
            {geminiRunning ? (
              <>
                <Loader2 size={13} className="animate-spin" />
                Cleaning {geminiProgress.done}/{geminiProgress.total}…
              </>
            ) : geminiResultCount !== null ? (
              <>
                <Wand2 size={13} />
                Rewrote {geminiResultCount}
              </>
            ) : (
              <>
                <Wand2 size={13} />
                Clean with Gemini
              </>
            )}
          </button>
          <button
            onClick={() => setEditingUpc('__new__')}
            className="flex items-center gap-1.5 bg-primary text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-primary-dark transition-colors"
          >
            <Plus size={13} /> Add UPC
          </button>
          <button
            onClick={reload}
            className="p-1.5 rounded-lg border border-border text-fg-muted hover:bg-muted/40 transition-colors"
            title="Refresh"
          >
            <RefreshCw size={13} />
          </button>
          {entries.length > 0 && (
            clearConfirm ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-danger">Clear all?</span>
                <button onClick={clearAll} className="text-xs bg-danger text-white px-3 py-1.5 rounded-lg hover:brightness-110 transition-colors">Yes</button>
                <button onClick={() => setClearConfirm(false)} className="text-xs border border-border text-fg-muted px-3 py-1.5 rounded-lg hover:bg-bg transition-colors">Cancel</button>
              </div>
            ) : (
              <button
                onClick={() => setClearConfirm(true)}
                className="flex items-center gap-1.5 text-xs border border-border text-fg-muted px-3 py-1.5 rounded-lg hover:bg-danger-subtle hover:text-danger hover:border-danger/30 transition-colors"
              >
                <X size={12} /> Clear All
              </button>
            )
          )}
        </div>
      </div>

      {/* Reprice progress banner */}
      {repriceRunning && (
        <div className="rounded-xl border border-warning/30 bg-warning-subtle p-4">
          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="flex items-center gap-2 text-sm font-medium text-warning">
              <Loader2 size={14} className="animate-spin" />
              <span>Repricing UPCs with missing prices…</span>
            </div>
            <span className="text-xs font-mono tabular-nums text-fg-muted">
              {repriceProgress.done} / {repriceProgress.total}
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-warning/20 overflow-hidden">
            <div
              className="h-full bg-warning transition-all duration-300"
              style={{
                width: `${repriceProgress.total > 0
                  ? Math.min(100, Math.round((repriceProgress.done / repriceProgress.total) * 100))
                  : 0}%`,
              }}
            />
          </div>
          <p className="text-[11px] text-fg-muted mt-2">
            Re-running the sold-comps Lambda (or eBay Browse API) on every cache entry without a price. Each
            chunk of 80 UPCs takes ~10-30s. Found prices replace the empty entries; unfound stay as-is.
          </p>
        </div>
      )}

      {/* Pull-from-cloud result banner */}
      {pullResult && (
        <div className={`rounded-lg border p-3 text-xs ${
          pullResult.type === 'success' ? 'border-success/30 bg-success-subtle text-success' :
          pullResult.type === 'error'   ? 'border-danger/30 bg-danger-subtle text-danger' :
                                          'border-border bg-muted text-fg-muted'
        }`}>
          {pullResult.msg}
        </div>
      )}

      {/* Gemini cleaning progress banner — sticks around for the entire run
          and surfaces the in-flight status from callGemini (sending /
          waiting on rate-limit / parsing / pacing) so the user can see what
          the cleaner is actually doing instead of staring at a frozen 0/N. */}
      {geminiRunning && (
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-4">
          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="flex items-center gap-2 text-sm font-medium text-primary">
              <Loader2 size={14} className="animate-spin" />
              <span>Cleaning titles with Gemini…</span>
            </div>
            <span className="text-xs font-mono tabular-nums text-fg-muted">
              {geminiProgress.done} / {geminiProgress.total}
              {geminiProgress.totalBatches > 0 && (
                <span className="ml-2 text-fg-subtle">
                  · batch {geminiProgress.batch}/{geminiProgress.totalBatches}
                </span>
              )}
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-primary/15 overflow-hidden mb-2">
            <div
              className="h-full bg-primary transition-all duration-300"
              style={{
                width: `${geminiProgress.total > 0
                  ? Math.min(100, Math.round((geminiProgress.done / geminiProgress.total) * 100))
                  : 0}%`,
              }}
            />
          </div>
          {geminiStatus && (
            <p className="text-[11px] font-medium text-primary/90 mt-1.5 mb-2">
              {geminiStatus}
            </p>
          )}
          <p className="text-[11px] text-fg-muted">
            Rewriting raw eBay titles into <span className="text-fg font-medium">[Brand] [Model] [Specs]</span> format.
            Stripping marketing fluff (BRAND NEW!, GENUINE, FAST SHIPPING), emojis, ALL-CAPS exclamations, and the
            "Opens in a new window or tab" suffix. Runs in batches of 60 with 6.5s between each to stay under
            the free-tier rate limit.
          </p>
        </div>
      )}

      {/* Search */}
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by UPC or title…"
          className="w-full border border-border rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 bg-surface"
        />
        {search && (
          <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-muted hover:text-fg">
            <X size={13} />
          </button>
        )}
      </div>

      {/* Category filter pills */}
      {activeCats.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setCatFilter('all')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              catFilter === 'all' ? 'bg-primary text-white' : 'border border-border text-fg-muted hover:bg-bg'
            }`}
          >
            All ({entries.length})
          </button>
          {activeCats.map(cat => (
            <button
              key={cat}
              onClick={() => setCatFilter(cat)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                catFilter === cat ? 'bg-primary text-white' : 'border border-border text-fg-muted hover:bg-bg'
              }`}
            >
              {UPC_CATEGORIES[cat] || cat} ({catCounts[cat]})
            </button>
          ))}
        </div>
      )}

      {/* Table */}
      {filtered.length === 0 ? (
        <EmptyState
          icon={Database}
          title={entries.length === 0 ? 'No UPC prices cached yet' : 'No results match your filters'}
          description={entries.length === 0
            ? 'Use the Manifest Pricer tab to look up UPCs from TechLiquidators manifests.'
            : 'Try a different search term.'}
        />
      ) : (
        <div className="rounded-xl border border-border overflow-x-auto">
          <table className="w-full text-sm min-w-[600px]">
            <thead>
              <tr className="bg-muted/40 border-b border-border">
                <th className="text-left px-4 py-3 font-semibold text-fg text-xs">UPC</th>
                <th className="text-left px-4 py-3 font-semibold text-fg text-xs">Title</th>
                <th className="text-left px-4 py-3 font-semibold text-fg text-xs hidden sm:table-cell">Category</th>
                <th className="text-center px-4 py-3 font-semibold text-fg text-xs">Low</th>
                <th className="text-center px-4 py-3 font-semibold text-fg text-xs">Avg</th>
                <th className="text-center px-4 py-3 font-semibold text-fg text-xs">High</th>
                <th className="text-center px-4 py-3 font-semibold text-fg text-xs">Sales</th>
                <th className="text-center px-4 py-3 font-semibold text-fg text-xs">Cached</th>
                <th className="text-right px-4 py-3 font-semibold text-fg text-xs">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(([upc, v], idx) => (
                <tr key={upc} className={`border-b border-border-subtle last:border-0 hover:bg-info-subtle/30 transition-colors ${idx % 2 === 1 ? 'bg-muted/40/50' : 'bg-surface'}`}>
                  <td className="px-4 py-3 font-mono text-xs text-fg">{upc}</td>
                  <td className="px-4 py-3 text-sm text-fg max-w-xs leading-snug">
                    {v.title || <span className="text-fg-muted italic">Unknown</span>}
                  </td>
                  <td className="px-4 py-3 hidden sm:table-cell">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-info-subtle text-info">
                      {UPC_CATEGORIES[v.category] || v.category || 'Other'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center font-mono text-xs text-fg-muted">{fmt(v.lowPrice)}</td>
                  <td className="px-4 py-3 text-center font-mono text-sm font-semibold text-fg">{fmt(v.avgPrice)}</td>
                  <td className="px-4 py-3 text-center font-mono text-xs text-fg-muted">{fmt(v.highPrice)}</td>
                  <td className="px-4 py-3 text-center text-xs text-fg-muted">{v.numSales || '—'}</td>
                  <td className="px-4 py-3 text-center text-xs text-fg-muted">
                    <span className="flex items-center justify-center gap-0.5">
                      <Clock size={10} />
                      {relativeTime(v.cachedAt)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {deleteConfirm === upc ? (
                      <div className="flex items-center justify-end gap-1.5">
                        <button onClick={() => deleteEntry(upc)} className="p-1.5 rounded-lg bg-danger text-white hover:brightness-110 transition-colors" title="Confirm">
                          <Check size={12} />
                        </button>
                        <button onClick={() => setDeleteConfirm(null)} className="p-1.5 rounded-lg border border-border text-fg-muted hover:bg-bg transition-colors" title="Cancel">
                          <X size={12} />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => setEditingUpc(upc)} className="p-1.5 rounded-lg border border-border text-fg-muted hover:bg-bg hover:text-primary transition-colors" title="Edit">
                          <Pencil size={12} />
                        </button>
                        <button onClick={() => setDeleteConfirm(upc)} className="p-1.5 rounded-lg border border-border text-fg-muted hover:bg-danger-subtle hover:text-danger hover:border-danger/30 transition-colors" title="Delete">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-fg-muted">
        Prices sourced from eBay listings via Manifest Pricer. Re-run the pricer to refresh stale entries, or edit manually.
      </p>

      {/* Edit / Add modal */}
      {editingUpc && (
        <UPCEditModal
          isNew={editingUpc === '__new__'}
          initial={editingUpc !== '__new__' ? { upc: editingUpc, ...cache[editingUpc] } : null}
          onSave={handleSaveUpc}
          onClose={() => setEditingUpc(null)}
        />
      )}
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────────

export default function ComponentDB() {
  const [dbTab, setDbTab] = useState('components'); // 'components' | 'upc-cache'

  const [components, setComponents] = useState([]);
  const [loading, setLoading]       = useState(true);
  const [storageError, setStorageError] = useState(null);

  const [search, setSearch]           = useState('');
  const [activeCategory, setActiveCategory] = useState('all');

  const [showModal, setShowModal]     = useState(false);
  const [editingItem, setEditingItem] = useState(null); // null = adding new
  const [deleteConfirm, setDeleteConfirm] = useState(null); // id to confirm

  // ─── Load from storage (seed if empty) ──────────────────────────────────

  const loadComponents = useCallback(async () => {
    setLoading(true);
    setStorageError(null);
    try {
      const stored = await window.storage.get(STORAGE_KEY);
      if (stored && Array.isArray(stored) && stored.length > 0) {
        setComponents(stored);
      } else {
        // Seed with default data
        await window.storage.set(STORAGE_KEY, COMPONENT_SEED);
        setComponents(COMPONENT_SEED);
      }
    } catch (err) {
      console.error('ComponentDB storage load error:', err);
      setStorageError("Couldn't load component database. " + err.message);
      // Fall back to seed data in memory
      setComponents(COMPONENT_SEED);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadComponents();
  }, [loadComponents]);

  // ─── Persist helper ──────────────────────────────────────────────────────

  async function persist(updated) {
    try {
      await window.storage.set(STORAGE_KEY, updated);
    } catch (err) {
      console.error('ComponentDB storage save error:', err);
      setStorageError("Couldn't save changes: " + err.message);
    }
  }

  // ─── Filtered view ────────────────────────────────────────────────────────

  const filtered = components.filter((c) => {
    const matchesCategory = activeCategory === 'all' || c.category === activeCategory;
    const q = search.toLowerCase();
    const matchesSearch = !q || c.name.toLowerCase().includes(q) || (c.notes || '').toLowerCase().includes(q);
    return matchesCategory && matchesSearch;
  });

  // ─── CRUD handlers ────────────────────────────────────────────────────────

  function handleAdd() {
    setEditingItem(null);
    setShowModal(true);
  }

  function handleEdit(item) {
    setEditingItem(item);
    setShowModal(true);
  }

  function handleDeleteRequest(id) {
    setDeleteConfirm(id);
  }

  function handleDeleteConfirm() {
    const updated = components.filter((c) => c.id !== deleteConfirm);
    setComponents(updated);
    persist(updated);
    setDeleteConfirm(null);
  }

  function handleModalSave(formData) {
    if (editingItem) {
      // Edit existing
      const updated = components.map((c) =>
        c.id === editingItem.id ? { ...editingItem, ...formData } : c
      );
      setComponents(updated);
      persist(updated);
    } else {
      // Add new
      const newItem = {
        ...formData,
        id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      };
      const updated = [newItem, ...components];
      setComponents(updated);
      persist(updated);
    }
    setShowModal(false);
    setEditingItem(null);
  }

  function handleModalClose() {
    setShowModal(false);
    setEditingItem(null);
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="animate-pulse space-y-3 p-4">
        <div className="h-8 bg-muted rounded-lg w-1/3" />
        <div className="h-10 bg-muted rounded-lg" />
        <div className="h-64 bg-muted rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Internal tab bar */}
      <div className="flex gap-1 border-b border-border pb-1">
        {[
          { id: 'components', label: 'Components', icon: Database },
          { id: 'upc-cache',  label: 'UPC Price Cache', icon: Barcode },
        ].map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setDbTab(id)}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              dbTab === id
                ? 'bg-primary text-white'
                : 'text-fg-muted hover:bg-bg hover:text-fg'
            }`}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>

      {/* UPC Cache tab */}
      {dbTab === 'upc-cache' && <UPCCachePanel />}

      {/* Components tab */}
      {dbTab === 'components' && <>

      {/* Header row */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-fg-muted text-sm">
          <Database size={15} />
          <span>{components.length} components</span>
        </div>
        <button
          onClick={handleAdd}
          className="flex items-center gap-1.5 bg-primary text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary-dark transition-colors"
        >
          <Plus size={15} />
          Add Component
        </button>
      </div>

      {/* Storage error */}
      {storageError && (
        <div className="bg-danger-subtle border border-danger/30 text-danger rounded-lg px-4 py-3 text-sm">
          {storageError}
        </div>
      )}

      {/* Search */}
      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search components..."
          className="w-full border border-border rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 bg-surface"
        />
        {search && (
          <button
            onClick={() => setSearch('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-muted hover:text-fg"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Category filters */}
      <div className="flex flex-wrap gap-2">
        {CATEGORY_FILTER_ORDER.map((cat) => {
          const active = activeCategory === cat;
          const label = cat === 'all' ? 'All' : CATEGORY_LABELS[cat];
          return (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                active
                  ? 'bg-primary text-white'
                  : 'border border-border text-fg-muted hover:bg-bg'
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <EmptyState
          icon={Cpu}
          title="No components found"
          description={search || activeCategory !== 'all'
            ? 'Try adjusting your search or filter.'
            : 'Add your first component to get started.'}
        />
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/40 border-b border-border">
                <th className="text-left px-4 py-3 font-semibold text-fg">Component</th>
                <th className="text-left px-4 py-3 font-semibold text-fg hidden sm:table-cell">Category</th>
                <th className="text-center px-4 py-3 font-semibold text-fg">Low</th>
                <th className="text-center px-4 py-3 font-semibold text-fg">Mid</th>
                <th className="text-center px-4 py-3 font-semibold text-fg">High</th>
                <th className="text-center px-4 py-3 font-semibold text-fg hidden md:table-cell">Demand</th>
                <th className="text-right px-4 py-3 font-semibold text-fg">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item, idx) => (
                <tr
                  key={item.id}
                  className={`border-b border-border-subtle last:border-0 hover:bg-info-subtle/40 transition-colors ${idx % 2 === 1 ? 'bg-muted/40/50' : 'bg-surface'}`}
                >
                  <td className="px-4 py-3">
                    <p className="font-medium text-fg leading-tight">{item.name}</p>
                    {item.notes && (
                      <p className="text-xs text-fg-muted mt-0.5 leading-tight">{item.notes}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 hidden sm:table-cell">
                    <CategoryBadge category={item.category} />
                  </td>
                  <td className="px-4 py-3 text-center font-mono text-xs text-fg-muted">
                    ${item.valueLow}
                  </td>
                  <td className="px-4 py-3 text-center font-mono text-sm font-semibold text-fg">
                    ${item.valueMid}
                  </td>
                  <td className="px-4 py-3 text-center font-mono text-xs text-fg-muted">
                    ${item.valueHigh}
                  </td>
                  <td className="px-4 py-3 text-center hidden md:table-cell">
                    <DemandBadge demand={item.demand} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    {deleteConfirm === item.id ? (
                      <div className="flex items-center justify-end gap-2">
                        <span className="text-xs text-danger">Delete?</span>
                        <button
                          onClick={handleDeleteConfirm}
                          className="p-1.5 rounded-lg bg-danger text-white hover:brightness-110 transition-colors"
                          title="Confirm delete"
                        >
                          <Check size={13} />
                        </button>
                        <button
                          onClick={() => setDeleteConfirm(null)}
                          className="p-1.5 rounded-lg border border-border text-fg-muted hover:bg-bg transition-colors"
                          title="Cancel"
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => handleEdit(item)}
                          className="p-1.5 rounded-lg border border-border text-fg-muted hover:bg-bg hover:text-primary transition-colors"
                          title="Edit"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          onClick={() => handleDeleteRequest(item.id)}
                          className="p-1.5 rounded-lg border border-border text-fg-muted hover:bg-danger-subtle hover:text-danger hover:border-danger/30 transition-colors"
                          title="Delete"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <ComponentFormModal
          initial={editingItem}
          onSave={handleModalSave}
          onClose={handleModalClose}
        />
      )}
      </>}
    </div>
  );
}
