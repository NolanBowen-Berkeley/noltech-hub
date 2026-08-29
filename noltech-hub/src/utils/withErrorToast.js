// ─── withErrorToast — async-action error surfacing helper ───────────────────
// Wraps an async function (Supabase call, storage op, fetch, etc.) so a
// failure surfaces as a notification:push toast AND a console.error tagged
// with the call site. Avoids the ~30 ad-hoc try/catch blocks in the app
// that swallow errors with console.error only, leaving the UI to render
// blank tables with no diagnostic.
//
// CLAUDE.md priority order — error visibility > silent failure. This module
// is the canonical wrapper to satisfy that rule.
//
// Usage:
//   await withErrorToast(
//     () => supabase.from('lots').select('*'),
//     { title: 'Lot load failed' },
//   );
//
//   await withErrorToast(
//     () => window.storage.set('noltech:foo', payload),
//     { title: 'Save failed', tag: 'foo-save' },
//   );
//
// Options:
//   title     — toast title (required when not silent)
//   tag       — optional console-tag prefix; defaults to title
//   silent    — when true, console.error only, no toast (useful for
//               periodic background polls that shouldn't spam toasts)
//   onError   — optional callback receiving the caught error
//   rethrow   — when true, re-throws after surfacing (so caller can branch)
//   default   — value to return when the async fn throws (default: undefined)
//
// Returns: { ok, value, error } shape so callers can do
//   const { ok, value } = await withErrorToast(...);
//   if (!ok) return; ...

import eventBus from '../services/eventBus';

export async function withErrorToast(asyncFn, opts = {}) {
  const {
    title,
    tag,
    silent = false,
    onError,
    rethrow = false,
    default: defaultValue,
  } = opts;

  try {
    const value = await asyncFn();
    return { ok: true, value, error: null };
  } catch (error) {
    const label = tag || title || 'async error';
    console.error(`[${label}]`, error);

    if (!silent) {
      try {
        eventBus.emit('notification:push', {
          type:    'error',
          title:   title || 'Something went wrong',
          message: errorMessage(error),
        });
      } catch {
        // notification:push should never throw, but if it does we don't
        // want to mask the original error. console.error above stays.
      }
    }

    if (typeof onError === 'function') {
      try { onError(error); } catch (cbErr) { console.error(`[${label}] onError callback threw:`, cbErr); }
    }

    if (rethrow) throw error;
    return { ok: false, value: defaultValue, error };
  }
}

// Best-effort message extraction. Supabase errors expose .message; native
// Error has .message; raw strings fall through. Capped at 240 chars so a
// stack-trace-like payload doesn't blow out the toast.
function errorMessage(error) {
  if (!error) return 'Unknown error';
  const raw = typeof error === 'string'
    ? error
    : (error.message || error.error?.message || String(error));
  return raw.length > 240 ? raw.slice(0, 237) + '…' : raw;
}
