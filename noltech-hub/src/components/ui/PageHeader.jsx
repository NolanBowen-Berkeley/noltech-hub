// ─── Page Header ──────────────────────────────────────────────────────────────
// Dense, single-row by default: title + inline subtitle (hidden on narrow) + actions right-aligned.
// Pass `stacked` to get the taller two-line variant if you actually need it.

import { cn } from './cn';

export default function PageHeader({ title, subtitle, actions, children, stacked = false, className = '' }) {
  if (stacked) {
    return (
      <div className={cn('mb-4', className)}>
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl md:text-2xl font-semibold text-fg tracking-tight">{title}</h1>
            {subtitle && <p className="text-sm text-fg-muted mt-0.5 max-w-2xl">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </div>
        {children}
      </div>
    );
  }

  return (
    <div className={cn('mb-3 flex items-center justify-between gap-4 flex-wrap', className)}>
      <div className="flex items-baseline gap-3 min-w-0 flex-wrap">
        <h1 className="text-xl md:text-2xl font-semibold text-fg tracking-tight truncate">{title}</h1>
        {subtitle && <p className="text-xs text-fg-muted hidden md:block truncate max-w-[40ch]">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      {children}
    </div>
  );
}
