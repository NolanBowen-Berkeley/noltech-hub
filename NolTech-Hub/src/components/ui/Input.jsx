// ─── Input / Textarea ─────────────────────────────────────────────────────────
// Consistent text field with optional leading icon and error state.

import { forwardRef } from 'react';
import { cn } from './cn';

const base =
  'w-full bg-surface text-fg placeholder-fg-subtle ' +
  'border border-border rounded-lg ' +
  'transition-all duration-150 ease-out-expo ' +
  'hover:border-border-strong ' +
  'focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent-ring/50 focus:hover:border-accent ' +
  'disabled:opacity-60 disabled:cursor-not-allowed';

const sizes = {
  sm: 'text-xs px-2.5 py-1.5',
  md: 'text-sm px-3 py-2',
  lg: 'text-sm px-4 py-2.5',
};

export const Input = forwardRef(function Input(
  { size = 'md', leadingIcon: Icon, error, className = '', ...rest },
  ref,
) {
  if (Icon) {
    return (
      <div className="relative">
        <Icon className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle pointer-events-none size-4" />
        <input
          ref={ref}
          className={cn(base, sizes[size], 'pl-9', error && 'border-danger focus:border-danger focus:ring-danger/30', className)}
          {...rest}
        />
      </div>
    );
  }
  return (
    <input
      ref={ref}
      className={cn(base, sizes[size], error && 'border-danger focus:border-danger focus:ring-danger/30', className)}
      {...rest}
    />
  );
});

export const Textarea = forwardRef(function Textarea(
  { error, className = '', rows = 3, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(base, 'text-sm px-3 py-2 resize-y', error && 'border-danger focus:border-danger focus:ring-danger/30', className)}
      {...rest}
    />
  );
});

export function Label({ htmlFor, children, hint, required, className = '' }) {
  return (
    <div className={cn('flex items-center justify-between mb-1.5', className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-fg-muted">
        {children}
        {required && <span className="text-danger ml-0.5">*</span>}
      </label>
      {hint && <span className="text-[10px] text-fg-subtle">{hint}</span>}
    </div>
  );
}

export function FieldError({ children }) {
  if (!children) return null;
  return <p className="text-xs text-danger mt-1">{children}</p>;
}
