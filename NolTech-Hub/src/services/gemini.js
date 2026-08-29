// ─── Gemini AI service ────────────────────────────────────────────────────────
// Thin wrapper around Google's Generative Language API for the Listing
// Generator's per-item auto-fill (description, condition description, item
// specifics). Pattern intentionally mirrors src/services/ai.js so callers can
// pick whichever model they have a key for.
//
// Storage: encrypted Gemini API key under GEMINI_KEY_STORAGE. Settings UI
// writes this; Listing Generator reads it on demand.

import { decrypt } from './crypto';

export const GEMINI_KEY_STORAGE = 'noltech:gemini:apikey';
export const GEMINI_TIER_STORAGE = 'noltech:gemini:tier';

// Pacing config per billing tier. Free tier on gemini-2.5-flash is 10 RPM,
// so we sleep 6.5s between batches to land under that. Paid tiers have far
// higher caps so we collapse the pacing — the bottleneck becomes Gemini's
// own response time (~2-3s per batch) instead of our self-throttling.
export const TIER_PACING = {
  'free':       { paceMs: 6_500, batchSize: 60,  concurrency: 1 },
  'paid-tier1': { paceMs:   200, batchSize: 80,  concurrency: 4 },
  'paid-tier2': { paceMs:     0, batchSize: 100, concurrency: 8 },
};

export async function loadGeminiTierConfig() {
  let tier = 'free';
  try {
    const stored = await window.storage.get(GEMINI_TIER_STORAGE);
    if (typeof stored === 'string' && TIER_PACING[stored]) tier = stored;
  } catch {}
  return { tier, ...TIER_PACING[tier] };
}
// gemini-2.5-flash is the current free-tier model (10 RPM / 250 RPD on free
// tier as of late 2025). The older gemini-2.0-flash had its free quota
// dropped to 0 — keys created against new projects can't use it without
// billing enabled.
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Parse Google's "Please retry in 8.333s" hint out of a 429 error message.
// Returns milliseconds, or null if no hint found. Used by callGemini to
// auto-retry rate-limited calls instead of bubbling the error.
function parseRetryAfterMs(errorMsg) {
  if (!errorMsg) return null;
  const m = String(errorMsg).match(/retry in ([\d.]+)\s*s/i);
  if (!m) return null;
  const seconds = parseFloat(m[1]);
  if (!isFinite(seconds) || seconds <= 0) return null;
  return Math.min(60_000, Math.ceil(seconds * 1000) + 250); // +250ms buffer, cap 60s
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Walk the string starting at the first `[` or `{` and find the matching
// closer, respecting strings and escapes. Returns the substring of the first
// balanced JSON value, or null if none. This handles cases where Gemini
// emits trailing commentary or a second array after the first ("[...]<junk>"
// would break a naive JSON.parse with "Unexpected non-whitespace character
// after JSON").
function extractFirstJsonValue(text) {
  let i = 0;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (i >= text.length) return null;
  const opener = text[i];
  if (opener !== '[' && opener !== '{') {
    // Find the first opener anywhere
    const idx = text.search(/[\[{]/);
    if (idx < 0) return null;
    i = idx;
  }
  const open = text[i];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === '\\') { escape = true; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return text.slice(i, j + 1);
    }
  }
  return null;
}

export function extractJSON(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : text).trim();
  // Fast path
  try { return JSON.parse(raw); } catch {}
  // Slow path: extract the first complete balanced value
  const slice = extractFirstJsonValue(raw);
  if (slice) {
    try { return JSON.parse(slice); } catch (e) {
      throw new Error('Gemini returned malformed JSON: ' + slice.slice(0, 200));
    }
  }
  throw new Error('Gemini returned non-JSON: ' + raw.slice(0, 200));
}

export async function loadGeminiKey() {
  const raw = await window.storage.get(GEMINI_KEY_STORAGE).catch(() => null);
  if (!raw) return null;
  try { return await decrypt(raw); } catch { return null; }
}

export async function callGemini(apiKey, systemPrompt, userMessage, options = {}) {
  const {
    maxTokens = 1500,
    temperature = 0.4,
    maxRetries = 3,
    // Gemini 2.5 Flash uses "thinking" tokens by default, which silently
    // consume the output budget — easy to truncate JSON arrays mid-string.
    // For deterministic structured tasks (cleaning titles, extracting
    // specifics), pass thinkingBudget=0 to disable it. Pass -1 for auto.
    thinkingBudget = -1,
    onStatus,        // (status: 'sending' | 'waiting' | 'parsing', meta?) => void
  } = options;
  if (!apiKey) throw new Error('Missing Gemini API key');
  const url = `${GEMINI_URL}?key=${encodeURIComponent(apiKey)}`;
  const body = {
    systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingBudget },
    },
  };

  let attempt = 0;
  for (;;) {
    onStatus?.('sending', { attempt });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (res.ok) {
      onStatus?.('parsing');
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('\n');
      if (!text) throw new Error('Gemini returned an empty response');
      // Detect truncation — Google sets finishReason to MAX_TOKENS when the
      // response was cut off. Surface that explicitly so callers can retry
      // with a smaller batch instead of failing on a JSON parse error.
      const finishReason = data?.candidates?.[0]?.finishReason;
      if (finishReason === 'MAX_TOKENS') {
        throw new Error('Gemini response truncated (MAX_TOKENS) — try a smaller batch.');
      }
      return text;
    }

    // Build error message for retry logic + final throw
    let errorMsg = `Gemini API error ${res.status}`;
    try { const b = await res.json(); errorMsg = b?.error?.message || errorMsg; } catch {}

    // Retry rate-limit (429) and transient server errors (5xx) using the
    // server's own retry-after hint when provided. Bail out otherwise.
    const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
    if (!retryable || attempt >= maxRetries) throw new Error(errorMsg);

    const hintMs = parseRetryAfterMs(errorMsg);
    const backoffMs = hintMs ?? Math.min(30_000, 2_000 * Math.pow(2, attempt));
    onStatus?.('waiting', { ms: backoffMs, reason: res.status, attempt });
    await sleep(backoffMs);
    attempt++;
  }
}

// ─── Title cleaner ────────────────────────────────────────────────────────────
// Higher-quality cousin of utils/titleClean.js. Takes raw eBay listing titles
// (the kind that come back from the Browse API and get stored in the UPC
// cache) and rewrites them into the format you'd actually list under.
//
// Batched — pass an array, get an array back in the same order. One Gemini
// call per batch of up to ~80 titles. Caller is expected to persist results
// back into the UPC cache so we don't re-clean the same UPC repeatedly.

const TITLE_CLEAN_SYSTEM = `You clean noisy eBay listing titles into concise, professional resale titles for NolTech (electronics reseller).

Input: a JSON array of items, each with { upc, rawTitle, brand, mpn }.
Output: ONLY a JSON array, in the SAME order, of { "upc": "<upc>", "cleanTitle": "<clean title>" }. No markdown, no explanation.

CLEANING RULES:
1. Format: [Brand] [Model] [Key Specs]
2. HARD LIMIT: 80 characters max
3. STRIP marketing fluff: "BRAND NEW!", "GENUINE", "AUTHENTIC", "100% Authentic", "FAST SHIPPING", "FREE SHIPPING", "MUST SEE", "L@@K", "WOW", "RARE", "Sealed in Box" (when not literally sealed), "Tested Working", "Works Great", "Great Condition", "US Seller", "Ships Today", "Limited Time"
4. STRIP emojis, ALL-CAPS exclamations, repeated punctuation (---, ..., !!!, ***)
5. STRIP seller-specific phrases ("Ships Fast", "Same Day", etc.)
6. Use proper Title Case — never keep ALL CAPS. EXCEPTIONS: keep abbreviations uppercase (GB, TB, SSD, HDD, RAM, CPU, GPU, USB, HDMI, RTX, GTX, DDR4, NVMe, OLED, LED, 4K, 1080p, Win10, Win11, etc.)
7. KEEP: brand, model, CPU model, RAM/storage size, screen size, color, generation, key specs from the original
8. NEVER invent specs. Only use what's in the input.
9. Don't add condition labels like "(Used)" or "- For Parts" — eBay's separate condition field handles that
10. Preserve number-letter combos exactly: "i5-8350U", "RTX 3060", "ThinkPad T480", "Latitude 5480"
11. If input title is empty or only fluff, return the brand + mpn if known, else empty string

Examples:
  IN:  { "rawTitle": "BRAND NEW! Apple iPhone 13 128GB Unlocked Smartphone - FAST SHIPPING - Sealed Box GENUINE" }
  OUT: { "cleanTitle": "Apple iPhone 13 128GB Unlocked Smartphone" }

  IN:  { "rawTitle": "🔥🔥 LENOVO ThinkPad T480 Laptop i5-8350U 8GB 256GB SSD Win10 - L@@K !!! ***" }
  OUT: { "cleanTitle": "Lenovo ThinkPad T480 i5-8350U 8GB 256GB SSD Win10" }

  IN:  { "rawTitle": "DELL OPTIPLEX 7060 SFF DESKTOP COMPUTER i5-8500 16GB 512GB SSD Win 11 PRO TESTED WORKING" }
  OUT: { "cleanTitle": "Dell OptiPlex 7060 SFF Desktop i5-8500 16GB 512GB SSD Win11 Pro" }

  IN:  { "rawTitle": "***RARE*** NVIDIA GeForce RTX 3070 8GB GDDR6 Graphics Card GENUINE OEM!!!" }
  OUT: { "cleanTitle": "NVIDIA GeForce RTX 3070 8GB GDDR6 Graphics Card" }`;

/**
 * Clean a batch of raw eBay titles via Gemini.
 *
 * @param {string} apiKey
 * @param {Array<{ upc?: string, rawTitle: string, brand?: string, mpn?: string }>} items
 * @returns {Promise<Array<{ upc: string, cleanTitle: string }>>}
 */
export async function cleanTitles(apiKey, items, { onStatus } = {}) {
  if (!Array.isArray(items) || items.length === 0) return [];

  // Strip empty inputs upfront — saves tokens, avoids confusing the model
  const valid = items.filter((i) => i && typeof i.rawTitle === 'string' && i.rawTitle.trim());
  if (valid.length === 0) return [];

  const payload = valid.map((i) => ({
    upc: i.upc || '',
    rawTitle: i.rawTitle.trim(),
    brand: i.brand || '',
    mpn: i.mpn || '',
  }));

  // Token budget: a cleaned JSON line is ~30 tokens. Allow ~50/item with
  // headroom — gemini-2.5-flash supports up to 65K output tokens. Cap at
  // 32K to stay safe on batches that drift larger.
  const maxTokens = Math.min(32_000, Math.max(2000, payload.length * 50 + 1000));

  const text = await callGemini(
    apiKey,
    TITLE_CLEAN_SYSTEM,
    `Clean these ${payload.length} eBay listing title(s):\n\n${JSON.stringify(payload)}`,
    {
      maxTokens,
      temperature: 0.2,
      // Disable thinking — title cleaning is a deterministic transform and
      // thinking tokens would silently consume the output budget, leading
      // to MAX_TOKENS truncation on big batches.
      thinkingBudget: 0,
      onStatus,
    },
  );

  const parsed = extractJSON(text);
  if (!Array.isArray(parsed)) throw new Error('cleanTitles: expected JSON array');

  return parsed
    .filter((r) => r && typeof r.cleanTitle === 'string')
    .map((r) => ({
      upc: typeof r.upc === 'string' ? r.upc : '',
      cleanTitle: r.cleanTitle.trim().slice(0, 80),
    }));
}

// ─── Listing auto-fill ────────────────────────────────────────────────────────
// Used by the per-listing expand editor. Gemini fills in the variable slots
// of the NolTech listing template (product name, condition bucket, spec
// pairs, test checklist, cosmetic prose, what's included). We then assemble
// the final HTML in `buildListingHtml` so the template itself stays a single
// source of truth — Gemini doesn't have to hand-write 200 lines of inline-CSS
// markup every call.
//
// We also collect the structured fields the eBay push needs separately
// (brand, mpn, color, storage, ram, conditionDescription, itemSpecifics).

const AUTOFILL_SYSTEM = `You are an expert eBay listing copywriter for an electronics resale & refurbishment business.

Return ONLY a valid JSON object — no markdown fences, no explanation. Start with { end with }.

Your output fills the variable slots of NolTech's listing template. Be specific, factual, and grounded in the input — NEVER invent specs, defects, or accessories that weren't provided.

Schema:
{
  "productName": "string — concise product name shown under the header. Format: Brand + Model + Key Spec (e.g. 'Dell Latitude 5480 — Intel i5, 8GB RAM, 256GB SSD'). Plain text, no HTML.",

  "conditionBucket": "excellent | good | fair",
  // excellent → new, like-new, sealed, mint, refurbished-grade-A
  // good      → used / working / tested / refurbished standard
  // fair      → cosmetic wear, untested, broken, salvage, for parts

  "specRows": [
    { "label": "Brand",     "value": "Dell" },
    { "label": "Model",     "value": "Latitude 5480" },
    { "label": "Processor", "value": "Intel Core i5-7300U" }
    /* 4 to 12 rows total. Render in pairs (2 columns), so prefer an even count. */
    /* Always include Brand and Model first. Then category-appropriate specs. */
  ],

  "testChecklist": [
    "Powers on and boots normally",
    "All USB ports verified functional",
    "Battery holds a charge under load"
    /* 4 to 6 short statements about what was actually verified. */
    /* For untested / for-parts items, state honestly: e.g. "Sold as-is — full functionality not verified" or "Visual inspection complete; not powered on". */
    /* Each item ≤ 80 chars. No marketing fluff. */
  ],

  "cosmeticCondition": "string — one paragraph (2-4 sentences) describing the physical condition. Mention scratches, scuffs, dents, discoloration, missing keys, cracks, etc. — but ONLY if mentioned in the input notes. If no notes provided, write a neutral statement based on the condition bucket (e.g. 'Light wear consistent with normal use. Refer to photos for exact representation.'). Do NOT invent specific defects.",

  "whatsIncluded": [
    "The device itself",
    "Charging cable"
    /* 1 to 6 items. Include the device + any accessories mentioned in input notes. */
    /* For laptops/desktops without a charger mentioned: end with "No charger or power cable included" as a separate item. */
    /* Keep each item short (≤ 60 chars). */
  ],

  "conditionDescription": "string — 1-3 honest sentences for eBay's separate Condition Description field. Mirrors cosmeticCondition + functional state. For unknown condition use: 'Unit untested — sourced from a commercial liquidation lot. Sold as-is.'",

  "itemSpecifics": [
    { "name": "Brand", "value": "Dell" },
    { "name": "MPN",   "value": "..." }
    /* 5 to 15 entries. Match eBay's standard specifics names. */
  ],

  "brand":   "string — extracted brand if confidently identifiable, else empty",
  "mpn":     "string — Manufacturer Part Number / model number, else empty",
  "color":   "string — primary chassis color if obvious, else empty",
  "storage": "string — e.g. '256 GB' if size in input, else empty",
  "ram":     "string — e.g. '8 GB' if size in input, else empty"
}

ITEM SPECIFICS rules:
- Always include Brand and MPN if known
- For laptops/desktops: add Processor, RAM Size, SSD Capacity, Screen Size, Operating System, GPU, Form Factor, Series
- For phones/tablets:  add Model, Storage Capacity, Operating System, Color, Connectivity, Screen Size
- For GPUs:            add Chipset/GPU Model, Memory Size, Memory Type, Connectors
- For RAM modules:     add Type, Capacity per Module, Form Factor, Speed
- For monitors:        add Screen Size, Max Resolution, Aspect Ratio, Refresh Rate
- DO NOT include speculative values like "May Vary" or "Various"
- Names should match eBay's standard specifics where possible (capitalized words)`;

// Internal HTML escaper — same shape eBay accepts (basic entity encoding).
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Bucket → badge styles. Mirrors the three commented-out badges in the
// original template. If Gemini returns an unrecognized bucket we fall back
// to "good" so the listing still renders.
const BADGE_BY_BUCKET = {
  excellent: { bg: '#d1f4dd', color: '#0a6c3a', label: 'EXCELLENT CONDITION' },
  good:      { bg: '#fff3cd', color: '#856404', label: 'GOOD CONDITION' },
  fair:      { bg: '#fde4e4', color: '#8b1a1a', label: 'FAIR — COSMETIC WEAR' },
};

// Map a free-text condition string ("Used", "Like New", "for parts", etc.)
// to one of the three template buckets. Used as a fallback when Gemini
// doesn't return a clean bucket.
function bucketFromCondition(condition) {
  if (!condition) return 'good';
  const c = String(condition).toLowerCase();
  if (/\b(new|sealed|mint|grade[\s_-]?a|excellent|like[\s_-]?new)\b/.test(c)) return 'excellent';
  if (/\b(parts|salvage|broken|defective|damaged|fair|poor|as[\s_-]?is|untested)\b/.test(c)) return 'fair';
  return 'good';
}

// Compose the final HTML using the variable slots Gemini filled in.
// The template structure is fixed in code — Gemini only fills the gaps.
export function buildListingHtml(filled, fallback = {}) {
  const productName = filled.productName || fallback.productName || fallback.title || 'Item for sale';
  const bucket = BADGE_BY_BUCKET[filled.conditionBucket]
    ? filled.conditionBucket
    : bucketFromCondition(fallback.condition);
  const badge = BADGE_BY_BUCKET[bucket] || BADGE_BY_BUCKET.good;

  // Spec rows render in pairs (2 columns × N rows). Pad with an empty cell
  // if there's an odd count so the table doesn't collapse the last row.
  const specs = (Array.isArray(filled.specRows) ? filled.specRows : [])
    .filter(r => r && r.label && r.value);
  let specsHtml = '';
  for (let i = 0; i < specs.length; i += 2) {
    const a = specs[i];
    const b = specs[i + 1];
    specsHtml +=
      `<tr>` +
      `<td style="padding: 6px 12px 6px 0; color: #6e6e73; width: 140px;">${esc(a.label)}</td>` +
      `<td style="padding: 6px 0; font-weight: 500;">${esc(a.value)}</td>` +
      (b
        ? `<td style="padding: 6px 12px 6px 0; color: #6e6e73; width: 140px;">${esc(b.label)}</td>` +
          `<td style="padding: 6px 0; font-weight: 500;">${esc(b.value)}</td>`
        : `<td></td><td></td>`) +
      `</tr>`;
  }
  if (!specsHtml) specsHtml = `<tr><td style="padding:6px 0;color:#6e6e73;font-style:italic;">See item specifics above.</td></tr>`;

  const checklist = (Array.isArray(filled.testChecklist) ? filled.testChecklist : [])
    .filter(t => t && String(t).trim());
  const checklistHtml = checklist.length
    ? checklist.map(t =>
        `<tr>` +
        `<td style="padding: 5px 0; width: 22px; color: #0a6c3a; font-weight: bold;">&#10003;</td>` +
        `<td style="padding: 5px 0;">${esc(t)}</td>` +
        `</tr>`
      ).join('')
    : `<tr><td colspan="2" style="padding:5px 0;color:#6e6e73;font-style:italic;">Item not yet tested.</td></tr>`;

  const included = (Array.isArray(filled.whatsIncluded) ? filled.whatsIncluded : [])
    .filter(x => x && String(x).trim());
  const includedHtml = included.length
    ? included.map(x => `<li style="padding: 3px 0;">${esc(x)}</li>`).join('')
    : `<li style="padding: 3px 0; color:#6e6e73; font-style:italic;">Item only — see photos for exact contents.</li>`;

  const cosmetic = filled.cosmeticCondition && String(filled.cosmeticCondition).trim()
    ? esc(filled.cosmeticCondition)
    : 'Refer to photos for exact cosmetic representation.';

  return `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; max-width: 900px; margin: 0 auto; color: #1a1a1a; line-height: 1.5;">

  <div style="background: linear-gradient(135deg, #1d1d1f 0%, #2c2c2e 100%); color: #ffffff; padding: 28px 24px; border-radius: 8px 8px 0 0; text-align: center;">
    <h1 style="margin: 0 0 6px 0; font-size: 26px; font-weight: 600; letter-spacing: -0.5px;">NolTech</h1>
    <p style="margin: 0; font-size: 13px; opacity: 0.75; letter-spacing: 1.5px; text-transform: uppercase;">Electronics Resale &amp; Refurbishment</p>
  </div>

  <div style="background: #ffffff; padding: 22px 24px; border-left: 1px solid #e5e5e7; border-right: 1px solid #e5e5e7; text-align: center;">
    <h2 style="margin: 0 0 8px 0; font-size: 22px; font-weight: 600; color: #1d1d1f;">${esc(productName)}</h2>
    <p style="margin: 0; font-size: 14px; color: #6e6e73;">Tested &amp; Verified by NolTech</p>
    <div style="display: inline-block; margin-top: 12px; padding: 6px 16px; background: ${badge.bg}; color: ${badge.color}; border-radius: 20px; font-size: 13px; font-weight: 600; letter-spacing: 0.3px;">${badge.label}</div>
  </div>

  <div style="background: #f5f5f7; padding: 18px 24px; border-left: 1px solid #e5e5e7; border-right: 1px solid #e5e5e7;">
    <h3 style="margin: 0 0 12px 0; font-size: 15px; font-weight: 600; color: #1d1d1f; text-transform: uppercase; letter-spacing: 0.5px;">Specifications</h3>
    <table style="width: 100%; border-collapse: collapse; font-size: 14px;">${specsHtml}</table>
  </div>

  <div style="background: #ffffff; padding: 22px 24px; border-left: 1px solid #e5e5e7; border-right: 1px solid #e5e5e7;">
    <h3 style="margin: 0 0 14px 0; font-size: 15px; font-weight: 600; color: #1d1d1f; text-transform: uppercase; letter-spacing: 0.5px;">Tested &amp; Verified</h3>
    <table style="width: 100%; border-collapse: collapse; font-size: 14px;">${checklistHtml}</table>
  </div>

  <div style="background: #f5f5f7; padding: 22px 24px; border-left: 1px solid #e5e5e7; border-right: 1px solid #e5e5e7;">
    <h3 style="margin: 0 0 12px 0; font-size: 15px; font-weight: 600; color: #1d1d1f; text-transform: uppercase; letter-spacing: 0.5px;">Cosmetic Condition</h3>
    <p style="margin: 0 0 8px 0; font-size: 14px; color: #333;">${cosmetic}</p>
    <p style="margin: 0; font-size: 13px; color: #6e6e73; font-style: italic;">Photos show the actual item being sold. Please review all images before purchasing.</p>
  </div>

  <div style="background: #ffffff; padding: 22px 24px; border-left: 1px solid #e5e5e7; border-right: 1px solid #e5e5e7;">
    <h3 style="margin: 0 0 12px 0; font-size: 15px; font-weight: 600; color: #1d1d1f; text-transform: uppercase; letter-spacing: 0.5px;">What's Included</h3>
    <ul style="margin: 0; padding-left: 20px; font-size: 14px;">${includedHtml}</ul>
    <p style="margin: 12px 0 0 0; font-size: 13px; color: #6e6e73; font-style: italic;">Anything not listed above is not included, regardless of what may appear in stock photos.</p>
  </div>

  <div style="background: #f5f5f7; padding: 22px 24px; border-left: 1px solid #e5e5e7; border-right: 1px solid #e5e5e7;">
    <h3 style="margin: 0 0 12px 0; font-size: 15px; font-weight: 600; color: #1d1d1f; text-transform: uppercase; letter-spacing: 0.5px;">Shipping &amp; Returns</h3>
    <p style="margin: 0 0 8px 0; font-size: 14px; color: #333;">Items are packed securely with appropriate padding and protection. Tracking is provided on every order.</p>
    <p style="margin: 0; font-size: 14px; color: #333;">Returns are accepted per the policy listed on this listing. Please review all photos and the condition description before purchasing — condition is clearly disclosed and documented.</p>
  </div>

  <div style="background: #ffffff; padding: 22px 24px; border-left: 1px solid #e5e5e7; border-right: 1px solid #e5e5e7;">
    <h3 style="margin: 0 0 10px 0; font-size: 15px; font-weight: 600; color: #1d1d1f; text-transform: uppercase; letter-spacing: 0.5px;">About NolTech</h3>
    <p style="margin: 0; font-size: 14px; color: #333;">NolTech specializes in electronics resale and refurbishment. Every device is thoroughly tested, documented, and packed with care. Questions? Send us a message — we respond quickly.</p>
  </div>

  <div style="background: #f5f5f7; padding: 16px 24px; border-radius: 0 0 8px 8px; border: 1px solid #e5e5e7; border-top: none; text-align: center;">
    <p style="margin: 0; font-size: 12px; color: #6e6e73;">NolTech &nbsp;&bull;&nbsp; Tested &amp; Refurbished Electronics &nbsp;&bull;&nbsp; Thank you for your business</p>
  </div>

</div>`;
}

export async function autofillListing(apiKey, { title, brand, category, condition, mpn, upc, notes, specs }) {
  const lines = [
    title && `Title: ${title}`,
    brand && `Brand: ${brand}`,
    mpn && `MPN/Model: ${mpn}`,
    category && `Category: ${category}`,
    condition && `Condition: ${condition}`,
    upc && `UPC: ${upc}`,
    specs && `Specs: ${specs}`,
    notes && `Notes: ${notes}`,
  ].filter(Boolean).join('\n');

  const text = await callGemini(
    apiKey,
    AUTOFILL_SYSTEM,
    `Generate eBay listing details for this electronics item:\n\n${lines}`,
    { maxTokens: 2500, temperature: 0.3 }
  );

  const parsed = extractJSON(text);

  // Coerce shapes so callers can trust the output
  const filled = {
    productName: typeof parsed.productName === 'string' ? parsed.productName : '',
    conditionBucket: typeof parsed.conditionBucket === 'string' ? parsed.conditionBucket.toLowerCase() : '',
    specRows: Array.isArray(parsed.specRows)
      ? parsed.specRows
          .filter(r => r && typeof r.label === 'string' && typeof r.value === 'string' && r.label.trim() && r.value.trim())
          .map(r => ({ label: r.label.trim(), value: r.value.trim() }))
      : [],
    testChecklist: Array.isArray(parsed.testChecklist)
      ? parsed.testChecklist.map(t => String(t).trim()).filter(Boolean)
      : [],
    cosmeticCondition: typeof parsed.cosmeticCondition === 'string' ? parsed.cosmeticCondition : '',
    whatsIncluded: Array.isArray(parsed.whatsIncluded)
      ? parsed.whatsIncluded.map(x => String(x).trim()).filter(Boolean)
      : [],
    conditionDescription: typeof parsed.conditionDescription === 'string' ? parsed.conditionDescription : '',
    itemSpecifics: Array.isArray(parsed.itemSpecifics)
      ? parsed.itemSpecifics
          .filter(s => s && typeof s.name === 'string' && typeof s.value === 'string' && s.name.trim() && s.value.trim())
          .map(s => ({ name: s.name.trim(), value: s.value.trim() }))
      : [],
    brand: typeof parsed.brand === 'string' ? parsed.brand : '',
    mpn: typeof parsed.mpn === 'string' ? parsed.mpn : '',
    color: typeof parsed.color === 'string' ? parsed.color : '',
    storage: typeof parsed.storage === 'string' ? parsed.storage : '',
    ram: typeof parsed.ram === 'string' ? parsed.ram : '',
  };

  // Assemble the final HTML using the template + filled slots.
  const description = buildListingHtml(filled, { title, condition });

  return {
    description,
    conditionDescription: filled.conditionDescription,
    itemSpecifics: filled.itemSpecifics,
    brand: filled.brand,
    mpn: filled.mpn,
    color: filled.color,
    storage: filled.storage,
    ram: filled.ram,
    // Raw fills returned too — useful if a future UI wants to expose the
    // template slots individually for editing.
    _raw: filled,
  };
}
