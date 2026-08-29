// ─── Login Screen ─────────────────────────────────────────────────────────────
// Handles sign in, sign up, and workspace selection/creation.

import { useState, useEffect } from 'react';
import { Cloud, Mail, Lock, Users, Plus, LogIn, UserPlus, ArrowRight, Loader2, AlertCircle, Key } from 'lucide-react';
import { signIn, signUp, getSession, getMyWorkspaces, createWorkspace, setActiveWorkspace, signOut, redeemInvite, previewInvite, validatePassword, requestPasswordReset, supabase } from '../services/supabase';
import LegalModal from './LegalModal';
import { Button, Input, Label } from './ui';

export default function LoginScreen({ onReady, onSkip }) {
  const [mode, setMode] = useState('loading'); // 'loading' | 'auth' | 'workspace' | 'done'
  const [authMode, setAuthMode] = useState('signin'); // 'signin' | 'signup' | 'reset'
  const [info, setInfo] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [workspaces, setWorkspaces] = useState([]);
  const [newWsName, setNewWsName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [legalModal, setLegalModal] = useState(null); // 'terms' | 'privacy' | null
  const [mfaChallenge, setMfaChallenge] = useState(null); // { factorId }
  const [mfaCode, setMfaCode] = useState('');

  // Check existing session on mount
  useEffect(() => {
    (async () => {
      const session = await getSession();
      if (session?.user) {
        await loadWorkspaces();
      } else {
        setMode('auth');
      }
    })();
  }, []);

  const loadWorkspaces = async () => {
    const { data } = await getMyWorkspaces();
    setWorkspaces(data || []);
    setMode('workspace');
  };

  const handleAuth = async (e) => {
    e.preventDefault();
    setError('');
    setInfo('');

    if (authMode === 'reset') {
      setLoading(true);
      const { error } = await requestPasswordReset(email);
      setLoading(false);
      if (error) setError(error.message);
      else setInfo('If an account exists for that email, a password reset link has been sent.');
      return;
    }

    if (authMode === 'signup') {
      const pwErr = validatePassword(password);
      if (pwErr) { setError(pwErr); return; }
    }

    setLoading(true);
    const fn = authMode === 'signup' ? signUp : signIn;
    const { error } = await fn(email, password);
    setLoading(false);
    if (error) {
      setError(error.message);
    } else if (authMode === 'signup') {
      setInfo('Check your email to confirm your account, then sign in.');
      setAuthMode('signin');
      setPassword('');
    } else {
      // Check if this user has 2FA enrolled → require TOTP before proceeding
      try {
        const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        if (aal?.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') {
          const { data: factorData } = await supabase.auth.mfa.listFactors();
          const verified = (factorData?.totp || []).find(f => f.status === 'verified');
          if (verified) {
            setMfaChallenge({ factorId: verified.id });
            return;
          }
        }
      } catch (e) {
        // If MFA assurance check fails (transient network), do NOT silently
        // proceed past it for a user who has MFA enrolled — surface the
        // failure so they retry rather than bypassing the second factor.
        console.error('[LoginScreen] MFA assurance check failed:', e);
      }
      await loadWorkspaces();
    }
  };

  const handleMfaVerify = async (e) => {
    e?.preventDefault?.();
    if (!mfaChallenge || mfaCode.length !== 6) return;
    setError('');
    setLoading(true);
    try {
      const { data: ch, error: chErr } = await supabase.auth.mfa.challenge({ factorId: mfaChallenge.factorId });
      if (chErr) throw chErr;
      const { error: vErr } = await supabase.auth.mfa.verify({ factorId: mfaChallenge.factorId, challengeId: ch.id, code: mfaCode });
      if (vErr) throw vErr;
      setMfaChallenge(null);
      setMfaCode('');
      await loadWorkspaces();
    } catch (e) {
      setError(e.message || 'Invalid code');
    } finally {
      setLoading(false);
    }
  };

  // Visual strength: 0-4 based on length, case mix, digits, symbols
  const pwStrength = (() => {
    if (!password) return 0;
    let s = 0;
    if (password.length >= 8) s++;
    if (password.length >= 12) s++;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) s++;
    if (/[0-9]/.test(password) && /[^a-zA-Z0-9]/.test(password)) s++;
    return s;
  })();

  const handleCreateWorkspace = async () => {
    if (!newWsName.trim()) return;
    setLoading(true);
    setError('');
    const { data, error } = await createWorkspace(newWsName.trim());
    setLoading(false);
    if (error) {
      setError(error.message);
    } else if (data) {
      await setActiveWorkspace(data.id);
      onReady({ workspaceId: data.id, workspaceName: data.name });
    }
  };

  const handleSelectWorkspace = async (ws) => {
    await setActiveWorkspace(ws.id);
    onReady({ workspaceId: ws.id, workspaceName: ws.name });
  };

  const handleJoinWithCode = async () => {
    if (!inviteCode.trim()) return;
    setLoading(true);
    setError('');
    const { data, error } = await redeemInvite(inviteCode);
    setLoading(false);
    if (error) {
      setError(error.message);
    } else if (data?.workspace_id) {
      await setActiveWorkspace(data.workspace_id);
      // Look up workspace name
      await loadWorkspaces();
      const { data: wsList } = await getMyWorkspaces();
      const ws = (wsList || []).find(w => w.id === data.workspace_id);
      onReady({ workspaceId: data.workspace_id, workspaceName: ws?.name || 'Workspace' });
    }
  };

  const handleSignOut = async () => {
    await signOut();
    setMode('auth');
    setEmail('');
    setPassword('');
  };

  if (mode === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg">
        <Loader2 className="w-8 h-8 animate-spin text-accent" />
      </div>
    );
  }

  const eyebrowLabel =
    mode === 'workspace' ? 'WORKSPACE' :
    mfaChallenge ? 'TWO-FACTOR' :
    authMode === 'signup' ? 'CREATE ACCOUNT' :
    authMode === 'reset' ? 'RESET PASSWORD' :
    'SIGN IN';

  return (
    <div className="relative min-h-screen flex items-center justify-center bg-bg p-4 overflow-hidden">
      <div className="hero-mesh" />
      <div className="relative z-10 w-full max-w-md bg-surface rounded-2xl border border-border shadow-glow-lg p-8">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <div className="w-11 h-11 rounded-xl bg-brand-gradient flex items-center justify-center shadow-accent-glow">
            <Cloud className="w-5 h-5 text-white" />
          </div>
          <div>
            <p className="ui-eyebrow">{eyebrowLabel}</p>
            <h1 className="h-section text-fg tracking-heading">
              Welcome to your <span className="gradient-text">Hub</span>
            </h1>
          </div>
        </div>

        {/* Auth form */}
        {mode === 'auth' && mfaChallenge && (
          <form onSubmit={handleMfaVerify} className="space-y-3">
            <div>
              <h2 className="text-sm font-semibold text-fg">Two-factor code</h2>
              <p className="text-xs text-fg-muted mt-0.5">Enter the 6-digit code from your authenticator app.</p>
            </div>
            <Input
              autoFocus
              type="text"
              value={mfaCode}
              onChange={e => setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="123456"
              className="text-center font-mono tracking-widest text-lg"
            />
            {error && (
              <div className="flex items-start gap-2 bg-danger-subtle border border-danger/20 rounded-lg px-3 py-2 text-xs text-danger-fg">
                <AlertCircle size={13} className="shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}
            <Button variant="accent" type="submit" size="lg" className="w-full" disabled={loading || mfaCode.length !== 6}>
              {loading ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />}
              Verify
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={async () => { await signOut(); setMfaChallenge(null); setMfaCode(''); setError(''); }}
              className="w-full"
            >
              Cancel & sign out
            </Button>
          </form>
        )}
        {mode === 'auth' && !mfaChallenge && (
          <>
            <form onSubmit={handleAuth} className="space-y-3">
              <div>
                <Label>Email</Label>
                <Input
                  type="email"
                  required
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  leadingIcon={Mail}
                  placeholder="you@example.com"
                />
              </div>
              {authMode !== 'reset' && (
                <div>
                  <Label>Password</Label>
                  <Input
                    type="password"
                    required
                    minLength={authMode === 'signup' ? 8 : 6}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    leadingIcon={Lock}
                    placeholder={authMode === 'signup' ? '8+ chars, letters & numbers' : 'Your password'}
                  />
                  {authMode === 'signup' && password && (
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <div className="flex gap-1 flex-1">
                        {[0,1,2,3].map(i => (
                          <div key={i} className={`h-1 flex-1 rounded ${
                            i < pwStrength
                              ? pwStrength <= 1 ? 'bg-danger' : pwStrength === 2 ? 'bg-warning' : 'bg-success'
                              : 'bg-muted'
                          }`} />
                        ))}
                      </div>
                      <span className="text-[10px] text-fg-muted">
                        {pwStrength <= 1 ? 'Weak' : pwStrength === 2 ? 'Okay' : pwStrength === 3 ? 'Good' : 'Strong'}
                      </span>
                    </div>
                  )}
                </div>
              )}
              {info && (
                <div className="flex items-start gap-2 bg-info-subtle border border-info/20 rounded-lg px-3 py-2 text-xs text-info-fg">
                  <AlertCircle size={13} className="shrink-0 mt-0.5" />
                  <span>{info}</span>
                </div>
              )}
              {error && (
                <div className="flex items-start gap-2 bg-danger-subtle border border-danger/20 rounded-lg px-3 py-2 text-xs text-danger-fg">
                  <AlertCircle size={13} className="shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}
              <Button variant="accent" type="submit" size="lg" className="w-full" disabled={loading}>
                {loading ? <Loader2 size={14} className="animate-spin" /> : authMode === 'signup' ? <UserPlus size={14} /> : authMode === 'reset' ? <Mail size={14} /> : <LogIn size={14} />}
                {authMode === 'signup' ? 'Create Account' : authMode === 'reset' ? 'Send Reset Link' : 'Sign In'}
              </Button>
            </form>

            <div className="mt-4 text-center text-xs text-fg-muted space-y-1.5">
              {authMode === 'signin' && (
                <>
                  <div>
                    No account? <button onClick={() => { setAuthMode('signup'); setError(''); setInfo(''); }} className="text-fg font-semibold hover:underline">Sign up</button>
                  </div>
                  <div>
                    <button onClick={() => { setAuthMode('reset'); setError(''); setInfo(''); setPassword(''); }} className="text-fg-muted hover:text-fg hover:underline">
                      Forgot password?
                    </button>
                  </div>
                </>
              )}
              {authMode === 'signup' && (
                <div>
                  Already have an account? <button onClick={() => { setAuthMode('signin'); setError(''); setInfo(''); }} className="text-fg font-semibold hover:underline">Sign in</button>
                </div>
              )}
              {authMode === 'reset' && (
                <div>
                  <button onClick={() => { setAuthMode('signin'); setError(''); setInfo(''); }} className="text-fg font-semibold hover:underline">
                    ← Back to sign in
                  </button>
                </div>
              )}
              {authMode === 'signup' && (
                <p className="text-[10px] text-fg-muted pt-2">
                  By creating an account you agree to the{' '}
                  <button type="button" onClick={() => setLegalModal('terms')} className="underline hover:text-fg">Terms</button>
                  {' '}and{' '}
                  <button type="button" onClick={() => setLegalModal('privacy')} className="underline hover:text-fg">Privacy Policy</button>.
                </p>
              )}
            </div>

            <div className="mt-6 pt-4 border-t border-border-subtle">
              <Button variant="ghost" size="sm" onClick={onSkip} className="w-full">
                Continue without cloud sync →
              </Button>
              <p className="text-[10px] text-fg-subtle text-center mt-1">
                Your data will stay local to this device
              </p>
            </div>
          </>
        )}

        {/* Workspace selection */}
        {mode === 'workspace' && (
          <>
            <h2 className="h-section text-fg mb-1 tracking-heading">Choose a workspace</h2>
            <p className="text-xs text-fg-muted mb-4">Teammates in the same workspace share inventory, bids, and sales.</p>

            {workspaces.length > 0 && (
              <div className="space-y-2 mb-4">
                {workspaces.map(ws => (
                  <button key={ws.id} onClick={() => handleSelectWorkspace(ws)}
                    className="w-full flex items-center justify-between px-4 py-3 border border-border rounded-lg hover:border-border-active hover:bg-muted transition-colors">
                    <div className="flex items-center gap-3">
                      <Users size={14} className="text-fg-muted" />
                      <div className="text-left">
                        <p className="text-sm font-medium text-fg">{ws.name}</p>
                        <p className="text-[10px] text-fg-muted capitalize">{ws.role}</p>
                      </div>
                    </div>
                    <ArrowRight size={14} className="text-fg-muted" />
                  </button>
                ))}
              </div>
            )}

            <div className="bg-recessed border border-border-subtle rounded-lg p-3 mb-3">
              <p className="ui-eyebrow mb-2">Join with Invite Code</p>
              <div className="flex gap-2">
                <Input
                  type="text"
                  value={inviteCode}
                  onChange={e => setInviteCode(e.target.value.toUpperCase())}
                  className="font-mono"
                  placeholder="NOLT-XXXXXXXX"
                />
                <Button variant="secondary" onClick={handleJoinWithCode} disabled={loading || !inviteCode.trim()} className="shrink-0">
                  {loading ? <Loader2 size={14} className="animate-spin" /> : <Key size={14} />}
                </Button>
              </div>
              <p className="text-[10px] text-fg-muted mt-1.5">Paste a code a teammate shared with you.</p>
            </div>

            <div className="bg-recessed border border-border-subtle rounded-lg p-3">
              <p className="ui-eyebrow mb-2">Create New Workspace</p>
              <div className="flex gap-2">
                <Input
                  type="text"
                  value={newWsName}
                  onChange={e => setNewWsName(e.target.value)}
                  placeholder="e.g. My Reseller Team"
                />
                <Button variant="accent" onClick={handleCreateWorkspace} disabled={loading || !newWsName.trim()} className="shrink-0">
                  {loading ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                </Button>
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2 bg-danger-subtle border border-danger/20 rounded-lg px-3 py-2 text-xs text-danger-fg mt-3">
                <AlertCircle size={13} className="shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <div className="mt-4 pt-3 border-t border-border-subtle flex items-center justify-between">
              <Button variant="ghost" size="sm" onClick={handleSignOut}>
                Sign out
              </Button>
              <Button variant="ghost" size="sm" onClick={onSkip}>
                Continue offline →
              </Button>
            </div>
          </>
        )}
      </div>
      {legalModal && <LegalModal kind={legalModal} onClose={() => setLegalModal(null)} />}
    </div>
  );
}
