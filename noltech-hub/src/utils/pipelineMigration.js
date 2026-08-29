// ─── One-time cloud-scraper → local-pipeline settings migration ──────────────
// The Hub used to point at a Cloudflare Worker, with its URL and bearer token
// stored under noltech:settings:cloud-scraper-{base,token}. That deployment is
// retired and the pipeline now runs locally.
//
// Left alone, an existing install would keep firing every scrape at a
// *.workers.dev host that no longer resolves, and the failures would look like
// scraper bugs rather than stale config. This clears that.
//
// Behavior:
//   - A stored *.workers.dev base is DISCARDED — it's dead, and falling back
//     to the local default is what the user wants.
//   - Any other stored base is CARRIED OVER: it means the pipeline was reached
//     through a custom domain or a LAN host, which still works.
//   - The encrypted token is carried over either way. It's harmless when the
//     local service runs without auth, and required if it doesn't.
//
// Idempotent: runs once, then records a marker key and no-ops thereafter.

import {
  PIPELINE_BASE_KEY, PIPELINE_TOKEN_KEY,
  LEGACY_CLOUD_SCRAPER_BASE_KEY, LEGACY_CLOUD_SCRAPER_TOKEN_KEY,
} from './constants';

const MIGRATION_KEY = 'noltech:settings:pipeline-migrated';

function isDeadWorkerUrl(url) {
  return /(^|\/\/)([^/]*\.)?workers\.dev(\/|$|:)/i.test(String(url || ''));
}

export async function migrateCloudScraperSettings() {
  try {
    if (await window.storage.get(MIGRATION_KEY)) return { migrated: false, reason: 'already-run' };

    const legacyBase  = await window.storage.get(LEGACY_CLOUD_SCRAPER_BASE_KEY);
    const legacyToken = await window.storage.get(LEGACY_CLOUD_SCRAPER_TOKEN_KEY);

    const result = { migrated: true, base: null, token: false, discarded: null };

    // Never clobber a value the user already set on the new key.
    const existingBase = await window.storage.get(PIPELINE_BASE_KEY);
    if (!existingBase && legacyBase) {
      if (isDeadWorkerUrl(legacyBase)) {
        result.discarded = legacyBase;
      } else {
        await window.storage.set(PIPELINE_BASE_KEY, legacyBase);
        result.base = legacyBase;
      }
    }

    const existingToken = await window.storage.get(PIPELINE_TOKEN_KEY);
    if (!existingToken && legacyToken) {
      // Copied still-encrypted — no decrypt/re-encrypt round trip needed.
      await window.storage.set(PIPELINE_TOKEN_KEY, legacyToken);
      result.token = true;
    }

    await window.storage.set(MIGRATION_KEY, new Date().toISOString());

    // Legacy keys are left in place deliberately: if this migration got
    // something wrong, the original values are still recoverable by hand.
    if (result.discarded) {
      console.info('[pipelineMigration] discarded dead worker URL, using local default:', result.discarded);
    } else if (result.base) {
      console.info('[pipelineMigration] carried over custom pipeline base:', result.base);
    }

    return result;
  } catch (e) {
    console.warn('[pipelineMigration] failed:', e?.message);
    return { migrated: false, error: e?.message };
  }
}
