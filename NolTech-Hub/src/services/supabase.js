// ─── Supabase Client ───────────────────────────────────────────────────────────
// Centralized Supabase client + auth helpers. All cloud sync features go through here.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isCloudEnabled = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

export const supabase = isCloudEnabled
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false, // Electron doesn't have URL-based flows
      },
    })
  : null;

// ─── Auth helpers ───────────────────────────────────────────────────────────

export async function getCurrentUser() {
  if (!supabase) return null;
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

export async function getSession() {
  if (!supabase) return null;
  const { data: { session } } = await supabase.auth.getSession();
  return session;
}

// ─── Password policy ────────────────────────────────────────────────────────
// Min 8 chars, at least one letter + one number. Blocks the worst 20 common passwords.
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', 'qwerty123',
  'qwertyuiop', 'iloveyou1', 'welcome1', 'admin123', 'letmein1', 'monkey123',
  'football1', 'princess1', 'sunshine1', 'master123', 'shadow123', 'superman1',
  'baseball1', 'trustno1',
]);

export function validatePassword(pw) {
  if (!pw || pw.length < 8) return 'Password must be at least 8 characters.';
  if (!/[a-zA-Z]/.test(pw)) return 'Password must contain at least one letter.';
  if (!/[0-9]/.test(pw)) return 'Password must contain at least one number.';
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) return 'That password is too common — pick something less obvious.';
  return null;
}

export async function signUp(email, password) {
  if (!supabase) return { error: { message: 'Cloud not configured' } };
  const pwErr = validatePassword(password);
  if (pwErr) return { error: { message: pwErr } };
  return supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: undefined },
  });
}

export async function requestPasswordReset(email) {
  if (!supabase) return { error: { message: 'Cloud not configured' } };
  return supabase.auth.resetPasswordForEmail(email);
}

export async function updatePassword(newPassword) {
  if (!supabase) return { error: { message: 'Cloud not configured' } };
  const pwErr = validatePassword(newPassword);
  if (pwErr) return { error: { message: pwErr } };
  return supabase.auth.updateUser({ password: newPassword });
}

export async function signOutAllDevices() {
  if (!supabase) return { error: { message: 'Cloud not configured' } };
  // scope 'global' revokes refresh tokens for every session on every device
  return supabase.auth.signOut({ scope: 'global' });
}

// ─── Multi-factor auth (TOTP) ─────────────────────────────────────────────

export async function listMfaFactors() {
  if (!supabase) return { data: null, error: { message: 'Cloud not configured' } };
  return supabase.auth.mfa.listFactors();
}

export async function enrollTotpFactor(friendlyName = 'NolTech Authenticator') {
  if (!supabase) return { error: { message: 'Cloud not configured' } };
  return supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName });
}

export async function verifyTotpFactor(factorId, code) {
  if (!supabase) return { error: { message: 'Cloud not configured' } };
  const { data: ch, error: chErr } = await supabase.auth.mfa.challenge({ factorId });
  if (chErr) return { error: chErr };
  return supabase.auth.mfa.verify({ factorId, challengeId: ch.id, code });
}

export async function unenrollMfaFactor(factorId) {
  if (!supabase) return { error: { message: 'Cloud not configured' } };
  return supabase.auth.mfa.unenroll({ factorId });
}

export async function challengeMfaAtSignIn(factorId, code) {
  if (!supabase) return { error: { message: 'Cloud not configured' } };
  const { data: ch, error: chErr } = await supabase.auth.mfa.challenge({ factorId });
  if (chErr) return { error: chErr };
  return supabase.auth.mfa.verify({ factorId, challengeId: ch.id, code });
}

export async function deleteMyAccount() {
  if (!supabase) return { error: { message: 'Cloud not configured' } };
  const { data, error } = await supabase.rpc('delete_my_account');
  if (error) return { error };
  await supabase.auth.signOut();
  return { data };
}

export async function signIn(email, password) {
  if (!supabase) return { error: { message: 'Cloud not configured' } };
  return supabase.auth.signInWithPassword({ email, password });
}

export async function signOut() {
  if (!supabase) return;
  await supabase.auth.signOut();
}

export function onAuthChange(callback) {
  if (!supabase) return () => {};
  const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
    callback(event, session);
  });
  return () => subscription.unsubscribe();
}

// ─── Workspace helpers ──────────────────────────────────────────────────────

export async function getMyWorkspaces() {
  if (!supabase) return { data: [], error: null };
  const user = await getCurrentUser();
  if (!user) return { data: [], error: null };

  const { data, error } = await supabase
    .from('workspace_members')
    .select('workspace_id, role, workspaces(id, name, created_by, created_at)')
    .eq('user_id', user.id);

  if (error) return { data: [], error };
  return {
    data: (data || []).map(m => ({ ...m.workspaces, role: m.role })),
    error: null,
  };
}

export async function createWorkspace(name) {
  if (!supabase) return { error: { message: 'Cloud not configured' } };
  const user = await getCurrentUser();
  if (!user) return { error: { message: 'Not authenticated' } };

  const { data: ws, error: wsError } = await supabase
    .from('workspaces')
    .insert({ name, created_by: user.id })
    .select()
    .single();

  if (wsError) return { error: wsError };

  // Add self as owner
  const { error: memberError } = await supabase
    .from('workspace_members')
    .insert({ workspace_id: ws.id, user_id: user.id, role: 'owner' });

  if (memberError) return { error: memberError };

  return { data: { ...ws, role: 'owner' }, error: null };
}

export async function joinWorkspace(workspaceId) {
  if (!supabase) return { error: { message: 'Cloud not configured' } };
  const user = await getCurrentUser();
  if (!user) return { error: { message: 'Not authenticated' } };

  const { error } = await supabase
    .from('workspace_members')
    .insert({ workspace_id: workspaceId, user_id: user.id, role: 'member' });

  return { error };
}

// ─── Invites ────────────────────────────────────────────────────────────

function generateInviteCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // skip I, L, O, 0, 1
  let code = 'NOLT-';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export async function createInvite(workspaceId, { maxUses = 10, expiresInDays = 30 } = {}) {
  if (!supabase) return { error: { message: 'Cloud not configured' } };
  const user = await getCurrentUser();
  if (!user) return { error: { message: 'Not authenticated' } };

  const code = generateInviteCode();
  const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86400000).toISOString() : null;

  const { data, error } = await supabase
    .from('workspace_invites')
    .insert({ code, workspace_id: workspaceId, created_by: user.id, max_uses: maxUses, expires_at: expiresAt })
    .select()
    .single();

  return { data, error };
}

export async function listInvites(workspaceId) {
  if (!supabase) return { data: [], error: null };
  const { data, error } = await supabase
    .from('workspace_invites')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('revoked', false)
    .order('created_at', { ascending: false });
  return { data: data || [], error };
}

export async function revokeInvite(code) {
  if (!supabase) return { error: { message: 'Cloud not configured' } };
  const { error } = await supabase
    .from('workspace_invites')
    .update({ revoked: true })
    .eq('code', code);
  return { error };
}

export async function redeemInvite(code) {
  if (!supabase) return { error: { message: 'Cloud not configured' } };
  const { data, error } = await supabase.rpc('redeem_workspace_invite', { invite_code: code.trim().toUpperCase() });
  if (error) return { error };
  if (!data?.success) return { error: { message: data?.error || 'Failed to redeem invite' } };
  return { data };
}

export async function previewInvite(code) {
  if (!supabase) return { error: { message: 'Cloud not configured' } };
  const { data, error } = await supabase
    .from('workspace_invites')
    .select('code, workspace_id, expires_at, max_uses, use_count, revoked, workspaces(name)')
    .eq('code', code.trim().toUpperCase())
    .maybeSingle();
  return { data, error };
}

export async function removeMember(workspaceId, userId) {
  if (!supabase) return { error: { message: 'Cloud not configured' } };
  const { error } = await supabase
    .from('workspace_members')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId);
  return { error };
}

// ─── Active workspace (local preference) ────────────────────────────────────

const ACTIVE_WS_KEY = 'noltech:cloud:active-workspace';

export async function getActiveWorkspace() {
  try {
    return await window.storage.get(ACTIVE_WS_KEY);
  } catch { return null; }
}

export async function setActiveWorkspace(workspaceId) {
  try {
    await window.storage.set(ACTIVE_WS_KEY, workspaceId);
  } catch (e) {
    console.error('[supabase] Failed to persist active workspace — selection will not survive a restart:', e);
  }
}
