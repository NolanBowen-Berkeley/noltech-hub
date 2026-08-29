// Supabase client wrapper. One factory per Worker invocation. Service-role
// key bypasses RLS (correct for backend write paths).

import { createClient } from '@supabase/supabase-js';
import { SupabaseError } from '../lib/errors.js';

let cached = null;

export function getSupabase(env) {
  if (cached) return cached;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    throw new SupabaseError('init', new Error('SUPABASE_URL or SUPABASE_SERVICE_KEY missing'));
  }
  cached = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
  return cached;
}

/**
 * Wraps a Supabase query and throws SupabaseError on error. Use this whenever
 * a silent failure would leave bad state on disk (every upsert and update
 * across the pipeline).
 */
export async function mustOk(operation, builder) {
  const { data, error } = await builder;
  if (error) throw new SupabaseError(operation, error);
  return data;
}

/**
 * Same as mustOk but uses .select().maybeSingle() under the hood so the
 * returned row's existence is verified. Throws on either error OR missing
 * row — catches the ON CONFLICT silently-skipped scenario that hid schema
 * mismatches in the old code.
 */
export async function mustReturnRow(operation, builder) {
  const { data, error } = await builder.select('*').maybeSingle();
  if (error) throw new SupabaseError(operation, error);
  if (!data) throw new SupabaseError(operation, new Error('no row returned (RLS skip or conflict-update mismatch)'));
  return data;
}
