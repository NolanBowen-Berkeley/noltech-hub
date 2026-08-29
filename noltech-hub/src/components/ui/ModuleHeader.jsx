// ─── ModuleHeader ───────────────────────────────────────────────────────────
// Standard 96px-ish module header per Layered Precision design spec:
//
//   ┌────────────────────────────────────────────────────────────────────────┐
//   │  EYEBROW                                                               │
//   │  Module Name                              [ Secondary ]  [ Primary ]   │
//   │  One-line description, muted                                           │
//   │  ─────────────────────────────────────────────────────────────────────  │
//   │  Tab 1   Tab 2   Tab 3                                                 │
//   └────────────────────────────────────────────────────────────────────────┘
//
// Constraints from the spec:
// - Max 2 action buttons (third actions go in a menu)
// - Title is H1: 24px / 600 / tight tracking (text-2xl + tracking-heading)
// - Description: 14px muted
// - Optional eyebrow above title for context (uppercase, 11px, tracked)
// - Optional tabs below — they live INSIDE the header card, not as a separate
//   strip, so the bottom border of the header is the separator from content.
//
// Props:
//   title       - string                 (required)
//   description - string                 (optional)
//   eyebrow     - string                 (optional, uppercase)
//   actions     - ReactNode              (optional, render Buttons; cap 2)
//   tabs        - [{ id, label, icon? }] (optional)
//   activeTab   - string id
//   onTabChange - (id) => void

import { motion } from 'framer-motion';
import { cn } from './cn';

export default function ModuleHeader({
  title,
  description,
  eyebrow,
  actions,
  tabs,
  activeTab,
  onTabChange,
  className,
}) {
  return (
    <header className={cn('relative pt-6 pb-4 border-b border-border', className)}>
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          {eyebrow && (
            <p className="ui-eyebrow text-fg-subtle mb-1.5">{eyebrow}</p>
          )}
          <h1 className="text-[24px] font-semibold text-fg leading-tight tracking-heading">
            {title}
          </h1>
          {description && (
            <p className="mt-1.5 text-[14px] text-fg-muted leading-snug max-w-2xl">
              {description}
            </p>
          )}
        </div>
        {actions && (
          <div className="flex items-center gap-2 shrink-0 pt-0.5">
            {actions}
          </div>
        )}
      </div>

      {tabs && tabs.length > 0 && (
        <nav className="mt-5 flex items-end gap-1 -mb-4" aria-label="Module tabs">
          {tabs.map((t) => {
            const active = t.id === activeTab;
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => onTabChange?.(t.id)}
                className={cn(
                  'relative inline-flex items-center gap-1.5 px-3 h-9 text-[13px] font-medium',
                  'transition-colors duration-150',
                  active ? 'text-fg' : 'text-fg-muted hover:text-fg',
                )}
              >
                {Icon && <Icon className="size-3.5" />}
                {t.label}
                {active && (
                  <motion.span
                    layoutId="module-header-tab-underline"
                    className="absolute -bottom-px left-2 right-2 h-[2px] rounded-full bg-accent-gradient"
                    transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                  />
                )}
              </button>
            );
          })}
        </nav>
      )}
    </header>
  );
}
