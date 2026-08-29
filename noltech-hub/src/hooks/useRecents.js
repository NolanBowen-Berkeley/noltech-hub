// ─── useRecents ─────────────────────────────────────────────────────────────
// Tracks the last N items/lots/modules the user touched so the UI can
// surface "jump back where you left off" affordances (Hub strip, command
// palette Recents group, sidebar flyout, etc.).
//
// API:
//   const { recents, trackRecent, clearRecents } = useRecents();
//   trackRecent({ type: 'item' | 'lot' | 'view', id, label, sub?, view? })
//
// Storage key: noltech:ui:recents  →  array of { type, id, label, sub, view, ts }
// Capped at RECENTS_MAX entries, newest first. Duplicate {type,id} moves to
// front instead of stacking.

import { useState, useEffect, useCallback, useRef } from 'react';

const KEY = 'noltech:ui:recents';
const RECENTS_MAX = 12;

let inMemory = null;        // cross-hook shared cache, hydrated once
const listeners = new Set();

function notify(next) {
  inMemory = next;
  listeners.forEach((l) => l(next));
}

async function hydrate() {
  if (inMemory) return inMemory;
  try {
    const v = await window.storage.get(KEY);
    inMemory = Array.isArray(v) ? v : [];
  } catch {
    inMemory = [];
  }
  return inMemory;
}

function persist(next) {
  window.storage.set(KEY, next).catch((e) => {
    console.error('[useRecents] persist failed:', e);
  });
}

export default function useRecents() {
  const [recents, setRecents] = useState(inMemory || []);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    hydrate().then((v) => { if (mounted.current) setRecents(v); });
    const l = (v) => { if (mounted.current) setRecents(v); };
    listeners.add(l);
    return () => { mounted.current = false; listeners.delete(l); };
  }, []);

  const trackRecent = useCallback((entry) => {
    if (!entry?.id || !entry?.type) return;
    const now = inMemory || [];
    const next = [
      { ...entry, ts: Date.now() },
      ...now.filter((r) => !(r.type === entry.type && r.id === entry.id)),
    ].slice(0, RECENTS_MAX);
    notify(next);
    persist(next);
  }, []);

  const clearRecents = useCallback(() => {
    notify([]);
    persist([]);
  }, []);

  return { recents, trackRecent, clearRecents };
}

// Fire-and-forget tracker for use outside React components (e.g. event bus).
export function trackRecentExternal(entry) {
  if (!entry?.id || !entry?.type) return;
  hydrate().then((now) => {
    const next = [
      { ...entry, ts: Date.now() },
      ...now.filter((r) => !(r.type === entry.type && r.id === entry.id)),
    ].slice(0, RECENTS_MAX);
    notify(next);
    persist(next);
  });
}
