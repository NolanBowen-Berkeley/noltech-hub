// ─── FlashOnChange ────────────────────────────────────────────────────────────
// Wraps a value; when that value changes, briefly highlights the container
// yellow → transparent. Used for cell updates (price changes, status flips).
//
// Usage:
//   <FlashOnChange value={item.price}>
//     {fmt(item.price)}
//   </FlashOnChange>

import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { cn } from './cn';

export default function FlashOnChange({ value, className = '', children }) {
  const reduce = useReducedMotion();
  const firstRun = useRef(true);
  const [flashKey, setFlashKey] = useState(0);

  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    if (reduce) return;
    setFlashKey(k => k + 1);
  }, [value, reduce]);

  return (
    <motion.span
      key={flashKey}
      initial={flashKey === 0 ? false : { backgroundColor: 'rgba(251, 191, 36, 0.35)' }}
      animate={{ backgroundColor: 'rgba(251, 191, 36, 0)' }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      className={cn('inline-block rounded px-0.5 -mx-0.5', className)}
    >
      {children}
    </motion.span>
  );
}
