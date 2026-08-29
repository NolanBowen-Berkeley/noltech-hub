// ─── FilterBar ──────────────────────────────────────────────────────────────
// 56px filter / control row per Layered Precision design spec:
//
//   ┌────────────────────────────────────────────────────────────────────┐
//   │  [ Search ]  [ Chip ] [ Chip ]            [ View toggle ] [ Sort ] │
//   └────────────────────────────────────────────────────────────────────┘
//
// - Search input on the left (300-400px wide)
// - Filter chips/dropdowns in the middle
// - View toggles + sort on the right
// - 16px gap, all elements 36px tall for alignment
//
// This is a layout primitive — caller provides children. Use the slot props
// (left/middle/right) for predictable spacing, or pass `children` for full
// control. The three-slot form is the recommended path.

import { Search } from 'lucide-react';
import { cn } from './cn';

export default function FilterBar({
  searchValue,
  onSearchChange,
  searchPlaceholder = 'Search…',
  middle,    // ReactNode — filter chips, dropdowns
  right,     // ReactNode — view toggles, sort
  children,  // fallback — render anything as the whole bar
  className,
}) {
  if (children) {
    return (
      <div className={cn('filter-bar flex items-center gap-4 py-3', className)}>
        {children}
      </div>
    );
  }

  return (
    <div className={cn('filter-bar flex items-center gap-4 py-3', className)}>
      {/* Search */}
      {onSearchChange && (
        <div className="relative w-full max-w-[360px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-fg-subtle pointer-events-none" />
          <input
            type="text"
            value={searchValue ?? ''}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder}
            className={cn(
              'w-full h-9 pl-8 pr-3 rounded-lg',
              'bg-recessed border border-border text-[13px] text-fg placeholder:text-fg-subtle',
              'focus:outline-none focus:border-border-active focus:ring-2 focus:ring-accent-ring',
              'transition-colors',
            )}
          />
        </div>
      )}

      {/* Middle — chips, dropdowns */}
      {middle && (
        <div className="flex items-center gap-2 min-w-0 overflow-x-auto">
          {middle}
        </div>
      )}

      {/* Right — view toggles, sort, action affordances */}
      {right && (
        <div className="flex items-center gap-2 ml-auto shrink-0">
          {right}
        </div>
      )}
    </div>
  );
}

// ─── FilterChip ─────────────────────────────────────────────────────────
// Toggleable pill used inside a FilterBar's middle slot.
export function FilterChip({ active, onClick, children, count, className }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-[13px] font-medium',
        'border transition-colors duration-150 whitespace-nowrap',
        active
          ? 'bg-accent-subtle border-accent/30 text-accent'
          : 'bg-surface border-border text-fg-muted hover:text-fg hover:border-border-strong',
        className,
      )}
    >
      {children}
      {count != null && (
        <span className={cn(
          'inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-mono tabular-nums',
          active ? 'bg-accent text-accent-fg' : 'bg-muted text-fg-muted',
        )}>
          {count}
        </span>
      )}
    </button>
  );
}

// ─── FilterDivider ──────────────────────────────────────────────────────
// Thin vertical separator between chip groups.
export function FilterDivider() {
  return <span className="inline-block w-px h-5 bg-border" aria-hidden />;
}
