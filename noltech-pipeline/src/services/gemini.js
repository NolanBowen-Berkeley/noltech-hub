// ─── Google Gemini client ────────────────────────────────────────────────────
// Used for grounded desktop part-out: Gemini researches the desktop model
// online via google_search and returns its decomposed components.
//
// Ported verbatim from scraper-worker/src/geminiPartOut.js so behavior is
// identical to what the user already validated locally.

const MODEL = 'gemini-2.5-flash';
const DEFAULT_TIMEOUT_MS = 30000;
const SEARCH_TIMEOUT_MS  = 45000;

/**
 * Single Gemini call. Returns the response text (joined parts).
 *
 * @param {string} apiKey
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {object} [opts]
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.maxRetries]
 * @param {boolean} [opts.useSearch] — enable google_search grounding
 */
export async function callGemini(apiKey, systemPrompt, userMessage, opts = {}) {
  const { maxTokens = 800, maxRetries = 2, useSearch = false } = opts;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const generationConfig = { temperature: 0.2, maxOutputTokens: maxTokens };
  if (!useSearch) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.thinkingConfig   = { thinkingBudget: 0 };
  }

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    generationConfig,
    ...(useSearch ? { tools: [{ google_search: {} }] } : {}),
  };

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(useSearch ? SEARCH_TIMEOUT_MS : DEFAULT_TIMEOUT_MS),
    });
    if (res.ok) {
      const data = await res.json();
      return data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('\n') || '';
    }
    const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
    if (!retryable || attempt >= maxRetries) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Gemini ${res.status}: ${txt.slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, Math.min(20000, 2000 * Math.pow(2, attempt))));
  }
}
