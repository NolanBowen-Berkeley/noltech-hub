// ─── Disk-backed R2 shim ─────────────────────────────────────────────────────
// Implements the subset of the Cloudflare R2 bucket API used by
// services/pricing/cache.js (imageGet/imagePut) and routes/admin.js, so those
// files need no changes after the move off Cloudflare.
//
// Supported surface:
//   get(key)                      → { arrayBuffer(), httpMetadata, customMetadata } | null
//   put(key, bytes, { httpMetadata, customMetadata })
//   delete(key | key[])
//   list({ prefix, cursor })      → { objects: [{ key, size }], truncated, cursor }
//
// Layout: bytes in <dir>/<base64url(key)>.bin, metadata alongside in
// <base64url(key)>.meta.json. Same filename-encoding rationale as kv.js.
//
// Expiry note: R2 has no TTL primitive, so imagePut() stamps an `expiresAt`
// into customMetadata and the read path is supposed to honor it. The Worker's
// imageGet() never actually checked that stamp, so cached images lived
// forever. This shim enforces it on read, which is what the original comment
// in cache.js describes.

import { promises as fs } from 'node:fs';
import path from 'node:path';

const LIST_PAGE_SIZE = 1000;

function encodeKey(key) {
  return Buffer.from(String(key), 'utf8').toString('base64url');
}

function decodeKey(stem) {
  try {
    return Buffer.from(stem, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

export function createR2Bucket(dir) {
  let ready = null;

  function ensureDir() {
    if (!ready) ready = fs.mkdir(dir, { recursive: true }).then(() => dir);
    return ready;
  }

  const binFor  = (key) => path.join(dir, encodeKey(key) + '.bin');
  const metaFor = (key) => path.join(dir, encodeKey(key) + '.meta.json');

  async function removeBoth(key) {
    await Promise.all([
      fs.unlink(binFor(key)).catch(() => {}),
      fs.unlink(metaFor(key)).catch(() => {}),
    ]);
  }

  return {
    async get(key) {
      await ensureDir();
      let bytes, meta;
      try {
        bytes = await fs.readFile(binFor(key));
      } catch {
        return null;
      }
      try {
        meta = JSON.parse(await fs.readFile(metaFor(key), 'utf8'));
      } catch {
        meta = {};
      }

      const expiresAt = Number(meta?.customMetadata?.expiresAt);
      if (Number.isFinite(expiresAt) && Date.now() > expiresAt) {
        await removeBoth(key);
        return null;
      }

      return {
        key,
        size: bytes.byteLength,
        httpMetadata:   meta.httpMetadata   || {},
        customMetadata: meta.customMetadata || {},
        // Hand back a copy sliced to this buffer's own view, so callers can't
        // observe the rest of Node's pooled allocation.
        async arrayBuffer() {
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
        async bytes() { return new Uint8Array(bytes); },
        async text()  { return bytes.toString('utf8'); },
      };
    },

    async put(key, value, options = {}) {
      await ensureDir();
      const buf = Buffer.isBuffer(value)
        ? value
        : value instanceof Uint8Array
          ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
          : value instanceof ArrayBuffer
            ? Buffer.from(new Uint8Array(value))
            : Buffer.from(String(value), 'utf8');

      const target = binFor(key);
      const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      try {
        await fs.writeFile(tmp, buf);
        await fs.rename(tmp, target);
        await fs.writeFile(metaFor(key), JSON.stringify({
          key,
          storedAt:       Date.now(),
          httpMetadata:   options.httpMetadata   || {},
          customMetadata: options.customMetadata || {},
        }), 'utf8');
      } catch (e) {
        await fs.unlink(tmp).catch(() => {});
        console.warn('[r2] put failed:', key, e?.message);
      }
    },

    // R2 accepts either a single key or an array of keys.
    async delete(keys) {
      await ensureDir();
      const list = Array.isArray(keys) ? keys : [keys];
      await Promise.all(list.map(removeBoth));
    },

    async list({ prefix = '', cursor = null } = {}) {
      await ensureDir();
      let names;
      try {
        names = await fs.readdir(dir);
      } catch {
        return { objects: [], truncated: false, cursor: null };
      }

      const all = names
        .filter((n) => n.endsWith('.bin'))
        .map((n) => decodeKey(n.slice(0, -4)))
        .filter((k) => k !== null && k.startsWith(prefix))
        .sort();

      const start = Number(cursor) || 0;
      const page = all.slice(start, start + LIST_PAGE_SIZE);
      const next = start + page.length;
      const truncated = next < all.length;

      return {
        objects: page.map((key) => ({ key })),
        truncated,
        cursor: truncated ? String(next) : null,
      };
    },
  };
}
