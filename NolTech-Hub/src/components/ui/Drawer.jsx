// ─── Drawer ────────────────────────────────────────────────────────────────
// Side panel that slides in from the right. Use for detail views that should
// preserve the list beneath them.

import { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { cn } from './cn';
import { modalBackdrop } from './motion';

const WIDTH = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
};

export default function Drawer({
  open,
  onClose,
  title,
  subtitle,
  width = 'md',
  closeOnBackdrop = true,
  showClose = true,
  footer,
  className = '',
  children,
}) {
  // Esc to close
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);

  // Lock body scroll
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            {...modalBackdrop}
            onClick={closeOnBackdrop ? onClose : undefined}
            className="fixed inset-0 z-[92] bg-black/40 backdrop-blur-[2px]"
          />
          <motion.aside
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? 'drawer-title' : undefined}
            className={cn(
              'fixed top-0 right-0 bottom-0 z-[93] w-full flex flex-col',
              'bg-surface border-l border-border shadow-glow-xl',
              WIDTH[width],
              className,
            )}
          >
            {(title || showClose) && (
              <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-border shrink-0">
                <div className="min-w-0">
                  {title && <h3 id="drawer-title" className="text-sm font-semibold text-fg tracking-tight truncate">{title}</h3>}
                  {subtitle && <p className="text-[11px] text-fg-muted mt-0.5 truncate">{subtitle}</p>}
                </div>
                {showClose && (
                  <button
                    onClick={onClose}
                    className="shrink-0 p-1 rounded-md text-fg-subtle hover:text-fg hover:bg-muted transition-colors"
                    aria-label="Close"
                  >
                    <X className="size-4" />
                  </button>
                )}
              </div>
            )}
            <div className="flex-1 overflow-y-auto p-4">
              {children}
            </div>
            {footer && (
              <div className="px-4 py-3 border-t border-border shrink-0">
                {footer}
              </div>
            )}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
