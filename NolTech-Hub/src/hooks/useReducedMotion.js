// ─── useReducedMotion ─────────────────────────────────────────────────────────
// Framer Motion ships its own, but we also expose a boolean that components
// can use to short-circuit expensive animation setup, and sync a root CSS class
// for legacy @keyframes.

import { useEffect, useState } from 'react';

export default function useReducedMotion() {
  const [reduced, setReduced] = useState(
    typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handler = (e) => {
      setReduced(e.matches);
      document.documentElement.classList.toggle('reduce-motion', e.matches);
    };
    handler(mq);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return reduced;
}
