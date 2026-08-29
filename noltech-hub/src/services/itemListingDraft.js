// ─── Inventory → Listing draft helper ────────────────────────────────────────
// Generates a Gemini-backed eBay listing draft for a single inventory item.
// Reuses src/services/gemini.js autofillListing — the same one ListingGenerator
// uses for paste-and-fill, so the output shape (description HTML, condition
// description, item specifics, structured fields) is identical.
//
// Persists drafts to `noltech:inventory:item-listing-drafts` keyed by item ID.
// Drafts are intentionally NOT auto-pushed to eBay — the user reviews + edits
// in the Listing Generator before sending. This service just front-loads the
// 60-second autofill so by the time you open the item to list it, the draft
// is already there.

import { autofillListing, loadGeminiKey } from './gemini';
import { logError } from './errorLog';

const DRAFTS_KEY = 'noltech:inventory:item-listing-drafts';

async function readDrafts() {
  try {
    const v = await window.storage.get(DRAFTS_KEY);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

async function writeDrafts(drafts) {
  try { await window.storage.set(DRAFTS_KEY, drafts); } catch (e) { await logError('itemListingDraft:write', e); }
}

export async function getDraftForItem(itemId) {
  if (!itemId) return null;
  const drafts = await readDrafts();
  return drafts[itemId] || null;
}

export async function deleteDraftForItem(itemId) {
  if (!itemId) return;
  const drafts = await readDrafts();
  if (drafts[itemId]) {
    delete drafts[itemId];
    await writeDrafts(drafts);
  }
}

/**
 * Build a listing draft for one inventory item. Caches the result so calling
 * twice for the same item (or re-opening the modal) returns instantly.
 *
 * @param {object} item — Inventory item
 *   Expected shape: { id, brand, model, category, condition, conditionDesc,
 *                     serialNumber, upc, mpn, photos, notes, lotId }
 * @param {object} [lot] — Parent lot (optional, for source context)
 * @param {object} [opts]
 * @param {boolean} [opts.force=false] — bypass cache and regenerate
 * @returns {Promise<object|null>}
 *   { description, conditionDescription, itemSpecifics, brand, mpn, color,
 *     storage, ram, _raw, generatedAt }
 *   Returns null if Gemini key isn't configured.
 */
export async function draftItemListing(item, lot = null, opts = {}) {
  const { force = false } = opts;
  if (!item?.id) return null;

  if (!force) {
    const cached = await getDraftForItem(item.id);
    if (cached) return cached;
  }

  const apiKey = await loadGeminiKey();
  if (!apiKey) {
    await logError('itemListingDraft', new Error('No Gemini key — configure in Settings → API Keys'));
    return null;
  }

  try {
    const result = await autofillListing(apiKey, {
      title:     item.title || `${item.brand || ''} ${item.model || ''}`.trim() || 'Item for sale',
      brand:     item.brand || '',
      mpn:       item.mpn || item.model || '',
      category:  item.category || '',
      condition: item.condition || item.conditionDesc || '',
      upc:       item.upc || '',
      notes:     [item.notes, lot?.notes, lot?.sourceName ? `Source: ${lot.sourceName}` : null].filter(Boolean).join('\n'),
      specs:     item.specs || '',
    });
    const draft = { ...result, generatedAt: new Date().toISOString(), itemId: item.id, lotId: item.lotId || lot?.id || null };
    const drafts = await readDrafts();
    drafts[item.id] = draft;
    await writeDrafts(drafts);
    return draft;
  } catch (e) {
    await logError('itemListingDraft:gemini', e, { itemId: item.id });
    return null;
  }
}
