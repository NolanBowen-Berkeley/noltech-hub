// ─── Select ───────────────────────────────────────────────────────────────────
// Native select styled to match Input. Custom chevron, accessible.

import { forwardRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from './cn';

const sizes = {
  sm: 'text-xs pl-2.5 pr-8 py-1.5',
  md: 'text-sm pl-3 pr-9 py-2',
  lg: 'text-sm pl-4 pr-10 py-2.5',
};

const Select = forwardRef(function Select(
  { size = 'md', error, className = '', children, ...rest },
  ref,
) {
  return (
    <div className="relative">
      <select
        ref={ref}
        className={cn(
          'w-full appearance-none bg-surface text-fg ' +
          'border border-border rounded-lg cursor-pointer ' +
          'transition-all duration-150 ease-out-expo ' +
          'hover:border-border-strong ' +
          'focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent-ring/50 ' +
          'disabled:opacity-60 disabled:cursor-not-allowed',
          sizes[size],
          error && 'border-danger focus:border-danger focus:ring-danger/30',
          className,
        )}
        {...rest}
      >
        {children}
      </select>
      <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 size-4 text-fg-subtle pointer-events-none" />
    </div>
  );
});

export default Select;
