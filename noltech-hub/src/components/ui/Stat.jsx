// ─── Stat ─────────────────────────────────────────────────────────────────────
// Hero number with label and optional trend/sub. Built for dashboards.
// Numeric values count up via AnimatedNumber.

import { motion } from 'framer-motion';
import { cn } from './cn';
import { TrendingUp, TrendingDown } from 'lucide-react';
import AnimatedNumber from './AnimatedNumber';
import Sparkline from './Sparkline';

export default function Stat({
  label,
  value,
  sub,
  trend,            // { value: number, direction: 'up'|'down', label?: string }
  sparkline,        // array of numbers — adds a tiny trend chart under the value
  icon: Icon,
  intent = 'neutral', // 'accent' | 'success' | 'danger' | 'warning' | 'neutral'
  size = 'md',
  loading = false,
  className = '',
}) {
  const intentCls = {
    neutral: 'text-fg',
    accent:  'text-accent',
    success: 'text-success',
    danger:  'text-danger',
    warning: 'text-warning',
  }[intent];

  const iconBgCls = {
    neutral: 'bg-muted text-fg-muted',
    accent:  'bg-accent-subtle text-accent',
    success: 'bg-success-subtle text-success',
    danger:  'bg-danger-subtle text-danger',
    warning: 'bg-warning-subtle text-warning',
  }[intent];

  const sizeCls = {
    sm: { value: 'text-lg', label: 'text-[10px]', icon: 'size-7 [&_svg]:size-3.5' },
    md: { value: 'text-xl', label: 'text-[10px]', icon: 'size-8 [&_svg]:size-4' },
    lg: { value: 'text-2xl md:text-3xl', label: 'text-[11px]', icon: 'size-10 [&_svg]:size-5' },
  }[size];

  return (
    <div className={cn('flex items-start gap-4 min-w-0', className)}>
      {Icon && (
        <div className={cn('shrink-0 rounded-xl flex items-center justify-center', iconBgCls, sizeCls.icon)}>
          <Icon />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className={cn('font-medium uppercase tracking-wider text-fg-muted', sizeCls.label)}>{label}</p>
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          className={cn('font-semibold font-mono tracking-tight mt-0.5', sizeCls.value, intentCls)}
        >
          {loading
            ? <span className="inline-block w-20 h-[1em] shimmer rounded-md" />
            : typeof value === 'number'
              ? <AnimatedNumber value={value} format={(v) => Math.round(v).toLocaleString()} />
              : value}
        </motion.div>
        <div className="mt-1 flex items-center gap-2 flex-wrap">
          {trend && (
            <span className={cn(
              'inline-flex items-center gap-0.5 text-xs font-medium',
              trend.direction === 'up' ? 'text-success' : 'text-danger'
            )}>
              {trend.direction === 'up' ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
              {trend.value}
              {trend.label && <span className="text-fg-muted font-normal ml-1">{trend.label}</span>}
            </span>
          )}
          {sub && (typeof sub === 'string'
            ? <p className="text-xs text-fg-muted">{sub}</p>
            : <div className="text-xs text-fg-muted">{sub}</div>
          )}
        </div>
        {sparkline && sparkline.length > 1 && (
          <div className="mt-2 -mb-1">
            <Sparkline
              data={sparkline}
              color={
                intent === 'success' ? 'var(--success)'
                : intent === 'danger' ? 'var(--danger)'
                : intent === 'warning' ? 'var(--warning)'
                : intent === 'accent' ? 'var(--accent)'
                : 'var(--fg-muted)'
              }
              width={80}
              height={18}
            />
          </div>
        )}
      </div>
    </div>
  );
}
