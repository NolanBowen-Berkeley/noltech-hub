// Server-side Supabase client. Uses the service-role key, so it BYPASSES RLS —
// every query/insert this client makes is fully privileged. Keep its usage
// confined to the agent process; never ship this module to a browser.

import { createClient } from '@supabase/supabase-js';
import config from './config.js';

const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey, {
  auth: {
    // The agent has no user session — service key is the auth.
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
  global: {
    headers: {
      'x-client-info': 'noltech-sync-agent',
    },
  },
});

export default supabase;
export { supabase };
