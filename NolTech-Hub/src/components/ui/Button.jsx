// ─── Button ───────────────────────────────────────────────────────────────────
// Per Layered Precision design spec:
//   - primary:   solid dark fg, white text, inner highlight, soft lift on hover
//   - accent:    brand-gradient + glow (signature CTA — use sparingly)
//   - secondary: transparent w/ 1px border, dark text — neutral default
//   - ghost:     text-only, hover background fill
//   - danger / success: intent-tinted solids
//   - outline:   alias for secondary with transparent fill
//
// Sizes: xs, sm, md, lg. Radius scale follows the spec (8/12 only).
// Icon-only mode when children is a single icon. Loading swaps in a spinner.

import { forwardRef } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from './cn';

const base =
  'inline-flex items-center justify-center gap-2 font-semibold whitespace-nowrap ' +
  'transition-all duration-150 ease-out-expo ' +
  'active:scale-[0.98] ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg ' +
  'disabled:opacity-50 disabled:pointer-events-none select-none';

const sizes = {
  xs: 'text-[12px] h-7 px-2.5 rounded-lg gap-1.5 [&_svg]:size-3.5',
  sm: 'text-[13px] h-8 px-3 rounded-lg [&_svg]:size-3.5',
  md: 'text-[14px] h-9 px-4 rounded-lg [&_svg]:size-4',
  lg: 'text-[14px] h-11 px-5 rounded-xl [&_svg]:size-[18px]',
};

const iconSizes = {
  xs: 'size-7 rounded-lg [&_svg]:size-3.5',
  sm: 'size-8 rounded-lg [&_svg]:size-4',
  md: 'size-9 rounded-lg [&_svg]:size-4',
  lg: 'size-11 rounded-xl [&_svg]:size-[18px]',
};

const variants = {
  // Solid dark — the spec's "primary." Uses fg as the surface so it's
  // theme-aware (near-black in light, near-white in dark inverted).
  primary:
    'bg-fg text-bg shadow-[inset_0_1px_0_0_rgb(255_255_255_/_0.10),0_1px_2px_0_rgb(15_23_42_/_0.10),0_4px_12px_-2px_rgb(15_23_42_/_0.10)] ' +
    'hover:-translate-y-px hover:shadow-[inset_0_1px_0_0_rgb(255_255_255_/_0.14),0_2px_4px_0_rgb(15_23_42_/_0.12),0_8px_24px_-2px_rgb(15_23_42_/_0.18)]',

  // Brand-gradient signature button — for the single most important CTA on
  // a page. Defined via .btn-accent in index.css (lift on hover + glow).
  accent:
    'btn-accent text-accent-fg',
  // Alias for clarity per spec terminology
  gradient:
    'btn-accent text-accent-fg',

  // Neutral fallback — transparent panel with subtle border
  secondary:
    'bg-surface text-fg border border-border shadow-glow-sm ' +
    'hover:bg-muted hover:-translate-y-px active:translate-y-0',

  // Text-only — for tertiary actions, never on primary CTAs
  ghost:
    'text-fg-muted hover:text-fg hover:bg-muted',

  danger:
    'bg-danger text-white shadow-[0_1px_2px_0_rgb(15_23_42_/_0.10),0_4px_12px_-2px_rgb(220_38_38_/_0.30)] ' +
    'hover:bg-danger/90 hover:-translate-y-px',

  success:
    'bg-success text-white shadow-[0_1px_2px_0_rgb(15_23_42_/_0.10),0_4px_12px_-2px_rgb(16_185_129_/_0.30)] ' +
    'hover:bg-success/90 hover:-translate-y-px',

  outline:
    'bg-transparent text-fg border border-border ' +
    'hover:bg-muted hover:border-border-strong',
};

const Button = forwardRef(function Button(
  { variant = 'secondary', size = 'md', iconOnly = false, loading = false, className = '', children, disabled, ...rest },
  ref,
) {
  const sizeCls = iconOnly ? iconSizes[size] : sizes[size];
  return (
    <button
      ref={ref}
      className={cn(base, sizeCls, variants[variant] || variants.secondary, className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 className="animate-spin" /> : children}
    </button>
  );
});

export default Button;
