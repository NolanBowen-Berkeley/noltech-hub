// ─── MetricTile ─────────────────────────────────────────────────────────────
// Bento-grid metric tile per Layered Precision design spec section 3 (Dashboard).
// Pattern: 12-column grid, tiles span 3/4/6/8/12 cols. Each tile:
//   - 14px muted label top-left
//   - big number / chart in the middle (hero-num class)
//   - 12px context line bottom
//
// Props:
//   label       — small muted top-line   (string)
//   value       — primary content        (ReactNode — usually a number)
//   delta       — optional trend         ({ value: '+12%', direction: 'up'|'down'|'flat' })
//   hint        — bottom context line    (string)
//   icon        — top-right icon         (lucide component)
//   intent      — color theme for delta  ('neutral'|'success'|'danger'|'warning'|'info'|'accent')
//   featured    — boolean: brand-gradient top accent
//   onClick     — optional click handler (makes the whole tile clickable)
//   children    — optional override slot for chart/sparkline placement

import { ArrowDown, ArrowRight, ArrowUp } from 'lucide-react';
import { cn } from './cn';

const intentClasses = {
  neutral: 'text-fg-muted',
  success: 'text-success',
  danger:  'text-danger',
  warning: 'text-warning',
  info:    'text-info',
  accent:  'text-accent',
};

export default function MetricTile({
  label,
  value,
  delta,
  hint,
  icon: Icon,
  intent = 'neutral',
  featured = false,
  onClick,
  className,
  span,            // for grid span helpers — e.g. "md:col-span-6"
  children,
}) {
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp
      onClick={onClick}
      className={cn(
        'glossy-card relative text-left',
        featured && 'brand-accent-top',
        'rounded-2xl p-5 md:p-6',
        'transition-all duration-200 ease-out-expo',
        onClick && 'card-hover cursor-pointer',
        span,
        className,
      )}
    >
      {/* Header: label + icon */}
      <div className="flex items-start justify-between gap-3 mb-3">
        {label && (
          <span className="ui-eyebrow text-fg-subtle">{label}</span>
        )}
        {Icon && (
          <span className="size-7 -mt-0.5 -mr-1 rounded-lg bg-muted/60 flex items-center justify-center text-fg-muted shrink-0">
            <Icon className="size-3.5" strokeWidth={1.6} />
          </span>
        )}
      </div>

      {/* Value — hero-num for tabular tightening */}
      {value !== undefined && value !== null && (
        <div className="hero-num text-[28px] md:text-[32px] leading-none text-fg">
          {value}
        </div>
      )}

      {children}

      {/* Delta + hint row */}
      {(delta || hint) && (
        <div className="mt-3 flex items-center gap-2 text-[12px]">
          {delta && (
            <span className={cn(
              'inline-flex items-center gap-1 font-medium tabular-nums',
              intentClasses[intent],
            )}>
              {delta.direction === 'up' && <ArrowUp className="size-3" />}
              {delta.direction === 'down' && <ArrowDown className="size-3" />}
              {delta.direction === 'flat' && <ArrowRight className="size-3" />}
              {delta.value}
            </span>
          )}
          {hint && (
            <span className="text-fg-subtle truncate">{hint}</span>
          )}
        </div>
      )}
    </Comp>
  );
}
