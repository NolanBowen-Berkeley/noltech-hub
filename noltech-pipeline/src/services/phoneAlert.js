// ─── Phone-alert dispatcher ──────────────────────────────────────────────────
// Sends structured bid alerts to ntfy / Discord / custom webhooks. Each
// platform gets a payload native to its formatting model — Discord gets
// rich embeds with color-coded urgency and clickable lot links, ntfy gets
// priority + tag headers, custom webhooks get a fuller structured JSON.
//
// Signature is back-compat: legacy callers passing (url, title, message)
// still work; new callers pass an `alert` object with richer context.

const NOLTECH_COLORS = {
  imminent: 0xE74C3C, // brand danger — closing in <5m or already past
  soon:     0xF39C12, // brand warning — 5-15m
  early:    0x2E86C1, // brand secondary blue — informational
  good:     0x27AE60, // brand success — under ceiling with margin
  neutral:  0x1A5276, // brand primary
};

const NTFY_PRIORITY = {
  imminent: '5', // max
  soon:     '4',
  early:    '3',
  good:     '3',
  neutral:  '3',
};

/**
 * Send a phone alert.
 *
 * Modern signature (preferred):
 *   sendPhoneAlert(url, {
 *     title:        string,           // short headline
 *     message:      string,           // optional plain-text body
 *     urgency:      'imminent'|'soon'|'early'|'good'|'neutral',
 *     lotTitle:     string,           // shown as embed description
 *     lotUrl:       string,           // clickable in Discord
 *     lotId:        string,
 *     asking:       number,           // current ask in USD
 *     ceiling:      number,           // user's ceiling in USD
 *     minutesLeft:  number,
 *     source:       string,           // 'liquidation.com' etc.
 *     imageUrl:     string,           // proxied lot thumbnail (Discord/ntfy render)
 *     extras:       Record<string,string>, // additional fields to show
 *   })
 *
 * Legacy signature (still supported):
 *   sendPhoneAlert(url, title, message)
 */
export async function sendPhoneAlert(url, alertOrTitle, maybeMessage) {
  if (!url || typeof url !== 'string') return { ok: false, error: 'no_url' };

  const alert = typeof alertOrTitle === 'object' && alertOrTitle !== null
    ? alertOrTitle
    : { title: String(alertOrTitle || ''), message: String(maybeMessage || '') };

  try {
    const res = /ntfy\.sh/i.test(url)
      ? await sendNtfy(url, alert)
      : /discord\.com\/api\/webhooks/i.test(url)
      ? await sendDiscord(url, alert)
      : await sendCustom(url, alert);

    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || 'unknown' };
  }
}

// ─── Discord ────────────────────────────────────────────────────────────────

function sendDiscord(url, alert) {
  const urgency = alert.urgency || 'neutral';
  const color   = NOLTECH_COLORS[urgency] || NOLTECH_COLORS.neutral;
  const icon    = urgencyIcon(urgency);

  const fields = [];

  if (Number.isFinite(alert.asking)) {
    fields.push({
      name:   'Current ask',
      value:  formatMoney(alert.asking),
      inline: true,
    });
  }
  if (Number.isFinite(alert.ceiling) && alert.ceiling > 0) {
    fields.push({
      name:   'Your ceiling',
      value:  formatMoney(alert.ceiling),
      inline: true,
    });
  }
  if (Number.isFinite(alert.asking) && Number.isFinite(alert.ceiling) && alert.ceiling > 0) {
    const headroom = alert.ceiling - alert.asking;
    const headroomPct = (headroom / alert.ceiling) * 100;
    const sign = headroom >= 0 ? '+' : '';
    fields.push({
      name:   'Headroom',
      value:  `${sign}${formatMoney(headroom)} (${sign}${headroomPct.toFixed(1)}%)`,
      inline: true,
    });
  }
  if (Number.isFinite(alert.minutesLeft) && alert.minutesLeft > 0) {
    fields.push({
      name:   'Time left',
      value:  formatDuration(alert.minutesLeft),
      inline: true,
    });
  }
  if (alert.source) {
    fields.push({ name: 'Source', value: alert.source, inline: true });
  }
  // Custom extras — caller can pass key/value strings to add to the embed
  if (alert.extras && typeof alert.extras === 'object') {
    for (const [name, value] of Object.entries(alert.extras)) {
      if (value == null || value === '') continue;
      fields.push({ name, value: String(value).slice(0, 1024), inline: true });
    }
  }

  const embed = {
    title:       `${icon} ${alert.title || 'Bid alert'}`.slice(0, 256),
    description: (alert.lotTitle || alert.message || '').slice(0, 4096),
    url:         alert.lotUrl || undefined,
    color,
    fields:      fields.slice(0, 25), // Discord max
    // Thumbnail (top-right ~80x80) over large image — keeps embeds compact
    // so multiple closing-window alerts fit on a phone screen without
    // forcing scroll past the pricing fields.
    thumbnail:   alert.imageUrl ? { url: alert.imageUrl } : undefined,
    footer:      { text: 'NolTech Hub · Bid Alert' },
    timestamp:   new Date().toISOString(),
  };

  // Add a money @everyone-style mention for imminent alerts. Discord
  // will only ping if the webhook's "Allow @everyone" is enabled in
  // server settings; otherwise it's just text.
  const content = urgency === 'imminent' ? '@here closing very soon' : undefined;

  return fetch(url, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username:   'NolTech Bids',
      content,
      embeds:     [embed],
      allowed_mentions: { parse: urgency === 'imminent' ? ['everyone'] : [] },
    }),
    signal: AbortSignal.timeout(10000),
  });
}

// ─── ntfy ───────────────────────────────────────────────────────────────────

function sendNtfy(url, alert) {
  const urgency  = alert.urgency || 'neutral';
  const priority = NTFY_PRIORITY[urgency] || '3';
  const tags = ['money_bag'];
  if (urgency === 'imminent') tags.push('rotating_light');
  else if (urgency === 'soon') tags.push('warning');
  else if (urgency === 'good') tags.push('white_check_mark');

  // Body lines
  const bodyLines = [];
  if (alert.lotTitle) bodyLines.push(alert.lotTitle);
  if (Number.isFinite(alert.asking))  bodyLines.push(`Ask: ${formatMoney(alert.asking)}`);
  if (Number.isFinite(alert.ceiling)) bodyLines.push(`Ceiling: ${formatMoney(alert.ceiling)}`);
  if (Number.isFinite(alert.minutesLeft) && alert.minutesLeft > 0) {
    bodyLines.push(`Closes in ${formatDuration(alert.minutesLeft)}`);
  }
  const body = bodyLines.join('\n') || (alert.message || '');

  const headers = {
    Title:    (alert.title || 'Bid alert').slice(0, 200),
    Priority: priority,
    Tags:     tags.join(','),
    'Content-Type': 'text/plain',
  };
  if (alert.lotUrl) {
    headers.Click  = alert.lotUrl;
    headers.Actions = `view, Open lot, ${alert.lotUrl}, clear=true`;
  }
  if (alert.imageUrl) headers.Icon = alert.imageUrl;

  return fetch(url, {
    method:  'POST',
    headers,
    body,
    signal:  AbortSignal.timeout(10000),
  });
}

// ─── Custom (catch-all) ─────────────────────────────────────────────────────

function sendCustom(url, alert) {
  return fetch(url, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title:        alert.title || '',
      message:      alert.message || alert.lotTitle || '',
      urgency:      alert.urgency || 'neutral',
      lot: {
        title:      alert.lotTitle || null,
        url:        alert.lotUrl || null,
        id:         alert.lotId || null,
        source:     alert.source || null,
        imageUrl:   alert.imageUrl || null,
      },
      pricing: {
        asking:     Number.isFinite(alert.asking)  ? alert.asking  : null,
        ceiling:    Number.isFinite(alert.ceiling) ? alert.ceiling : null,
        headroom:   (Number.isFinite(alert.asking) && Number.isFinite(alert.ceiling))
                    ? alert.ceiling - alert.asking : null,
      },
      timing: {
        minutesLeft: Number.isFinite(alert.minutesLeft) ? alert.minutesLeft : null,
      },
      extras: alert.extras || {},
      at:     new Date().toISOString(),
      source: 'noltech-pipeline',
    }),
    signal: AbortSignal.timeout(10000),
  });
}

// ─── Formatting helpers ─────────────────────────────────────────────────────

function formatMoney(n) {
  if (!Number.isFinite(n)) return '—';
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function formatDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return '—';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function urgencyIcon(urgency) {
  switch (urgency) {
    case 'imminent': return '🚨';
    case 'soon':     return '⏰';
    case 'early':    return '🔔';
    case 'good':     return '✅';
    default:         return '📢';
  }
}
