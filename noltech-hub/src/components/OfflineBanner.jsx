// ─── Offline Banner ───────────────────────────────────────────────────────────
// Subtle top-of-screen bar that appears when the browser reports offline.
// Doesn't block anything; just informs. Slides in/out gracefully.

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { WifiOff } from 'lucide-react';

export default function OfflineBanner() {
  const [offline, setOffline] = useState(
    typeof navigator !== 'undefined' ? !navigator.onLine : false,
  );

  useEffect(() => {
    const on  = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener('online',  on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online',  on);
      window.removeEventListener('offline', off);
    };
  }, []);

  return (
    <AnimatePresence>
      {offline && (
        <motion.div
          initial={{ y: -40, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -40, opacity: 0 }}
          transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
          className="fixed top-0 inset-x-0 z-[120] pointer-events-none"
          style={{ paddingLeft: 'var(--sidebar-w, 0px)' }}
          role="status"
          aria-live="polite"
        >
          <div className="pointer-events-auto mx-auto max-w-3xl mt-3 px-4">
            <div className="flex items-center gap-3 px-4 py-2.5 rounded-xl glossy-elevated border border-warning/30 bg-warning-subtle">
              <WifiOff className="size-4 text-warning shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-warning-fg">You're offline</p>
                <p className="text-xs text-warning-fg/80">Changes save locally and sync when you reconnect.</p>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
