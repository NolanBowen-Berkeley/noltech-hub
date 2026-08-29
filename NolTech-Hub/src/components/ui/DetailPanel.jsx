// ─── DetailPanel ────────────────────────────────────────────────────────────
// 480px slide-in panel for inspecting individual records WITHOUT leaving the
// list view. Per Layered Precision design spec section 2 ("Detail Panel"):
//   - Slides in from right
//   - Has own close button, header, scrollable body, sticky footer
//   - Use this pattern instead of full-page nav wherever possible — it
//     preserves the user's place in the list.
//
// Built on Framer Motion + a fixed overlay. Esc-to-close, click-backdrop-to-
// close (configurable). Composed of <DetailPanel.Header/>, <DetailPanel.Body/>,
// and <DetailPanel.Footer/> sub-components for predictable layout.

import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { cn } from './cn';

export default function DetailPanel({
  open,
  onClose,
  width = 'md',           // sm: 360 · md: 480 · lg: 640
  closeOnBackdrop = true,
  closeOnEsc = true,
  className,
  children,
}) {
  useEffect(() => {
    if (!open || !closeOnEsc) return;
    const h = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [open, closeOnEsc, onClose]);

  const widthClass = width === 'sm' ? 'max-w-[360px]' : width === 'lg' ? 'max-w-[640px]' : 'max-w-[480px]';

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            key="detail-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => closeOnBackdrop && onClose?.()}
            className="fixed inset-0 z-[92] bg-fg/10 backdrop-blur-[2px]"
          />

          {/* Panel */}
          <motion.aside
            key="detail-panel"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 380, damping: 38 }}
            className={cn(
              'fixed top-0 right-0 bottom-0 z-[93] w-full',
              widthClass,
              'bg-surface border-l border-border shadow-glow-xl',
              'flex flex-col',
              className,
            )}
            role="dialog"
            aria-modal="true"
          >
            {children}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

// ─── Subcomponents ──────────────────────────────────────────────────────────

function Header({ eyebrow, title, subtitle, onClose, action, className }) {
  return (
    <div className={cn(
      'shrink-0 px-6 pt-5 pb-4 border-b border-border flex items-start gap-3',
      className,
    )}>
      <div className="min-w-0 flex-1">
        {eyebrow && <p className="ui-eyebrow text-fg-subtle mb-1.5">{eyebrow}</p>}
        {title && (
          <h2 className="text-[18px] font-semibold text-fg leading-tight tracking-subheading">
            {title}
          </h2>
        )}
        {subtitle && (
          <p className="text-[13px] text-fg-muted mt-1 leading-snug">{subtitle}</p>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {action}
        {onClose && (
          <button
            onClick={onClose}
            className="size-8 inline-flex items-center justify-center rounded-md text-fg-muted hover:text-fg hover:bg-muted transition-colors"
            aria-label="Close panel"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function Body({ className, children }) {
  return (
    <div className={cn('flex-1 overflow-y-auto px-6 py-5', className)}>
      {children}
    </div>
  );
}

function Footer({ className, children }) {
  return (
    <div className={cn(
      'shrink-0 px-6 py-4 border-t border-border bg-subtle/40 backdrop-blur-sm',
      'flex items-center gap-2 justify-end',
      className,
    )}>
      {children}
    </div>
  );
}

DetailPanel.Header = Header;
DetailPanel.Body   = Body;
DetailPanel.Footer = Footer;
