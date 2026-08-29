import { useState, useEffect, useMemo, useCallback, Fragment } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  FileSpreadsheet,
  Download,
  Edit2,
  Package,
  Tag,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  Clock,
  Trash2,
  Image as ImageIcon,
  Percent,
  X,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { fmt } from '../../utils/formatters';
import {
  Badge, Button, Card, Input, Label, Modal, PageHeader, Select, Skeleton,
  Stat, Tabs, Table, THead, TBody, TR, TH, TD,
} from '../../components/ui';
import EmptyState from '../../components/EmptyState';
import eventBus from '../../services/eventBus';
import { decryptObject, decrypt } from '../../services/crypto';
import { PIPELINE_BASE, EBAY_TOKEN_KEY } from '../../utils/constants';
import { Send, Loader2, ChevronDown, ChevronRight, Plus, Sparkles, Wand2 } from 'lucide-react';
import { getEffectiveResaleMultiplier } from '../../utils/fees';
import { autofillListing as geminiAutofill, cleanTitles as geminiCleanTitles, GEMINI_KEY_STORAGE, loadGeminiTierConfig } from '../../services/gemini';
import { cleanEbayTitle } from '../../utils/titleClean';

const SCHEDULED_KEY = 'noltech:inventory:scheduled-listings';

// ─── Constants ────────────────────────────────────────────────────────────────

const BROWSE_KEY   = 'noltech:arbitrage:browse-lots';
const UPC_CACHE_KEY = 'noltech:arbitrage:upc-cache';

// eBay condition ID mapping
const CONDITION_MAP = {
  new:       { id: 1000, label: 'New' },
  like_new:  { id: 1500, label: 'Open Box' },
  open_box:  { id: 1500, label: 'Open Box' },
  good:      { id: 3000, label: 'Used' },
  used:      { id: 3000, label: 'Used' },
  fair:      { id: 3000, label: 'Used' },
  refurbished: { id: 2500, label: 'Seller Refurbished' },
  salvage:   { id: 7000, label: 'For Parts or Not Working' },
  poor:      { id: 7000, label: 'For Parts or Not Working' },
  broken:    { id: 7000, label: 'For Parts or Not Working' },
  untested:  { id: 3000, label: 'Used' },
};

// Category suggestions based on keywords
const CATEGORY_RULES = [
  { keywords: ['laptop', 'notebook', 'thinkpad', 'latitude', 'elitebook', 'chromebook', 'macbook', 'surface pro', 'surface laptop'], category: 'Laptops & Netbooks' },
  { keywords: ['desktop', 'optiplex', 'thinkcentre', 'prodesk', 'tower', 'mini pc', 'nuc'], category: 'Desktops & All-In-Ones' },
  { keywords: ['gpu', 'graphics card', 'geforce', 'radeon', 'rtx', 'gtx', 'rx '], category: 'Graphics/Video Cards' },
  { keywords: ['ram', 'ddr4', 'ddr5', 'memory', 'dimm', 'sodimm'], category: 'Memory (RAM)' },
  { keywords: ['ssd', 'hdd', 'hard drive', 'nvme', 'm.2', 'solid state'], category: 'Drives, Storage & Blank Media' },
  { keywords: ['monitor', 'display', 'screen'], category: 'Monitors, Projectors & Accs' },
  { keywords: ['iphone', 'galaxy', 'pixel', 'phone'], category: 'Cell Phones & Smartphones' },
  { keywords: ['ipad', 'tablet', 'surface go'], category: 'Tablets & eReaders' },
  { keywords: ['keyboard', 'mouse', 'webcam', 'headset', 'speaker', 'dock', 'docking'], category: 'Keyboards, Mice & Pointers' },
  { keywords: ['switch', 'router', 'access point', 'firewall', 'networking'], category: 'Enterprise Networking' },
  { keywords: ['server', 'poweredge', 'proliant'], category: 'Enterprise Servers' },
  { keywords: ['printer', 'scanner', 'copier'], category: 'Printers' },
  { keywords: ['cpu', 'processor', 'core i', 'ryzen', 'xeon'], category: 'CPUs/Processors' },
  { keywords: ['power supply', 'psu', 'charger', 'adapter', 'ac adapter'], category: 'Power Supplies' },
  { keywords: ['motherboard', 'mainboard', 'system board'], category: 'Motherboards' },
];

const TEMPLATES = {
  basic: { label: 'Basic', description: 'Simple and clean — product name, condition, shipping info' },
  detailed: { label: 'Detailed', description: 'Includes specs and item specifics where available' },
  professional: { label: 'Professional', description: 'Full branded template with HTML formatting' },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function guessCategory(text) {
  if (!text) return 'Other';
  const lower = text.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some(kw => lower.includes(kw))) return rule.category;
  }
  return 'Other';
}

function mapCondition(rawCondition) {
  if (!rawCondition) return CONDITION_MAP.used;
  const key = rawCondition.toLowerCase().replace(/[\s_-]+/g, '_').trim();
  return CONDITION_MAP[key] || CONDITION_MAP.used;
}

function buildTitle(item, maxLen = 80) {
  const parts = [];
  if (item.brand) parts.push(item.brand);
  const name = item.ebayTitle || item.title || '';
  if (name) parts.push(name);

  let title = parts.join(' ');

  // Deduplicate brand if already in the name
  if (item.brand && name.toLowerCase().startsWith(item.brand.toLowerCase())) {
    title = name;
  }

  // Add condition suffix if room
  const cond = item._conditionLabel;
  if (cond && title.length + cond.length + 3 <= maxLen) {
    title = title + ' - ' + cond;
  }

  return title.length > maxLen ? title.slice(0, maxLen - 1).trim() + '\u2026' : title;
}

function buildDescription(item, template) {
  const name = item.ebayTitle || item.title || item.brand || 'Item';
  const cond = item._conditionLabel || 'Used';

  if (template === 'basic') {
    return [
      name,
      '',
      `Condition: ${cond}`,
      '',
      'Ships within 1 business day.',
      '30-day returns accepted.',
      '',
      'Thank you for shopping with NolTech!',
    ].join('\n');
  }

  if (template === 'detailed') {
    const lines = [
      name,
      '',
      `Condition: ${cond}`,
    ];
    if (item.brand) lines.push(`Brand: ${item.brand}`);
    if (item.upc) lines.push(`UPC: ${item.upc}`);
    lines.push('');
    lines.push("What's Included: Item as shown / described in listing.");
    lines.push('');
    lines.push('Ships within 1 business day. 30-day returns accepted.');
    lines.push('');
    lines.push('Thank you for shopping with NolTech!');
    return lines.join('\n');
  }

  // professional — HTML
  return [
    `<h2>${escapeHtml(name)}</h2>`,
    `<p><strong>Condition:</strong> ${escapeHtml(cond)}</p>`,
    item.brand ? `<p><strong>Brand:</strong> ${escapeHtml(item.brand)}</p>` : '',
    item.upc ? `<p><strong>UPC:</strong> ${escapeHtml(item.upc)}</p>` : '',
    `<p><strong>What's Included:</strong> Item as described in manifest</p>`,
    '<hr>',
    '<p>Ships within 1 business day. 30-day returns accepted.</p>',
    '<p>Thank you for shopping with NolTech!</p>',
  ].filter(Boolean).join('\n');
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeCsv(val) {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function downloadCsv(filename, csvContent) {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Listing Row ──────────────────────────────────────────────────────────────

const PRICE_SOURCE_BADGE = {
  'upc-cache': { variant: 'info',    label: 'UPC cache' },
  manifest:    { variant: 'neutral', label: 'Manifest'  },
  inventory:   { variant: 'neutral', label: 'Inventory' },
  manual:      { variant: 'accent',  label: 'Manual'    },
  missing:     { variant: 'warning', label: 'Missing'   },
};

function conditionVariant(label) {
  const l = (label || '').toLowerCase();
  if (l.includes('new')) return 'success';
  if (l.includes('parts') || l.includes('not working')) return 'warning';
  if (l.includes('refurbished') || l.includes('open box')) return 'info';
  return 'neutral';
}

function TitleCharCounter({ len, max = 80 }) {
  const pct = Math.min(100, (len / max) * 100);
  const over = len > max;
  const tone = over ? 'danger' : len >= 60 ? 'warning' : 'neutral';
  const fg = { danger: 'text-danger', warning: 'text-warning', neutral: 'text-fg-muted' }[tone];
  const bar = { danger: 'bg-danger', warning: 'bg-warning', neutral: 'bg-fg-muted/50' }[tone];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="relative inline-block h-1 w-10 rounded-full bg-muted overflow-hidden">
        <span className={`absolute inset-y-0 left-0 ${bar} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </span>
      <span className={`text-[10px] font-mono tabular-nums ${fg} ${over ? 'font-semibold' : ''}`}>
        {len}/{max}
      </span>
      {over && <AlertTriangle size={10} className="text-danger" aria-label="Title exceeds eBay 80-char limit" />}
    </span>
  );
}

// ─── Per-listing expand editor ───────────────────────────────────────────────
// Renders inside a TR with colSpan covering the full table. Lets the user:
//   - Override eBay business policies for THIS listing
//   - Edit Condition Description (eBay's native field, separate from the
//     long Description)
//   - Edit / add / remove Item Specifics (key-value pairs eBay shows in a
//     spec sheet on the listing page)
//   - Edit structured fields (Brand, MPN, Color, Storage, RAM)
//   - Run Gemini AI auto-fill to populate description + specifics in one click
function ListingExpandEditor({
  listing,
  index,
  onUpdate,
  availablePolicies,
  policiesLoading,
  policiesError,
  onLoadPolicies,
  onRunGemini,
  geminiBusy,
  globalPolicies,
}) {
  const setField = (field, value) => onUpdate(index, { [field]: value });

  const overrides = listing.policyOverrides || {};
  const setPolicy = (key, value) => {
    const next = { ...overrides };
    if (value) next[key] = value;
    else delete next[key];
    onUpdate(index, { policyOverrides: Object.keys(next).length ? next : null });
  };

  const specs = Array.isArray(listing.itemSpecifics) ? listing.itemSpecifics : [];
  const updateSpec = (i, patch) => {
    const next = specs.map((s, j) => (j === i ? { ...s, ...patch } : s));
    onUpdate(index, { itemSpecifics: next });
  };
  const addSpec = () => onUpdate(index, { itemSpecifics: [...specs, { name: '', value: '' }] });
  const removeSpec = (i) => onUpdate(index, { itemSpecifics: specs.filter((_, j) => j !== i) });

  const policiesFetched = !!availablePolicies;
  const lists = availablePolicies || { payment: [], shipping: [], return: [] };

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      className="overflow-hidden"
    >
      <div className="px-4 py-4 bg-muted/30 border-l-4 border-accent space-y-4">
        {/* Header bar with Gemini auto-fill */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
            Listing details · #{index + 1}
          </h4>
          <Button
            variant="primary"
            size="sm"
            onClick={() => onRunGemini(index)}
            disabled={geminiBusy}
          >
            {geminiBusy
              ? <><Loader2 className="animate-spin" /> Generating…</>
              : <><Sparkles /> Auto-fill with Gemini</>}
          </Button>
        </div>

        {/* Structured fields row */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <div>
            <Label className="text-[10px] uppercase tracking-wider text-fg-muted">Brand</Label>
            <Input value={listing.brand || ''} onChange={e => setField('brand', e.target.value)} placeholder="Dell" />
          </div>
          <div>
            <Label className="text-[10px] uppercase tracking-wider text-fg-muted">MPN / Model</Label>
            <Input value={listing.mpn || ''} onChange={e => setField('mpn', e.target.value)} placeholder="Latitude 5480" />
          </div>
          <div>
            <Label className="text-[10px] uppercase tracking-wider text-fg-muted">Storage</Label>
            <Input value={listing.storage || ''} onChange={e => setField('storage', e.target.value)} placeholder="256 GB" />
          </div>
          <div>
            <Label className="text-[10px] uppercase tracking-wider text-fg-muted">RAM</Label>
            <Input value={listing.ram || ''} onChange={e => setField('ram', e.target.value)} placeholder="8 GB" />
          </div>
          <div>
            <Label className="text-[10px] uppercase tracking-wider text-fg-muted">Color</Label>
            <Input value={listing.color || ''} onChange={e => setField('color', e.target.value)} placeholder="Black" />
          </div>
        </div>

        {/* Condition description */}
        <div>
          <Label className="text-[10px] uppercase tracking-wider text-fg-muted">
            Condition Description
            <span className="ml-2 text-fg-muted normal-case font-normal">
              eBay's native condition field (1–3 sentences). Falls back to the eBay condition label if empty.
            </span>
          </Label>
          <textarea
            value={listing.conditionDescription || ''}
            onChange={e => setField('conditionDescription', e.target.value)}
            rows={3}
            placeholder='e.g. "Powers on and boots to Windows. Light scuffs on the lid. Battery holds a charge. No charger included."'
            className="w-full border border-border rounded-lg px-2.5 py-2 text-xs text-fg bg-surface focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/50 resize-y"
            maxLength={1000}
          />
        </div>

        {/* Long description */}
        <div>
          <Label className="text-[10px] uppercase tracking-wider text-fg-muted">Description (HTML allowed)</Label>
          <textarea
            value={listing.description || ''}
            onChange={e => setField('description', e.target.value)}
            rows={6}
            placeholder="The full body of your listing. HTML is rendered."
            className="w-full border border-border rounded-lg px-2.5 py-2 text-xs font-mono text-fg bg-surface focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/50 resize-y"
          />
        </div>

        {/* Item specifics editor */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <Label className="text-[10px] uppercase tracking-wider text-fg-muted mb-0">
              Item Specifics
              <span className="ml-2 text-fg-muted normal-case font-normal">
                Name/value pairs shown in eBay's spec sheet. Brand and MPN auto-populate from the fields above when missing.
              </span>
            </Label>
            <Button variant="ghost" size="sm" onClick={addSpec}>
              <Plus /> Add
            </Button>
          </div>
          {specs.length === 0 ? (
            <p className="text-xs text-fg-muted italic px-2 py-3 bg-surface rounded-lg border border-dashed border-border">
              No specifics yet. Add manually or use Auto-fill with Gemini.
            </p>
          ) : (
            <div className="space-y-1.5">
              {specs.map((s, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={s.name}
                    onChange={e => updateSpec(i, { name: e.target.value })}
                    placeholder="Name (e.g. Processor)"
                    className="flex-1 max-w-[200px]"
                  />
                  <Input
                    value={s.value}
                    onChange={e => updateSpec(i, { value: e.target.value })}
                    placeholder="Value (e.g. Intel Core i5)"
                    className="flex-1"
                  />
                  <button
                    onClick={() => removeSpec(i)}
                    className="p-1.5 text-fg-subtle hover:text-danger transition-colors"
                    title="Remove"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Policy overrides */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <Label className="text-[10px] uppercase tracking-wider text-fg-muted mb-0">
              eBay Policy Overrides
              <span className="ml-2 text-fg-muted normal-case font-normal">
                Override the default policies just for this listing. Empty = inherit from Settings.
              </span>
            </Label>
            {!policiesFetched && !policiesLoading && (
              <Button variant="secondary" size="sm" onClick={onLoadPolicies}>
                Load my policies
              </Button>
            )}
            {policiesLoading && (
              <span className="text-[11px] text-fg-muted inline-flex items-center gap-1">
                <Loader2 className="size-3 animate-spin" /> Loading…
              </span>
            )}
          </div>
          {policiesError && <p className="text-[11px] text-danger mb-2">{policiesError}</p>}
          {policiesFetched ? (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {[
                { key: 'paymentProfileId',  label: 'Payment',  list: lists.payment },
                { key: 'shippingProfileId', label: 'Shipping', list: lists.shipping },
                { key: 'returnProfileId',   label: 'Return',   list: lists.return },
              ].map(({ key, label, list }) => {
                const inherited = globalPolicies?.[key];
                const inheritedName = list.find(p => p.id === inherited)?.name;
                return (
                  <div key={key}>
                    <Label className="text-[10px] uppercase tracking-wider text-fg-muted">{label}</Label>
                    <Select
                      value={overrides[key] || ''}
                      onChange={e => setPolicy(key, e.target.value)}
                    >
                      <option value="">
                        Inherit{inheritedName ? ` (${inheritedName})` : ''}
                      </option>
                      {list.map(p => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </Select>
                  </div>
                );
              })}
            </div>
          ) : !policiesLoading && (
            <p className="text-xs text-fg-muted italic">
              Click "Load my policies" to enable per-listing overrides.
            </p>
          )}
        </div>
      </div>
    </motion.div>
  );
}

function ListingRow({ listing, index, onUpdate, selected, onToggleSelect, expanded, onToggleExpand }) {
  const [editing, setEditing] = useState(null); // 'title' | 'description' | 'price' | null
  const [editVal, setEditVal] = useState('');
  const [showDesc, setShowDesc] = useState(false);

  function startEdit(field) {
    setEditVal(listing[field] ?? '');
    setEditing(field);
  }

  function saveEdit() {
    if (editing === 'price') {
      const num = parseFloat(editVal);
      if (!isNaN(num) && num >= 0) onUpdate(index, { price: num });
    } else if (editing) {
      onUpdate(index, { [editing]: editVal });
    }
    setEditing(null);
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && editing !== 'description') saveEdit();
    if (e.key === 'Escape') setEditing(null);
  }

  const titleLen = (listing.title || '').length;
  const priceBadge = PRICE_SOURCE_BADGE[listing.priceSource] || PRICE_SOURCE_BADGE.missing;

  return (
    <TR className={selected ? 'bg-accent-subtle/40' : undefined}>
      <TD className="w-10 align-top">
        <input
          type="checkbox"
          checked={!!selected}
          onChange={() => onToggleSelect(index)}
          className="accent-accent size-3.5 cursor-pointer"
          aria-label={`Select listing ${index + 1}`}
        />
      </TD>

      <TD className="w-8 align-top">
        <button
          onClick={() => onToggleExpand(index)}
          className="p-1 -ml-1 rounded hover:bg-muted text-fg-muted hover:text-accent transition-colors"
          title={expanded ? 'Collapse' : 'Expand to edit specifics, policies & description'}
          aria-label={expanded ? 'Collapse listing details' : 'Expand listing details'}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
      </TD>

      <TD className="w-10 align-top text-xs text-fg-muted tabular-nums">
        {index + 1}
      </TD>

      <TD className="w-14 align-top">
        {listing.firstPhoto ? (
          <div className="relative size-10 rounded-lg overflow-hidden border border-border-subtle bg-muted">
            <img src={listing.firstPhoto} alt="" className="w-full h-full object-cover" />
            {listing.photoCount > 1 && (
              <span className="absolute -top-1 -right-1 text-[9px] font-semibold bg-accent text-accent-fg rounded-full px-1 min-w-[16px] h-4 inline-flex items-center justify-center leading-none">
                {listing.photoCount}
              </span>
            )}
          </div>
        ) : (
          <div className="size-10 rounded-lg border border-dashed border-border-subtle flex items-center justify-center text-fg-subtle">
            <ImageIcon size={14} />
          </div>
        )}
      </TD>

      <TD className="align-top max-w-[340px]">
        {editing === 'title' ? (
          <input
            autoFocus
            value={editVal}
            onChange={e => setEditVal(e.target.value)}
            onBlur={saveEdit}
            onKeyDown={handleKeyDown}
            className="w-full border border-border rounded-lg px-2 py-1 text-sm text-fg bg-surface focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/50"
            maxLength={100}
          />
        ) : (
          <button
            onClick={() => startEdit('title')}
            className="text-left text-sm leading-snug text-fg hover:text-accent transition-colors group inline-flex items-start gap-1.5"
            title="Tap to edit title"
          >
            <span className={titleLen > 80 ? 'text-danger' : ''}>
              {listing.title || <span className="italic text-fg-muted">No title</span>}
            </span>
            <Edit2 size={11} className="shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity text-fg-muted" />
          </button>
        )}
        <div className="flex items-center gap-3 mt-1.5">
          <TitleCharCounter len={titleLen} max={80} />
          <button
            onClick={() => setShowDesc(v => !v)}
            className="inline-flex items-center gap-1 text-[10px] text-fg-muted hover:text-accent transition-colors"
          >
            {showDesc ? <EyeOff size={10} /> : <Eye size={10} />}
            {showDesc ? 'Hide description' : 'Show description'}
          </button>
        </div>
        <AnimatePresence initial={false}>
          {showDesc && (
            <motion.div
              key="desc"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              className="mt-2 overflow-hidden"
            >
              {editing === 'description' ? (
                <textarea
                  autoFocus
                  value={editVal}
                  onChange={e => setEditVal(e.target.value)}
                  onBlur={saveEdit}
                  rows={6}
                  className="w-full border border-border rounded-lg px-2 py-1.5 text-xs font-mono text-fg bg-surface focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/50 resize-y"
                />
              ) : (
                <div className="bg-muted/40 rounded-lg p-2.5 text-xs text-fg-muted leading-relaxed whitespace-pre-wrap max-h-40 overflow-y-auto relative group">
                  {listing.description || <span className="italic">No description</span>}
                  <button
                    onClick={() => startEdit('description')}
                    className="absolute top-1.5 right-1.5 p-1 opacity-0 group-hover:opacity-100 text-fg-muted hover:text-accent transition-all rounded-md hover:bg-surface"
                    title="Edit description"
                  >
                    <Edit2 size={11} />
                  </button>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </TD>

      <TD className="w-24 align-top text-right">
        {editing === 'price' ? (
          <input
            autoFocus
            type="number"
            step="0.01"
            min="0"
            value={editVal}
            onChange={e => setEditVal(e.target.value)}
            onBlur={saveEdit}
            onKeyDown={handleKeyDown}
            className="w-20 border border-border rounded-lg px-2 py-1 text-sm font-mono text-fg text-right bg-surface focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/50"
          />
        ) : (
          <button
            onClick={() => startEdit('price')}
            className={`font-mono tabular-nums text-sm font-semibold hover:text-accent transition-colors ${
              listing.price == null ? 'text-fg-muted' : 'text-fg'
            }`}
            title="Tap to edit price"
          >
            {listing.price != null ? fmt(listing.price) : '—'}
          </button>
        )}
        <div className="mt-1 flex justify-end">
          <Badge variant={priceBadge.variant} size="xs">{priceBadge.label}</Badge>
        </div>
      </TD>

      <TD className="w-12 align-top text-center font-mono tabular-nums text-fg text-sm">
        {listing.quantity}
      </TD>

      <TD className="w-28 align-top">
        <Badge variant={conditionVariant(listing.conditionLabel)} size="xs">
          {listing.conditionLabel}
        </Badge>
      </TD>

      <TD className="w-40 align-top text-[11px] text-fg-muted">
        <span className="block max-w-full truncate" title={listing.category}>
          {listing.category}
        </span>
      </TD>

      <TD className="w-28 align-top font-mono text-[11px] text-fg-muted tabular-nums">
        {listing.upc || '\u2014'}
      </TD>
    </TR>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

const PHOTOS_KEY = 'noltech:photos';

export default function ListingGenerator() {
  const { state: appState, dispatch } = useApp();
  const [browseData, setBrowseData]   = useState(null);
  const [upcCache, setUpcCache]       = useState({});
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [selectedLotId, setSelectedLotId] = useState('');
  const [template, setTemplate]       = useState('professional');
  const [listings, setListings]       = useState([]);
  const [exported, setExported]       = useState(false);
  const [source, setSource]           = useState('manifests'); // 'manifests' | 'inventory'
  const [photoData, setPhotoData]     = useState({});
  const [scheduledList, setScheduledList] = useState([]);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [scheduleDate, setScheduleDate] = useState('');
  const [selectedRows, setSelectedRows] = useState(() => new Set());
  const [bulkConditionId, setBulkConditionId] = useState('');
  const [bulkPricePct, setBulkPricePct] = useState('');

  // Push-to-eBay state. Tracks per-listing progress in a modal so the user
  // can see what succeeded vs what eBay rejected.
  const [pushOpen, setPushOpen] = useState(false);
  const [pushStatus, setPushStatus] = useState({});  // { [idx]: { state, itemId?, error?, fees? } }
  const [pushRunning, setPushRunning] = useState(false);
  const [ebayPolicies, setEbayPolicies] = useState(null); // { paymentProfileId, shippingProfileId, returnProfileId }
  useEffect(() => {
    window.storage.get('noltech:ebay:policies').then((v) => {
      if (v && typeof v === 'object') setEbayPolicies(v);
    }).catch(e => console.error('[lg] policy load:', e));
  }, []);

  // ── Per-listing expand editor ──────────────────────────────────────────
  // expandedRows tracks which listings have the editor open (Set of indices).
  // availablePolicies caches the user's eBay business policies once loaded
  // (re-used across all expanded rows so we don't re-call eBay per listing).
  // geminiBusy tracks per-listing Gemini auto-fill calls.
  const [expandedRows, setExpandedRows] = useState(() => new Set());
  const [availablePolicies, setAvailablePolicies] = useState(null); // { payment:[], shipping:[], return:[] }
  const [policiesLoading, setPoliciesLoading] = useState(false);
  const [policiesError, setPoliciesError] = useState('');
  const [geminiBusy, setGeminiBusy] = useState(() => new Set());

  // Title cleaner — batched Gemini call that rewrites the raw eBay titles
  // stored in the UPC cache into clean listing titles. Cached results are
  // persisted to noltech:arbitrage:upc-cache so the next time the user opens
  // this lot, no API call is needed.
  const [cleanTitlesRunning, setCleanTitlesRunning] = useState(false);
  const [cleanTitlesProgress, setCleanTitlesProgress] = useState({ done: 0, total: 0 });

  const runCleanTitles = useCallback(async () => {
    if (cleanTitlesRunning) return;

    // Find UPCs with raw titles but no cleanTitle yet. We only attempt UPCs
    // because the UPC is the cache key — items without a UPC can't be
    // persisted (the regex pass on display still cleans them).
    const upcsToClean = new Set();
    const itemsToClean = [];
    for (const l of listings) {
      const upc = l.upc;
      if (!upc) continue;
      if (upcsToClean.has(upc)) continue;
      const cached = upcCache[upc];
      if (!cached?.title) continue;       // nothing to clean
      if (cached.cleanTitle) continue;     // already cleaned
      upcsToClean.add(upc);
      itemsToClean.push({
        upc,
        rawTitle: cached.title,
        brand: l.brand || '',
        mpn: l.mpn || l._item?.model || '',
      });
    }

    if (itemsToClean.length === 0) {
      eventBus.emit('notification:push', {
        type: 'info',
        title: 'Titles already clean',
        message: 'Every cache entry on this lot already has a clean title.',
      });
      return;
    }

    // Verify Gemini key is set
    const rawKey = await window.storage.get(GEMINI_KEY_STORAGE).catch(() => null);
    if (!rawKey) {
      eventBus.emit('notification:push', {
        type: 'error',
        title: 'No Gemini API key',
        message: 'Add your Gemini key in Settings → Connections → Google Gemini API Key.',
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

    setCleanTitlesRunning(true);
    setCleanTitlesProgress({ done: 0, total: itemsToClean.length });

    // Tier-aware config from Settings. Free tier sequential at 6.5s pace,
    // Tier 1 = 4× parallel at 200ms, Tier 2 = 8× parallel with no pace.
    const tierCfg = await loadGeminiTierConfig();
    const BATCH = tierCfg.batchSize;
    const PACE_MS = tierCfg.paceMs;
    const CONCURRENCY = tierCfg.concurrency;

    // Slice into batches and process with N-way concurrency.
    const batches = [];
    for (let i = 0; i < itemsToClean.length; i += BATCH) {
      batches.push(itemsToClean.slice(i, i + BATCH));
    }

    const cleaned = {};
    let completedItems = 0;
    let nextIdx = 0;

    const runLane = async () => {
      for (;;) {
        const slice = nextIdx < batches.length ? batches[nextIdx++] : null;
        if (!slice) return;
        const results = await geminiCleanTitles(apiKey, slice);
        for (const r of results) {
          if (r.upc && r.cleanTitle) cleaned[r.upc] = r.cleanTitle;
        }
        completedItems += slice.length;
        setCleanTitlesProgress({
          done: Math.min(completedItems, itemsToClean.length),
          total: itemsToClean.length,
        });
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
        title: 'Title cleaning failed',
        message: err.message,
      });
      setCleanTitlesRunning(false);
      return;
    }

    const cleanedCount = Object.keys(cleaned).length;
    if (cleanedCount === 0) {
      setCleanTitlesRunning(false);
      eventBus.emit('notification:push', {
        type: 'warning',
        title: 'No titles returned',
        message: 'Gemini did not return any cleaned titles. Try again later.',
      });
      return;
    }

    // Persist to UPC cache (storage + state)
    const nextCache = { ...upcCache };
    for (const [upc, cleanTitle] of Object.entries(cleaned)) {
      nextCache[upc] = { ...(nextCache[upc] || {}), cleanTitle, cleanedAt: new Date().toISOString() };
    }
    try {
      await window.storage.set(UPC_CACHE_KEY, nextCache);
    } catch (e) {
      console.error('[lg] failed to persist clean titles:', e);
    }
    setUpcCache(nextCache);

    setCleanTitlesRunning(false);
    eventBus.emit('notification:push', {
      type: 'success',
      title: 'Titles cleaned',
      message: `Rewrote ${cleanedCount} title${cleanedCount !== 1 ? 's' : ''} with Gemini.`,
    });
  }, [listings, upcCache, cleanTitlesRunning]);

  const toggleExpand = useCallback((index) => {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  // Lazy-load the full list of business policies (payment / shipping / return)
  // the first time any row expands. Without this, per-listing dropdowns can
  // only show the saved selections — not allow switching to alternates.
  const loadAvailablePolicies = useCallback(async () => {
    if (availablePolicies || policiesLoading) return;
    setPoliciesLoading(true);
    setPoliciesError('');
    try {
      const rawCreds = await window.storage.get(EBAY_TOKEN_KEY).catch(() => null);
      const creds = await decryptObject(rawCreds || {});
      if (!creds?.token) throw new Error('Add your eBay token in Settings first.');
      const resp = await fetch(`${PIPELINE_BASE}/api/ebay/policies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userToken: creds.token,
          appId: creds.appId,
          devId: creds.devId,
          certId: creds.certId,
        }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || 'Failed to load policies');
      setAvailablePolicies({
        payment: data.payment || [],
        shipping: data.shipping || [],
        return: data.return || [],
      });
    } catch (err) {
      setPoliciesError(err.message);
    } finally {
      setPoliciesLoading(false);
    }
  }, [availablePolicies, policiesLoading]);

  // Gemini auto-fill — populates description, conditionDescription,
  // itemSpecifics, brand, mpn, etc. for one listing.
  const runGeminiAutofill = useCallback(async (index) => {
    const listing = listings[index];
    if (!listing) return;
    setGeminiBusy(prev => { const n = new Set(prev); n.add(index); return n; });
    try {
      const rawKey = await window.storage.get(GEMINI_KEY_STORAGE).catch(() => null);
      if (!rawKey) {
        eventBus.emit('notification:push', {
          type: 'error',
          title: 'No Gemini API key',
          message: 'Add your key in Settings → Google Gemini API Key.',
        });
        return;
      }
      const apiKey = await decrypt(rawKey);
      if (!apiKey) throw new Error('Gemini key failed to decrypt');
      const filled = await geminiAutofill(apiKey, {
        title: listing.title,
        brand: listing.brand,
        category: listing.category,
        condition: listing.conditionLabel,
        mpn: listing.mpn,
        upc: listing.upc,
        notes: listing._item?.notes || '',
        specs: listing._item?.specs || '',
      });
      // Merge into the listing — only overwrite empty fields (so manual edits
      // are preserved unless the user explicitly hits the button on a clean row).
      setListings(prev => prev.map((l, i) => {
        if (i !== index) return l;
        return {
          ...l,
          description: filled.description || l.description,
          conditionDescription: filled.conditionDescription || l.conditionDescription,
          itemSpecifics: filled.itemSpecifics?.length ? filled.itemSpecifics : l.itemSpecifics,
          brand: l.brand || filled.brand,
          mpn: l.mpn || filled.mpn,
          color: l.color || filled.color,
          storage: l.storage || filled.storage,
          ram: l.ram || filled.ram,
        };
      }));
      eventBus.emit('notification:push', {
        type: 'success',
        title: 'Auto-fill complete',
        message: `Generated ${filled.itemSpecifics?.length || 0} specifics for "${listing.title || 'this listing'}"`,
      });
    } catch (err) {
      eventBus.emit('notification:push', {
        type: 'error',
        title: 'Gemini auto-fill failed',
        message: err.message,
      });
    } finally {
      setGeminiBusy(prev => { const n = new Set(prev); n.delete(index); return n; });
    }
  }, [listings]);

  // ── Load data ───────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [browse, cache, photos, sched] = await Promise.all([
          window.storage.get(BROWSE_KEY),
          window.storage.get(UPC_CACHE_KEY),
          window.storage.get(PHOTOS_KEY),
          window.storage.get(SCHEDULED_KEY),
        ]);
        if (cancelled) return;
        setBrowseData(browse || null);
        setUpcCache(cache && typeof cache === 'object' ? cache : {});
        setPhotoData(photos && typeof photos === 'object' ? photos : {});
        setScheduledList(Array.isArray(sched) ? sched : []);
      } catch (e) {
        if (!cancelled) setError(e.message || "Couldn't load data");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // ── Derive lots list ────────────────────────────────────────────────────

  // ── Inventory lots from AppContext ───────────────────────────────────

  const inventoryLots = useMemo(() => {
    if (source !== 'inventory') return [];
    return (appState.lots || []).filter(lot => (lot.items || []).length > 0);
  }, [appState.lots, source]);

  const lots = useMemo(() => {
    if (source === 'inventory') return inventoryLots;
    if (!browseData?.lots) return [];
    return browseData.lots.filter(lot => {
      const enrich = browseData.enrichments?.[lot.id];
      return enrich?.status === 'done' && enrich.manifestItems?.length > 0;
    });
  }, [browseData, source, inventoryLots]);

  // ── Generate listings when lot or template changes ──────────────────────

  useEffect(() => {
    if (!selectedLotId) { setListings([]); return; }

    // ── Inventory source ────────────────────────────────────────────
    if (source === 'inventory') {
      const lot = inventoryLots.find(l => l.id === selectedLotId);
      if (!lot) { setListings([]); return; }

      const generated = (lot.items || []).map(item => {
        const cond = mapCondition(item.conditionOnArrival || item.conditionGrade || '');
        const hasPhotos = Array.isArray(photoData[item.id]) && photoData[item.id].length > 0;
        const photoCount = hasPhotos ? photoData[item.id].length : 0;
        const firstPhoto = hasPhotos ? photoData[item.id][0] : null;

        const enrichedItem = {
          brand: item.brand || '',
          title: item.model || '',
          ebayTitle: `${item.brand || ''} ${item.model || ''}`.trim(),
          upc: item.upc || '',
          _conditionLabel: cond.label,
        };

        const desc = buildDescription(enrichedItem, template) +
          (hasPhotos ? `\n\n[${photoCount} photo${photoCount !== 1 ? 's' : ''} available]` : '');

        // Apply realization buffer when the price is derived from market data
        // (estimatedValue/avgPrice). If user already set an explicit listing
        // price we trust it as-is — that's a manual decision.
        const explicitPrice = item.listing?.price ?? item.listingPrice ?? null;
        let price = explicitPrice;
        let priceSource = explicitPrice != null ? 'inventory' : 'missing';
        if (explicitPrice == null) {
          const marketPrice = item.estimatedValue ?? item.avgPrice ?? null;
          if (marketPrice != null) {
            const mult = getEffectiveResaleMultiplier(
              item.conditionOnArrival || item.conditionGrade || '',
              item.category || ''
            );
            price = Math.round(marketPrice * mult * 100) / 100;
            priceSource = 'inventory';
          }
        }

        return {
          title: buildTitle(enrichedItem),
          description: desc,
          price,
          priceSource,
          quantity: 1,
          conditionId: cond.id,
          conditionLabel: cond.label,
          category: guessCategory(`${item.brand || ''} ${item.model || ''} ${item.category || ''}`),
          upc: item.upc || '',
          brand: item.brand || '',
          // ── Per-listing eBay fields (user-editable in expand pane) ──
          conditionDescription: '',
          itemSpecifics: [],
          mpn: item.model || '',
          color: '',
          storage: '',
          ram: '',
          policyOverrides: null,  // null = inherit global ebayPolicies
          hasPhotos,
          photoCount,
          firstPhoto,
          _item: item,
        };
      });

      setListings(generated);
      setSelectedRows(new Set());
      setExported(false);
      return;
    }

    // ── Manifest source (original behavior) ─────────────────────────
    if (!browseData) { setListings([]); return; }

    const lot = lots.find(l => l.id === selectedLotId);
    if (!lot) { setListings([]); return; }

    const enrich = browseData.enrichments?.[lot.id];
    const manifestItems = enrich?.manifestItems || [];
    const lotCondition = lot.condition || lot.conditionCode || '';
    const cond = mapCondition(lotCondition);

    const generated = manifestItems.map(item => {
      // Try UPC cache for pricing
      const cached = item.upc ? upcCache[item.upc] : null;
      const rawAvgPrice = item.avgPrice ?? cached?.avgPrice ?? null;
      const priceSource = rawAvgPrice == null
        ? 'missing'
        : item.avgPrice != null
          ? 'manifest'
          : 'upc-cache';

      // Manifest/UPC-cache prices are eBay active asks averaged with no
      // condition haircut — apply the user's realization rate + ask buffer +
      // condition haircut so listed price reflects what they actually
      // realize, not the inflated active-listing average.
      let avgPrice = rawAvgPrice;
      if (rawAvgPrice != null) {
        const mult = getEffectiveResaleMultiplier(lotCondition, item.category || '');
        avgPrice = Math.round(rawAvgPrice * mult * 100) / 100;
      }

      const condLabel = cond.label;
      const condId = cond.id;

      // Title resolution priority:
      //   1. cache.cleanTitle  — Gemini-cleaned, persisted (best)
      //   2. regex-cleaned     — instant, runs every time on the raw title
      //   3. raw item.ebayTitle — last resort
      const rawTitle = item.ebayTitle || cached?.title || item.title || '';
      const displayTitle = cached?.cleanTitle || cleanEbayTitle(rawTitle, { maxLen: 80 });

      const enrichedItem = {
        ...item,
        ebayTitle: displayTitle,
        _rawEbayTitle: rawTitle,
        _conditionLabel: condLabel,
      };

      return {
        title: buildTitle(enrichedItem),
        description: buildDescription(enrichedItem, template),
        price: avgPrice,
        priceSource,
        quantity: item.qty || 1,
        conditionId: condId,
        conditionLabel: condLabel,
        category: guessCategory(item.ebayTitle || item.title || item.brand || ''),
        upc: item.upc || '',
        brand: item.brand || '',
        // ── Per-listing eBay fields (user-editable in expand pane) ──
        conditionDescription: '',
        itemSpecifics: [],
        mpn: item.model || '',
        color: '',
        storage: '',
        ram: '',
        policyOverrides: null,
        hasPhotos: false,
        photoCount: 0,
        firstPhoto: null,
        _item: item,
      };
    });

    setListings(generated);
    setSelectedRows(new Set());
    setExported(false);
  }, [selectedLotId, template, browseData, lots, upcCache, source, inventoryLots, photoData]);

  // ── Update handler ──────────────────────────────────────────────────────

  const handleUpdate = useCallback((index, updates) => {
    setListings(prev => prev.map((l, i) => {
      if (i !== index) return l;
      // If user edits the price field, mark the source as 'manual' so it shows a distinct badge
      const next = { ...l, ...updates };
      if ('price' in updates && updates.price !== l.price) next.priceSource = 'manual';
      return next;
    }));
    setExported(false);
  }, []);

  // ── Bulk selection helpers ─────────────────────────────────────────────
  const toggleRow = useCallback((index) => {
    setSelectedRows(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedRows(prev => {
      if (prev.size === listings.length && listings.length > 0) return new Set();
      return new Set(listings.map((_, i) => i));
    });
  }, [listings]);

  const clearSelection = useCallback(() => setSelectedRows(new Set()), []);

  const bulkSetCondition = useCallback((condId) => {
    if (!condId || selectedRows.size === 0) return;
    const id = parseInt(condId);
    const label = Object.values(CONDITION_MAP).find(c => c.id === id)?.label || '';
    setListings(prev => prev.map((l, i) =>
      selectedRows.has(i) ? { ...l, conditionId: id, conditionLabel: label } : l
    ));
    setExported(false);
  }, [selectedRows]);

  const bulkAdjustPrice = useCallback((pctStr) => {
    const pct = parseFloat(pctStr);
    if (!isFinite(pct) || selectedRows.size === 0) return;
    const factor = 1 + pct / 100;
    setListings(prev => prev.map((l, i) => {
      if (!selectedRows.has(i) || l.price == null) return l;
      return { ...l, price: Math.round(l.price * factor * 100) / 100, priceSource: 'manual' };
    }));
    setExported(false);
  }, [selectedRows]);

  const bulkDelete = useCallback(() => {
    if (selectedRows.size === 0) return;
    setListings(prev => prev.filter((_, i) => !selectedRows.has(i)));
    setSelectedRows(new Set());
    setExported(false);
  }, [selectedRows]);

  // ── CSV Export ──────────────────────────────────────────────────────────

  function handleExport() {
    if (!listings.length) return;

    const headers = [
      '*Action(SiteID=US|Country=US|Currency=USD|Version=1193)',
      '*Title',
      '*Description',
      '*StartPrice',
      '*Quantity',
      '*ConditionID',
      'Product:UPC',
      'Product:Brand',
      '*Duration',
      '*Format',
      'PaymentProfileName',
    ];

    const rows = listings.map(l => [
      'Add',
      escapeCsv(l.title),
      escapeCsv(l.description),
      l.price != null ? l.price.toFixed(2) : '0.00',
      String(l.quantity),
      String(l.conditionId),
      escapeCsv(l.upc),
      escapeCsv(l.brand),
      'GTC',
      'FixedPrice',
      'eBay Payments',
    ]);

    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
    downloadCsv(`ebay-listings-${selectedLotId}.csv`, csv);
    setExported(true);
    setTimeout(() => setExported(false), 4000);
  }

  // ── Push to eBay ──────────────────────────────────────────────────────
  // Walks listings in series (eBay rate-limits parallel AddItem calls per
  // account). Per-listing status is tracked in pushStatus so the modal can
  // show progress. On success, saves the resulting itemId back to inventory
  // so the next Sync All picks it up correctly.

  // Pull simple item specifics for a listing. If the user has explicitly
  // edited specifics in the expand pane (or Gemini filled them in), trust
  // that list verbatim. Otherwise fall back to a heuristic on title + the
  // structured per-listing fields (brand, mpn, color, storage, ram).
  function extractItemSpecifics(listing) {
    if (Array.isArray(listing.itemSpecifics) && listing.itemSpecifics.length > 0) {
      return listing.itemSpecifics
        .filter(s => s && s.name && s.value)
        .map(s => ({ name: String(s.name).trim(), value: String(s.value).trim() }));
    }
    const out = [];
    const title = listing.title || '';
    if (listing.brand) out.push({ name: 'Brand', value: listing.brand });
    const mpn = listing.mpn || listing._item?.model;
    if (mpn) out.push({ name: 'MPN', value: mpn });
    if (listing.storage) out.push({ name: 'Storage Capacity', value: listing.storage });
    if (listing.ram) out.push({ name: 'RAM Size', value: listing.ram });
    if (listing.color) out.push({ name: 'Color', value: listing.color });
    // Heuristics for fields the user hasn't explicitly set
    if (!listing.storage) {
      const storageMatch = title.match(/(\d{2,4})\s*(GB|TB)\b/i);
      if (storageMatch) out.push({ name: 'Storage Capacity', value: `${storageMatch[1]} ${storageMatch[2].toUpperCase()}` });
    }
    if (!listing.ram) {
      const ramMatch = title.match(/(\d{1,3})\s*GB\s*RAM\b/i);
      if (ramMatch) out.push({ name: 'RAM Size', value: `${ramMatch[1]} GB` });
    }
    if (!listing.color) {
      const colors = ['Black','White','Silver','Gray','Grey','Gold','Rose Gold','Space Gray','Blue','Red','Green','Pink','Purple'];
      for (const c of colors) {
        if (new RegExp(`\\b${c}\\b`, 'i').test(title)) { out.push({ name: 'Color', value: c }); break; }
      }
    }
    return out;
  }

  // Get photo dataUrls for a listing's underlying inventory item.
  async function getPhotosForListing(listing) {
    const itemId = listing._item?.id;
    if (!itemId) return [];
    const itemPhotos = photoData?.[itemId]?.photos || [];
    return itemPhotos
      .filter(p => p.dataUrl)
      .slice(0, 12)  // eBay caps at 12 per listing
      .map(p => ({ dataUrl: p.dataUrl }));
  }

  async function handlePushToEbay() {
    if (!listings.length) return;
    if (pushRunning) return;
    if (!ebayPolicies?.paymentProfileId || !ebayPolicies?.shippingProfileId || !ebayPolicies?.returnProfileId) {
      eventBus.emit('notification:push', {
        type: 'error',
        title: 'Set up eBay business policies first',
        message: 'Go to Settings → eBay Credentials to pick your payment / shipping / return profiles.',
      });
      return;
    }
    // Decrypt credentials.
    const rawCreds = await window.storage.get(EBAY_TOKEN_KEY).catch(() => null);
    const creds = await decryptObject(rawCreds || {});
    if (!creds?.token) {
      eventBus.emit('notification:push', {
        type: 'error',
        title: 'No eBay token',
        message: 'Add your eBay user token in Settings → eBay Credentials.',
      });
      return;
    }

    setPushOpen(true);
    setPushRunning(true);
    setPushStatus({});

    for (let i = 0; i < listings.length; i++) {
      const listing = listings[i];
      setPushStatus(prev => ({ ...prev, [i]: { state: 'running' } }));

      try {
        const photos = await getPhotosForListing(listing);
        const itemSpecifics = extractItemSpecifics(listing);
        const sku = listing._item?.sku || listing._item?.serialNumber || '';

        // Per-listing policy overrides — fall back to the global defaults
        // for any field the user didn't explicitly override.
        const effectivePolicies = {
          paymentProfileId:  listing.policyOverrides?.paymentProfileId  || ebayPolicies.paymentProfileId,
          shippingProfileId: listing.policyOverrides?.shippingProfileId || ebayPolicies.shippingProfileId,
          returnProfileId:   listing.policyOverrides?.returnProfileId   || ebayPolicies.returnProfileId,
        };

        const resp = await fetch(`${PIPELINE_BASE}/api/ebay/listings/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userToken: creds.token,
            appId: creds.appId,
            devId: creds.devId,
            certId: creds.certId,
            listing: {
              title: listing.title,
              description: listing.description,
              price: listing.price,
              quantity: listing.quantity || 1,
              conditionId: listing.conditionId,
              // Prefer the user-authored condition description; fall back to
              // the eBay condition label so the field is never empty.
              conditionDesc: listing.conditionDescription || listing.conditionLabel || '',
              categoryId: listing.categoryId,  // null → server auto-detects
              sku,
              brand: listing.brand,
              mpn: listing.mpn || listing._item?.model || '',
              photos,
              itemSpecifics,
            },
            policies: effectivePolicies,
            country: 'US',
            currency: 'USD',
            postalCode: creds.postalCode || '',
          }),
          signal: AbortSignal.timeout(5 * 60 * 1000),
        });

        const data = await resp.json();
        if (!data.success) {
          setPushStatus(prev => ({ ...prev, [i]: { state: 'error', error: data.error || 'Unknown error' } }));
          continue;
        }

        // Save the eBay itemId back to the inventory item so the next sync
        // recognizes the listing as ours.
        if (listing._item?.id && data.itemId) {
          dispatch({
            type: 'UPDATE_ITEM',
            id: listing._item.id,
            updates: {
              ebayItemId: data.itemId,
              status: 'listed',
              listingPrice: parseFloat(listing.price) || null,
            },
          });
        }

        setPushStatus(prev => ({
          ...prev,
          [i]: {
            state: 'done',
            itemId: data.itemId,
            fees: data.fees,
            warnings: data.warnings,
            photoCount: data.photoCount,
            photoErrors: data.photoErrors,
          },
        }));
      } catch (err) {
        setPushStatus(prev => ({ ...prev, [i]: { state: 'error', error: err.message } }));
      }
    }

    setPushRunning(false);
    eventBus.emit('notification:push', {
      type: 'success',
      title: 'eBay push complete',
      message: `${listings.length} listing${listings.length !== 1 ? 's' : ''} processed`,
    });
  }

  // ── Schedule listings ──────────────────────────────────────────────────

  async function handleSchedule() {
    if (!listings.length || !scheduleDate) return;
    const when = new Date(scheduleDate).toISOString();
    const selectedLot = lots.find(l => l.id === selectedLotId);
    const entry = {
      id: crypto.randomUUID?.() ?? Date.now().toString(36),
      scheduledAt: when,
      createdAt: new Date().toISOString(),
      lotId: selectedLotId,
      lotName: selectedLot?.title || selectedLot?.sourceName || selectedLot?.name || selectedLotId,
      source,
      template,
      listings,
      status: 'pending',
    };
    const next = [entry, ...scheduledList];
    await window.storage.set(SCHEDULED_KEY, next);
    setScheduledList(next);
    setShowScheduleModal(false);
    setScheduleDate('');
  }

  async function cancelScheduled(id) {
    const next = scheduledList.filter(s => s.id !== id);
    await window.storage.set(SCHEDULED_KEY, next);
    setScheduledList(next);
  }

  async function exportScheduled(entry) {
    const headers = [
      '*Action(SiteID=US|Country=US|Currency=USD|Version=1193)',
      '*Title', '*Description', '*StartPrice', '*Quantity', '*ConditionID',
      'Product:UPC', 'Product:Brand', '*Duration', '*Format', 'PaymentProfileName',
    ];
    const rows = entry.listings.map(l => [
      'Add', escapeCsv(l.title), escapeCsv(l.description),
      l.price != null ? l.price.toFixed(2) : '0.00',
      String(l.quantity), String(l.conditionId),
      escapeCsv(l.upc), escapeCsv(l.brand), 'GTC', 'FixedPrice', 'eBay Payments',
    ]);
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
    downloadCsv(`ebay-scheduled-${entry.lotId}.csv`, csv);
    const next = scheduledList.map(s => s.id === entry.id ? { ...s, status: 'exported' } : s);
    await window.storage.set(SCHEDULED_KEY, next);
    setScheduledList(next);
  }

  const now = Date.now();
  const dueCount = scheduledList.filter(s => s.status === 'pending' && new Date(s.scheduledAt).getTime() <= now).length;

  // ── Summary stats ──────────────────────────────────────────────────────

  const stats = useMemo(() => {
    const totalItems = listings.reduce((s, l) => s + l.quantity, 0);
    const priced = listings.filter(l => l.price != null && l.price > 0);
    const totalValue = priced.reduce((s, l) => s + (l.price * l.quantity), 0);
    const avgPrice = priced.length > 0 ? totalValue / priced.reduce((s, l) => s + l.quantity, 0) : 0;
    return { totalItems, pricedCount: priced.length, totalValue, avgPrice, totalListings: listings.length };
  }, [listings]);

  // ── Loading state ──────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-4">
        <PageHeader title="Listing Generator" subtitle="Turn enriched manifests into eBay bulk-upload CSVs." />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => (
            <Card key={i} padding="sm" radius="lg"><Skeleton className="h-14 w-full" /></Card>
          ))}
        </div>
        <Card padding="none" radius="lg">
          <div className="p-4 space-y-3">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="size-10 rounded-lg" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3 w-3/4" />
                  <Skeleton className="h-2 w-1/2" />
                </div>
                <Skeleton className="h-5 w-16" />
              </div>
            ))}
          </div>
        </Card>
      </div>
    );
  }

  // ── Error state ────────────────────────────────────────────────────────

  if (error) {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Couldn't load data"
        description={error}
      />
    );
  }

  // ── Source toggle helper ────────────────────────────────────────────────

  const changeSource = (next) => {
    setSource(next);
    setSelectedLotId('');
    setListings([]);
  };

  const noData = lots.length === 0;
  const selectedLot = lots.find(l => l.id === selectedLotId);
  const allRowsSelected = listings.length > 0 && selectedRows.size === listings.length;
  const someRowsSelected = selectedRows.size > 0 && selectedRows.size < listings.length;

  const sourceItems = [
    { id: 'manifests', label: 'From Manifests', icon: FileSpreadsheet },
    { id: 'inventory', label: 'From Inventory', icon: Package },
  ];
  const templateItems = Object.entries(TEMPLATES).map(([k, v]) => ({ id: k, label: v.label }));

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      <PageHeader
        title="Listing Generator"
        subtitle="Turn enriched manifests into eBay bulk-upload CSVs."
        actions={
          listings.length > 0 ? (
            <>
              {source === 'manifests' && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={runCleanTitles}
                  disabled={cleanTitlesRunning}
                  title="Use Gemini to rewrite the raw eBay titles in the UPC cache into clean listing titles"
                >
                  {cleanTitlesRunning ? (
                    <>
                      <Loader2 className="animate-spin" />
                      Cleaning {cleanTitlesProgress.done}/{cleanTitlesProgress.total}…
                    </>
                  ) : (
                    <><Wand2 /> Clean titles</>
                  )}
                </Button>
              )}
              <Button variant="secondary" size="sm" onClick={() => {
                const d = new Date(Date.now() + 60 * 60 * 1000);
                const iso = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
                setScheduleDate(iso);
                setShowScheduleModal(true);
              }}>
                <Clock /> Schedule
              </Button>
              <Button variant={exported ? 'success' : 'accent'} size="sm" onClick={handleExport}>
                {exported ? <><CheckCircle2 /> Exported</> : <><Download /> Export CSV</>}
              </Button>
              <Button variant="primary" size="sm" onClick={handlePushToEbay} disabled={pushRunning}>
                {pushRunning ? <><Loader2 className="animate-spin" /> Pushing…</> : <><Send /> Push to eBay</>}
              </Button>
            </>
          ) : null
        }
      />

      {/* Push to eBay progress modal */}
      <Modal
        open={pushOpen}
        onClose={() => !pushRunning && setPushOpen(false)}
        title="Push to eBay"
        subtitle={pushRunning ? 'Creating listings — this can take a few minutes' : 'Results'}
        size="lg"
      >
        <div className="space-y-2 max-h-[60vh] overflow-y-auto">
          {listings.map((l, i) => {
            const s = pushStatus[i] || { state: 'queued' };
            const stateColor = {
              queued:  'text-fg-muted',
              running: 'text-primary',
              done:    'text-success',
              error:   'text-danger',
            }[s.state] || 'text-fg-muted';
            const stateLabel = {
              queued:  'Queued',
              running: 'Pushing…',
              done:    `✓ Listed`,
              error:   '✗ Failed',
            }[s.state] || s.state;
            return (
              <div key={i} className="flex items-start justify-between gap-3 px-3 py-2 rounded-lg border border-border bg-white">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-fg truncate">{l.title || 'Listing'}</p>
                  <p className="text-[11px] text-fg-muted">
                    {fmt(l.price)} · qty {l.quantity || 1}
                    {s.itemId && <> · ItemID <span className="font-mono">{s.itemId}</span></>}
                    {s.photoCount != null && <> · {s.photoCount} photo{s.photoCount !== 1 ? 's' : ''}</>}
                  </p>
                  {s.error && (
                    <p className="text-[11px] text-danger mt-0.5 break-words">{s.error}</p>
                  )}
                  {s.warnings && s.warnings.length > 0 && (
                    <p className="text-[11px] text-warning mt-0.5 break-words">⚠ {s.warnings.join('; ')}</p>
                  )}
                  {s.photoErrors && s.photoErrors.length > 0 && (
                    <p className="text-[10px] text-warning mt-0.5">{s.photoErrors.length} photo upload{s.photoErrors.length !== 1 ? 's' : ''} failed</p>
                  )}
                </div>
                <span className={`text-xs font-semibold whitespace-nowrap ${stateColor}`}>
                  {s.state === 'running' && <Loader2 size={11} className="inline animate-spin mr-1" />}
                  {stateLabel}
                </span>
              </div>
            );
          })}
        </div>
        <div className="mt-4 flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => !pushRunning && setPushOpen(false)} disabled={pushRunning}>
            {pushRunning ? 'Working…' : 'Close'}
          </Button>
        </div>
      </Modal>

      {/* Controls card */}
      <Card padding="sm" radius="lg" className="sticky top-0 z-20 bg-surface/95 backdrop-blur-sm">
        <div className="flex flex-wrap items-center gap-3">
          <Tabs size="sm" items={sourceItems} value={source} onChange={changeSource} />

          <div className="flex-1 min-w-[200px]">
            <Label className="text-[10px] uppercase tracking-wider text-fg-muted">
              {source === 'inventory' ? 'Inventory Lot' : 'Enriched Lot'}
            </Label>
            <Select value={selectedLotId} onChange={e => setSelectedLotId(e.target.value)}>
              <option value="">Choose a lot…</option>
              {lots.map(lot => {
                if (source === 'inventory') {
                  const itemCount = (lot.items || []).length;
                  return (
                    <option key={lot.id} value={lot.id}>
                      {lot.sourceName || lot.name || lot.title || lot.id} ({itemCount} items)
                    </option>
                  );
                }
                const enrich = browseData?.enrichments?.[lot.id];
                const itemCount = enrich?.manifestItems?.length || 0;
                return (
                  <option key={lot.id} value={lot.id}>
                    {lot.title || lot.id} ({itemCount} items)
                  </option>
                );
              })}
            </Select>
          </div>

          <div className="shrink-0">
            <Label className="text-[10px] uppercase tracking-wider text-fg-muted">Description</Label>
            <Tabs size="sm" items={templateItems} value={template} onChange={setTemplate} />
          </div>
        </div>
        {listings.length > 0 && selectedLot && (
          <p className="text-[11px] text-fg-muted mt-2">
            {TEMPLATES[template].description} · {listings.length} listing{listings.length !== 1 ? 's' : ''} from{' '}
            <span className="font-medium text-fg">{selectedLot.title || selectedLot.sourceName || selectedLot.name}</span>
          </p>
        )}
      </Card>

      {/* Stats */}
      {listings.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Listings',         value: stats.totalListings, intent: 'neutral' },
            { label: 'Total Items',      value: stats.totalItems,    intent: 'accent' },
            {
              label: 'Priced',
              value: `${stats.pricedCount}/${stats.totalListings}`,
              intent: stats.totalListings && stats.pricedCount / stats.totalListings > 0.8
                ? 'success'
                : stats.pricedCount / Math.max(1, stats.totalListings) < 0.5
                  ? 'warning'
                  : 'neutral',
            },
            { label: 'Est. Total Value', value: fmt(stats.totalValue), intent: 'success', hero: true },
          ].map((k, i) => (
            <motion.div
              key={k.label}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: i * 0.04, ease: [0.16, 1, 0.3, 1] }}
            >
              <Card padding="sm" radius="lg" className="card-hover">
                <Stat
                  label={k.label}
                  value={k.hero ? <span className="hero-num">{k.value}</span> : k.value}
                  intent={k.intent}
                  size="md"
                />
              </Card>
            </motion.div>
          ))}
        </div>
      )}

      {/* Bulk actions bar */}
      <AnimatePresence initial={false}>
        {selectedRows.size > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2 }}
          >
            <Card padding="sm" radius="lg" className="flex flex-wrap items-center gap-3 bg-accent-subtle/40 border-accent/30">
              <div className="flex items-center gap-2 text-sm font-semibold text-fg shrink-0">
                <span className="inline-flex items-center justify-center min-w-6 h-6 px-1.5 rounded-md bg-accent text-accent-fg text-xs tabular-nums">
                  {selectedRows.size}
                </span>
                selected
              </div>

              <div className="flex items-center gap-1.5">
                <Label className="text-[10px] mb-0 text-fg-muted">Condition:</Label>
                <Select value={bulkConditionId} onChange={e => { bulkSetCondition(e.target.value); setBulkConditionId(''); }} className="w-36">
                  <option value="">Set…</option>
                  {[...new Map(Object.values(CONDITION_MAP).map(c => [c.id, c])).values()].map(c => (
                    <option key={c.id} value={c.id}>{c.label}</option>
                  ))}
                </Select>
              </div>

              <div className="flex items-center gap-1.5">
                <Label className="text-[10px] mb-0 text-fg-muted inline-flex items-center gap-1"><Percent size={11} /> Adjust:</Label>
                <Input
                  type="number"
                  step="1"
                  placeholder="e.g. -5"
                  value={bulkPricePct}
                  onChange={e => setBulkPricePct(e.target.value)}
                  className="w-20"
                />
                <Button variant="secondary" size="sm" onClick={() => { bulkAdjustPrice(bulkPricePct); setBulkPricePct(''); }}>
                  Apply
                </Button>
              </div>

              <div className="flex items-center gap-1.5 ml-auto">
                <Button variant="secondary" size="sm" onClick={bulkDelete}>
                  <Trash2 /> Remove
                </Button>
                <Button variant="ghost" size="sm" onClick={clearSelection}>
                  <X /> Clear
                </Button>
              </div>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Listings table */}
      {listings.length > 0 && (
        <Card padding="none" radius="lg" className="overflow-hidden">
          <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
            <h3 className="text-sm font-semibold text-fg flex items-center gap-1.5">
              <Tag className="size-3.5" />
              Generated Listings
            </h3>
            <span className="text-xs text-fg-muted">Tap any title or price to edit</span>
          </div>
          <div className="overflow-x-auto">
            <Table className="min-w-[880px]">
              <THead sticky>
                <TR>
                  <TH className="w-10">
                    <input
                      type="checkbox"
                      checked={allRowsSelected}
                      ref={el => { if (el) el.indeterminate = someRowsSelected; }}
                      onChange={toggleSelectAll}
                      className="accent-accent size-3.5 cursor-pointer"
                      aria-label="Select all listings"
                    />
                  </TH>
                  <TH className="w-8" aria-label="Expand" />
                  <TH className="w-10 text-center">#</TH>
                  <TH className="w-14">Photo</TH>
                  <TH>Title / Description</TH>
                  <TH className="w-24 text-right">Price</TH>
                  <TH className="w-12 text-center">Qty</TH>
                  <TH className="w-28">Condition</TH>
                  <TH className="w-40">Category</TH>
                  <TH className="w-28">UPC</TH>
                </TR>
              </THead>
              <TBody>
                {listings.map((listing, i) => {
                  const isExpanded = expandedRows.has(i);
                  const rowKey = `${listing.upc || 'no-upc'}-${i}`;
                  return (
                    <Fragment key={rowKey}>
                      <ListingRow
                        listing={listing}
                        index={i}
                        onUpdate={handleUpdate}
                        selected={selectedRows.has(i)}
                        onToggleSelect={toggleRow}
                        expanded={isExpanded}
                        onToggleExpand={(idx) => {
                          toggleExpand(idx);
                          // Lazy-load policies the first time anyone expands
                          if (!availablePolicies && !policiesLoading) loadAvailablePolicies();
                        }}
                      />
                      {isExpanded && (
                        <TR className="bg-transparent">
                          <TD colSpan={10} className="!p-0 !border-0">
                            <ListingExpandEditor
                              listing={listing}
                              index={i}
                              onUpdate={handleUpdate}
                              availablePolicies={availablePolicies}
                              policiesLoading={policiesLoading}
                              policiesError={policiesError}
                              onLoadPolicies={loadAvailablePolicies}
                              onRunGemini={runGeminiAutofill}
                              geminiBusy={geminiBusy.has(i)}
                              globalPolicies={ebayPolicies}
                            />
                          </TD>
                        </TR>
                      )}
                    </Fragment>
                  );
                })}
              </TBody>
            </Table>
          </div>
        </Card>
      )}

      {/* Scheduled queue */}
      {scheduledList.length > 0 && (
        <Card padding="none" radius="lg" className="overflow-hidden">
          <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
            <h3 className="text-sm font-semibold text-fg flex items-center gap-1.5">
              <Clock className="size-3.5" /> Scheduled Queue
              {dueCount > 0 && <Badge variant="solid-accent" size="xs">{dueCount} due</Badge>}
            </h3>
            <span className="text-xs text-fg-muted">{scheduledList.length} total</span>
          </div>
          <div className="divide-y divide-border-subtle">
            {scheduledList.map(entry => {
              const when = new Date(entry.scheduledAt).getTime();
              const diff = when - now;
              const due = entry.status === 'pending' && diff <= 0;
              const soon = entry.status === 'pending' && diff > 0 && diff < 3600000;
              let countdown = '';
              if (entry.status === 'pending') {
                if (due) countdown = 'Due now';
                else {
                  const hrs = Math.floor(diff / 3600000);
                  const mins = Math.floor((diff % 3600000) / 60000);
                  const days = Math.floor(hrs / 24);
                  if (days >= 1) countdown = `In ${days}d ${hrs % 24}h`;
                  else if (hrs >= 1) countdown = `In ${hrs}h ${mins}m`;
                  else countdown = `In ${mins}m`;
                }
              }
              return (
                <div key={entry.id} className={`row-hover px-4 py-3 flex items-center gap-3 ${due ? 'bg-accent-subtle/30' : ''}`}>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-fg truncate">{entry.lotName}</p>
                    <p className="text-[11px] text-fg-muted">
                      {entry.listings.length} listing{entry.listings.length !== 1 ? 's' : ''} · {new Date(entry.scheduledAt).toLocaleString()}
                      {entry.status === 'exported' && <span className="ml-2 text-success">· exported</span>}
                    </p>
                  </div>
                  {entry.status === 'pending' && (
                    <Badge variant={due ? 'solid-accent' : soon ? 'warning' : 'neutral'} size="xs" className={due ? 'animate-pulse' : ''}>
                      {countdown}
                    </Badge>
                  )}
                  {entry.status === 'pending' && (
                    <Button variant={due ? 'accent' : 'secondary'} size="sm" onClick={() => exportScheduled(entry)}>
                      <Download /> {due ? 'Export now' : 'Export early'}
                    </Button>
                  )}
                  <button
                    onClick={() => cancelScheduled(entry.id)}
                    className="p-1.5 text-fg-subtle hover:text-danger transition-colors"
                    title="Remove"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Empty / no-selection states */}
      {!selectedLotId && noData && (
        <EmptyState
          icon={Package}
          title={source === 'inventory' ? 'No inventory lots yet' : 'No enriched lots available'}
          description={source === 'inventory'
            ? 'Add lots and items in the Inventory module to generate listings here.'
            : 'Browse and enrich lots in the Arbitrage Scanner to generate listings from manifests.'}
        />
      )}
      {!selectedLotId && !noData && (
        <EmptyState
          icon={FileSpreadsheet}
          title="Pick a lot to generate listings"
          description={`${lots.length} ${source === 'inventory' ? 'inventory' : 'enriched'} lot${lots.length !== 1 ? 's' : ''} ready to go.`}
        />
      )}
      {selectedLotId && listings.length === 0 && (
        <EmptyState
          icon={AlertCircle}
          title="No items found for this lot"
          description="This lot has no parseable manifest data."
        />
      )}

      {/* Schedule modal */}
      <Modal
        open={showScheduleModal}
        onClose={() => setShowScheduleModal(false)}
        size="md"
        title="Schedule listings"
        subtitle={`Save ${listings.length} listing${listings.length !== 1 ? 's' : ''} for later export.`}
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setShowScheduleModal(false)}>Cancel</Button>
            <Button variant="accent" size="sm" onClick={handleSchedule} disabled={!scheduleDate}>
              <Clock /> Schedule
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <p className="text-xs text-fg-muted">
            When the scheduled time arrives you'll get a notification to export the CSV. Nothing is posted to eBay automatically.
          </p>
          <div>
            <Label className="text-[10px] uppercase tracking-wider">Post Date &amp; Time</Label>
            <Input
              type="datetime-local"
              value={scheduleDate}
              onChange={e => setScheduleDate(e.target.value)}
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
