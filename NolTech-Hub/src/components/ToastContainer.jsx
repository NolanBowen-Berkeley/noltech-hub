// ─── Toast Container ──────────────────────────────────────────────────────────
// Glossy, stacked toasts with Framer Motion entry/exit. Listens to eventBus.

import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle2, AlertTriangle, XCircle, Info, X, ChevronRight } from 'lucide-react';
import eventBus from '../services/eventBus';
import { cn } from './ui/cn';
import SyncSummaryModal from './SyncSummaryModal';

const ICON_MAP = {
  success: CheckCircle2,
  error:   XCircle,
  warning: AlertTriangle,
  info:    Info,
};

const INTENT_MAP = {
  success: { iconCls: 'text-success', accent: 'bg-success' },
  error:   { iconCls: 'text-danger',  accent: 'bg-danger'  },
  warning: { iconCls: 'text-warning', accent: 'bg-warning' },
  info:    { iconCls: 'text-accent',  accent: 'bg-accent'  },
};

export default function ToastContainer() {
  const [toasts, setToasts] = useState([]);
  // When a clickable toast is tapped, store its details for the modal to
  // render. Modal can open from any toast that was emitted with
  // `details: { kind: 'sync-summary', summary }`.
  const [openSummary, setOpenSummary] = useState(null);

  const addToast = useCallback((toast) => {
    const id = toast.id || `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const type = toast.type || 'info';
    const duration = toast.duration || (type === 'error' ? 6000 : 4000);

    setToasts(prev => [...prev.slice(-4), { ...toast, id, type }]);

    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, duration);
  }, []);

  const dismiss = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  useEffect(() => {
    const unsub1 = eventBus.on('notification:push', addToast);
    const unsub2 = eventBus.on('sync:conflict', ({ itemLabel }) => {
      addToast({
        type: 'warning',
        title: 'Updated by teammate',
        message: `"${itemLabel}" was just changed by another user. Your view refreshed.`,
        duration: 5000,
      });
    });
    return () => { unsub1(); unsub2(); };
  }, [addToast]);

  return (
    <>
      <div className="fixed bottom-6 right-6 z-[9999] flex flex-col gap-2 max-w-sm pointer-events-none">
        <AnimatePresence mode="popLayout">
          {toasts.map((toast) => {
            const Icon = ICON_MAP[toast.type] || Info;
            const intent = INTENT_MAP[toast.type] || INTENT_MAP.info;
            const isClickable = toast.details?.kind === 'sync-summary';
            const handleClick = () => {
              if (!isClickable) return;
              setOpenSummary(toast.details.summary);
              dismiss(toast.id);
            };
            return (
              <motion.div
                key={toast.id}
                layout
                initial={{ opacity: 0, x: 60, scale: 0.96 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, x: 60, scale: 0.96 }}
                transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                onClick={isClickable ? handleClick : undefined}
                className={cn(
                  'pointer-events-auto glossy-elevated overflow-hidden relative',
                  isClickable && 'cursor-pointer hover:shadow-glow-md transition-shadow'
                )}
                role="status"
                aria-live="polite"
              >
                {/* Left color accent bar */}
                <div className={cn('absolute left-0 top-0 bottom-0 w-1', intent.accent)} />
                <div className="flex items-start gap-3 pl-4 pr-3 py-3 min-w-[280px]">
                  <Icon className={cn('size-4 shrink-0 mt-0.5', intent.iconCls)} />
                  <div className="flex-1 min-w-0">
                    {toast.title && (
                      <p className="text-sm font-semibold text-fg leading-tight">{toast.title}</p>
                    )}
                    {toast.message && (
                      <p className="text-xs text-fg-muted mt-0.5 leading-relaxed">{toast.message}</p>
                    )}
                  </div>
                  {isClickable && (
                    <ChevronRight className="size-4 shrink-0 mt-0.5 text-fg-subtle" />
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); dismiss(toast.id); }}
                    className="shrink-0 p-1 rounded-md text-fg-subtle hover:text-fg hover:bg-muted transition-colors"
                    aria-label="Dismiss"
                  >
                    <X size={12} />
                  </button>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
      {openSummary && (
        <SyncSummaryModal summary={openSummary} onClose={() => setOpenSummary(null)} />
      )}
    </>
  );
}
