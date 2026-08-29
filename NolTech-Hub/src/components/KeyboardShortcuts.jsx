// ─── Keyboard Shortcuts ────────────────────────────────────────────────────
// Press ? to show an overlay of all shortcuts.
// Register vim-style leader sequences (g+h, g+s, etc) for navigation.

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Keyboard, X } from 'lucide-react';
import { modalBackdrop, modalPanel } from './ui/motion';
import { cn } from './ui/cn';

const GROUPS = [
  {
    name: 'Navigation',
    items: [
      { keys: ['g', 'h'], label: 'Dashboard' },
      { keys: ['g', 's'], label: 'Source' },
      { keys: ['g', 'b'], label: 'Bid & Buy' },
      { keys: ['g', 'i'], label: 'Inventory' },
      { keys: ['g', '$'], label: 'Profit & Finance' },
      { keys: ['g', ','], label: 'Settings' },
    ],
  },
  {
    name: 'Global',
    items: [
      { keys: ['⌘', 'K'], mac: true,  label: 'Command Palette' },
      { keys: ['Ctrl', 'K'], mac: false, label: 'Command Palette' },
      { keys: ['/'],              label: 'Quick search' },
      { keys: ['n'],              label: 'New (context-aware)' },
      { keys: ['f'],              label: 'Toggle focus mode' },
      { keys: ['?'],              label: 'Show this overlay' },
      { keys: ['Esc'],            label: 'Close overlay / exit focus mode' },
    ],
  },
  {
    name: 'Lists',
    items: [
      { keys: ['↑', '↓'], label: 'Move selection' },
      { keys: ['j'], label: 'Next row (when focused)' },
      { keys: ['k'], label: 'Previous row' },
      { keys: ['Enter'], label: 'Open selected' },
    ],
  },
];

function Key({ children }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[22px] h-6 px-1.5 rounded-md border border-border bg-surface text-[11px] font-mono text-fg-muted shadow-glow-sm">
      {children}
    </kbd>
  );
}

export default function KeyboardShortcuts({ open, onClose, onNavigate }) {
  // Register the ? shortcut
  useEffect(() => {
    const handler = (e) => {
      const tag = e.target?.tagName;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
      if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (!open) {
          // parent controls open state via onClose(true), but we just fire an event
          window.dispatchEvent(new CustomEvent('ui:show-keys'));
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  // Register vim-style g-prefix sequences
  useEffect(() => {
    let pending = null;
    let timer = null;
    const map = { h: 'hub', s: 'source', b: 'bidding', i: 'inventory', $: 'finance', ',': 'settings' };

    const handler = (e) => {
      const tag = e.target?.tagName;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (pending === 'g' && map[e.key]) {
        e.preventDefault();
        onNavigate?.(map[e.key]);
        pending = null;
        clearTimeout(timer);
        return;
      }

      if (e.key === 'g') {
        pending = 'g';
        clearTimeout(timer);
        timer = setTimeout(() => { pending = null; }, 1000);
      } else {
        pending = null;
      }
    };
    window.addEventListener('keydown', handler);
    return () => { window.removeEventListener('keydown', handler); clearTimeout(timer); };
  }, [onNavigate]);

  const isMac = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div {...modalBackdrop} onClick={onClose} className="fixed inset-0 z-[110] bg-black/50 backdrop-blur-sm" />
          <motion.div
            {...modalPanel}
            onClick={(e) => e.stopPropagation()}
            className="fixed top-[15vh] left-1/2 -translate-x-1/2 z-[111] w-full max-w-lg glossy-elevated overflow-hidden"
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <Keyboard size={14} className="text-accent" />
                <h3 className="text-sm font-semibold text-fg">Keyboard Shortcuts</h3>
              </div>
              <button onClick={onClose} className="p-1 rounded-md text-fg-subtle hover:text-fg hover:bg-muted">
                <X size={14} />
              </button>
            </div>
            <div className="max-h-[60vh] overflow-y-auto p-4 space-y-5">
              {GROUPS.map((group) => (
                <div key={group.name}>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-subtle mb-2">{group.name}</p>
                  <div className="space-y-1">
                    {group.items
                      .filter((it) => it.mac == null || it.mac === isMac)
                      .map((it, i) => (
                        <div key={i} className="flex items-center justify-between py-1">
                          <span className="text-sm text-fg">{it.label}</span>
                          <div className="flex items-center gap-1">
                            {it.keys.map((k, j) => (
                              <span key={j} className="flex items-center gap-1">
                                <Key>{k}</Key>
                                {j < it.keys.length - 1 && <span className="text-[11px] text-fg-subtle">then</span>}
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
