import { useState, useEffect, useCallback } from 'react';
import {
  Download,
  Upload,
  Database,
  AlertTriangle,
  Check,
  RefreshCw,
  HardDrive,
  FileJson,
  Shield,
  Trash2,
  Clock,
  Eraser,
} from 'lucide-react';
import { listSnapshots, getSnapshot, deleteSnapshot, captureNow, getBackupStatus } from '../../hooks/useDailyBackup';
import { BACKUP_KEYS } from '../../utils/backupKeys';
import { resetAllScraperCaches, LOCAL_CACHE_KEYS, LOCAL_USER_KEYS_KEEP } from '../../services/resetPipelineCaches';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function todayStamp() {
  return new Date().toISOString().split('T')[0];
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function DataBackup() {
  const [keyInfo, setKeyInfo] = useState([]); // { key, size, exists }
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importPreview, setImportPreview] = useState(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [status, setStatus] = useState(null); // { type: 'success' | 'error', message }
  const [error, setError] = useState(null);

  // ── Scan storage keys ──────────────────────────────────────────────────

  const scanKeys = useCallback(async () => {
    setLoading(true);
    try {
      const info = [];
      for (const key of BACKUP_KEYS) {
        try {
          const val = await window.storage.get(key);
          if (val !== null && val !== undefined) {
            const json = JSON.stringify(val);
            info.push({ key, size: new Blob([json]).size, exists: true });
          } else {
            info.push({ key, size: 0, exists: false });
          }
        } catch {
          info.push({ key, size: 0, exists: false });
        }
      }
      setKeyInfo(info);
    } catch (err) {
      setError(err.message || "Couldn't scan storage");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { scanKeys(); }, [scanKeys]);

  // ── Export ─────────────────────────────────────────────────────────────

  const handleExport = useCallback(async () => {
    setExporting(true);
    setStatus(null);
    try {
      const backup = {
        _meta: {
          app: 'NolTech Hub',
          version: '1.0',
          exportedAt: new Date().toISOString(),
          keyCount: 0,
        },
        data: {},
      };

      for (const key of BACKUP_KEYS) {
        try {
          const val = await window.storage.get(key);
          if (val !== null && val !== undefined) {
            backup.data[key] = val;
            backup._meta.keyCount++;
          }
        } catch {
          // skip keys that fail to read
        }
      }

      const json = JSON.stringify(backup, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `noltech-backup-${todayStamp()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setStatus({ type: 'success', message: `Exported ${backup._meta.keyCount} key${backup._meta.keyCount !== 1 ? 's' : ''} (${formatBytes(blob.size)})` });
    } catch (err) {
      setStatus({ type: 'error', message: err.message || 'Export failed' });
    } finally {
      setExporting(false);
    }
  }, []);

  // ── Import: file selection ─────────────────────────────────────────────

  const handleFileSelect = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportFile(file);
    setImportPreview(null);
    setShowConfirm(false);
    setStatus(null);

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target.result);
        // Validate structure
        if (!parsed._meta || !parsed.data || typeof parsed.data !== 'object') {
          setStatus({ type: 'error', message: 'Invalid backup file: missing _meta or data fields' });
          setImportFile(null);
          return;
        }
        const allKeys = Object.keys(parsed.data);
        const validKeys = allKeys.filter(k => BACKUP_KEYS.includes(k));
        const skippedKeys = allKeys.filter(k => !BACKUP_KEYS.includes(k));
        const totalSize = new Blob([ev.target.result]).size;
        // Filter data to only include whitelisted keys
        const safeData = {};
        for (const k of validKeys) safeData[k] = parsed.data[k];
        setImportPreview({
          exportedAt: parsed._meta.exportedAt || 'Unknown',
          keyCount: validKeys.length,
          keys: validKeys,
          skippedKeys,
          totalSize,
          data: safeData,
        });
      } catch (err) {
        setStatus({ type: 'error', message: "Couldn't parse file: " + err.message });
        setImportFile(null);
      }
    };
    reader.readAsText(file);
  }, []);

  // ── Import: write to storage ───────────────────────────────────────────

  const handleImport = useCallback(async () => {
    if (!importPreview?.data) return;
    setImporting(true);
    setShowConfirm(false);
    setStatus(null);

    try {
      let written = 0;
      let failed = 0;
      for (const [key, val] of Object.entries(importPreview.data)) {
        try {
          await window.storage.set(key, val);
          written++;
        } catch {
          failed++;
        }
      }

      setStatus({
        type: failed > 0 ? 'error' : 'success',
        message: `Imported ${written} key${written !== 1 ? 's' : ''}${failed > 0 ? `, ${failed} failed` : ''}. Reload the app to see changes.`,
      });
      setImportFile(null);
      setImportPreview(null);
      // Re-scan keys
      await scanKeys();
    } catch (err) {
      setStatus({ type: 'error', message: err.message || 'Import failed' });
    } finally {
      setImporting(false);
    }
  }, [importPreview, scanKeys]);

  // ── Summary stats ──────────────────────────────────────────────────────

  const existingKeys = keyInfo.filter(k => k.exists);
  const totalSize = existingKeys.reduce((s, k) => s + k.size, 0);

  // ── Loading ────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-3">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="bg-surface rounded-xl border border-border h-12 animate-pulse" />
        ))}
      </div>
    );
  }

  // ── Error ──────────────────────────────────────────────────────────────

  if (error) {
    return (
      <div className="flex items-start gap-3 bg-danger-subtle border border-danger/30 rounded-xl px-5 py-4 text-sm text-danger">
        <AlertTriangle size={16} className="shrink-0 mt-0.5" />
        <div>
          <p className="font-semibold">Couldn't scan storage</p>
          <p className="text-xs mt-0.5">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">

      {/* Header */}
      <div className="flex items-center gap-2">
        <Database size={16} className="text-accent" />
        <h2 className="text-lg font-bold text-fg">Data Backup & Restore</h2>
      </div>

      {/* Status message */}
      {status && (
        <div className={`flex items-start gap-3 rounded-xl px-4 py-3 text-sm ${
          status.type === 'success' ? 'bg-success-subtle border border-success/30 text-success' : 'bg-danger-subtle border border-danger/30 text-danger'
        }`}>
          {status.type === 'success' ? <Check size={15} className="mt-0.5 flex-shrink-0" /> : <AlertTriangle size={15} className="mt-0.5 flex-shrink-0" />}
          <p>{status.message}</p>
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <div className="bg-surface rounded-xl border border-border shadow-sm px-4 py-3">
          <p className="text-[10px] font-semibold text-fg-muted uppercase tracking-wide">Storage Keys</p>
          <p className="text-xl font-bold text-fg mt-0.5">{existingKeys.length} / {BACKUP_KEYS.length}</p>
        </div>
        <div className="bg-surface rounded-xl border border-border shadow-sm px-4 py-3">
          <p className="text-[10px] font-semibold text-fg-muted uppercase tracking-wide">Total Size</p>
          <p className="text-xl font-bold text-fg font-mono mt-0.5">{formatBytes(totalSize)}</p>
        </div>
        <div className="bg-surface rounded-xl border border-border shadow-sm px-4 py-3">
          <p className="text-[10px] font-semibold text-fg-muted uppercase tracking-wide">Empty Keys</p>
          <p className="text-xl font-bold text-fg-muted mt-0.5">{BACKUP_KEYS.length - existingKeys.length}</p>
        </div>
      </div>

      {/* Export / Import buttons */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">

        {/* Export */}
        <div className="bg-surface rounded-xl border border-border shadow-sm p-5">
          <div className="flex items-center gap-2 mb-3">
            <Download size={16} className="text-accent" />
            <h3 className="text-sm font-semibold text-fg">Export Backup</h3>
          </div>
          <p className="text-xs text-fg-muted mb-4">
            Download all app data as a JSON file. Includes inventory, arbitrage data, settings, and more.
          </p>
          <button
            onClick={handleExport}
            disabled={exporting || existingKeys.length === 0}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold text-white bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {exporting ? (
              <>
                <RefreshCw size={14} className="animate-spin" />
                Exporting...
              </>
            ) : (
              <>
                <Download size={14} />
                Export {existingKeys.length} key{existingKeys.length !== 1 ? 's' : ''} ({formatBytes(totalSize)})
              </>
            )}
          </button>
        </div>

        {/* Import */}
        <div className="bg-surface rounded-xl border border-border shadow-sm p-5">
          <div className="flex items-center gap-2 mb-3">
            <Upload size={16} className="text-success" />
            <h3 className="text-sm font-semibold text-fg">Import Backup</h3>
          </div>
          <p className="text-xs text-fg-muted mb-4">
            Restore from a previously exported JSON backup file. This will overwrite existing data.
          </p>
          <label className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold text-white bg-success hover:opacity-90 cursor-pointer transition-colors">
            <Upload size={14} />
            Select Backup File
            <input
              type="file"
              accept=".json,application/json"
              onChange={handleFileSelect}
              className="hidden"
            />
          </label>
        </div>
      </div>

      {/* Daily snapshot history */}
      <DailySnapshotPanel onStatus={setStatus} />

      {/* Scraper cache reset */}
      <ResetScraperCachePanel onStatus={setStatus} onDone={scanKeys} />

      {/* Import preview */}
      {importPreview && (
        <div className="bg-surface rounded-xl border border-warning/30 shadow-sm overflow-hidden">
          <div className="px-4 py-3 bg-warning-subtle border-b border-warning/30 flex items-center gap-2">
            <FileJson size={14} className="text-warning" />
            <h3 className="text-sm font-semibold text-fg">Import Preview</h3>
            <span className="ml-auto text-xs text-fg-muted">
              {importFile?.name}
            </span>
          </div>
          <div className="p-4">
            <div className="grid grid-cols-3 gap-3 mb-4">
              <div>
                <p className="text-[10px] font-semibold text-fg-muted uppercase tracking-wide">Keys</p>
                <p className="text-sm font-bold text-fg">{importPreview.keyCount}</p>
              </div>
              <div>
                <p className="text-[10px] font-semibold text-fg-muted uppercase tracking-wide">Size</p>
                <p className="text-sm font-bold text-fg font-mono">{formatBytes(importPreview.totalSize)}</p>
              </div>
              <div>
                <p className="text-[10px] font-semibold text-fg-muted uppercase tracking-wide">Exported</p>
                <p className="text-sm font-bold text-fg">
                  {importPreview.exportedAt !== 'Unknown'
                    ? new Date(importPreview.exportedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                    : 'Unknown'}
                </p>
              </div>
            </div>

            {/* Keys list */}
            <div className="max-h-40 overflow-y-auto border border-border-subtle rounded-lg mb-4">
              {importPreview.keys.map(key => (
                <div key={key} className="flex items-center gap-2 px-3 py-1.5 text-xs border-b border-border-subtle last:border-0">
                  <HardDrive size={10} className="text-fg-muted flex-shrink-0" />
                  <span className="font-mono text-fg truncate">{key}</span>
                </div>
              ))}
            </div>

            {/* Skipped keys warning */}
            {importPreview.skippedKeys?.length > 0 && (
              <div className="bg-warning-subtle border border-warning/30 rounded-lg p-2.5 mb-4">
                <p className="text-xs font-semibold text-warning mb-1">
                  {importPreview.skippedKeys.length} unrecognized key{importPreview.skippedKeys.length !== 1 ? 's' : ''} will be skipped:
                </p>
                <div className="max-h-20 overflow-y-auto">
                  {importPreview.skippedKeys.map(k => (
                    <p key={k} className="text-xs font-mono text-warning truncate">{k}</p>
                  ))}
                </div>
              </div>
            )}

            {/* Warning + confirm */}
            {!showConfirm ? (
              <button
                onClick={() => setShowConfirm(true)}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold text-white bg-warning hover:opacity-90 transition-colors"
              >
                <Upload size={14} />
                Import Data
              </button>
            ) : (
              <div className="bg-danger-subtle border border-danger/30 rounded-lg p-3">
                <div className="flex items-start gap-2 mb-3">
                  <Shield size={14} className="text-danger flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-semibold text-danger">Warning: This will overwrite all existing data</p>
                    <p className="text-xs text-danger mt-0.5">
                      All {importPreview.keyCount} storage keys will be replaced. This action cannot be undone.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleImport}
                    disabled={importing}
                    className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold text-white bg-danger hover:bg-danger/90 disabled:opacity-50 transition-colors"
                  >
                    {importing ? (
                      <>
                        <RefreshCw size={13} className="animate-spin" />
                        Importing...
                      </>
                    ) : (
                      <>
                        <AlertTriangle size={13} />
                        Confirm Overwrite
                      </>
                    )}
                  </button>
                  <button
                    onClick={() => { setShowConfirm(false); setImportFile(null); setImportPreview(null); }}
                    className="px-3 py-2 rounded-lg text-sm font-medium text-fg-muted hover:bg-muted transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Storage key inventory */}
      <div className="bg-surface rounded-xl border border-border shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <HardDrive size={14} className="text-fg-muted" />
            <h3 className="text-sm font-semibold text-fg">Storage Keys</h3>
          </div>
          <button
            onClick={scanKeys}
            className="p-1.5 rounded-lg hover:bg-muted text-fg-muted transition-colors"
            title="Rescan"
          >
            <RefreshCw size={13} />
          </button>
        </div>
        <div className="divide-y divide-border max-h-64 overflow-y-auto">
          {keyInfo.map(({ key, size, exists }) => (
            <div key={key} className="flex items-center gap-3 px-4 py-2 hover:bg-muted/40/50 transition-colors">
              <div className={`w-2 h-2 rounded-full flex-shrink-0 ${exists ? 'bg-success' : 'bg-border-strong'}`} />
              <span className="font-mono text-xs text-fg flex-1 truncate">{key}</span>
              <span className="text-[10px] text-fg-muted font-mono flex-shrink-0">
                {exists ? formatBytes(size) : 'empty'}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Daily snapshot panel ────────────────────────────────────────────────────
// Shows the rolling 30-day local snapshot history. User can capture-now,
// download any snapshot as JSON, restore from one, or delete an old one.
function DailySnapshotPanel({ onStatus }) {
  const [snapshots, setSnapshots] = useState([]);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const list = await listSnapshots();
    setSnapshots(list.sort((a, b) => b.date.localeCompare(a.date)));
    setStatus(await getBackupStatus());
  }, []);

  useEffect(() => { reload(); }, [reload]);

  // Compact health badge: green if last success was today/yesterday, amber
  // if older, red if a recent failure is on record. Surfaces silent backup
  // failures so we don't carry a broken snapshot subsystem for weeks again.
  const statusBadge = (() => {
    if (!status) return null;
    const now = Date.now();
    const lastOk = status.lastSuccessAt ? Date.parse(status.lastSuccessAt) : 0;
    const lastErr = status.lastError?.at ? Date.parse(status.lastError.at) : 0;
    const ageDays = lastOk ? Math.floor((now - lastOk) / 86400000) : Infinity;
    if (lastErr && lastErr > lastOk) {
      return {
        cls: 'text-danger bg-danger-subtle border-danger/30',
        label: 'Backup failed',
        detail: status.lastError.message || 'see console',
      };
    }
    if (!status.lastSuccessAt) {
      return {
        cls: 'text-warning bg-warning-subtle border-warning/30',
        label: 'No successful backup yet',
        detail: 'A snapshot will be captured ~30s after launch.',
      };
    }
    if (ageDays > 2) {
      return {
        cls: 'text-warning bg-warning-subtle border-warning/30',
        label: `Last backup ${ageDays}d ago`,
        detail: 'Capture now if the auto-snapshot isn\'t running.',
      };
    }
    return {
      cls: 'text-success bg-success-subtle border-success/30',
      label: `Last backup ${ageDays === 0 ? 'today' : 'yesterday'}`,
      detail: status.latestSnapshot ? `${status.latestSnapshot.keyCount} keys · ${(status.latestSnapshot.sizeKb || 0).toLocaleString()} KB` : '',
    };
  })();

  const handleCapture = async () => {
    setBusy(true);
    try {
      await captureNow();
      await reload();
      onStatus?.({ type: 'success', message: 'Snapshot captured.' });
    } catch (e) {
      onStatus?.({ type: 'error', message: e.message });
    } finally {
      setBusy(false);
    }
  };

  const handleDownload = async (date) => {
    const snap = await getSnapshot(date);
    if (!snap) return;
    const json = JSON.stringify({
      _meta: { app: 'NolTech Hub', version: '1.0', source: 'daily-snapshot', date: snap.date, capturedAt: snap.capturedAt, keyCount: snap.keyCount },
      data: snap.data,
    }, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `noltech-snapshot-${snap.date}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleRestore = async (date) => {
    if (!confirm(`Restore from snapshot ${date}? This will OVERWRITE current data with what was saved on that day. Manual entries since then will be lost.`)) return;
    const snap = await getSnapshot(date);
    if (!snap) return;
    setBusy(true);
    try {
      let restored = 0;
      for (const [key, value] of Object.entries(snap.data || {})) {
        try {
          await window.storage.set(key, value);
          restored++;
        } catch (e) {
          console.error(`[snapshot restore] failed for ${key}:`, e);
        }
      }
      onStatus?.({ type: 'success', message: `Restored ${restored} keys from ${date}. Reloading…` });
      setTimeout(() => window.location.reload(), 1500);
    } catch (e) {
      onStatus?.({ type: 'error', message: e.message });
    } finally {
      setBusy(false);
    }
  };

  // Surgical: restore ONLY the UPC cache from a snapshot. Merges with the
  // current cache (snapshot wins for any UPC, local-only entries are kept).
  // Used to recover the cache without losing inventory edits made today.
  const handleRestoreUpcCache = async (date) => {
    const snap = await getSnapshot(date);
    if (!snap) return;
    const snapshotCache = snap.data?.['noltech:arbitrage:upc-cache'];
    if (!snapshotCache || typeof snapshotCache !== 'object') {
      onStatus?.({ type: 'error', message: `No UPC cache in snapshot ${date}` });
      return;
    }
    const snapshotCount = Object.keys(snapshotCache).length;
    if (!confirm(`Restore only the UPC cache from ${date}? Will merge ${snapshotCount} entries into the current cache (current entries are kept; snapshot wins for any conflicts). Other data is NOT touched.`)) return;
    setBusy(true);
    try {
      const current = (await window.storage.get('noltech:arbitrage:upc-cache')) || {};
      const merged = { ...current, ...snapshotCache };
      // Snapshot fields win for entries that exist in both, EXCEPT keep any
      // newer cleanTitle/cleanedAt the user has done since the snapshot.
      for (const upc of Object.keys(snapshotCache)) {
        if (current[upc]?.cleanedAt && current[upc]?.cleanTitle) {
          merged[upc] = { ...snapshotCache[upc], cleanTitle: current[upc].cleanTitle, cleanedAt: current[upc].cleanedAt, title: current[upc].title || snapshotCache[upc].title };
        }
      }
      await window.storage.set('noltech:arbitrage:upc-cache', merged);
      onStatus?.({ type: 'success', message: `Restored UPC cache: now ${Object.keys(merged).length} entries. Reloading…` });
      setTimeout(() => window.location.reload(), 1500);
    } catch (e) {
      onStatus?.({ type: 'error', message: e.message });
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (date) => {
    if (!confirm(`Delete snapshot ${date}? (snapshots older than 30 days are removed automatically anyway)`)) return;
    await deleteSnapshot(date);
    await reload();
  };

  return (
    <div className="bg-surface rounded-xl border border-border shadow-sm p-5">
      <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
        <div className="flex items-center gap-2">
          <Clock size={16} className="text-fg-muted" />
          <h3 className="text-sm font-semibold text-fg">Daily Snapshots</h3>
          <span className="text-xs text-fg-muted">({snapshots.length} / 30)</span>
        </div>
        <button
          onClick={handleCapture}
          disabled={busy}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-primary text-white hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          <RefreshCw size={11} className={busy ? 'animate-spin' : ''} />
          Capture now
        </button>
      </div>
      <p className="text-xs text-fg-muted mb-3 leading-relaxed">
        Automatic local snapshots once per day, kept for 30 days. Useful for
        "undo something I changed last week." Saved inside the app — for off-
        device backup, also use Export above.
      </p>
      {statusBadge && (
        <div className={`mb-3 flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs ${statusBadge.cls}`}>
          <span className="font-semibold">{statusBadge.label}</span>
          {statusBadge.detail && <span className="opacity-80 truncate">— {statusBadge.detail}</span>}
        </div>
      )}
      {snapshots.length === 0 ? (
        <p className="text-xs text-fg-subtle italic">
          No snapshots yet. The first daily snapshot fires ~30s after app launch.
        </p>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 border-b border-border text-[11px] uppercase tracking-wide text-fg-muted">
              <tr>
                <th className="text-left px-3 py-2">Date</th>
                <th className="text-right px-3 py-2">Size</th>
                <th className="text-right px-3 py-2">Keys</th>
                <th className="text-right px-3 py-2 w-32">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {snapshots.map((s) => (
                <tr key={s.date} className="hover:bg-muted/20">
                  <td className="px-3 py-2 font-mono text-fg">{s.date}</td>
                  <td className="px-3 py-2 text-right font-mono text-fg-muted">{s.sizeKb} KB</td>
                  <td className="px-3 py-2 text-right font-mono text-fg-muted">{s.keyCount}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => handleDownload(s.date)}
                        className="text-fg-muted hover:text-primary p-1 rounded hover:bg-primary/10"
                        title="Download as JSON"
                      >
                        <Download size={11} />
                      </button>
                      <button
                        onClick={() => handleRestoreUpcCache(s.date)}
                        className="text-fg-muted hover:text-warning p-1 rounded hover:bg-warning/10 text-[10px] font-bold"
                        title="Restore ONLY the UPC cache from this snapshot (merges into current; doesn't touch other data)"
                      >
                        UPC
                      </button>
                      <button
                        onClick={() => handleRestore(s.date)}
                        className="text-fg-muted hover:text-success p-1 rounded hover:bg-success/10"
                        title="Restore EVERYTHING from this snapshot (overwrites current data)"
                      >
                        <Upload size={11} />
                      </button>
                      <button
                        onClick={() => handleDelete(s.date)}
                        className="text-fg-muted hover:text-danger p-1 rounded hover:bg-danger/10"
                        title="Delete snapshot"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Reset scraper caches panel ──────────────────────────────────────────────
// Full nuke across three tiers: local IndexedDB, Worker KV/R2, Supabase
// sold_comps. Two-click confirm (button → "Really wipe" prompt) so it can't
// fire accidentally. Result summary shows what was actually cleared.
function ResetScraperCachePanel({ onStatus, onDone }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [lastResult, setLastResult] = useState(null);

  const handleReset = async () => {
    setBusy(true);
    setConfirming(false);
    onStatus?.(null);
    setLastResult(null);
    try {
      const result = await resetAllScraperCaches();
      setLastResult(result);
      const localCleared = result.local?.cleared || 0;
      const workerTotal  = result.worker?.total || 0;
      const supabaseTotal = result.supabase?.deleted || 0;
      const errors = [
        ...(result.local?.errors || []),
        result.worker?.error,
        result.supabase?.error,
      ].filter(Boolean);
      if (errors.length) {
        onStatus?.({
          type: 'error',
          message: `Partial reset (${errors.length} error${errors.length !== 1 ? 's' : ''}). ` +
                   `Local: ${localCleared} · Worker: ${workerTotal} · Supabase: ${supabaseTotal}.`,
        });
      } else {
        onStatus?.({
          type: 'success',
          message: `Wiped ${localCleared} local + ${workerTotal} Worker KV/R2 + ${supabaseTotal} Supabase sold_comps rows.`,
        });
      }
      onDone?.();
    } catch (e) {
      onStatus?.({ type: 'error', message: e?.message || 'Reset failed' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-surface rounded-xl border border-border shadow-sm p-5">
      <div className="flex items-center gap-2 mb-3">
        <Eraser size={16} className="text-danger" />
        <h3 className="text-sm font-semibold text-fg">Reset scraper caches</h3>
      </div>
      <p className="text-xs text-fg-muted mb-3 leading-relaxed">
        Wipes every layer that scraper output flows through — local browse-lots
        + UPC cache + lot history, the Cloudflare Worker's KV (search results,
        manifests, UPC pricing) and R2 (proxied images), and the Supabase
        tables the cron/analyzer write to: <span className="font-mono">sold_comps</span>,{' '}
        <span className="font-mono">lot_analyses</span>,{' '}
        <span className="font-mono">liquidation_manifests</span>,{' '}
        <span className="font-mono">liquidation_lots_newegg</span>,{' '}
        <span className="font-mono">lot_analysis_queue</span>,{' '}
        <span className="font-mono">browse_lots</span>,{' '}
        <span className="font-mono">partout_cache</span>,{' '}
        <span className="font-mono">analysis_costs</span>. Next scrape rebuilds
        everything from live Bright Data (expect a burst of API cost). Your
        watchlist, notes, saved searches, bids, and won manifests are{' '}
        <span className="font-semibold">not touched</span>.
      </p>

      <details className="mb-3 text-[11px] text-fg-muted">
        <summary className="cursor-pointer hover:text-fg select-none">
          What gets wiped ({LOCAL_CACHE_KEYS.length} local keys) / what's kept ({LOCAL_USER_KEYS_KEEP.length})
        </summary>
        <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-3 pl-3">
          <div>
            <p className="font-semibold text-danger mb-1">Wiped (local):</p>
            <ul className="space-y-0.5 font-mono text-[10px]">
              {LOCAL_CACHE_KEYS.map((k) => <li key={k}>· {k}</li>)}
            </ul>
          </div>
          <div>
            <p className="font-semibold text-success mb-1">Kept:</p>
            <ul className="space-y-0.5 font-mono text-[10px]">
              {LOCAL_USER_KEYS_KEEP.map((k) => <li key={k}>· {k}</li>)}
            </ul>
          </div>
        </div>
      </details>

      {!confirming ? (
        <button
          onClick={() => setConfirming(true)}
          disabled={busy}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold bg-danger/10 hover:bg-danger/20 text-danger border border-danger/30 transition-colors disabled:opacity-50"
        >
          <Trash2 size={13} />
          Reset all scraper caches
        </button>
      ) : (
        <div className="bg-danger-subtle border border-danger/30 rounded-lg p-3">
          <div className="flex items-start gap-2 mb-3">
            <Shield size={14} className="text-danger flex-shrink-0 mt-0.5" />
            <p className="text-sm font-semibold text-danger">
              This will wipe local + Worker + Supabase scraper caches. Cannot be undone.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleReset}
              disabled={busy}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold text-white bg-danger hover:bg-danger/90 disabled:opacity-50 transition-colors"
            >
              {busy ? (
                <>
                  <RefreshCw size={13} className="animate-spin" />
                  Wiping…
                </>
              ) : (
                <>
                  <AlertTriangle size={13} />
                  Really wipe everything
                </>
              )}
            </button>
            <button
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="px-3 py-2 rounded-lg text-sm font-medium text-fg-muted hover:bg-muted transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {lastResult && !busy && (
        <div className="mt-3 pt-3 border-t border-border-subtle text-[11px] space-y-1 font-mono text-fg-muted">
          <div className="flex justify-between">
            <span>Local IDB keys cleared</span>
            <span className="text-fg">{lastResult.local?.cleared ?? 0}</span>
          </div>
          <div className="flex justify-between">
            <span>Worker KV + R2 objects deleted</span>
            <span className="text-fg">
              {lastResult.worker?.skipped
                ? `skipped (${lastResult.worker.reason})`
                : lastResult.worker?.error
                ? `error: ${lastResult.worker.error.slice(0, 60)}`
                : lastResult.worker?.total ?? 0}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Supabase cache rows (8 tables)</span>
            <span className="text-fg">
              {lastResult.supabase?.skipped
                ? `skipped (${lastResult.supabase.reason})`
                : lastResult.supabase?.error
                ? `error: ${lastResult.supabase.error.slice(0, 60)}`
                : lastResult.supabase?.deleted ?? 0}
            </span>
          </div>
          {lastResult.supabase?.perTable && (
            <div className="pl-3 pt-1 text-[10px] space-y-0.5">
              {Object.entries(lastResult.supabase.perTable).map(([table, n]) => (
                <div key={table} className="flex justify-between">
                  <span>· {table}</span>
                  <span className="text-fg-muted">{n}</span>
                </div>
              ))}
            </div>
          )}
          {Array.isArray(lastResult.supabase?.errors) && lastResult.supabase.errors.length > 0 && (
            <details className="pl-3 pt-1 text-[10px] text-warning">
              <summary className="cursor-pointer">
                {lastResult.supabase.errors.length} table error{lastResult.supabase.errors.length !== 1 ? 's' : ''} (probably schema-missing — safe to ignore)
              </summary>
              <ul className="mt-1 space-y-0.5">
                {lastResult.supabase.errors.map((e, i) => <li key={i}>· {e}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
