// ─── useDarkMode ─────────────────────────────────────────────────────────────
// Tri-state theme toggle: 'light' | 'dark' | 'auto' (auto follows OS).
//
// Storage:
//   noltech:settings:darkmode      → boolean (legacy, kept for back-compat)
//   noltech:settings:theme-mode    → 'light' | 'dark' | 'auto' (new, preferred)
//
// Returns [isDark, toggleDark, mode, setMode]:
//   - isDark   — current effective state (resolves 'auto' to OS pref)
//   - toggleDark — flip between light/dark (skips auto for the simple case)
//   - mode     — current preference ('light' | 'dark' | 'auto')
//   - setMode  — set explicitly to one of the three modes
//
// On first run with no preference: starts in 'auto' so users with OS dark
// mode get dark theme out of the box, no toggle needed.

import { useState, useEffect, useCallback } from 'react';

const LEGACY_KEY = 'noltech:settings:darkmode';
const MODE_KEY   = 'noltech:settings:theme-mode';

function getOsPrefersDark() {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyTheme(isDark) {
  document.documentElement.classList.toggle('dark', isDark);
}

export default function useDarkMode() {
  const [mode, setModeState]   = useState('auto');  // 'light' | 'dark' | 'auto'
  const [isDark, setIsDark]    = useState(() => getOsPrefersDark());

  // Hydrate from storage. Migrate legacy boolean → tri-state mode.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let resolvedMode = await window.storage.get(MODE_KEY);
        if (!resolvedMode) {
          // Migration: older installs only had the boolean. If true → 'dark',
          // if false → 'light'. Otherwise 'auto'.
          const legacy = await window.storage.get(LEGACY_KEY);
          if (legacy === true) resolvedMode = 'dark';
          else if (legacy === false) resolvedMode = 'light';
          else resolvedMode = 'auto';
          await window.storage.set(MODE_KEY, resolvedMode).catch(() => {});
        }
        if (cancelled) return;
        setModeState(resolvedMode);
        const dark = resolvedMode === 'dark' || (resolvedMode === 'auto' && getOsPrefersDark());
        setIsDark(dark);
        applyTheme(dark);
      } catch (e) {
        console.error('[darkmode] hydrate failed:', e);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Watch OS preference — re-apply when in 'auto' mode and the OS theme
  // flips at runtime (Mac auto-light/dark cycle, Windows time-based).
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e) => {
      if (mode === 'auto') {
        setIsDark(e.matches);
        applyTheme(e.matches);
      }
    };
    mq.addEventListener?.('change', handler);
    return () => mq.removeEventListener?.('change', handler);
  }, [mode]);

  const setMode = useCallback((nextMode) => {
    if (!['light', 'dark', 'auto'].includes(nextMode)) return;
    setModeState(nextMode);
    const dark = nextMode === 'dark' || (nextMode === 'auto' && getOsPrefersDark());
    setIsDark(dark);
    applyTheme(dark);
    window.storage.set(MODE_KEY, nextMode).catch(console.error);
    // Keep legacy key in sync for any code still reading it directly.
    window.storage.set(LEGACY_KEY, dark).catch(() => {});
  }, []);

  // Simple binary toggle (skips auto). The mode is set to the explicit
  // light/dark choice so the next OS theme flip doesn't surprise the user.
  const toggleDark = useCallback(() => {
    setMode(isDark ? 'light' : 'dark');
  }, [isDark, setMode]);

  return [isDark, toggleDark, mode, setMode];
}
