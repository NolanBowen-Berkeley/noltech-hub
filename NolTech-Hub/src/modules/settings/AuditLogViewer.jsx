// ─── Audit Log Viewer ──────────────────────────────────────────────────────
// Displays recent changes across the workspace with who made them.

import { useState, useEffect, useCallback } from 'react';
import { Clock, User, Plus, Edit3, Trash2, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';
import { supabase, getActiveWorkspace, isCloudEnabled } from '../../services/supabase';
import { withErrorToast } from '../../utils/withErrorToast';

const OP_CONFIG = {
  INSERT: { icon: Plus, label: 'Added', cls: 'text-success bg-success-subtle' },
  UPDATE: { icon: Edit3, label: 'Changed', cls: 'text-info bg-info-subtle' },
  DELETE: { icon: Trash2, label: 'Deleted', cls: 'text-danger bg-danger-subtle' },
};

function formatTime(iso) {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function rowLabel(log) {
  const snap = log.row_snapshot || {};
  if (log.table_name === 'lots') {
    return snap.source_name || snap.source || 'Lot';
  }
  if (log.table_name === 'items') {
    return [snap.brand, snap.model].filter(Boolean).join(' ') || snap.serial_number || 'Item';
  }
  if (log.table_name === 'bids') {
    return snap.lot_title || 'Bid';
  }
  if (log.table_name === 'transactions') {
    return snap.description || snap.category || 'Transaction';
  }
  return log.row_id.slice(0, 8);
}

export default function AuditLogViewer() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);

  const loadLogs = useCallback(async () => {
    if (!isCloudEnabled) { setLoading(false); return; }
    setLoading(true);
    const { value } = await withErrorToast(
      async () => {
        const wsId = await getActiveWorkspace();
        if (!wsId) return [];
        const { data, error } = await supabase
          .from('audit_log')
          .select('*')
          .eq('workspace_id', wsId)
          .order('created_at', { ascending: false })
          .limit(100);
        if (error) throw error;
        return data || [];
      },
      { title: 'Audit log load failed', tag: 'AuditLogViewer', default: [] },
    );
    setLogs(value || []);
    setLoading(false);
  }, []);

  useEffect(() => { loadLogs(); }, [loadLogs]);

  if (!isCloudEnabled) return null;

  return (
    <div className="bg-surface rounded-xl border border-border shadow-sm p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-fg-muted" />
          <h3 className="text-sm font-semibold text-fg">Audit Log</h3>
          <span className="text-[10px] text-fg-muted">Last 100 changes</span>
        </div>
        <button onClick={loadLogs} className="flex items-center gap-1 px-2 py-1 text-[10px] border border-border rounded-lg hover:bg-muted/40">
          <RefreshCw size={10} /> Refresh
        </button>
      </div>

      {loading ? (
        <div className="space-y-2">{[...Array(3)].map((_, i) => (
          <div key={i} className="h-8 bg-muted rounded animate-pulse" />
        ))}</div>
      ) : logs.length === 0 ? (
        <p className="text-xs text-fg-muted italic">No changes logged yet. Data changes will appear here as teammates edit.</p>
      ) : (
        <div className="space-y-1 max-h-96 overflow-y-auto">
          {logs.map(log => {
            const cfg = OP_CONFIG[log.operation] || OP_CONFIG.UPDATE;
            const Icon = cfg.icon;
            const isExpanded = expanded === log.id;
            const label = rowLabel(log);
            const fieldCount = log.changed_fields ? Object.keys(log.changed_fields).length : 0;

            return (
              <div key={log.id} className="border border-border-subtle rounded-lg overflow-hidden">
                <button onClick={() => setExpanded(isExpanded ? null : log.id)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/40 transition-colors">
                  <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase ${cfg.cls}`}>
                    <Icon size={9} className="inline mr-0.5" /> {cfg.label}
                  </span>
                  <span className="text-[11px] text-fg-muted">{log.table_name}</span>
                  <span className="text-xs font-medium text-fg flex-1 truncate">{label}</span>
                  {log.operation === 'UPDATE' && fieldCount > 0 && (
                    <span className="text-[10px] text-fg-muted">{fieldCount} field{fieldCount !== 1 ? 's' : ''}</span>
                  )}
                  <div className="flex items-center gap-1 text-[10px] text-fg-muted shrink-0">
                    <User size={9} />
                    <span className="truncate max-w-[100px]">{log.actor_email?.split('@')[0] || 'unknown'}</span>
                  </div>
                  <span className="text-[10px] text-fg-muted shrink-0">{formatTime(log.created_at)}</span>
                  {isExpanded ? <ChevronUp size={11} className="text-fg-muted" /> : <ChevronDown size={11} className="text-fg-muted" />}
                </button>

                {isExpanded && (
                  <div className="px-3 py-2 bg-muted/40 border-t border-border-subtle text-[11px] font-mono">
                    {log.operation === 'UPDATE' && log.changed_fields && (
                      <div className="space-y-1">
                        {Object.entries(log.changed_fields).map(([field, change]) => (
                          <div key={field} className="flex items-start gap-2">
                            <span className="font-semibold text-fg w-24 shrink-0 truncate">{field}:</span>
                            <span className="text-danger line-through max-w-[180px] truncate">{JSON.stringify(change.old)}</span>
                            <span className="text-fg-muted">→</span>
                            <span className="text-success flex-1 truncate">{JSON.stringify(change.new)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {(log.operation === 'INSERT' || log.operation === 'DELETE') && log.row_snapshot && (
                      <div className="text-[10px] text-fg-muted whitespace-pre-wrap break-all">
                        {JSON.stringify(log.row_snapshot, null, 2).slice(0, 500)}
                        {JSON.stringify(log.row_snapshot).length > 500 && '...'}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
