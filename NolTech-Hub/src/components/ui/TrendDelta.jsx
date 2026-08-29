// ─── TrendDelta ───────────────────────────────────────────────────────────────
// Badge showing +X% / −X% or $+/-$ vs. a previous value. Colors by direction.
// Props:
//   current  — number (required)
//   previous — number (required)
//   format   — 'pct' | 'money' | 'count' (default 'pct')
//   fmtMoney — callback for money formatting (e.g. fmt from formatters)
//   size     — 'xs' | 'sm' (default 'xs')
//   inverseGood — when true, down is good (e.g. for fees/expenses)

import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { cn } from './cn';

export default function TrendDelta({
  current,
  previous,
  format = 'pct',
  fmtMoney,
  size = 'xs',
  inverseGood = false,
  className = '',
}) {
  const cur  = Number(current)  || 0;
  const prev = Number(previous) || 0;

  if (!isFinite(cur) || !isFinite(prev) || prev === 0) {
    return <span className={cn('text-fg-subtle inline-flex items-center gap-0.5', className)}>
      <Minus className="size-3" />
    </span>;
  }

  const diff = cur - prev;
  const pct  = (diff / Math.abs(prev)) * 100;
  const isZero = Math.abs(pct) < 0.5;
  const isUp   = diff > 0;
  const good   = inverseGood ? !isUp : isUp;

  const color = isZero ? 'text-fg-muted' : good ? 'text-success' : 'text-danger';
  const Icon  = isZero ? Minus : isUp ? TrendingUp : TrendingDown;

  let label;
  if (format === 'money' && fmtMoney) {
    label = (isUp ? '+' : '') + fmtMoney(diff);
  } else if (format === 'count') {
    label = (isUp ? '+' : '') + Math.round(diff).toLocaleString();
  } else {
    label = (isUp ? '+' : '') + Math.abs(pct).toFixed(isZero ? 0 : pct < 10 ? 1 : 0) + '%';
    if (!isUp && !isZero) label = '−' + label.slice(1);
  }

  const sizeCls = size === 'sm' ? 'text-xs' : 'text-[11px]';

  return (
    <span className={cn('inline-flex items-center gap-0.5 font-medium tabular-nums', color, sizeCls, className)}>
      <Icon className="size-3" />
      {label}
    </span>
  );
}
