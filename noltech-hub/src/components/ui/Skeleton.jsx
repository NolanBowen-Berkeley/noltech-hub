// ─── Skeleton ────────────────────────────────────────────────────────────────
// Pulse-loading placeholder for skeleton screens. Per project convention,
// loading states use these instead of spinners.

import { cn } from './cn';

export default function Skeleton({ className = '' }) {
  return <div className={cn('animate-pulse bg-muted rounded', className)} />;
}

export function SkeletonText({ lines = 3, className = '' }) {
  return (
    <div className={cn('space-y-2', className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          className={cn('h-3', i === lines - 1 ? 'w-2/3' : 'w-full')}
        />
      ))}
    </div>
  );
}

export function SkeletonCard({ className = '' }) {
  return (
    <div className={cn('p-4 space-y-3', className)}>
      <Skeleton className="h-5 w-3/5" />
      <SkeletonText lines={2} />
      <Skeleton className="h-8 w-1/3" />
    </div>
  );
}
