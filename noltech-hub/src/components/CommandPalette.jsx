// ─── Command Palette ──────────────────────────────────────────────────────────
// Cmd+K / Ctrl+K launcher. Fuzzy-search over modules, lots, items, and actions.
// Keyboard-driven with j/k or arrow-key navigation, enter to select.

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search, ArrowRight, Command as CmdIcon,
  LayoutDashboard, Package, ScanSearch, Gavel, ShoppingCart, DollarSign, Cog,
  RefreshCw, Sun, BookOpen, Archive,
  Maximize2, Plus, MessageSquare, Handshake, Clock,
  ClipboardCheck, Camera, Truck,
} from 'lucide-react';
import useRecents from '../hooks/useRecents';
import { useApp } from '../context/AppContext';
import { cn } from './ui/cn';

// ─── Command registry — static commands ─────────────────────────────────────

function makeStaticCommands({ setView, syncAll, toggleDarkMode }) {
  return [
    { id: 'nav.hub',       label: 'Go to Dashboard',    icon: LayoutDashboard, group: 'Navigate', action: () => setView('hub') },
    { id: 'nav.source',    label: 'Go to Source',       icon: ScanSearch,      group: 'Navigate', action: () => setView('source') },
    { id: 'nav.analyzer',  label: 'Open Deal Analyzer', icon: ScanSearch,      group: 'Navigate', action: () => { setView('source'); setTimeout(() => window.dispatchEvent(new CustomEvent('ui:source-open', { detail: { view: 'analyzer' } })), 50); } },
    { id: 'nav.components',label: 'Open Component DB',  icon: ScanSearch,      group: 'Navigate', action: () => { setView('source'); setTimeout(() => window.dispatchEvent(new CustomEvent('ui:source-open', { detail: { view: 'components' } })), 50); } },
    { id: 'nav.watchlist', label: 'Open Watchlist',     icon: ScanSearch,      group: 'Navigate', action: () => { setView('source'); setTimeout(() => window.dispatchEvent(new CustomEvent('ui:source-open', { detail: { view: 'watchlist' } })), 50); } },
    { id: 'nav.bidding',   label: 'Go to Bid & Buy',    icon: Gavel,           group: 'Navigate', action: () => setView('bidding') },
    { id: 'nav.inventory', label: 'Go to Inventory',    icon: Package,         group: 'Navigate', action: () => setView('inventory') },
    { id: 'nav.operations',label: 'Go to Operations',   icon: Package,         group: 'Navigate', action: () => setView('operations') },
    { id: 'nav.process',   label: 'Open Process',       icon: ClipboardCheck,  group: 'Navigate', action: () => { setView('operations'); setTimeout(() => window.dispatchEvent(new CustomEvent('ui:ops-tab', { detail: { tab: 'process' } })), 50); } },
    { id: 'nav.photos',    label: 'Open Photo Prep',    icon: Camera,          group: 'Navigate', action: () => { setView('operations'); setTimeout(() => window.dispatchEvent(new CustomEvent('ui:ops-tab', { detail: { tab: 'photos' } })), 50); } },
    { id: 'nav.shipping',  label: 'Open Shipping',      icon: Truck,           group: 'Navigate', action: () => { setView('operations'); setTimeout(() => window.dispatchEvent(new CustomEvent('ui:ops-tab', { detail: { tab: 'shipping' } })), 50); } },
    { id: 'nav.sell',      label: 'Go to Sell',         icon: ShoppingCart,    group: 'Navigate', action: () => setView('sell') },
    { id: 'nav.offers',    label: 'Go to Offers',       icon: Handshake,       group: 'Navigate', action: () => { setView('sell'); setTimeout(() => window.dispatchEvent(new CustomEvent('ui:sell-tab', { detail: { tab: 'offers' } })), 50); } },
    { id: 'nav.finance',   label: 'Go to Profit & Finance', icon: DollarSign,  group: 'Navigate', action: () => setView('finance') },
    { id: 'nav.settings',  label: 'Go to Settings',     icon: Cog,             group: 'Navigate', action: () => setView('settings') },
    { id: 'nav.books',     label: 'Go to Bookkeeping',  icon: BookOpen,        group: 'Navigate', action: () => setView('finance') },
    { id: 'nav.templates', label: 'Open Message Templates', icon: MessageSquare, group: 'Navigate', action: () => { setView('settings'); setTimeout(() => window.dispatchEvent(new CustomEvent('ui:settings-section', { detail: { section: 'templates' } })), 50); } },
    { id: 'act.new',       label: 'New (context-aware)',       icon: Plus,    group: 'Actions', shortcut: 'n', action: () => window.dispatchEvent(new CustomEvent('ui:new')) },
    { id: 'act.focus',     label: 'Toggle focus mode',         icon: Maximize2, group: 'Actions', shortcut: 'f', action: () => window.dispatchEvent(new CustomEvent('ui:toggle-focus')) },
    { id: 'act.sync',      label: 'Sync All (refresh eBay + manifests)', icon: RefreshCw, group: 'Actions', shortcut: '⌘R', action: syncAll },
    { id: 'act.theme',     label: 'Toggle dark / light mode', icon: Sun,       group: 'Actions', action: toggleDarkMode },
  ];
}

// ─── Fuzzy match ────────────────────────────────────────────────────────────
function fuzzyScore(text, query) {
  if (!query) return 1;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  if (t.includes(q)) return 100 - t.indexOf(q); // exact substring wins
  // subsequence match
  let ti = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const idx = t.indexOf(q[qi], ti);
    if (idx === -1) return 0;
    ti = idx + 1;
  }
  return 10;
}

// ─── Toggle dark mode ─────────────────────────────────────────────────────────
async function toggleDarkModeGlobal() {
  const isDark = document.documentElement.classList.toggle('dark');
  try { await window.storage.set('noltech:settings:darkmode', isDark); } catch (e) { console.error('[command palette] darkmode save failed:', e); }
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function CommandPalette({ open, onClose, setView }) {
  const { state } = useApp();
  const { recents } = useRecents();
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIdx(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  // Flatten all items + lots for searching
  const dataItems = useMemo(() => {
    const lots = state.lots.map(l => ({
      id: `lot.${l.id}`,
      label: l.sourceName || l.name || `Lot ${l.id.slice(0, 6)}`,
      sub: `${(l.items || []).length} items • ${l.status}`,
      icon: Archive,
      group: 'Lots',
      action: () => setView('inventory'),
    }));
    const items = state.lots.flatMap(l =>
      (l.items || []).slice(0, 500).map(i => ({
        id: `item.${i.id}`,
        label: [i.brand, i.model].filter(Boolean).join(' ') || i.serialNumber || 'Unnamed item',
        sub: `${i.status}${i.listingPrice ? ` • $${i.listingPrice}` : ''}`,
        icon: Package,
        group: 'Items',
        action: () => setView('inventory'),
      }))
    );
    return [...lots, ...items];
  }, [state.lots, setView]);

  const staticCommands = useMemo(
    () => makeStaticCommands({
      setView,
      syncAll: () => setView('hub'),  // Sync All is triggered from the dashboard
      toggleDarkMode: toggleDarkModeGlobal,
    }),
    [setView],
  );

  const recentCommands = useMemo(() => (
    (recents || []).slice(0, 6).map(r => ({
      id: `recent.${r.type}.${r.id}`,
      label: r.label,
      sub: r.sub || null,
      icon: Clock,
      group: 'Recent',
      action: () => { if (r.view) setView(r.view); },
    }))
  ), [recents, setView]);

  const all = useMemo(() => [...staticCommands, ...dataItems], [staticCommands, dataItems]);

  // Filter + rank
  const filtered = useMemo(() => {
    if (!query) {
      // Empty query: show recents (if any) then static commands, grouped
      return [...recentCommands, ...staticCommands];
    }
    const scored = all
      .map(cmd => ({ cmd, score: fuzzyScore(cmd.label + ' ' + (cmd.sub || ''), query) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 40)
      .map(x => x.cmd);
    return scored;
  }, [all, staticCommands, recentCommands, query]);

  // Group filtered results
  const grouped = useMemo(() => {
    const g = {};
    for (const cmd of filtered) {
      const group = cmd.group || 'Other';
      if (!g[group]) g[group] = [];
      g[group].push(cmd);
    }
    return g;
  }, [filtered]);

  const run = useCallback((cmd) => {
    cmd.action?.();
    onClose();
  }, [onClose]);

  // Keyboard navigation
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n') || (e.ctrlKey && e.key === 'j')) {
        e.preventDefault();
        setActiveIdx(i => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p') || (e.ctrlKey && e.key === 'k')) {
        e.preventDefault();
        setActiveIdx(i => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = filtered[activeIdx];
        if (cmd) run(cmd);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, filtered, activeIdx, run, onClose]);

  // Scroll active into view
  useEffect(() => {
    if (!listRef.current) return;
    const activeEl = listRef.current.querySelector(`[data-idx="${activeIdx}"]`);
    activeEl?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  // Clamp active idx when filtered list shrinks
  useEffect(() => { setActiveIdx(0); }, [query]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
            className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm"
          />
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="fixed top-[15vh] left-1/2 -translate-x-1/2 z-[101] w-full max-w-xl glossy-elevated overflow-hidden"
          >
            {/* Search input */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
              <Search className="size-4 text-fg-subtle shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Type a command or search…"
                className="flex-1 bg-transparent text-sm text-fg placeholder-fg-subtle focus:outline-none"
              />
              <kbd className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-fg-muted font-mono">ESC</kbd>
            </div>

            {/* Results */}
            <div ref={listRef} className="max-h-[50vh] overflow-y-auto p-2">
              {filtered.length === 0 ? (
                <div className="py-12 text-center text-sm text-fg-muted">No results for "{query}"</div>
              ) : (
                Object.entries(grouped).map(([group, cmds]) => (
                  <div key={group} className="mb-1">
                    <div className="px-3 pt-2 pb-1 text-[10px] font-semibold text-fg-subtle uppercase tracking-wider">{group}</div>
                    {cmds.map((cmd) => {
                      const idx = filtered.indexOf(cmd);
                      const active = idx === activeIdx;
                      const Icon = cmd.icon;
                      return (
                        <button
                          key={cmd.id}
                          data-idx={idx}
                          onMouseEnter={() => setActiveIdx(idx)}
                          onClick={() => run(cmd)}
                          className={cn(
                            'w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors',
                            active ? 'bg-accent-subtle text-fg' : 'text-fg hover:bg-muted/50',
                          )}
                        >
                          {Icon && <Icon className={cn('size-4 shrink-0', active ? 'text-accent' : 'text-fg-muted')} />}
                          <div className="flex-1 min-w-0">
                            <div className="text-sm truncate">{cmd.label}</div>
                            {cmd.sub && <div className="text-[11px] text-fg-muted truncate">{cmd.sub}</div>}
                          </div>
                          {cmd.shortcut && (
                            <kbd className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-fg-muted font-mono shrink-0">{cmd.shortcut}</kbd>
                          )}
                          {active && <ArrowRight className="size-3.5 text-accent shrink-0" />}
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between px-4 py-2 border-t border-border bg-muted/30 text-[10px] text-fg-muted">
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1">
                  <kbd className="px-1.5 py-0.5 rounded bg-surface border border-border font-mono">↑↓</kbd> Navigate
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="px-1.5 py-0.5 rounded bg-surface border border-border font-mono">↵</kbd> Select
                </span>
              </div>
              <div className="flex items-center gap-1">
                <CmdIcon className="size-3" />
                <span>Command Palette</span>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
