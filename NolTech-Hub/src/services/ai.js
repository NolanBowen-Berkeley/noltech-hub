// ─── Helpers ──────────────────────────────────────────────────────────────────

export function extractJSON(text) {
  // Strip code fences if present
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1].trim() : text.trim();
  try {
    return JSON.parse(raw);
  } catch {
    // Last resort: find first [ or { to end
    const arr = raw.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
    if (arr) return JSON.parse(arr[1]);
    throw new Error('AI returned non-JSON: ' + raw.slice(0, 200));
  }
}

export async function callClaude(apiKey, systemPrompt, userMessage, maxTokens = 3000) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
    signal: AbortSignal.timeout(120000),
  });

  if (!res.ok) {
    let msg = `API error ${res.status}`;
    try {
      const body = await res.json();
      msg = body?.error?.message || msg;
    } catch { /* ignore */ }
    throw new Error(msg);
  }

  const data = await res.json();
  return data.content[0].text;
}

// Vision call — accepts a base64 image + prompt, returns extracted text
async function callClaudeVision(apiKey, systemPrompt, imageBase64, mediaType = 'image/jpeg', maxTokens = 1000) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: 'Extract the receipt information.' },
        ],
      }],
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) {
    let msg = `API error ${res.status}`;
    try { const body = await res.json(); msg = body?.error?.message || msg; } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  return data.content[0].text;
}

// ─── Receipt OCR ──────────────────────────────────────────────────────────
const RECEIPT_SYSTEM = `You extract structured data from receipt photos for an electronics reseller's bookkeeping.

Return ONLY valid JSON — no markdown, no explanation. Start with { end with }.

Schema:
{
  "vendor": "string — business name from receipt header",
  "amount": number — total amount paid (not subtotal, final total after tax),
  "date": "YYYY-MM-DD — transaction date",
  "category": "one of: Shipping, Office Supplies, Packaging, Tools, Parts, Gas, Meals, Other",
  "description": "string — brief (3-6 word) summary of what was purchased",
  "confidence": "high|medium|low — how confident you are in the extraction"
}

If any field is illegible, return empty string for strings, 0 for numbers, and set confidence to "low".`;

export async function extractReceipt(apiKey, imageBase64, mediaType) {
  const text = await callClaudeVision(apiKey, RECEIPT_SYSTEM, imageBase64, mediaType, 500);
  return extractJSON(text);
}

// ─── Manifest Parsing ─────────────────────────────────────────────────────────

const PARSE_SYSTEM = `You are an expert electronics liquidation specialist. Your job is to parse raw lot manifest text into structured JSON.

Return ONLY a valid JSON array — no explanation, no markdown fences, no extra text. Start your response with [ and end with ].

Rules:
- Each element in the array represents EXACTLY ONE physical unit.
- Expand quantities: "3x ThinkPad T480" or "ThinkPad T480 x3" → three separate objects.
- If condition is not mentioned, use "unknown".
- Extract every spec detail you can find (CPU, RAM, storage, screen size, etc.).
- Use the most specific brand/model you can identify from context.
- For vague entries like "mixed tablets" with no count, create one entry.

Each object must follow this exact schema — no extra keys:
{
  "brand": "string",
  "model": "string",
  "fullName": "string — readable brand + model + key specs, e.g. Dell Latitude 5480 i5 8GB 256GB",
  "category": "laptop|desktop|tablet|phone|monitor|gpu|ram|ssd|drive|printer|server|networking|peripheral|other",
  "condition": "new|like_new|good|fair|poor|unknown",
  "specs": "string — CPU, RAM, storage, screen, etc. Empty string if unknown.",
  "notes": "string — damage, missing parts, special flags. Empty string if none.",
  "sourceLine": "string — the exact manifest line this item came from"
}`;

export async function parseManifest(apiKey, manifestText) {
  const maxTokens = Math.max(2000, Math.min(8000, manifestText.split('\n').length * 200));
  const text = await callClaude(
    apiKey,
    PARSE_SYSTEM,
    `Parse this liquidation lot manifest:\n\n${manifestText}`,
    maxTokens
  );
  const items = extractJSON(text);
  if (!Array.isArray(items)) throw new Error('Unexpected AI response structure');
  return items.map((item) => ({
    id: crypto.randomUUID(),
    brand:       String(item.brand    || '').trim(),
    model:       String(item.model    || '').trim(),
    fullName:    String(item.fullName || `${item.brand} ${item.model}`).trim(),
    category:    String(item.category || 'other'),
    condition:   String(item.condition|| 'unknown'),
    specs:       String(item.specs    || '').trim(),
    notes:       String(item.notes    || '').trim(),
    sourceLine:  String(item.sourceLine || '').trim(),
    // valuation fields (filled in step 3)
    estimatedValue: null,
    lowValue:       null,
    highValue:      null,
    yourValue:      null,
    confidence:     null,
    valuationNotes: null,
  }));
}

// ─── Listing Generation ───────────────────────────────────────────────────────

const LISTINGS_SYSTEM = `You are an expert eBay listing copywriter for an electronics resale business.

Return ONLY a valid JSON array — no markdown, no explanation. Start with [ and end with ].

For each item, match by its 0-based index and provide:
{
  "index": 0,
  "title": "string",
  "conditionSummary": "string",
  "whatsIncluded": "string"
}

TITLE RULES — read carefully, these are strict:
- HARD LIMIT: 80 characters maximum — count every character including spaces and dashes
- Format: [Brand] [Model] [Key Specs] - [Condition Keyword]
- Lead with Brand + Model: "Dell Latitude 5480", "Lenovo ThinkPad T480", "HP EliteBook 840 G5"
- Include key specs: CPU (e.g. "i5-7300U" or "i5 7th Gen"), RAM (e.g. "8GB"), Storage (e.g. "256GB SSD"), screen size for laptops (e.g. 14in)
- Condition keyword at the end after a dash: "Tested Working" (good/like_new), "For Parts/Repair" (broken/poor), "Untested AS-IS" (unknown)
- NO filler words: no "Great", "Excellent", "Beautiful", "Nice", "Must See", "Fast Shipping", "Look"
- Abbreviate: GB not Gigabyte, SSD not Solid State, Win10/Win11 not Windows 10

CONDITION SUMMARY RULES:
- 2–3 sentences, honest and specific
- State what was verified (e.g. "Powers on and boots to Windows. All ports tested functional.")
- Call out any defects from the notes field: scratches, cracks, missing keys, dead pixels, missing parts
- For "unknown" condition: "Unit untested — sourced from a commercial liquidation lot. Condition unknown. Sold as-is."
- Do NOT invent defects or conditions not mentioned

WHAT'S INCLUDED RULES:
- Start with the device type: "Laptop only." / "Desktop tower only." / "GPU only."
- Add any accessories explicitly mentioned in the notes
- Default for laptops/desktops: end with "No charger or power cable included." unless notes say otherwise`;

export async function generateListings(apiKey, items) {
  const itemList = items
    .map(
      (it, i) =>
        `${i}. ${it.fullName} | category: ${it.category} | condition: ${it.condition}` +
        (it.specs ? ` | specs: ${it.specs}` : '') +
        (it.notes ? ` | notes: ${it.notes}` : '')
    )
    .join('\n');

  const maxTokens = Math.max(2000, Math.min(8000, items.length * 280 + 500));
  const text = await callClaude(
    apiKey,
    LISTINGS_SYSTEM,
    `Generate eBay listing titles and condition descriptions for these ${items.length} items:\n\n${itemList}`,
    maxTokens
  );
  const listings = extractJSON(text);
  if (!Array.isArray(listings)) throw new Error('Unexpected AI response structure');
  return listings;
}

export function buildListingHTML(item, listing) {
  const specsHtml = item.specs
    ? item.specs
        .split(/[,;|]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((spec) => {
          const colonIdx = spec.indexOf(':');
          if (colonIdx > 0) {
            return `<tr style="border-bottom:1px solid #E2E8F0"><td style="padding:5px 10px 5px 0;font-weight:600;color:#475569;width:40%;white-space:nowrap">${spec.slice(0, colonIdx).trim()}</td><td style="padding:5px 0">${spec.slice(colonIdx + 1).trim()}</td></tr>`;
          }
          return `<tr style="border-bottom:1px solid #E2E8F0"><td colspan="2" style="padding:5px 0">${spec}</td></tr>`;
        })
        .join('')
    : '';

  const overview = [item.brand, item.model, item.specs].filter(Boolean).join(' — ');

  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:680px;margin:0 auto;color:#1E293B;line-height:1.6">
<div style="background:#1A5276;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
<h2 style="margin:0;font-size:17px;font-weight:700">${listing.title}</h2>
<p style="margin:5px 0 0;font-size:12px;opacity:.75">Electronics Resale Specialist</p>
</div>
<div style="border:1px solid #E2E8F0;border-top:none;padding:20px;border-radius:0 0 8px 8px">

<h3 style="margin:0 0 8px;color:#1A5276;font-size:14px;text-transform:uppercase;border-bottom:2px solid #1A5276;padding-bottom:5px">Product Overview</h3>
<p style="margin:0 0 16px;font-size:14px">${overview}.</p>

${specsHtml ? `<h3 style="margin:0 0 8px;color:#1A5276;font-size:14px;text-transform:uppercase;border-bottom:2px solid #1A5276;padding-bottom:5px">Specifications</h3>
<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px"><tbody>${specsHtml}</tbody></table>` : ''}

<h3 style="margin:0 0 8px;color:#1A5276;font-size:14px;text-transform:uppercase;border-bottom:2px solid #1A5276;padding-bottom:5px">Condition Notes</h3>
<p style="margin:0 0 16px;font-size:14px">${listing.conditionSummary}</p>

<h3 style="margin:0 0 8px;color:#1A5276;font-size:14px;text-transform:uppercase;border-bottom:2px solid #1A5276;padding-bottom:5px">What's Included</h3>
<p style="margin:0 0 16px;font-size:14px">${listing.whatsIncluded}</p>

<h3 style="margin:0 0 8px;color:#1A5276;font-size:14px;text-transform:uppercase;border-bottom:2px solid #1A5276;padding-bottom:5px">Shipping &amp; Returns</h3>
<p style="margin:0 0 16px;font-size:14px">Ships within 1&ndash;2 business days of cleared payment. Items are carefully packed with bubble wrap and foam padding. 30-day returns accepted &mdash; item must be returned in the same condition as received.</p>

<div style="background:#FFFBEB;border:1px solid #F59E0B;border-radius:6px;padding:12px 14px;font-size:12px;color:#92400E">
<strong>&#9888; Liquidation Disclosure:</strong> This item was sourced from a commercial liquidation lot. It has been inspected and tested to the degree described in Condition Notes above. NolTech is not an authorized reseller and cannot transfer or guarantee manufacturer warranty status. All sales are final unless the item is significantly not as described.
</div>

<p style="text-align:center;color:#94A3B8;font-size:11px;margin:16px 0 0">Thank you for shopping with NolTech &bull; Questions? Message us before purchasing!</p>
</div>
</div>`;
}

// ─── Valuation ────────────────────────────────────────────────────────────────

const VALUE_SYSTEM = `You are an expert electronics reseller with deep knowledge of eBay sold prices (completed listings).

Return ONLY a valid JSON array — no markdown, no explanation. Start with [ and end with ].

For each item, match by its 0-based index and provide:
{
  "index": 0,
  "estimatedValue": 285,
  "lowValue": 160,
  "highValue": 380,
  "confidence": "high|medium|low",
  "valuationNotes": "One or two sentences: key value factors, model variants, condition impact."
}

Pricing guidelines:
- Use eBay SOLD prices (not listed/asking prices).
- confidence "high" = well-known model with clear market; "medium" = known model but wide variance; "low" = vague item, rare, or insufficient data.
- Be conservative for liquidation: items may have unlisted issues.
- For "unknown" condition, use fair-to-poor assumption.
- Note if a spec variation significantly affects price.
- Your training data extends to August 2025; flag if market has likely shifted.`;

export async function valuateItems(apiKey, items) {
  const itemList = items
    .map(
      (it, i) =>
        `${i}. ${it.fullName} | category: ${it.category} | condition: ${it.condition}` +
        (it.specs ? ` | specs: ${it.specs}` : '') +
        (it.notes ? ` | notes: ${it.notes}` : '')
    )
    .join('\n');

  const maxTokens = Math.max(1500, Math.min(8000, items.length * 120 + 500));
  const text = await callClaude(
    apiKey,
    VALUE_SYSTEM,
    `Value these ${items.length} electronics items for eBay resale:\n\n${itemList}`,
    maxTokens
  );
  const valuations = extractJSON(text);
  if (!Array.isArray(valuations)) throw new Error('Unexpected AI response structure');
  return valuations;
}
