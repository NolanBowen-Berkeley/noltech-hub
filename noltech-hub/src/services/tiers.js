// Storage key for user tier (cache only — source of truth is the `subscriptions` table in Supabase when cloud is enabled)
const TIER_KEY = 'noltech:account:tier';
const TRIAL_KEY = 'noltech:account:trial';

import { supabase, isCloudEnabled, getCurrentUser } from './supabase';

// Tier definitions
export const TIERS = {
  free: {
    name: 'Scout',
    label: 'Free',
    price: 0,
    color: 'slate',
    features: ['hub', 'source', 'settings'],
    description: 'Discover deals across liquidation sites',
  },
  pro: {
    name: 'Pro',
    label: '$29/mo',
    price: 29,
    color: 'primary',
    features: [
      'hub', 'source', 'bidding', 'settings',
      'inventory', 'sell',
    ],
    description: 'Full inventory management + selling tools',
  },
  business: {
    name: 'Business',
    label: '$59/mo',
    price: 59,
    color: 'accent',
    features: [
      'hub', 'source', 'bidding', 'settings',
      'inventory', 'sell', 'finance',
    ],
    description: 'Complete business suite with finance & operations',
  },
};

// Get current tier from storage (sync — reads cached value)
// Default to 'business' ONLY in offline mode. When cloud is enabled,
// the server-side `subscriptions` table is authoritative.
let _cachedTier = isCloudEnabled ? 'free' : 'business';

export async function loadTier() {
  // Offline: trust local cache (single-user installs)
  if (!isCloudEnabled) {
    try {
      const tier = await window.storage.get(TIER_KEY);
      _cachedTier = tier || 'business';
      return _cachedTier;
    } catch { return 'business'; }
  }

  // Cloud: fetch from subscriptions table (RLS ensures user can only read own row)
  try {
    const user = await getCurrentUser();
    if (!user) { _cachedTier = 'free'; return 'free'; }

    const { data, error } = await supabase
      .from('subscriptions')
      .select('tier, status, current_period_end, trial_ends_at')
      .eq('user_id', user.id)
      .maybeSingle();

    if (error || !data) { _cachedTier = 'free'; return 'free'; }

    // Honor trial + active subscription; expired/canceled → free
    const now = Date.now();
    const trialActive = data.trial_ends_at && new Date(data.trial_ends_at).getTime() > now;
    const subActive = data.status === 'active' && (!data.current_period_end || new Date(data.current_period_end).getTime() > now);

    if (trialActive || subActive) {
      _cachedTier = data.tier || 'free';
    } else {
      _cachedTier = 'free';
    }

    // Cache locally for offline fallback
    try { await window.storage.set(TIER_KEY, _cachedTier); } catch {}
    return _cachedTier;
  } catch {
    _cachedTier = 'free';
    return 'free';
  }
}

export function getUserTier() {
  return _cachedTier;
}

// Setting tier client-side only works offline. Cloud tier is controlled
// server-side (Stripe webhook → subscriptions table via service role).
export async function setUserTier(tier) {
  if (isCloudEnabled) {
    console.warn('[tiers] Cannot set tier client-side when cloud is enabled. Tier is controlled by subscription status.');
    return;
  }
  _cachedTier = tier;
  await window.storage.set(TIER_KEY, tier);
}

export function canAccess(/* featureId */) {
  // Feature gating disabled — single-user app, no upsell flow needed.
  // Every feature is always accessible. Other tier helpers (loadTier,
  // getUserTier, TIERS map) still exist so any UI that displays tier
  // badges keeps rendering without breaking, but access checks are no-ops.
  return true;
}

export function getRequiredTier(featureId) {
  // Find lowest tier that includes this feature
  for (const [key, tier] of Object.entries(TIERS)) {
    if (tier.features.includes(featureId)) return { key, ...tier };
  }
  return { key: 'business', ...TIERS.business };
}

// Trial management — offline only. Cloud trials are server-side (subscriptions.trial_ends_at).
export async function startTrial() {
  if (isCloudEnabled) {
    console.warn('[tiers] Trials are managed server-side when cloud is enabled.');
    return null;
  }
  const trial = { startedAt: new Date().toISOString(), durationDays: 7 };
  await window.storage.set(TRIAL_KEY, trial);
  _cachedTier = 'business'; // full access during trial
  await window.storage.set(TIER_KEY, 'business');
  return trial;
}

export async function checkTrial() {
  try {
    const trial = await window.storage.get(TRIAL_KEY);
    if (!trial) return { active: false };
    const elapsed = (Date.now() - new Date(trial.startedAt).getTime()) / 86400000;
    const remaining = Math.max(0, trial.durationDays - elapsed);
    return { active: remaining > 0, remaining: Math.ceil(remaining), startedAt: trial.startedAt };
  } catch { return { active: false }; }
}
