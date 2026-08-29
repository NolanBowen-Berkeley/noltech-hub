// ─── Tabs ─────────────────────────────────────────────────────────────────────
// Pill-style tab bar with animated indicator (Framer Motion layoutId).
// Pass items as [{id, label, count?, icon?}].

import { useId } from 'react';
import { motion } from 'framer-motion';
import { cn } from './cn';

export default function Tabs({ items, value, onChange, size = 'md', className = '' }) {
  const layoutId = useId();
  const sizeCls = {
    sm: 'text-xs px-3 py-1.5 gap-1.5 [&_svg]:size-3.5',
    md: 'text-sm px-4 py-2 gap-2 [&_svg]:size-4',
  }[size];

  return (
    <div className={cn(
      'inline-flex items-center gap-1 p-1 rounded-xl bg-muted border border-border-subtle',
      className,
    )}>
      {items.map((item) => {
        const active = item.id === value;
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            onClick={() => onChange(item.id)}
            className={cn(
              'relative inline-flex items-center rounded-lg font-medium transition-colors',
              sizeCls,
              active ? 'text-fg' : 'text-fg-muted hover:text-fg',
            )}
          >
            {active && (
              <motion.span
                layoutId={`tab-indicator-${layoutId}`}
                className="absolute inset-0 bg-surface shadow-glow-sm rounded-lg border border-border-subtle"
                transition={{ type: 'spring', stiffness: 380, damping: 30 }}
              />
            )}
            <span className="relative inline-flex items-center gap-1.5">
              {Icon && <Icon />}
              {item.label}
              {item.count != null && (
                <span className={cn(
                  'inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-md text-[10px] font-semibold',
                  active ? 'bg-accent text-accent-fg' : 'bg-border text-fg-muted',
                )}>
                  {item.count}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
