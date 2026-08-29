// ─── Phone alerts ────────────────────────────────────────────────────────────
// Sends a push notification to the user's phone via a configurable webhook.
// Electron itself can't reach a phone, so we route through one of these
// intermediaries (all free; one URL field, format auto-detected):
//
//   • ntfy.sh — zero-account. Install the ntfy app on phone, subscribe to a
//     topic. URL: https://ntfy.sh/<your-topic-name>. The topic acts as the
//     channel — pick something unguessable so randoms can't ping you.
//
//   • Discord webhook — copy a channel webhook URL from server settings.
//     Posts as the webhook bot; Discord app on phone surfaces it.
//
//   • Custom webhook — anything that accepts POST JSON
//     { title, message, at } at a URL. For Zapier / IFTTT / your own server.
//
// URL stored at `noltech:settings:phone-webhook`. Optional; absence = no-op.
//
// Best-effort: a phone push failure should never throw to the caller, since
// callers are usually fire-and-forget background hooks.

import { logError } from './errorLog';

const KEY = 'noltech:settings:phone-webhook';

export async function getPhoneWebhookUrl() {
  try {
    const v = await window.storage.get(KEY);
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

export async function setPhoneWebhookUrl(url) {
  try { await window.storage.set(KEY, (url || '').trim()); } catch (e) { await logError('phoneAlerts:save', e); }
}

// Quick send for the "test" button in Settings — returns { ok, error }.
export async function testPhoneAlert() {
  return sendPhoneAlertInternal('NolTech test alert', 'If you see this on your phone, the webhook is working.', { surfaceError: true });
}

/**
 * Send a notification to the configured phone webhook.
 * @returns {Promise<boolean>} true if the URL is set and the request resolved 2xx.
 */
export async function sendPhoneAlert(title, message) {
  return sendPhoneAlertInternal(title, message, { surfaceError: false }).then((r) => r.ok);
}

async function sendPhoneAlertInternal(title, message, { surfaceError }) {
  const url = await getPhoneWebhookUrl();
  if (!url) return { ok: false, error: 'no_webhook_configured' };
  try {
    let res;
    if (/ntfy\.sh/i.test(url)) {
      res = await fetch(url, {
        method: 'POST',
        // ntfy uses HTTP headers for title/priority. Body is the message text.
        headers: { 'Title': title, 'Content-Type': 'text/plain' },
        body: message,
        signal: AbortSignal.timeout(8000),
      });
    } else if (/discord\.com\/api\/webhooks/i.test(url)) {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `**${title}**\n${message}` }),
        signal: AbortSignal.timeout(8000),
      });
    } else {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, message, at: new Date().toISOString(), source: 'noltech-hub' }),
        signal: AbortSignal.timeout(8000),
      });
    }
    if (!res.ok) {
      const err = `Webhook returned HTTP ${res.status}`;
      if (surfaceError) await logError('phoneAlert', new Error(err));
      return { ok: false, error: err };
    }
    return { ok: true };
  } catch (e) {
    if (surfaceError) await logError('phoneAlert', e);
    return { ok: false, error: e?.message || 'unknown' };
  }
}
