// ─── Workspace Settings ───────────────────────────────────────────────────────
// Shows current workspace, members, invites. Upload/download local data to cloud.

import { useState, useEffect, useCallback } from 'react';
import { Cloud, Upload, Download, Users, Copy, Check, LogOut, AlertTriangle, Loader2, Plus, Ban, UserX, Trash2, Shield, LogOutIcon, ShieldCheck, ShieldAlert } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import {
  supabase, isCloudEnabled, getActiveWorkspace, getCurrentUser, signOut,
  getMyWorkspaces, createInvite, listInvites, revokeInvite, removeMember,
  deleteMyAccount, signOutAllDevices,
  listMfaFactors, enrollTotpFactor, verifyTotpFactor, unenrollMfaFactor,
} from '../../services/supabase';
import { uploadLocalData, downloadWorkspace } from '../../services/syncEngine';
import eventBus from '../../services/eventBus';

export default function WorkspaceSettings() {
  const { state, dispatch } = useApp();
  const [workspace, setWorkspace] = useState(null);
  const [members, setMembers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [user, setUser] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [copiedCode, setCopiedCode] = useState(null);
  const [status, setStatus] = useState(null);

  const loadData = useCallback(async () => {
    const u = await getCurrentUser();
    setUser(u);
    const wsId = await getActiveWorkspace();
    if (!wsId) return;
    const { data: wsList } = await getMyWorkspaces();
    const ws = (wsList || []).find(w => w.id === wsId);
    setWorkspace(ws);
    const { data: membersData } = await supabase
      .from('workspace_members')
      .select('user_id, role, joined_at')
      .eq('workspace_id', wsId);
    setMembers(membersData || []);
    const { data: invitesData } = await listInvites(wsId);
    setInvites(invitesData || []);
  }, []);

  useEffect(() => { if (isCloudEnabled) loadData(); }, [loadData]);

  const handleUpload = async () => {
    if (!workspace || !user) return;
    if (!confirm(`Upload all data to cloud? This pushes ${state.lots.length} lots + bids + transactions.`)) return;
    setUploading(true);
    setStatus(null);
    const result = await uploadLocalData(state.lots, workspace.id, user.id);
    setUploading(false);
    if (result.success) {
      setStatus({ type: 'success', text: `Uploaded ${result.lotCount} lots, ${result.itemCount} items, ${result.otherCount || 0} other records` });
      eventBus.emit('notification:push', { type: 'success', title: 'Upload Complete', message: `${result.itemCount} items synced` });
    } else {
      setStatus({ type: 'error', text: result.error });
    }
  };

  const handleDownload = async () => {
    if (!workspace) return;
    if (!confirm('Replace local data with cloud data? Unsynced local changes will be lost.')) return;
    setDownloading(true);
    setStatus(null);
    try {
      const { lots } = await downloadWorkspace(workspace.id);
      await window.storage.set('noltech:inventory:lots', lots);
      dispatch({ type: 'INIT', lots, _fromSync: true });
      setStatus({ type: 'success', text: `Downloaded ${lots.length} lots + related data` });
    } catch (e) {
      setStatus({ type: 'error', text: e.message });
    }
    setDownloading(false);
  };

  const handleCreateInvite = async () => {
    if (!workspace) return;
    setCreatingInvite(true);
    const { data, error } = await createInvite(workspace.id, { maxUses: 10, expiresInDays: 30 });
    setCreatingInvite(false);
    if (error) {
      setStatus({ type: 'error', text: error.message });
    } else {
      setInvites(prev => [data, ...prev]);
    }
  };

  const handleRevokeInvite = async (code) => {
    if (!confirm(`Revoke invite code ${code}? Anyone with this code will no longer be able to join.`)) return;
    const { error } = await revokeInvite(code);
    if (!error) setInvites(prev => prev.filter(i => i.code !== code));
  };

  const handleCopyCode = async (code) => {
    await navigator.clipboard.writeText(code);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  const handleRemoveMember = async (userId) => {
    if (!workspace || userId === user?.id) return;
    if (!confirm('Remove this teammate from the workspace? They will lose access to all shared data.')) return;
    const { error } = await removeMember(workspace.id, userId);
    if (!error) setMembers(prev => prev.filter(m => m.user_id !== userId));
  };

  const handleSignOut = async () => {
    if (!confirm('Sign out of cloud sync? Local data stays on this device.')) return;
    await signOut();
    await window.storage.set('noltech:cloud:active-workspace', null).catch(() => {});
    await window.storage.set('noltech:cloud:skipped', null).catch(() => {});
    window.location.reload();
  };

  if (!isCloudEnabled) {
    return (
      <div className="bg-surface rounded-xl border border-border shadow-sm p-5">
        <div className="flex items-center gap-2 mb-2">
          <Cloud className="w-4 h-4 text-fg-muted" />
          <h3 className="text-sm font-semibold text-fg">Cloud Sync</h3>
        </div>
        <p className="text-xs text-fg-muted">Cloud sync not configured.</p>
      </div>
    );
  }

  if (!workspace) {
    return (
      <div className="bg-surface rounded-xl border border-border shadow-sm p-5">
        <div className="flex items-center gap-2 mb-2">
          <Cloud className="w-4 h-4 text-fg-muted" />
          <h3 className="text-sm font-semibold text-fg">Cloud Sync</h3>
        </div>
        <p className="text-xs text-fg-muted">Not signed in to a workspace.</p>
      </div>
    );
  }

  const isOwner = workspace.role === 'owner';

  return (
    <div className="bg-surface rounded-xl border border-border shadow-sm p-5">
      <div className="flex items-center gap-2 mb-1">
        <Cloud className="w-4 h-4 text-fg-muted" />
        <h3 className="text-sm font-semibold text-fg">Cloud Sync</h3>
      </div>
      <p className="text-xs text-fg-muted mb-4 leading-relaxed">
        Signed in as <span className="font-mono">{user?.email}</span> in <span className="font-semibold">{workspace.name}</span> ({workspace.role}).
      </p>

      {/* Members */}
      <div className="mb-4">
        <p className="text-[10px] font-semibold text-fg-muted uppercase tracking-wide mb-2">
          Members ({members.length})
        </p>
        <div className="space-y-1">
          {members.map(m => (
            <div key={m.user_id} className="flex items-center justify-between text-xs px-3 py-1.5 bg-muted/40 rounded-lg">
              <div className="flex items-center gap-2 min-w-0">
                <Users size={11} className="text-fg-muted shrink-0" />
                <span className="font-mono truncate">{m.user_id === user?.id ? `${user.email} (you)` : m.user_id.slice(0, 12) + '...'}</span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${m.role === 'owner' ? 'bg-primary/10 text-primary' : 'bg-muted text-fg-muted'}`}>
                  {m.role}
                </span>
                {isOwner && m.user_id !== user?.id && (
                  <button onClick={() => handleRemoveMember(m.user_id)} title="Remove teammate"
                    className="p-1 text-fg-muted hover:text-danger"><UserX size={11} /></button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Invites */}
      <div className="mb-4 p-3 bg-muted/40 rounded-lg">
        <div className="flex items-center justify-between mb-2">
          <p className="text-[10px] font-semibold text-fg-muted uppercase tracking-wide">Invite Codes</p>
          <button onClick={handleCreateInvite} disabled={creatingInvite}
            className="flex items-center gap-1 px-2 py-1 bg-primary text-white text-[10px] font-semibold rounded hover:bg-primary/90 disabled:opacity-50">
            {creatingInvite ? <Loader2 size={10} className="animate-spin" /> : <Plus size={10} />}
            Create Invite
          </button>
        </div>
        {invites.length === 0 ? (
          <p className="text-[11px] text-fg-muted italic">No active invites. Click Create Invite to generate a code teammates can use to join.</p>
        ) : (
          <div className="space-y-1.5">
            {invites.map(inv => {
              const expired = inv.expires_at && new Date(inv.expires_at) < new Date();
              const exhausted = inv.max_uses && inv.use_count >= inv.max_uses;
              return (
                <div key={inv.code} className={`flex items-center gap-2 bg-surface border border-border rounded-lg px-2 py-1.5 ${expired || exhausted ? 'opacity-50' : ''}`}>
                  <code className="flex-1 text-[11px] font-mono font-semibold text-fg truncate">{inv.code}</code>
                  <span className="text-[9px] text-fg-muted whitespace-nowrap">{inv.use_count}/{inv.max_uses || '∞'}</span>
                  <button onClick={() => handleCopyCode(inv.code)}
                    className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] border border-border rounded hover:bg-muted/40">
                    {copiedCode === inv.code ? <><Check size={9} /> Copied</> : <><Copy size={9} /> Copy</>}
                  </button>
                  <button onClick={() => handleRevokeInvite(inv.code)} title="Revoke"
                    className="p-1 text-fg-muted hover:text-danger"><Ban size={10} /></button>
                </div>
              );
            })}
            <p className="text-[10px] text-fg-muted mt-1">
              Teammates sign up, then click "Join workspace" and paste the code.
            </p>
          </div>
        )}
      </div>

      {/* Migration actions */}
      <div className="grid grid-cols-2 gap-2 mb-4">
        <button onClick={handleUpload} disabled={uploading || downloading}
          className="flex items-center justify-center gap-2 px-3 py-2 border border-primary/30 text-primary text-xs font-semibold rounded-lg hover:bg-primary/5 disabled:opacity-50">
          {uploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
          {uploading ? 'Uploading...' : 'Upload Local → Cloud'}
        </button>
        <button onClick={handleDownload} disabled={uploading || downloading}
          className="flex items-center justify-center gap-2 px-3 py-2 border border-border text-fg-muted text-xs font-semibold rounded-lg hover:bg-muted/40 disabled:opacity-50">
          {downloading ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
          {downloading ? 'Downloading...' : 'Download Cloud → Local'}
        </button>
      </div>

      {status && (
        <div className={`flex items-start gap-2 text-xs px-3 py-2 rounded-lg border ${
          status.type === 'success' ? 'bg-success-subtle border-success/30 text-success' : 'bg-danger-subtle border-danger/30 text-danger'
        }`}>
          {status.type === 'success' ? <Check size={13} className="shrink-0 mt-0.5" /> : <AlertTriangle size={13} className="shrink-0 mt-0.5" />}
          <span>{status.text}</span>
        </div>
      )}

      {/* Security section */}
      <SecuritySection />

      {/* Sign out */}
      <div className="mt-4 pt-3 border-t border-border-subtle flex items-center gap-4">
        <button onClick={handleSignOut}
          className="flex items-center gap-1.5 text-xs text-fg-muted hover:text-danger">
          <LogOut size={11} /> Sign out of cloud sync
        </button>
        <button
          onClick={async () => {
            if (!confirm('Sign out of every device where this account is logged in? You will need to sign in again on each one.')) return;
            await signOutAllDevices();
            eventBus.emit('notification:push', { type: 'info', title: 'Signed out everywhere', message: 'All sessions have been revoked.' });
          }}
          className="flex items-center gap-1.5 text-xs text-fg-muted hover:text-danger">
          <LogOut size={11} /> Sign out all devices
        </button>
      </div>

      {/* Danger zone */}
      <DangerZone onDeleted={() => { setWorkspace(null); setMembers([]); setInvites([]); eventBus.emit('cloud:signed-out'); }} />
    </div>
  );
}

function SecuritySection() {
  const [factors, setFactors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [enrolling, setEnrolling] = useState(null); // { factorId, qr, secret }
  const [code, setCode] = useState('');
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [err, setErr] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    const { data } = await listMfaFactors();
    const verified = (data?.totp || data?.all || []).filter(f => f.status === 'verified');
    setFactors(verified);
    setLoading(false);
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const startEnroll = async () => {
    setErr('');
    const { data, error } = await enrollTotpFactor();
    if (error) { setErr(error.message); return; }
    setEnrolling({ factorId: data.id, qr: data.totp?.qr_code, secret: data.totp?.secret });
  };

  const completeEnroll = async () => {
    if (!enrolling || !code.trim()) return;
    setVerifyBusy(true);
    setErr('');
    const { error } = await verifyTotpFactor(enrolling.factorId, code.trim());
    setVerifyBusy(false);
    if (error) { setErr(error.message); return; }
    setEnrolling(null);
    setCode('');
    await reload();
  };

  const cancelEnroll = async () => {
    if (enrolling) await unenrollMfaFactor(enrolling.factorId);
    setEnrolling(null);
    setCode('');
    setErr('');
  };

  const remove = async (factorId) => {
    if (!confirm('Remove this authenticator? You will lose 2FA protection.')) return;
    await unenrollMfaFactor(factorId);
    await reload();
  };

  return (
    <div className="mt-4 pt-3 border-t border-border-subtle">
      <div className="flex items-center gap-2 mb-2">
        <Shield size={13} className="text-primary" />
        <h3 className="text-sm font-semibold text-fg">Two-Factor Authentication</h3>
        {factors.length > 0 ? (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-success/10 text-success">
            <ShieldCheck size={10} /> Enabled
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-muted text-fg-muted">
            <ShieldAlert size={10} /> Off
          </span>
        )}
      </div>

      {loading ? (
        <Loader2 size={14} className="animate-spin text-fg-muted" />
      ) : enrolling ? (
        <div className="bg-muted/40 border border-border rounded-lg p-3 space-y-3">
          <p className="text-xs text-fg">
            Scan this QR in your authenticator app (Google Authenticator, 1Password, Authy, etc.), then enter the 6-digit code to confirm.
          </p>
          {enrolling.qr && (
            <div className="flex justify-center bg-surface p-3 rounded">
              <img src={enrolling.qr} alt="TOTP QR code" className="w-40 h-40" />
            </div>
          )}
          {enrolling.secret && (
            <div>
              <p className="text-[10px] text-fg-muted uppercase mb-0.5">Can't scan? Enter this key manually</p>
              <code className="text-xs font-mono bg-surface px-2 py-1 rounded border border-border block break-all">{enrolling.secret}</code>
            </div>
          )}
          <div>
            <label className="text-[10px] font-semibold text-fg-muted uppercase mb-1 block">6-Digit Code</label>
            <input
              type="text"
              value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="123456"
              className="w-32 border border-border rounded-lg px-3 py-2 text-sm font-mono tracking-widest focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          {err && <p className="text-xs text-danger">{err}</p>}
          <div className="flex gap-2">
            <button onClick={cancelEnroll} className="px-3 py-1.5 text-xs font-medium text-fg-muted border border-border rounded-lg hover:bg-surface">
              Cancel
            </button>
            <button onClick={completeEnroll} disabled={verifyBusy || code.length !== 6}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50">
              {verifyBusy ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
              Verify & Enable
            </button>
          </div>
        </div>
      ) : factors.length > 0 ? (
        <div className="space-y-2">
          {factors.map(f => (
            <div key={f.id} className="flex items-center justify-between bg-muted/40 border border-border rounded-lg px-3 py-2">
              <div>
                <p className="text-xs font-medium text-fg">{f.friendly_name || 'Authenticator'}</p>
                <p className="text-[10px] text-fg-muted">Added {new Date(f.created_at).toLocaleDateString()}</p>
              </div>
              <button onClick={() => remove(f.id)} className="text-[10px] text-danger hover:underline">Remove</button>
            </div>
          ))}
          <button onClick={startEnroll} className="flex items-center gap-1.5 text-xs text-primary hover:underline">
            <Plus size={11} /> Add another authenticator
          </button>
        </div>
      ) : (
        <div className="flex items-start gap-2">
          <p className="text-xs text-fg-muted flex-1">
            Add a second factor to protect your account even if your password is stolen.
          </p>
          <button onClick={startEnroll}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-primary text-white rounded-lg hover:bg-primary/90 whitespace-nowrap">
            <Shield size={11} /> Enable 2FA
          </button>
        </div>
      )}
      {err && !enrolling && <p className="text-xs text-danger mt-1">{err}</p>}
    </div>
  );
}

function DangerZone({ onDeleted }) {
  const [expanded, setExpanded] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const handleDelete = async () => {
    setErr('');
    setBusy(true);
    const { error } = await deleteMyAccount();
    setBusy(false);
    if (error) { setErr(error.message); return; }
    onDeleted?.();
    alert('Your account has been permanently deleted.');
  };

  return (
    <div className="mt-4 pt-3 border-t border-danger/20">
      <button onClick={() => setExpanded(v => !v)} className="flex items-center gap-1.5 text-xs text-danger hover:underline">
        <Trash2 size={11} /> Delete account
      </button>
      {expanded && (
        <div className="mt-3 bg-danger-subtle border border-danger/30 rounded-lg p-4 space-y-3">
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} className="shrink-0 mt-0.5 text-danger" />
            <div className="text-xs text-danger leading-relaxed">
              <p className="font-semibold mb-1">This action is permanent.</p>
              <p>
                Your account, cloud data, workspaces you solely own, and all associated inventory/bids/transactions will be deleted.
                Workspaces you share with teammates will remain; you'll just be removed as a member.
                Local data on this device is unaffected — export a backup first if you want to keep it.
              </p>
            </div>
          </div>
          <div>
            <label className="text-[10px] font-semibold text-fg-muted uppercase mb-1 block">Type DELETE to confirm</label>
            <input
              type="text"
              value={confirmText}
              onChange={e => setConfirmText(e.target.value)}
              className="w-full border border-danger/40 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-danger/30"
              placeholder="DELETE"
            />
          </div>
          {err && <p className="text-xs text-danger">{err}</p>}
          <div className="flex gap-2">
            <button onClick={() => { setExpanded(false); setConfirmText(''); setErr(''); }}
              className="px-3 py-1.5 text-xs font-medium text-fg-muted border border-border rounded-lg hover:bg-surface">
              Cancel
            </button>
            <button onClick={handleDelete} disabled={busy || confirmText !== 'DELETE'}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-danger text-white rounded-lg hover:bg-danger/90 disabled:opacity-50">
              {busy ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
              Permanently delete my account
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
