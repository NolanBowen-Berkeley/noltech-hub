// ─── Sidebar ──────────────────────────────────────────────────────────────────
// Glossy dark sidebar with animated active-pill indicator, collapsible,
// persists collapsed state, keyboard-navigable.

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  LayoutDashboard, Package, ChevronLeft, ChevronRight,
  ScanSearch, DollarSign, Gavel, ShoppingCart,
  Cog, Lock, Briefcase,
} from 'lucide-react';
import { canAccess } from '../services/tiers';
import UpgradePrompt from './UpgradePrompt';
import AboutModal from './AboutModal';
import { cn } from './ui/cn';

const NAV_ITEMS = [
  { id: 'hub',        label: 'Dashboard',        icon: LayoutDashboard },
  { id: 'source',     label: 'Source',           icon: ScanSearch },
  { id: 'bidding',    label: 'Bid & Buy',        icon: Gavel },
  { id: 'inventory',  label: 'Inventory',        icon: Package },
  { id: 'operations', label: 'Operations',       icon: Briefcase },
  { id: 'sell',       label: 'Sell',             icon: ShoppingCart },
  { id: 'finance',    label: 'Profit & Finance', icon: DollarSign },
  { id: 'settings',   label: 'Settings',         icon: Cog },
];

const COLLAPSED_KEY = 'noltech:ui:sidebar-collapsed';

export default function Sidebar({ view, setView, stats }) {
  const [collapsed, setCollapsed] = useState(false);
  const [upgradeFeature, setUpgradeFeature] = useState(null);
  const [showAbout, setShowAbout] = useState(false);

  useEffect(() => {
    window.storage.get(COLLAPSED_KEY)
      .then(v => { if (typeof v === 'boolean') setCollapsed(v); })
      .catch(e => console.error('[sidebar] storage error:', e));
  }, []);

  // Expose sidebar width to main content via CSS var (set only on md+ screens via media query)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const apply = () => {
      document.documentElement.style.setProperty(
        '--sidebar-w',
        mq.matches ? (collapsed ? '4rem' : '14rem') : '0px',
      );
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [collapsed]);

  const toggle = () => {
    setCollapsed(c => {
      const next = !c;
      window.storage.set(COLLAPSED_KEY, next).catch(e => console.error('[sidebar] storage error:', e));
      return next;
    });
  };

  const handleLockedClick = (id, name) => setUpgradeFeature({ id, name });

  return (
    <>
      {upgradeFeature && (
        <UpgradePrompt
          featureId={upgradeFeature.id}
          featureName={upgradeFeature.name}
          onClose={() => setUpgradeFeature(null)}
        />
      )}

      <AboutModal open={showAbout} onClose={() => setShowAbout(false)} />

      {/* Desktop sidebar — glossy dark surface */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 hidden md:flex flex-col',
          'transition-[width] duration-300 ease-out-expo',
          'border-r border-border',
          collapsed ? 'w-16' : 'w-56',
        )}
        style={{
          background:
            'linear-gradient(180deg, var(--bg) 0%, color-mix(in srgb, var(--bg) 80%, var(--surface)) 100%)',
        }}
      >
        {/* Brand gradient mesh — soft, blurred behind nav for signature accent */}
        <div
          className="absolute inset-x-0 top-0 h-48 pointer-events-none opacity-40"
          style={{
            background: 'var(--brand-gradient-soft)',
            filter: 'blur(60px) saturate(1.1)',
            mixBlendMode: 'screen',
          }}
        />

        {/* Brand header — gradient mark per spec */}
        <div className={cn(
          'relative flex items-center gap-2.5 border-b border-border',
          collapsed ? 'px-4 py-3 justify-center' : 'px-5 py-3.5',
        )}>
          <div className={cn(
            'size-8 rounded-lg bg-brand-gradient flex items-center justify-center shrink-0',
            'shadow-[0_2px_10px_-2px_rgb(123_97_255_/_0.5),inset_0_1px_0_0_rgb(255_255_255_/_0.25)]',
          )}>
            <span className="text-white font-bold text-sm tracking-tight">N</span>
          </div>
          {!collapsed && (
            <div className="flex-1 min-w-0">
              <span className="block text-[15px] font-semibold text-fg tracking-tight">NolTech</span>
              <span className="block text-[10px] text-fg-subtle uppercase tracking-[0.15em] mt-0.5">Hub</span>
            </div>
          )}
        </div>

        {/* Nav */}
        <nav className="relative flex-1 py-2.5 overflow-y-auto overflow-x-hidden">
          <div className={cn('space-y-0.5', collapsed ? 'px-2' : 'px-3')}>
            {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
              const active = view === id;
              const locked = !canAccess(id);
              return (
                <button
                  key={id}
                  onClick={() => locked ? handleLockedClick(id, label) : setView(id)}
                  title={collapsed ? (locked ? `${label} (locked)` : label) : undefined}
                  className={cn(
                    'relative w-full flex items-center gap-3 rounded-lg text-left',
                    'text-[13px] font-medium transition-colors duration-150',
                    collapsed ? 'justify-center h-9' : 'px-3 h-9',
                    locked
                      ? 'text-fg-subtle/60 cursor-not-allowed'
                      : active
                        ? 'text-fg'
                        : 'text-fg-muted hover:text-fg',
                  )}
                >
                  {active && !locked && (
                    <>
                      <motion.span
                        layoutId="sidebar-active-pill"
                        className="absolute inset-0 rounded-lg bg-surface border border-border shadow-glow-sm"
                        transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                      />
                      {/* 2px brand-gradient left accent bar per spec */}
                      <motion.span
                        layoutId="sidebar-active-accent"
                        className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-r bg-brand-gradient"
                        transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                      />
                    </>
                  )}
                  <Icon className={cn('relative size-[18px] shrink-0', locked ? 'opacity-40' : active ? 'text-fg' : '')} />
                  {!collapsed && (
                    <>
                      <span className={cn('relative flex-1 truncate', active ? 'font-semibold' : '')}>{label}</span>
                      {locked && <Lock className="relative size-3 opacity-50" />}
                    </>
                  )}
                </button>
              );
            })}
          </div>
        </nav>

        {/* Footer: stats + sync + collapse toggle */}
        <div className="relative border-t border-border/70">
          <AnimatePresence mode="wait" initial={false}>
            {!collapsed && stats && (
              <motion.div
                key="stats"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="px-4 pt-2 pb-1.5 flex items-center justify-between text-[10px] font-mono text-fg-subtle"
                title={`${stats.lots} lots · ${stats.available} available · ${stats.sold} sold`}
              >
                <span className="flex items-center gap-1"><span className="text-fg">{stats.lots}</span>lots</span>
                <span className="flex items-center gap-1"><span className="text-accent">{stats.available}</span>avail</span>
                <span className="flex items-center gap-1"><span className="text-success">{stats.sold}</span>sold</span>
              </motion.div>
            )}
          </AnimatePresence>

          <div className={cn(
            'flex items-center border-t border-border',
            collapsed ? 'flex-col gap-1 p-2' : 'justify-between px-4 py-2.5 gap-2',
          )}>
            <div className="flex items-center gap-1">
              {!collapsed && (
                <button
                  onClick={() => setShowAbout(true)}
                  className="px-1.5 h-7 flex items-center justify-center rounded-md text-fg-subtle hover:text-fg hover:bg-muted transition-colors font-mono text-[10px] tracking-wider uppercase"
                  title="About NolTech Hub"
                >
                  v1.0
                </button>
              )}
              <button
                onClick={() => window.dispatchEvent(new CustomEvent('ui:show-keys'))}
                className="size-7 flex items-center justify-center rounded-md text-fg-subtle hover:text-fg hover:bg-muted transition-colors font-mono text-xs"
                title="Keyboard shortcuts (?)"
              >
                ?
              </button>
            </div>
            <button
              onClick={toggle}
              className={cn(
                'size-7 flex items-center justify-center rounded-md',
                'text-fg-subtle hover:text-fg hover:bg-muted transition-colors',
              )}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {collapsed ? <ChevronRight className="size-3.5" /> : <ChevronLeft className="size-3.5" />}
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile top bar */}
      <div className="md:hidden fixed top-0 inset-x-0 z-50 h-14 px-4 flex items-center gap-2.5 bg-surface/95 backdrop-blur-md border-b border-border">
        <div className="size-7 rounded-md bg-accent-gradient flex items-center justify-center shadow-glow-sm">
          <span className="text-white font-bold text-xs">N</span>
        </div>
        <span className="font-semibold text-fg">NolTech Hub</span>
      </div>

      {/* Mobile bottom tab bar */}
      <div className="md:hidden fixed bottom-0 inset-x-0 z-50 bg-surface/95 backdrop-blur-md border-t border-border flex">
        {[
          { id: 'hub',       label: 'Home',     icon: LayoutDashboard },
          { id: 'source',    label: 'Source',   icon: ScanSearch },
          { id: 'inventory', label: 'Inventory',icon: Package },
          { id: 'sell',      label: 'Sell',     icon: ShoppingCart },
          { id: 'settings',  label: 'Settings', icon: Cog },
        ].map(({ id, label, icon: Icon }) => {
          const locked = !canAccess(id);
          const active = view === id;
          return (
            <button
              key={id}
              onClick={() => locked ? handleLockedClick(id, label) : setView(id)}
              className={cn(
                'flex-1 flex flex-col items-center py-2.5 text-[10px] font-medium transition-colors',
                locked ? 'text-fg-subtle/50' : active ? 'text-accent' : 'text-fg-muted',
              )}
            >
              {locked ? <Lock className="w-5 h-5 mb-0.5" /> : <Icon className="w-5 h-5 mb-0.5" />}
              {label}
            </button>
          );
        })}
      </div>
    </>
  );
}
