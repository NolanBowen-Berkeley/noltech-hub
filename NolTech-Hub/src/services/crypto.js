// ─── Encryption utilities (AES-GCM via Web Crypto API) ─────────────────────
// Threat model: this protects stored secrets (eBay token, API keys) from
// casual reads of the IndexedDB file. The key is derived from app-shipped
// constants, so anyone with the source can reproduce it — this is obfuscation
// against data-file theft, NOT defense against a determined attacker with
// code access. Real device-bound encryption would require an Electron
// safeStorage hop or OS keychain integration; deferred until needed.

const APP_SALT = 'noltech-hub-v1'; // used in key derivation
const ALGO = 'AES-GCM';
const IV_LEN = 12;        // AES-GCM IV size
const TAG_LEN = 16;       // AES-GCM auth tag size
const MIN_CIPHER_LEN = IV_LEN + TAG_LEN;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

async function deriveKey() {
  // Use a combination of app salt + origin as key material
  // This means secrets are bound to this app installation
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(APP_SALT + window.location.origin),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: new TextEncoder().encode('noltech-secrets'), iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: ALGO, length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encrypt(plaintext) {
  const key = await deriveKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: ALGO, iv }, key, encoded);
  // Store as base64: iv + ciphertext
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

// Heuristic: does this string look like our base64-encoded (IV+ciphertext+tag)
// payload? If not, it is almost certainly a legacy plaintext value that pre-
// dates encryption (e.g., an API key stored before the encrypt() rollout).
function looksLikeCiphertext(s) {
  if (typeof s !== 'string' || s.length < 28) return false;
  if (!B64_RE.test(s)) return false;
  try {
    const bytes = atob(s);
    return bytes.length >= MIN_CIPHER_LEN;
  } catch {
    return false;
  }
}

export async function decrypt(encrypted) {
  // Legacy plaintext (pre-encryption rollout): pass through unchanged so old
  // installs keep working. Anything that parses as base64 of the right shape
  // is treated as ciphertext — and if the auth tag fails, we return null
  // rather than the raw bytes, because returning ciphertext was previously
  // silently feeding garbage into eBay/Anthropic API calls.
  if (!looksLikeCiphertext(encrypted)) return encrypted;
  try {
    const key = await deriveKey();
    const combined = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
    const iv = combined.slice(0, IV_LEN);
    const ciphertext = combined.slice(IV_LEN);
    const decrypted = await crypto.subtle.decrypt({ name: ALGO, iv }, key, ciphertext);
    return new TextDecoder().decode(decrypted);
  } catch (e) {
    console.warn('[crypto] decrypt failed (corrupted ciphertext or wrong key) — returning null');
    return null;
  }
}

// Helper: encrypt an object's values (for storing credentials)
export async function encryptObject(obj) {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = value ? await encrypt(String(value)) : '';
  }
  result._encrypted = true;
  return result;
}

export async function decryptObject(obj) {
  if (!obj?._encrypted) return obj; // not encrypted, return as-is (backward compat)
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === '_encrypted') continue;
    result[key] = value ? await decrypt(value) : '';
  }
  return result;
}
