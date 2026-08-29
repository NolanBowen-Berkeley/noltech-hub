// ─── Initial Sync Screen ───────────────────────────────────────────────────
// Shown when a user logs in on a new device with no local data.
// Downloads all workspace data from Supabase before landing in the app.

import { useState, useEffect } from 'react';
import { Cloud, Download, Check, AlertCircle, Loader2 } from 'lucide-react';
import { downloadWorkspace } from '../services/syncEngine';
import { getActiveWorkspace, getMyWorkspaces } from '../services/supabase';

export default function InitialSyncScreen({ onDone }) {
  const [status, setStatus] = useState('starting'); // 'starting' | 'downloading' | 'done' | 'error'
  const [workspaceName, setWorkspaceName] = useState('');
  const [counts, setCounts] = useState({ lots: 0, items: 0 });
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const wsId = await getActiveWorkspace();
        if (!wsId) { onDone(); return; }

        const { data: wsList } = await getMyWorkspaces();
        const ws = (wsList || []).find(w => w.id === wsId);
        setWorkspaceName(ws?.name || 'Workspace');
        setStatus('downloading');

        const { lots } = await downloadWorkspace(wsId);
        await window.storage.set('noltech:inventory:lots', lots);

        const itemCount = lots.reduce((sum, l) => sum + (l.items?.length || 0), 0);
        setCounts({ lots: lots.length, items: itemCount });
        setStatus('done');

        // Brief pause so user sees the success, then continue
        setTimeout(() => onDone(), 1200);
      } catch (e) {
        setError(e.message || 'Download failed');
        setStatus('error');
      }
    })();
  }, [onDone]);

  return (
    <div className="relative min-h-screen flex items-center justify-center bg-bg p-4 overflow-hidden">
      <div className="hero-mesh" />
      <div className="relative z-10 w-full max-w-md bg-surface rounded-2xl border border-border shadow-glow-lg p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-11 h-11 rounded-xl bg-brand-gradient flex items-center justify-center shadow-accent-glow">
            <Cloud className="w-5 h-5 text-white" />
          </div>
          <div>
            <p className="ui-eyebrow">FIRST-TIME DOWNLOAD</p>
            <h1 className="h-section text-fg tracking-heading">
              Syncing your <span className="gradient-text">workspace</span>
            </h1>
            <p className="text-xs text-fg-muted mt-0.5">{workspaceName}</p>
          </div>
        </div>

        {status === 'starting' && (
          <div className="flex items-center gap-2 text-sm text-fg-muted">
            <Loader2 size={14} className="animate-spin" />
            <span>Connecting...</span>
          </div>
        )}

        {status === 'downloading' && (
          <div>
            <div className="flex items-center gap-2 text-sm text-fg mb-3">
              <Download size={14} className="text-accent animate-pulse" />
              <span>Downloading your data from the cloud...</span>
            </div>
            <div className="w-full h-1.5 bg-recessed rounded-full overflow-hidden">
              <div className="h-full bg-brand-gradient rounded-full animate-pulse" style={{ width: '60%' }} />
            </div>
            <p className="text-[10px] text-fg-subtle mt-2">This runs once per device.</p>
          </div>
        )}

        {status === 'done' && (
          <div>
            <div className="flex items-center gap-2 text-sm text-success-fg mb-2">
              <Check size={14} className="text-success" />
              <span className="font-semibold">Ready to go!</span>
            </div>
            <p className="text-xs text-fg-muted">
              Downloaded <span className="font-mono font-semibold text-fg">{counts.lots}</span> lots with{' '}
              <span className="font-mono font-semibold text-fg">{counts.items}</span> items.
            </p>
          </div>
        )}

        {status === 'error' && (
          <div className="flex items-start gap-2 bg-danger-subtle border border-danger/20 rounded-lg px-3 py-2">
            <AlertCircle size={14} className="text-danger shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-semibold text-danger-fg">Sync failed</p>
              <p className="text-[11px] text-danger-fg/80 mt-0.5">{error}</p>
              <button onClick={onDone} className="mt-2 text-xs text-fg font-semibold hover:underline">
                Continue anyway →
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
