// ─── Message Templates ─────────────────────────────────────────────────────
// Library of reusable buyer-response messages with variable substitution.
// Use from ShippingQueue, EbayOrderSync, or anywhere a buyer inquiry lands.
//
// Storage:  noltech:messages:templates  →  array of { id, name, category, body }
// Variables supported in body:
//   {buyer}       {item_title}    {order_id}
//   {tracking}    {ship_date}     {return_window}
//
// Render renders a list of templates grouped by category, a big editable
// preview with variable picker on the right, and one-click copy to clipboard.

import { useState, useEffect, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  MessageSquare, Plus, Trash2, Copy, Check, Edit2, Save, X, Search, FileText,
} from 'lucide-react';
import { Button, Card, Input, Label, Modal, Badge, Textarea } from '../../components/ui';
import EmptyState from '../../components/EmptyState';

const KEY = 'noltech:messages:templates';

const VAR_DEFS = [
  { token: '{buyer}',        label: 'Buyer username' },
  { token: '{item_title}',   label: 'Item title' },
  { token: '{order_id}',     label: 'Order / transaction ID' },
  { token: '{tracking}',     label: 'Tracking number' },
  { token: '{ship_date}',    label: 'Ship date' },
  { token: '{return_window}',label: 'Return window (e.g. 30 days)' },
];

const DEFAULT_CATEGORIES = ['Shipping', 'Returns', 'Compatibility', 'Pricing', 'General'];

const SEED_TEMPLATES = [
  {
    id: 'seed-ship',
    name: 'Shipping confirmation',
    category: 'Shipping',
    body: `Hi {buyer},

Thanks for your order! Your package shipped on {ship_date}. Tracking number: {tracking}

You should see it within 3–5 business days. Let me know if you have any questions.

— NolTech`,
  },
  {
    id: 'seed-when',
    name: 'When will it ship?',
    category: 'Shipping',
    body: `Hi {buyer},

Your order ({order_id}) will ship within 1 business day. I'll send tracking as soon as the label is printed.

Thanks for your patience!

— NolTech`,
  },
  {
    id: 'seed-compat',
    name: 'Compatibility question',
    category: 'Compatibility',
    body: `Hi {buyer},

Thanks for reaching out! To help me confirm compatibility, can you share the exact make and model you're using this with?

— NolTech`,
  },
  {
    id: 'seed-return',
    name: 'Return accepted',
    category: 'Returns',
    body: `Hi {buyer},

I've accepted the return on order {order_id}. Please use the prepaid label eBay generated — once I receive the item, a full refund will be issued within 1 business day.

Sorry it didn't work out for you!

— NolTech`,
  },
  {
    id: 'seed-combine',
    name: 'Combined shipping',
    category: 'Pricing',
    body: `Hi {buyer},

Happy to combine shipping! Once you've added everything to your cart, I can send a combined-shipping invoice to discount the rate. Let me know when you're ready.

— NolTech`,
  },
];

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function substitute(body, vars) {
  return Object.entries(vars).reduce(
    (acc, [k, v]) => acc.replaceAll(`{${k}}`, v || `{${k}}`),
    body || '',
  );
}

function useClipboard() {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error('[MessageTemplates] clipboard failed:', e);
    }
  }, []);
  return { copied, copy };
}

// ─── Form ─────────────────────────────────────────────────────────────────
function TemplateForm({ initial, onSave, onCancel }) {
  const [name, setName]         = useState(initial?.name || '');
  const [category, setCategory] = useState(initial?.category || 'General');
  const [body, setBody]         = useState(initial?.body || '');

  const insertVar = (tok) => setBody((b) => b + tok);

  const valid = name.trim() && body.trim();

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <Label>Template name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Shipping confirmation" />
        </div>
        <div>
          <Label>Category</Label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-surface text-fg focus:outline-none focus:ring-2 focus:ring-accent/30"
          >
            {DEFAULT_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </select>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <Label className="mb-0">Message body</Label>
          <div className="flex items-center gap-1 flex-wrap">
            {VAR_DEFS.map((v) => (
              <button
                key={v.token}
                onClick={() => insertVar(v.token)}
                className="text-[10px] px-1.5 py-0.5 rounded-md border border-border-subtle bg-muted/40 text-fg-muted hover:bg-accent-subtle hover:text-accent hover:border-accent/30 font-mono transition-colors"
                title={v.label}
              >
                {v.token}
              </button>
            ))}
          </div>
        </div>
        <Textarea
          rows={10}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Hi {buyer},&#10;&#10;Thanks for your order! …"
          className="font-mono text-xs"
        />
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
        <Button
          variant="accent"
          size="sm"
          disabled={!valid}
          onClick={() => onSave({
            id: initial?.id || uid(),
            name: name.trim(),
            category,
            body: body.trim(),
          })}
        >
          <Save /> Save template
        </Button>
      </div>
    </div>
  );
}

// ─── Row ─────────────────────────────────────────────────────────────────
function TemplateRow({ tpl, active, onSelect, onEdit, onDelete }) {
  return (
    <button
      onClick={onSelect}
      className={`row-hover w-full text-left flex items-start gap-2 px-3 py-2.5 rounded-lg transition-colors ${
        active ? 'bg-accent-subtle/60 border border-accent/30' : 'border border-transparent hover:bg-muted/40'
      }`}
    >
      <FileText className="size-4 mt-0.5 text-fg-muted shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <p className="text-sm font-medium text-fg truncate">{tpl.name}</p>
          <Badge variant="neutral" size="xs">{tpl.category}</Badge>
        </div>
        <p className="text-[11px] text-fg-muted truncate mt-0.5">
          {tpl.body.split('\n').find((l) => l.trim()) || 'Empty template'}
        </p>
      </div>
      <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={(e) => { e.stopPropagation(); onEdit(); }}
          className="p-1 rounded text-fg-muted hover:text-accent transition-colors"
          title="Edit"
        >
          <Edit2 className="size-3.5" />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="p-1 rounded text-fg-muted hover:text-danger transition-colors"
          title="Delete"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </button>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────
export default function MessageTemplates() {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [query, setQuery]         = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [editing, setEditing]     = useState(null); // 'new' | tplId | null
  const [vars, setVars]           = useState({
    buyer: '', item_title: '', order_id: '',
    tracking: '', ship_date: '', return_window: '30 days',
  });
  const { copied, copy } = useClipboard();

  useEffect(() => {
    let mounted = true;
    window.storage.get(KEY).then((v) => {
      if (!mounted) return;
      if (Array.isArray(v) && v.length) setTemplates(v);
      else { setTemplates(SEED_TEMPLATES); window.storage.set(KEY, SEED_TEMPLATES).catch(() => {}); }
    }).catch((e) => console.error('[MessageTemplates] load failed:', e))
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, []);

  const persist = (next) => {
    setTemplates(next);
    window.storage.set(KEY, next).catch((e) => console.error('[MessageTemplates] persist failed:', e));
  };

  const handleSave = (tpl) => {
    const exists = templates.some((t) => t.id === tpl.id);
    const next = exists
      ? templates.map((t) => (t.id === tpl.id ? tpl : t))
      : [tpl, ...templates];
    persist(next);
    setEditing(null);
    setSelectedId(tpl.id);
  };

  const handleDelete = (id) => {
    if (!confirm('Delete this template?')) return;
    persist(templates.filter((t) => t.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const filtered = useMemo(() => {
    if (!query.trim()) return templates;
    const q = query.toLowerCase();
    return templates.filter((t) =>
      t.name.toLowerCase().includes(q) ||
      t.category.toLowerCase().includes(q) ||
      t.body.toLowerCase().includes(q),
    );
  }, [templates, query]);

  const grouped = useMemo(() => {
    const m = {};
    for (const t of filtered) {
      const c = t.category || 'General';
      (m[c] ||= []).push(t);
    }
    return m;
  }, [filtered]);

  const selected = templates.find((t) => t.id === selectedId);
  const preview = selected ? substitute(selected.body, vars) : '';

  if (loading) {
    return (
      <Card padding="md" radius="lg">
        <div className="h-40 shimmer rounded-lg" />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h2 className="text-lg font-semibold text-fg tracking-tight flex items-center gap-2">
            <MessageSquare className="size-4 text-accent" /> Message Templates
          </h2>
          <p className="text-xs text-fg-muted hidden md:block">
            Reusable buyer responses with variable substitution.
          </p>
        </div>
        <Button variant="accent" size="sm" onClick={() => setEditing('new')}>
          <Plus /> New template
        </Button>
      </div>

      {templates.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title="No message templates yet"
          description="Save reusable responses for shipping updates, return requests, and compatibility questions."
          action={() => setEditing('new')}
          actionLabel="Create your first template"
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
          {/* Template list */}
          <Card padding="none" radius="lg" className="overflow-hidden">
            <div className="px-3 py-2 border-b border-border-subtle">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-fg-subtle" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search templates…"
                  className="w-full pl-8 pr-2 py-1.5 text-sm bg-muted/40 border border-border-subtle rounded-md text-fg placeholder-fg-subtle focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/50"
                />
              </div>
            </div>
            <div className="max-h-[560px] overflow-y-auto p-2 space-y-3">
              {Object.entries(grouped).map(([cat, items]) => (
                <div key={cat}>
                  <p className="px-2 pb-1 text-[10px] font-semibold text-fg-subtle uppercase tracking-wider">{cat}</p>
                  <div className="space-y-1">
                    {items.map((tpl) => (
                      <div key={tpl.id} className="group">
                        <TemplateRow
                          tpl={tpl}
                          active={selectedId === tpl.id}
                          onSelect={() => { setSelectedId(tpl.id); setEditing(null); }}
                          onEdit={() => setEditing(tpl.id)}
                          onDelete={() => handleDelete(tpl.id)}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {filtered.length === 0 && (
                <p className="text-xs text-fg-muted text-center py-6">No matches for "{query}"</p>
              )}
            </div>
          </Card>

          {/* Preview / edit */}
          <Card padding="md" radius="lg">
            {editing ? (
              <TemplateForm
                initial={editing === 'new' ? null : templates.find((t) => t.id === editing)}
                onSave={handleSave}
                onCancel={() => setEditing(null)}
              />
            ) : selected ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div>
                    <h3 className="text-sm font-semibold text-fg">{selected.name}</h3>
                    <div className="flex items-center gap-1.5 mt-1">
                      <Badge variant="neutral" size="xs">{selected.category}</Badge>
                      <span className="text-[11px] text-fg-muted">Tap a variable slot to fill, then copy.</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button variant="secondary" size="sm" onClick={() => setEditing(selected.id)}>
                      <Edit2 /> Edit
                    </Button>
                    <Button variant={copied ? 'success' : 'accent'} size="sm" onClick={() => copy(preview)}>
                      {copied ? <><Check /> Copied</> : <><Copy /> Copy message</>}
                    </Button>
                  </div>
                </div>

                {/* Variable slots */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {VAR_DEFS.filter((v) => selected.body.includes(v.token)).map((v) => {
                    const key = v.token.replace(/[{}]/g, '');
                    return (
                      <div key={v.token}>
                        <Label className="text-[10px] mb-0.5 inline-flex items-center gap-1">
                          <code className="text-[10px] bg-muted/60 px-1 rounded text-accent font-mono">{v.token}</code>
                          {v.label}
                        </Label>
                        <Input
                          value={vars[key] || ''}
                          onChange={(e) => setVars((s) => ({ ...s, [key]: e.target.value }))}
                          placeholder={v.label}
                          className="text-sm"
                        />
                      </div>
                    );
                  })}
                </div>

                {/* Preview */}
                <div>
                  <Label className="text-[10px] mb-0.5">Preview</Label>
                  <div className="bg-muted/40 border border-border-subtle rounded-lg p-3 text-sm text-fg whitespace-pre-wrap font-mono leading-relaxed max-h-[320px] overflow-y-auto">
                    {preview}
                  </div>
                </div>
              </div>
            ) : (
              <EmptyState
                icon={MessageSquare}
                title="Pick a template to preview"
                description="Or create a new one. Variables like {buyer} fill in on the right."
              />
            )}
          </Card>
        </div>
      )}

      {/* Modal-driven new form on mobile (optional alternate presentation) */}
      <Modal
        open={editing === 'new' && false /* preview always uses inline form */}
        onClose={() => setEditing(null)}
        size="lg"
        title="New template"
      >
        <TemplateForm onSave={handleSave} onCancel={() => setEditing(null)} />
      </Modal>
    </div>
  );
}
