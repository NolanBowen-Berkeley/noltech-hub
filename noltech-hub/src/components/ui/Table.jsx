// ─── Table ────────────────────────────────────────────────────────────────────
// Consistent table primitives. Zebra rows, sticky header, row hover.
// Compose freely: <Table><THead><TR>...</TR></THead><TBody>...</TBody></Table>

import { cn } from './cn';

export function Table({ className = '', children }) {
  return (
    <div className="relative overflow-auto rounded-xl border border-border bg-surface">
      <table className={cn('w-full text-sm', className)}>{children}</table>
    </div>
  );
}

export function THead({ className = '', sticky = false, children }) {
  return (
    <thead className={cn(
      'bg-muted/60 backdrop-blur-sm',
      sticky && 'sticky top-0 z-10',
      className,
    )}>
      {children}
    </thead>
  );
}

export function TBody({ className = '', children }) {
  return <tbody className={cn('divide-y divide-border-subtle', className)}>{children}</tbody>;
}

export function TR({ className = '', onClick, children, ...rest }) {
  return (
    <tr
      onClick={onClick}
      className={cn(
        onClick && 'row-hover',
        className,
      )}
      {...rest}
    >
      {children}
    </tr>
  );
}

export function TH({ className = '', children, ...rest }) {
  return (
    <th
      className={cn(
        'px-3 py-2 text-left text-[10px] font-semibold text-fg-muted uppercase tracking-wider',
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

export function TD({ className = '', mono = false, children, ...rest }) {
  return (
    <td
      className={cn(
        'px-3 py-2 text-fg text-sm',
        mono && 'font-mono tabular-nums',
        className,
      )}
      {...rest}
    >
      {children}
    </td>
  );
}
