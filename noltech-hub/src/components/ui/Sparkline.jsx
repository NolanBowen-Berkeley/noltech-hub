// ─── Sparkline ────────────────────────────────────────────────────────────────
// Tiny inline chart. No axes, no labels. Use for context on a single number.
// Props:
//   data        — array of numbers (required)
//   color       — CSS color (default: accent)
//   width       — px (default 64)
//   height      — px (default 16)
//   fill        — fill under the line with a subtle gradient (default true)
//   dot         — show a dot on the last point (default true)

import { useMemo, useId } from 'react';

export default function Sparkline({
  data = [],
  color = 'var(--accent)',
  width = 64,
  height = 16,
  fill = true,
  dot = true,
  className = '',
}) {
  const id = useId();

  const d = useMemo(() => {
    const clean = (data || []).filter((n) => typeof n === 'number' && isFinite(n));
    if (clean.length < 2) return null;

    const min = Math.min(...clean);
    const max = Math.max(...clean);
    const range = max - min || 1;
    const padY = 1.5; // top/bottom padding so lines don't clip
    const stepX = width / (clean.length - 1);

    const points = clean.map((v, i) => {
      const x = i * stepX;
      const y = height - padY - ((v - min) / range) * (height - padY * 2);
      return { x, y, v };
    });

    const linePath = points
      .map((p, i) => (i === 0 ? `M ${p.x.toFixed(1)} ${p.y.toFixed(1)}` : `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`))
      .join(' ');

    const fillPath = `${linePath} L ${width} ${height} L 0 ${height} Z`;
    const last = points[points.length - 1];
    return { linePath, fillPath, last, count: points.length };
  }, [data, width, height]);

  if (!d) {
    // Fallback: show a faint horizontal line so the slot doesn't collapse
    return (
      <svg width={width} height={height} className={className} aria-hidden>
        <line x1="0" y1={height / 2} x2={width} y2={height / 2}
              stroke="var(--border)" strokeWidth="1" strokeDasharray="2 2" />
      </svg>
    );
  }

  const gradientId = `spark-grad-${id}`;

  return (
    <svg width={width} height={height} className={className} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden>
      {fill && (
        <>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"  stopColor={color} stopOpacity="0.22" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={d.fillPath} fill={`url(#${gradientId})`} />
        </>
      )}
      <path d={d.linePath} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      {dot && (
        <circle cx={d.last.x} cy={d.last.y} r="2" fill={color}
                stroke="var(--surface)" strokeWidth="1" />
      )}
    </svg>
  );
}
