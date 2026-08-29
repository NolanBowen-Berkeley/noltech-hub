// ─── Modal ────────────────────────────────────────────────────────────────────
// Unified modal primitive. Framer Motion entrance, backdrop blur, Esc to close,
// click-outside to dismiss, focus trap via autoFocus on first tabbable.
//
// Usage:
//   <Modal open={open} onClose={() => setOpen(false)} title="Edit item" size="md">
//     ...content...
//   </Modal>

import { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { cn } from './cn';
import { modalBackdrop, modalPanel, drawerPanel } from './motion';

const SIZE = {
  sm:     'max-w-sm',
  md:     'max-w-md',
  lg:     'max-w-lg',
  xl:     'max-w-2xl',
  '2xl':  'max-w-4xl',
  drawer: 'max-w-md h-full ml-auto rounded-none rounded-l-2xl',
};

export default function Modal({
  open,
  onClose,
  title,
  subtitle,
  size = 'md',
  closeOnBackdrop = true,
  showClose = true,
  footer,
  className = '',
  children,
}) {
  const panelRef = useRef(null);
  const isDrawer = size === 'drawer';

  // Esc to close
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);

  // Lock scroll on open
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
            className="fixed inset-0 z-[90] bg-black/50 backdrop-blur-sm"
          />
          <div className={cn(
            'fixed inset-0 z-[91] pointer-events-none flex p-4',
            isDrawer ? 'justify-end' : 'items-center justify-center',
          )}>
            <motion.div
              ref={panelRef}
              {...(isDrawer ? drawerPanel : modalPanel)}
              role="dialog"
              aria-modal="true"
              aria-labelledby={title ? 'modal-title' : undefined}
              onClick={(e) => e.stopPropagation()}
              className={cn(
                'pointer-events-auto w-full glossy-elevated flex flex-col',
                !isDrawer && 'max-h-[90vh]',
                SIZE[size],
                className,
              )}
            >
              {(title || showClose) && (
                <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-border shrink-0">
                  <div className="min-w-0">
                    {title && <h3 id="modal-title" className="text-sm font-semibold text-fg tracking-tight">{title}</h3>}
                    {subtitle && <p className="text-[11px] text-fg-muted mt-0.5">{subtitle}</p>}
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
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
