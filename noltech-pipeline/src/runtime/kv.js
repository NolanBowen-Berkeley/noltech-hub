// ─── Disk-backed KV shim ─────────────────────────────────────────────────────
// Implements the subset of the Cloudflare Workers KV API that this codebase
// uses, so services/pricing/cache.js, services/pricing/upcCache.js and
// routes/admin.js keep working *unchanged* after the move off Cloudflare.
//
// Supported surface:
//   get(key, { type: 'json' | 'text' })  → value | null
//   put(key, stringValue, { expirationTtl })
//   delete(key)
//   list({ prefix, cursor })             → { keys: [{ name }], list_complete, cursor }
//
// Storage layout: one file per key under <dir>/, named base64url(key) + '.json'.
// Encoding the key into the filename (rather than hashing) keeps list({prefix})
// a pure readdir with no file reads, and sidesteps Windows' ban on ':' in
// filenames — every cache key here is of the form 'liq:manifest:12345'.
//
// Expiry is stored inside the file and enforced lazily on read. list() does not
// filter expired entries: its only caller is the admin cache-flush, which is
// deleting them regardless.

import { promises as fs } from 'node:fs';
import path from 'node:path';

const LIST_PAGE_SIZE = 1000;

function encodeKey(key) {
  return Buffer.from(String(key), 'utf8').toString('base64url');
}

function decodeKey(filename) {
  const stem = filename.endsWith('.json') ? filename.slice(0, -5) : filename;
  try {
    return Buffer.from(stem, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

export function createKvStore(dir) {
  let ready = null;

  // Serializes concurrent writes to the same key. Without this, two in-flight
  // cachePutJson() calls for one key can interleave their write+rename and
  // leave a partial file behind.
  const inflight = new Map();

  function ensureDir() {
    if (!ready) ready = fs.mkdir(dir, { recursive: true }).then(() => dir);
    return ready;
  }

  function fileFor(key) {
    return path.join(dir, encodeKey(key) + '.json');
  }

  async function readRecord(key) {
    try {
      const raw = await fs.readFile(fileFor(key), 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  return {
    async get(key, options) {
      await ensureDir();
      const rec = await readRecord(key);
      if (!rec) return null;

      if (rec.expiresAt && Date.now() > rec.expiresAt) {
        // Lazily evict. Best-effort: a failed unlink just means we re-evict
        // on the next read.
        await fs.unlink(fileFor(key)).catch(() => {});
        return null;
      }

      const type = typeof options === 'string' ? options : options?.type;
      if (type === 'json') {
        if (typeof rec.value !== 'string') return rec.value ?? null;
        try { return JSON.parse(rec.value); } catch { return null; }
      }
      return rec.value ?? null;
    },

    async put(key, value, options = {}) {
      await ensureDir();

      const prev = inflight.get(key) || Promise.resolve();
      const task = prev.then(async () => {
        const ttl = Number(options.expirationTtl);
        const rec = {
          key,
          value: typeof value === 'string' ? value : String(value),
          storedAt: Date.now(),
          expiresAt: Number.isFinite(ttl) && ttl > 0 ? Date.now() + ttl * 1000 : null,
        };
        const target = fileFor(key);
        // Write to a unique temp file then rename — rename is atomic on both
        // NTFS and ext4, so a reader never observes a half-written record.
        const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
        try {
          await fs.writeFile(tmp, JSON.stringify(rec), 'utf8');
          await fs.rename(tmp, target);
        } catch (e) {
          await fs.unlink(tmp).catch(() => {});
          console.warn('[kv] put failed:', key, e?.message);
        }
      });

      inflight.set(key, task.catch(() => {}));
      try {
        await task;
      } finally {
        if (inflight.get(key) === task || inflight.size > 500) {
          // Drop the chain once settled so the map doesn't grow without bound.
          inflight.delete(key);
        }
      }
    },

    async delete(key) {
      await ensureDir();
      await fs.unlink(fileFor(key)).catch(() => {});
    },

    // Cursor is the index into the sorted filename list, serialized as a string
    // to match the opaque-cursor contract the Workers API presents.
    async list({ prefix = '', cursor = null } = {}) {
      await ensureDir();
      let names;
      try {
        names = await fs.readdir(dir);
      } catch {
        return { keys: [], list_complete: true, cursor: null };
      }

      const all = names
        .filter((n) => n.endsWith('.json'))
        .map(decodeKey)
        .filter((k) => k !== null && k.startsWith(prefix))
        .sort();

      const start = Number(cursor) || 0;
      const page = all.slice(start, start + LIST_PAGE_SIZE);
      const next = start + page.length;
      const complete = next >= all.length;

      return {
        keys: page.map((name) => ({ name })),
        list_complete: complete,
        cursor: complete ? null : String(next),
      };
    },
  };
}
