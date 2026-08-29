// ─── AnimatedNumber ───────────────────────────────────────────────────────────
// Smoothly tweens from previous value to next when the prop changes.
// Respects prefers-reduced-motion (snaps immediately).
//
// Usage:
//   <AnimatedNumber value={123.45} format={fmt} />           // → "$123.45"
//   <AnimatedNumber value={42} />                             // → "42"
//   <AnimatedNumber value={0.135} format={(v) => `${(v*100).toFixed(1)}%`} />

import { useEffect, useState } from 'react';
import { animate, useMotionValue, useReducedMotion } from 'framer-motion';

export default function AnimatedNumber({
  value,
  format = (v) => Math.round(v).toString(),
  duration = 0.6,
  className = '',
}) {
  const reduce = useReducedMotion();
  const mv = useMotionValue(typeof value === 'number' ? value : 0);
  const [display, setDisplay] = useState(() => format(typeof value === 'number' ? value : 0));

  useEffect(() => {
    if (typeof value !== 'number' || !isFinite(value)) {
      setDisplay(format(0));
      return;
    }
    if (reduce) {
      mv.set(value);
      setDisplay(format(value));
      return;
    }
    const controls = animate(mv, value, {
      duration,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (latest) => setDisplay(format(latest)),
    });
    return () => controls.stop();
  }, [value, duration, reduce, format, mv]);

  return <span className={className}>{display}</span>;
}
