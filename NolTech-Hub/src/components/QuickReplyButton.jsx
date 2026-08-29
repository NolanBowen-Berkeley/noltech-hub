// ─── Quick Reply Button ────────────────────────────────────────────────────
// Dropdown button that lists message templates + auto-fills variables from
// order/item context + copies the message to clipboard.
//
// Usage:
//   <QuickReplyButton context={{ buyer, item_title, order_id, tracking, ship_date }} />
//
// Reads templates from noltech:messages:templates.

import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { MessageSquare, Copy, Check, ChevronDown, X } from 'lucide-react';
import { cn } from './ui/cn';
import { Badge } from './ui';

const KEY = 'noltech:messages:templates';

function substitute(body, vars) {
  return Object.entries(vars || {}).reduce(
    (acc, [k, v]) => acc.replaceAll(`{${k}}`, v || `{${k}}`),
    body || '',
  );
}

export default function QuickReplyButton({
  context = {},
  size = 'sm',
  label = 'Quick reply',
  className = '',
}) {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [copiedId, setCopiedId] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    window.storage.get(KEY).then((v) => {
      setTemplates(Array.isArray(v) ? v : []);
    }).catch((e) => console.error('[QuickReply] load failed:', e));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const copy = useCallback(async (tpl) => {
    const text = substitute(tpl.body, context);
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(tpl.id);
      setTimeout(() => { setCopiedId(null); setOpen(false); }, 1100);
    } catch (e) {
      console.error('[QuickReply] clipboard failed:', e);
    }
  }, [context]);

  const sizeCls = size === 'xs' ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1.5 text-xs';

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md border border-border bg-surface font-medium text-fg-muted hover:text-fg hover:border-accent/40 transition-colors',
          sizeCls,
        )}
        title="Quick reply from saved templates"
      >
        <MessageSquare className="size-3.5" />
        {label}
        <ChevronDown className={cn('size-3 transition-transform', open && 'rotate-180')} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.14 }}
            className="absolute right-0 top-full mt-1 z-30 w-72 glossy-elevated overflow-hidden"
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">Templates</p>
              <button onClick={() => setOpen(false)} className="text-fg-subtle hover:text-fg-muted">
                <X className="size-3" />
              </button>
            </div>
            {templates.length === 0 ? (
              <div className="p-4 text-xs text-fg-muted text-center">
                No templates saved yet.
                <br />
                <span className="text-fg-subtle">Settings → Message Templates</span>
              </div>
            ) : (
              <div className="max-h-72 overflow-y-auto p-1">
                {templates.map((tpl) => (
                  <button
                    key={tpl.id}
                    onClick={() => copy(tpl)}
                    className="row-hover w-full text-left flex items-center gap-2 px-2.5 py-2 rounded-md text-sm text-fg hover:bg-muted/40 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="truncate text-[13px] font-medium">{tpl.name}</p>
                        <Badge variant="neutral" size="xs">{tpl.category}</Badge>
                      </div>
                    </div>
                    {copiedId === tpl.id ? (
                      <Check className="size-3.5 text-success shrink-0" />
                    ) : (
                      <Copy className="size-3.5 text-fg-subtle shrink-0" />
                    )}
                  </button>
                ))}
              </div>
            )}
            <div className="px-3 py-1.5 border-t border-border-subtle text-[10px] text-fg-subtle">
              Click to copy. Variables auto-filled from order context.
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
