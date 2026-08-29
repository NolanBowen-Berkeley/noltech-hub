// ─── EmptyState ─────────────────────────────────────────────────────────────
// Per Layered Precision design spec section 6:
// - Centered in available space
// - 60-80px stroked icon, single brand color
// - 18px / 600 title — describes what's missing
// - 14px muted description — explains why
// - One primary CTA button — the action that resolves it

import { Inbox } from 'lucide-react';
import { cn } from './ui/cn';

export default function EmptyState({
  icon: Icon = Inbox,
  title = 'Nothing to show yet',
  description = '',
  action = null,
  actionLabel = '',
  secondaryAction = null,
  secondaryLabel = '',
  className = '',
  size = 'md', // 'sm' | 'md' | 'lg'
}) {
  const iconBox = size === 'sm' ? 'size-12' : size === 'lg' ? 'size-20' : 'size-16';
  const iconSize = size === 'sm' ? 'size-5' : size === 'lg' ? 'size-9' : 'size-7';
  const titleClass = size === 'sm' ? 'text-sm font-semibold' : 'text-[18px] font-semibold';
  const pad = size === 'sm' ? 'py-10 px-6' : 'py-16 px-6';

  return (
    <div className={cn(
      'flex flex-col items-center justify-center text-center',
      'rounded-2xl border border-dashed border-border bg-surface/40',
      pad,
      className,
    )}>
      {/* Icon — stroked, single brand color, slightly tinted background ring */}
      <div className={cn(
        iconBox,
        'rounded-2xl flex items-center justify-center mb-4',
        'bg-accent-subtle ring-1 ring-accent/15',
      )}>
        <Icon className={cn(iconSize, 'text-accent')} strokeWidth={1.5} />
      </div>

      <h3 className={cn(titleClass, 'text-fg tracking-subheading mb-1.5')}>{title}</h3>

      {description && (
        <p className="text-[14px] text-fg-muted max-w-md leading-relaxed">
          {description}
        </p>
      )}

      {(action && actionLabel) || (secondaryAction && secondaryLabel) ? (
        <div className="mt-6 flex items-center gap-2">
          {action && actionLabel && (
            <button
              onClick={action}
              className="btn-accent inline-flex items-center px-4 h-9 rounded-lg text-[13px] font-semibold"
            >
              {actionLabel}
            </button>
          )}
          {secondaryAction && secondaryLabel && (
            <button
              onClick={secondaryAction}
              className="inline-flex items-center px-4 h-9 rounded-lg text-[13px] font-medium text-fg-muted hover:text-fg hover:bg-muted transition-colors"
            >
              {secondaryLabel}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
