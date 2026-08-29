// ─── Badge ────────────────────────────────────────────────────────────────────
// Status pill. Subtle-fill variant by default, solid for high emphasis.

import { cn } from './cn';

const variants = {
  neutral: 'bg-muted text-fg-muted border-border',
  accent:  'bg-accent-subtle text-accent border-accent/20',
  success: 'bg-success-subtle text-success-fg border-success/20',
  danger:  'bg-danger-subtle text-danger-fg border-danger/20',
  warning: 'bg-warning-subtle text-warning-fg border-warning/20',
  info:    'bg-info-subtle text-info-fg border-info/20',
  // Solid variants for higher emphasis
  'solid-accent':  'bg-accent text-accent-fg',
  'solid-success': 'bg-success text-white',
  'solid-danger':  'bg-danger text-white',
  'solid-warning': 'bg-warning text-white',
};

const sizes = {
  xs: 'text-[10px] px-1.5 py-0.5 rounded-md',
  sm: 'text-xs px-2 py-0.5 rounded-md',
  md: 'text-xs px-2.5 py-1 rounded-lg',
};

export default function Badge({ variant = 'neutral', size = 'sm', icon: Icon, className = '', children, ...rest }) {
  const isSolid = variant.startsWith('solid-');
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 font-medium whitespace-nowrap',
        !isSolid && 'border',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {Icon && <Icon className="size-3" />}
      {children}
    </span>
  );
}
