// ─── NolTech Event Bus ────────────────────────────────────────────────────────
// Lightweight pub/sub for cross-module communication.
// Modules emit events when they change data; other modules subscribe to react.

const listeners = {};

export const eventBus = {
  on(event, callback) {
    (listeners[event] ||= []).push(callback);
    return () => { listeners[event] = listeners[event].filter(fn => fn !== callback); };
  },
  emit(event, payload) {
    // debug: uncomment to trace events
    // console.log(`[event] ${event}`, payload?.itemId || payload?.lotId || '');
    (listeners[event] || []).forEach(fn => {
      try { fn(payload); } catch (e) { console.error(`[EventBus] ${event}:`, e); }
    });
  },
};

export default eventBus;
