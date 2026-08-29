import { openDB } from 'idb';

const DB_NAME    = 'noltech-hub-db';
const STORE_NAME = 'keyval';

const dbPromise = openDB(DB_NAME, 1, {
  upgrade(db) {
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      db.createObjectStore(STORE_NAME);
    }
  },
});

// Sync hook (set by syncEngine after it loads)
let _syncHook = null;
export function setSyncHook(fn) { _syncHook = fn; }

export const storage = {
  async get(key)        { return (await dbPromise).get(STORE_NAME, key); },
  async set(key, value) {
    const result = await (await dbPromise).put(STORE_NAME, value, key);
    // Notify sync engine after successful write
    if (_syncHook) { try { _syncHook(key, value); } catch (e) { console.error('[storage] sync hook failed:', e); } }
    return result;
  },
  async delete(key)     { return (await dbPromise).delete(STORE_NAME, key); },
};

window.storage = storage;
export default storage;
