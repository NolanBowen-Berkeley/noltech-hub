// ─── Safe Storage Helpers ─────────────────────────────────────────────────────
// Wrappers around window.storage that log errors and emit notifications
// instead of failing silently.

import eventBus from '../services/eventBus';

/**
 * Safe storage write with error logging and notification.
 * @param {string} key   Storage key
 * @param {*}      value Value to persist
 * @param {string} [context] Human-readable context for error messages
 */
export async function safeSet(key, value, context = '') {
  try {
    await window.storage.set(key, value);
  } catch (e) {
    const label = context || key;
    console.error(`[storage] Failed to write "${label}":`, e);
    eventBus.emit('notification:push', {
      id: `storage-err-${Date.now()}`,
      type: 'error',
      title: 'Save Failed',
      message: `Could not save ${label}. Please try again.`,
      ts: new Date().toISOString(),
    });
    throw e;
  }
}

/**
 * Safe storage read with fallback.
 * @param {string} key       Storage key
 * @param {*}      fallback  Value to return on error
 * @param {string} [context] Human-readable context for warnings
 */
export async function safeGet(key, fallback = null, context = '') {
  try {
    const v = await window.storage.get(key);
    return v ?? fallback;
  } catch (e) {
    console.warn(`[storage] Failed to read "${context || key}":`, e.message);
    return fallback;
  }
}
