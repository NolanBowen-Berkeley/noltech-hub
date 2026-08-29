// ─── LazyMount ───────────────────────────────────────────────────────────────
// Defers rendering of children until their placeholder enters the viewport.
// Once mounted, stays mounted (default `keepMounted=true`) so scrolling
// back up doesn't tear down + remount.
//
// Useful for lists of expensive-to-render items where the user only sees a
// handful at a time — Browse Lots cards, inventory rows, manifest tables.
// Reduces initial paint cost and React render work for off-screen items.
//
// Usage:
//   <LazyMount minHeight={420}>
//     <LotCard ... />
//   </LazyMount>

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export default function LazyMount({ children, minHeight = 200, rootMargin = '400px', keepMounted = true, className = '' }) {
  const ref = useRef(null);
  const [mounted, setMounted] = useState(false);

  // Check on every render: if the placeholder is currently in (or near) the
  // viewport, mount immediately. This fires after sort/filter reordering
  // moves placeholders into view — IntersectionObserver alone misses these
  // layout-shift cases.
  useLayoutEffect(() => {
    if (mounted) return;
    const el = ref.current;
    if (!el || typeof window === 'undefined') return;
    const rect = el.getBoundingClientRect();
    const margin = parseInt(rootMargin, 10) || 0;
    if (rect.top < window.innerHeight + margin && rect.bottom > -margin) {
      setMounted(true);
    }
  });

  useEffect(() => {
    if (mounted && keepMounted) return;
    if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') {
      setMounted(true);
      return;
    }
    const el = ref.current;
    if (!el) return;

    const obs = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          setMounted(true);
          if (keepMounted) obs.disconnect();
          return;
        }
        if (!keepMounted) setMounted(false);
      }
    }, { rootMargin, threshold: 0.01 });
    obs.observe(el);
    return () => obs.disconnect();
  }, [keepMounted, mounted, rootMargin]);

  return (
    <div ref={ref} className={className} style={!mounted ? { minHeight } : undefined}>
      {mounted ? children : (
        <div className="rounded-xl border border-border-subtle bg-muted/20 animate-pulse" style={{ minHeight }} />
      )}
    </div>
  );
}
