// ─── Shipping Slip ────────────────────────────────────────────────────────────
// Opens a print-optimized window for a packing slip given an order-like object.
// Expects: { orderId, title, sku, qty, buyer, shipTo: {name, street1, street2, city, state, postalCode, country, phone}, date }
// Optional: fromAddress string for return address.

import { BUSINESS_DEFAULTS } from './constants';

// Default return address. Override per-call via the `fromAddress` argument,
// or edit BUSINESS_DEFAULTS in utils/constants.js for a shop-wide change.
const FROM_ADDRESS = {
  name: BUSINESS_DEFAULTS.name,
  street1: BUSINESS_DEFAULTS.location,
  city: '',
  state: '',
  postalCode: '',
};

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function printShippingSlip(order, fromAddress = FROM_ADDRESS) {
  const ship = order.shipTo || {};
  const hasAddress = ship.street1 || ship.city;

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Packing Slip ${esc(order.orderId || '')}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Arial, sans-serif; margin: 0; padding: 24px; color: #1E293B; }
  .slip { max-width: 680px; margin: 0 auto; border: 2px solid #1A5276; border-radius: 8px; padding: 24px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1A5276; padding-bottom: 12px; margin-bottom: 16px; }
  .brand { font-size: 22px; font-weight: 700; color: #1A5276; }
  .meta { text-align: right; font-size: 11px; color: #64748B; }
  .row { display: flex; gap: 24px; margin-bottom: 16px; }
  .box { flex: 1; }
  .label { font-size: 10px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
  .addr { font-size: 13px; line-height: 1.5; white-space: pre-line; }
  .item { border-top: 1px solid #E2E8F0; padding-top: 12px; margin-top: 8px; }
  .item-title { font-size: 14px; font-weight: 600; margin-bottom: 6px; }
  .item-meta { font-size: 11px; color: #64748B; font-family: ui-monospace, monospace; }
  .footer { margin-top: 24px; padding-top: 12px; border-top: 1px dashed #CBD5E1; font-size: 11px; color: #64748B; text-align: center; }
  @media print { body { padding: 0; } .slip { border-color: #000; } button { display: none; } }
  .print-btn { position: fixed; top: 12px; right: 12px; padding: 10px 18px; background: #1A5276; color: white; border: 0; border-radius: 6px; font-weight: 600; cursor: pointer; }
</style></head>
<body>
<button class="print-btn" onclick="window.print()">Print</button>
<div class="slip">
  <div class="header">
    <div>
      <div class="brand">${esc(fromAddress.name || 'NolTech')}</div>
      <div style="font-size:11px;color:#64748B;margin-top:4px">Packing Slip</div>
    </div>
    <div class="meta">
      Order: <strong>${esc(order.orderId || '—')}</strong><br/>
      Date: ${esc(order.date || new Date().toISOString().slice(0,10))}<br/>
      ${order.sku ? `SKU: <strong>${esc(order.sku)}</strong>` : ''}
    </div>
  </div>

  <div class="row">
    <div class="box">
      <div class="label">From</div>
      <div class="addr">${esc(fromAddress.name || '')}
${esc(fromAddress.street1 || '')}
${[fromAddress.city, fromAddress.state, fromAddress.postalCode].filter(Boolean).join(', ')}</div>
    </div>
    <div class="box">
      <div class="label">Ship To</div>
      <div class="addr">${hasAddress ? [
        esc(ship.name || order.buyer || ''),
        esc(ship.street1 || ''),
        ship.street2 ? esc(ship.street2) : '',
        esc([ship.city, ship.state, ship.postalCode].filter(Boolean).join(', ')),
        ship.country && ship.country !== 'US' ? esc(ship.country) : '',
        ship.phone ? 'Phone: ' + esc(ship.phone) : '',
      ].filter(Boolean).join('\n') : '<em style="color:#94A3B8">No address on file — look up on eBay</em>'}</div>
    </div>
  </div>

  <div class="item">
    <div class="label">Item</div>
    <div class="item-title">${esc(order.title || 'Item')}</div>
    <div class="item-meta">
      ${order.sku ? `SKU: ${esc(order.sku)} &nbsp;•&nbsp; ` : ''}
      Qty: ${esc(order.qty || 1)}
      ${order.ebayItemId ? ` &nbsp;•&nbsp; eBay Item: ${esc(order.ebayItemId)}` : ''}
    </div>
  </div>

  <div class="footer">
    Thank you for your purchase! Questions? Message us on eBay.<br/>
    30-day returns accepted — contact us before returning.
  </div>
</div>
<script>setTimeout(() => window.print(), 300);</script>
</body></html>`;

  const w = window.open('', '_blank', 'width=720,height=900');
  if (!w) {
    alert('Popup blocked. Please allow popups to print shipping slips.');
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}
