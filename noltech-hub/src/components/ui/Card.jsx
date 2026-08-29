// ─── Card ─────────────────────────────────────────────────────────────────────
// Per Layered Precision design spec:
//   - radius 8/12/16 only — never odd numbers
//   - 1px subtle border, white/surface bg, optional 2px gradient top accent
//   - 32px padding by default ("xl"), 24px alternative ("lg")
//   - Hover: border slightly more visible, translateY(-2px), soft shadow
//
// Props:
//   padding   — none | sm | md | lg | xl   (xl = spec default 32px)
//   radius    — md (12px) | lg (16px) | xl (20px)
//   hover     — bool: enable card-hover transition
//   featured  — bool: brand-gradient 2px top accent
//   elevated  — bool: bigger shadow

import { cn } from './cn';

const paddings = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-6',  // 24px
  xl: 'p-8',  // 32px — spec default
};

const radii = {
  md: 'rounded-xl',     // 12px
  lg: 'rounded-2xl',    // 16px
  xl: 'rounded-[20px]', // 20px for hero/feature cards
};

export default function Card({
  as: Tag = 'div',
  padding = 'md',
  radius = 'lg',
  hover = false,
  featured = false,
  elevated = false,
  className = '',
  children,
  ...rest
}) {
  return (
    <Tag
      className={cn(
        'glossy-card relative',
        paddings[padding],
        radii[radius],
        hover && 'card-hover',
        featured && 'brand-accent-top',
        elevated && 'shadow-glow-lg',
        className
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export function CardHeader({ title, subtitle, action, className = '' }) {
  return (
    <div className={cn('flex items-start justify-between gap-3 mb-3', className)}>
      <div className="min-w-0">
        {title && <h3 className="text-base font-semibold text-fg tracking-tight truncate">{title}</h3>}
        {subtitle && <p className="text-xs text-fg-muted mt-0.5">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
