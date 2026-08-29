import { useState, useEffect, useCallback } from 'react';
import { Save, Plus, Trash2, Wifi, WifiOff, Server, Globe, ToggleLeft, ToggleRight, Loader2 } from 'lucide-react';
import { PIPELINE_BASE } from '../../utils/constants';
import eventBus from '../../services/eventBus';
import { withErrorToast } from '../../utils/withErrorToast';

function StatusDot({ status }) {
  if (status === 'checking') return <span className="inline-flex items-center gap-1 text-[11px] text-fg-muted"><Loader2 size={10} className="animate-spin" /> Checking</span>;
  if (status === 'online')   return <span className="inline-flex items-center gap-1 text-[11px] text-success"><span className="w-1.5 h-1.5 rounded-full bg-success" /> Online</span>;
  if (status === 'offline')  return <span className="inline-flex items-center gap-1 text-[11px] text-danger"><span className="w-1.5 h-1.5 rounded-full bg-danger" /> Offline</span>;
  return <span className="inline-flex items-center gap-1 text-[11px] text-fg-subtle"><span className="w-1.5 h-1.5 rounded-full bg-border-strong" /> Unknown</span>;
}

const inputCls =
  'w-full border border-border rounded-lg px-3 py-2.5 text-sm text-fg bg-surface ' +
  'focus:outline-none focus:ring-2 focus:ring-secondary/30 focus:border-secondary transition-colors';
const labelCls = 'block text-xs font-semibold text-fg-muted uppercase tracking-wide mb-1.5';

const SOURCES_KEY = 'noltech:settings:sources';

// Lot sources the pipeline is configured to serve. These IDs are passed
// through to /api/lots/all as ?sources=; the pipeline's LOT_SOURCES setting
// decides which ones actually resolve. 'sample' is the built-in generated
// feed — add your own entries here to match whatever provider you configure.
// See noltech-pipeline/docs/DATA-SOURCES.md.
const BUILT_IN_SOURCES = [
  { id: 'sample', name: 'Sample data (generated)', url: `${PIPELINE_BASE}`, healthEndpoint: '/api/health' },
  { id: 'ebay',   name: 'eBay API',                url: `${PIPELINE_BASE}`, healthEndpoint: '/api/health' },
];

export default function SourceManager() {
  const [enabled, setEnabled]     = useState(['sample']);
  const [custom, setCustom]       = useState([]);
  const [health, setHealth]       = useState({}); // id -> 'online' | 'offline' | 'checking'
  const [newName, setNewName]     = useState('');
  const [newUrl, setNewUrl]       = useState('');
  const [saved, setSaved]         = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  // Load saved config
  useEffect(() => {
    window.storage.get(SOURCES_KEY).then(cfg => {
      if (cfg) {
        if (Array.isArray(cfg.enabled)) setEnabled(cfg.enabled);
        if (Array.isArray(cfg.custom))  setCustom(cfg.custom);
      }
    }).catch(e => console.error('[source manager] storage error:', e));
  }, []);

  // Cross-device sync — refresh when another device updates the sources list.
  useEffect(() => {
    const off = eventBus.on('sync:object-updated', ({ storageKey, value }) => {
      if (storageKey !== SOURCES_KEY || !value) return;
      if (Array.isArray(value.enabled)) setEnabled(value.enabled);
      if (Array.isArray(value.custom))  setCustom(value.custom);
    });
    return off;
  }, []);

  const persist = useCallback(async (newEnabled, newCustom) => {
    setEnabled(newEnabled);
    setCustom(newCustom);
    const { ok } = await withErrorToast(
      () => window.storage.set(SOURCES_KEY, { enabled: newEnabled, custom: newCustom }),
      { title: 'Sources save failed', tag: 'SourceManager' },
    );
    if (ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  }, []);

  // Check health for all sources
  const checkHealth = useCallback(async () => {
    const allSources = [
      ...BUILT_IN_SOURCES,
      ...custom.map(c => ({ id: c.name, url: c.url, healthEndpoint: '/api/health' })),
    ];

    const newHealth = {};
    for (const src of allSources) {
      newHealth[src.id] = 'checking';
    }
    setHealth({ ...newHealth });

    await Promise.all(allSources.map(async (src) => {
      try {
        const res = await fetch(`${src.url}${src.healthEndpoint || '/api/health'}`, {
          signal: AbortSignal.timeout(5000),
        });
        newHealth[src.id] = res.ok ? 'online' : 'offline';
      } catch {
        newHealth[src.id] = 'offline';
      }
    }));

    setHealth({ ...newHealth });
  }, [custom]);

  // Check health on mount
  useEffect(() => { checkHealth(); }, [checkHealth]);

  const toggleSource = (id) => {
    const newEnabled = enabled.includes(id)
      ? enabled.filter(e => e !== id)
      : [...enabled, id];
    persist(newEnabled, custom);
  };

  const addCustomSource = () => {
    const name = newName.trim();
    let url = newUrl.trim();
    if (!name || !url) return;
    if (!url.startsWith('http')) url = 'https://' + url;
    // Remove trailing slash
    url = url.replace(/\/+$/, '');
    if (custom.some(c => c.name === name)) return;
    const newCustom = [...custom, { name, url }];
    const newEnabled = [...enabled, name];
    persist(newEnabled, newCustom);
    setNewName('');
    setNewUrl('');
  };

  const removeCustomSource = (name) => {
    const newCustom = custom.filter(c => c.name !== name);
    const newEnabled = enabled.filter(e => e !== name);
    persist(newEnabled, newCustom);
    setDeleteConfirm(null);
  };

  const statusBadge = (id) => <StatusDot status={health[id]} />;

  return (
    <div className="bg-surface rounded-xl border border-border shadow-sm p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Server className="w-4 h-4 text-fg-muted" />
          <h3 className="text-sm font-semibold text-fg">Liquidation Sources</h3>
        </div>
        <div className="flex items-center gap-2">
          {saved && <span className="text-xs text-success font-medium">Saved!</span>}
          <button onClick={checkHealth}
            className="flex items-center gap-1 px-2.5 py-1 text-xs text-fg-muted border border-border rounded-lg hover:bg-muted/40 transition-colors">
            <Wifi className="w-3 h-3" /> Check All
          </button>
        </div>
      </div>
      <p className="text-xs text-fg-muted mb-4 leading-relaxed">
        Enable or disable liquidation sources. The scraper server must be running for online sources. Custom sources can be added for future generic scraper support.
      </p>

      {/* Built-in sources */}
      <div className="mb-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted mb-2">Built-in sources</h3>
        <div className="bg-subtle rounded-lg p-3 space-y-1.5">
          {BUILT_IN_SOURCES.map(src => (
            <div key={src.id} className="flex items-center gap-3 px-2 py-1.5 rounded-md hover:bg-surface/60 transition-colors">
              <button onClick={() => toggleSource(src.id)} className="transition-colors shrink-0">
                {enabled.includes(src.id) ? (
                  <ToggleRight className="w-5 h-5 text-success" />
                ) : (
                  <ToggleLeft className="w-5 h-5 text-border-strong" />
                )}
              </button>
              <span className={`text-sm font-medium shrink-0 ${enabled.includes(src.id) ? 'text-fg' : 'text-fg-muted line-through'}`}>
                {src.name}
              </span>
              <span className="flex-1 min-w-0 truncate text-[11px] font-mono text-fg-muted">{src.url}</span>
              <div className="shrink-0">{statusBadge(src.id)}</div>
            </div>
          ))}
        </div>

        {custom.length > 0 && (
          <>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted mb-2 mt-5">Custom sources</h3>
            <div className="bg-subtle rounded-lg p-3 space-y-1.5">
              {custom.map(src => (
                <div key={src.name} className="flex items-center gap-3 px-2 py-1.5 rounded-md hover:bg-surface/60 transition-colors">
                  <button onClick={() => toggleSource(src.name)} className="transition-colors shrink-0">
                    {enabled.includes(src.name) ? (
                      <ToggleRight className="w-5 h-5 text-success" />
                    ) : (
                      <ToggleLeft className="w-5 h-5 text-border-strong" />
                    )}
                  </button>
                  <span className={`text-sm font-medium shrink-0 inline-flex items-center gap-1.5 ${enabled.includes(src.name) ? 'text-fg' : 'text-fg-muted line-through'}`}>
                    <Globe className="w-3 h-3 text-fg-muted" />
                    {src.name}
                  </span>
                  <span className="flex-1 min-w-0 truncate text-[11px] font-mono text-fg-muted">{src.url}</span>
                  <div className="shrink-0">{statusBadge(src.name)}</div>
                  {deleteConfirm === src.name ? (
                    <span className="flex items-center gap-1 shrink-0">
                      <button onClick={() => removeCustomSource(src.name)}
                        className="px-2 py-0.5 bg-danger text-white rounded text-xs font-medium hover:bg-danger/90">
                        Remove
                      </button>
                      <button onClick={() => setDeleteConfirm(null)}
                        className="px-2 py-0.5 border border-border text-fg-muted rounded text-xs hover:bg-muted/40">
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button onClick={() => setDeleteConfirm(src.name)}
                      className="p-1 text-fg-muted hover:text-danger transition-colors shrink-0" title="Remove source">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Add custom source */}
      <div className="bg-muted/40 rounded-lg p-3">
        <p className="text-xs font-semibold text-fg-muted uppercase tracking-wide mb-2">Add Custom Source</p>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelCls}>Source Name</label>
            <input
              type="text"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="e.g. AllSurplus"
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>Base URL</label>
            <input
              type="text"
              value={newUrl}
              onChange={e => setNewUrl(e.target.value)}
              placeholder="e.g. https://api.example.com/lots"
              className={inputCls + ' font-mono text-xs'}
            />
          </div>
        </div>
        <button
          onClick={addCustomSource}
          disabled={!newName.trim() || !newUrl.trim()}
          className="mt-2 flex items-center gap-2 px-3 py-1.5 bg-secondary text-white rounded-lg text-sm font-medium hover:bg-secondary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Plus className="w-3.5 h-3.5" /> Add Source
        </button>
      </div>
    </div>
  );
}
