// ─── Settings → Errors panel ─────────────────────────────────────────────────
// Lists the last 200 errors captured by the errorLog service. Source labels +
// timestamps + message + (collapsed) stack. Lets you copy or clear.

import { useEffect, useState, useCallback } from 'react';
import { AlertTriangle, RefreshCw, Trash2, Copy, ChevronDown, ChevronRight } from 'lucide-react';
import { getRecentErrors, clearErrors } from '../../services/errorLog';
import { formatDateTime } from '../../utils/formatters';

function ErrorRow({ entry }) {
  const [open, setOpen] = useState(false);
  const hasStack = !!entry.stack;
  return (
    <div className="border-b border-border last:border-b-0 py-2">
      <button
        type="button"
        onClick={() => hasStack && setOpen((v) => !v)}
        className={`w-full flex items-start gap-2 text-left ${hasStack ? 'cursor-pointer hover:bg-muted/30 -mx-2 px-2 rounded' : ''}`}
      >
        {hasStack ? (
          open ? <ChevronDown size={12} className="text-fg-muted mt-1 shrink-0" />
               : <ChevronRight size={12} className="text-fg-muted mt-1 shrink-0" />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[10px] uppercase tracking-wide text-fg-muted font-mono">{entry.source || 'unknown'}</span>
            <span className="text-[10px] text-fg-subtle">{formatDateTime(entry.at)}</span>
          </div>
          <p className="text-xs text-fg break-words">{entry.message}</p>
        </div>
      </button>
      {open && hasStack && (
        <pre className="mt-2 ml-5 text-[10px] font-mono text-fg-muted bg-muted/30 rounded p-2 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap break-all">
          {entry.stack}
        </pre>
      )}
    </div>
  );
}

export default function ErrorLogPanel() {
  const [errors, setErrors] = useState([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setErrors(await getRecentErrors());
    setLoading(false);
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const handleCopy = async () => {
    try {
      const text = errors.map((e) => `[${e.at}] [${e.source}] ${e.message}${e.stack ? '\n' + e.stack : ''}`).join('\n\n');
      await navigator.clipboard.writeText(text);
    } catch {}
  };

  const handleClear = async () => {
    if (!confirm(`Clear all ${errors.length} error entries?`)) return;
    await clearErrors();
    await reload();
  };

  return (
    <div className="bg-surface rounded-xl border border-border shadow-sm p-5">
      <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
        <div className="flex items-center gap-2">
          <AlertTriangle size={16} className="text-warning" />
          <h3 className="text-sm font-semibold text-fg">Recent Errors</h3>
          <span className="text-xs text-fg-muted">({errors.length} / 200)</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={reload}
            disabled={loading}
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] border border-border text-fg hover:bg-muted/40 disabled:opacity-50"
            title="Reload error list"
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          {errors.length > 0 && (
            <>
              <button
                onClick={handleCopy}
                className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] border border-border text-fg hover:bg-muted/40"
                title="Copy all entries"
              >
                <Copy size={11} /> Copy
              </button>
              <button
                onClick={handleClear}
                className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] border border-danger/30 bg-danger-subtle text-danger hover:bg-danger-subtle/80"
                title="Clear all entries"
              >
                <Trash2 size={11} /> Clear
              </button>
            </>
          )}
        </div>
      </div>

      <p className="text-xs text-fg-muted mb-3 leading-relaxed">
        Everything logged via the errorLog service or emitted as a global error
        toast. Useful for diagnosing background failures (sync, scrape, listing
        push) that don't always reach the foreground.
      </p>

      {errors.length === 0 ? (
        <div className="text-center py-6 text-xs text-fg-muted">
          No errors logged.
        </div>
      ) : (
        <div className="max-h-96 overflow-y-auto rounded-lg border border-border-subtle">
          {errors.map((e, i) => <ErrorRow key={`${e.at}-${i}`} entry={e} />)}
        </div>
      )}
    </div>
  );
}
