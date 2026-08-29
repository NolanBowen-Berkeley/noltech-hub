import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  MapPin, Search, Printer, Package, Layers, Save,
  AlertCircle, X, ChevronDown, Loader2, LayoutGrid, List,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { useHiddenLots } from '../../hooks/useHiddenLots';
import EmptyState from '../../components/EmptyState';

// ─── Storage ─────────────────────────────────────────────────────────────────
const LOCATIONS_KEY = 'noltech:locations';

const ZONES = [
  'Shelf A', 'Shelf B', 'Shelf C',
  'Bin 1', 'Bin 2', 'Bin 3',
  'Storage', 'Listed', 'Shipped', 'Other',
];

// ─── Component ───────────────────────────────────────────────────────────────
export default function InventoryLocations() {
  const { state } = useApp();
  const { lots: allLots, loading: lotsLoading } = state;
  const { filterVisible } = useHiddenLots();
  const lots = useMemo(() => filterVisible(allLots), [allLots, filterVisible]);

  const [locationData, setLocationData] = useState({});  // { [itemId]: { location, zone, notes, updatedAt } }
  const [storageLoading, setStorageLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState('grid');       // 'grid' | 'list'
  const [editingItemId, setEditingItemId] = useState(null);
  const [editZone, setEditZone] = useState('');
  const [editLocation, setEditLocation] = useState('');
  const [editNotes, setEditNotes] = useState('');

  // Bulk assign state
  const [bulkLotId, setBulkLotId] = useState('');
  const [bulkZone, setBulkZone] = useState('');
  const [showBulkAssign, setShowBulkAssign] = useState(false);

  // Multi-select state for bulk-assign-by-checkbox in the list view.
  const [selectedItemIds, setSelectedItemIds] = useState(() => new Set());
  const [multiZone, setMultiZone] = useState('');
  const toggleItemSelected = useCallback((itemId) => {
    setSelectedItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelectedItemIds(new Set()), []);
  const applyMultiZone = useCallback(async () => {
    if (!selectedItemIds.size || !multiZone) return;
    const next = { ...locationData };
    const stamp = new Date().toISOString();
    for (const id of selectedItemIds) {
      next[id] = { ...(next[id] || {}), zone: multiZone, updatedAt: stamp };
    }
    setLocationData(next);
    try { await window.storage.set(LOCATIONS_KEY, next); } catch (e) { console.error('[Locations] multi-assign save:', e); }
    setSelectedItemIds(new Set());
  }, [selectedItemIds, multiZone, locationData]);

  // ── All items flat ──────────────────────────────────────────────────────
  const allItems = useMemo(
    () => lots.flatMap((l) => (l.items || []).map((item) => ({
      ...item,
      lotName: l.sourceName || l.source || 'Unnamed Lot',
      lotId: l.id,
    }))),
    [lots],
  );

  // ── Load storage ────────────────────────────────────────────────────────
  useEffect(() => {
    window.storage.get(LOCATIONS_KEY)
      .then((data) => setLocationData(data && typeof data === 'object' ? data : {}))
      .catch((err) => setError("Couldn't load locations: " + err.message))
      .finally(() => setStorageLoading(false));
  }, []);

  // ── Persist ─────────────────────────────────────────────────────────────
  const persist = useCallback(async (next) => {
    setSaving(true);
    try {
      await window.storage.set(LOCATIONS_KEY, next);
      setLocationData(next);
    } catch (err) {
      setError("Couldn't save: " + err.message);
    } finally {
      setSaving(false);
    }
  }, []);

  // ── Items grouped by zone ──────────────────────────────────────────────
  const grouped = useMemo(() => {
    const groups = {};
    ZONES.forEach((z) => { groups[z] = []; });
    groups['Unassigned'] = [];

    allItems.forEach((item) => {
      const loc = locationData[item.id];
      const zone = loc?.zone || 'Unassigned';
      if (!groups[zone]) groups[zone] = [];
      groups[zone].push(item);
    });

    return groups;
  }, [allItems, locationData]);

  // ── Search / "Where is?" ───────────────────────────────────────────────
  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return null;
    const q = searchQuery.toLowerCase();
    return allItems.filter((item) => {
      const name = `${item.brand || ''} ${item.model || ''}`.toLowerCase();
      const sn = (item.serialNumber || '').toLowerCase();
      const loc = locationData[item.id];
      const locStr = `${loc?.zone || ''} ${loc?.location || ''}`.toLowerCase();
      return name.includes(q) || sn.includes(q) || locStr.includes(q);
    });
  }, [searchQuery, allItems, locationData]);

  // ── Edit handlers ──────────────────────────────────────────────────────
  const startEdit = useCallback((itemId) => {
    const loc = locationData[itemId] || {};
    setEditingItemId(itemId);
    setEditZone(loc.zone || '');
    setEditLocation(loc.location || '');
    setEditNotes(loc.notes || '');
  }, [locationData]);

  const saveEdit = useCallback(async () => {
    if (!editingItemId) return;
    const next = {
      ...locationData,
      [editingItemId]: {
        zone: editZone,
        location: editLocation,
        notes: editNotes,
        updatedAt: new Date().toISOString(),
      },
    };
    await persist(next);
    setEditingItemId(null);
  }, [editingItemId, editZone, editLocation, editNotes, locationData, persist]);

  const cancelEdit = useCallback(() => { setEditingItemId(null); }, []);

  // ── Bulk assign ────────────────────────────────────────────────────────
  const handleBulkAssign = useCallback(async () => {
    if (!bulkLotId || !bulkZone) return;
    const lot = lots.find((l) => l.id === bulkLotId);
    if (!lot) return;
    const next = { ...locationData };
    (lot.items || []).forEach((item) => {
      next[item.id] = {
        ...(next[item.id] || {}),
        zone: bulkZone,
        updatedAt: new Date().toISOString(),
      };
    });
    await persist(next);
    setShowBulkAssign(false);
    setBulkLotId('');
    setBulkZone('');
  }, [bulkLotId, bulkZone, lots, locationData, persist]);

  // ── Print label ────────────────────────────────────────────────────────
  const printLabel = useCallback((item) => {
    const loc = locationData[item.id];
    const label = `${item.brand || ''} ${item.model || ''}\n${loc?.zone || 'Unassigned'}${loc?.location ? ' - ' + loc.location : ''}\nS/N: ${item.serialNumber || 'N/A'}`;
    const w = window.open('', '_blank', 'width=400,height=200');
    if (w) {
      w.document.write(`<html><head><title>Label</title><style>body{font-family:monospace;padding:20px;font-size:14px;white-space:pre-line}</style></head><body>${label}</body></html>`);
      w.document.close();
      w.print();
    }
  }, [locationData]);

  // ── Loading ────────────────────────────────────────────────────────────
  if (lotsLoading || storageLoading) {
    return (
      <div className="space-y-3">
        <div className="h-8 w-48 shimmer rounded-lg" />
        <div className="h-32 shimmer rounded-xl" />
        <div className="h-64 shimmer rounded-xl" />
      </div>
    );
  }

  if (allItems.length === 0) {
    return (
      <div className="bg-surface rounded-xl border border-border shadow-sm p-12 text-center">
        <MapPin className="w-12 h-12 text-fg-subtle mx-auto mb-3" />
        <p className="text-fg-muted font-medium">No items in inventory</p>
        <p className="text-sm text-fg-subtle mt-1">Add lots and items first, then assign locations.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-fg flex items-center gap-2">
          <MapPin className="w-5 h-5 text-accent" /> Inventory Locations
        </h2>
        <div className="flex items-center gap-2">
          {saving && (
            <span className="text-xs text-fg-subtle flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" /> Saving...
            </span>
          )}
          <button
            onClick={() => setShowBulkAssign(!showBulkAssign)}
            className="text-xs px-3 py-1.5 bg-primary text-white rounded-lg hover:bg-primary/90 flex items-center gap-1"
          >
            <Layers className="w-3 h-3" /> Bulk Assign
          </button>
          <div className="flex border border-border-strong rounded-lg overflow-hidden">
            <button
              onClick={() => setViewMode('grid')}
              className={`p-1.5 ${viewMode === 'grid' ? 'bg-primary text-white' : 'bg-surface text-fg-muted hover:bg-muted/40'}`}
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={`p-1.5 ${viewMode === 'list' ? 'bg-primary text-white' : 'bg-surface text-fg-muted hover:bg-muted/40'}`}
            >
              <List className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-danger-subtle border border-danger/30 rounded-lg p-3 flex items-center gap-2 text-sm text-danger">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
          <button onClick={() => setError(null)} className="ml-auto text-danger hover:text-danger">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* ── Bulk Assign Panel ───────────────────────────────────────────── */}
      {showBulkAssign && (
        <div className="bg-surface rounded-xl border border-border shadow-sm p-4">
          <h3 className="text-sm font-medium text-fg-muted mb-3 flex items-center gap-1">
            <Layers className="w-4 h-4" /> Bulk Assign Lot to Zone
          </h3>
          <div className="flex gap-3 items-end flex-wrap">
            <div className="flex-1 min-w-[180px]">
              <label className="text-xs text-fg-muted mb-1 block">Lot</label>
              <select
                value={bulkLotId}
                onChange={(e) => setBulkLotId(e.target.value)}
                className="w-full border border-border-strong rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-primary/30 focus:border-primary outline-none"
              >
                <option value="">Select lot...</option>
                {lots.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.sourceName || l.source || 'Unnamed'} ({(l.items || []).length} items)
                  </option>
                ))}
              </select>
            </div>
            <div className="flex-1 min-w-[140px]">
              <label className="text-xs text-fg-muted mb-1 block">Zone</label>
              <select
                value={bulkZone}
                onChange={(e) => setBulkZone(e.target.value)}
                className="w-full border border-border-strong rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-primary/30 focus:border-primary outline-none"
              >
                <option value="">Select zone...</option>
                {ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
              </select>
            </div>
            <button
              onClick={handleBulkAssign}
              disabled={!bulkLotId || !bulkZone}
              className="px-4 py-1.5 bg-accent text-white text-sm rounded-lg hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
            >
              <Save className="w-3.5 h-3.5" /> Assign All
            </button>
          </div>
        </div>
      )}

      {/* ── Where Is? Search ────────────────────────────────────────────── */}
      <div className="bg-surface rounded-xl border border-border shadow-sm p-4">
        <label className="text-sm font-medium text-fg-muted mb-2 block flex items-center gap-1">
          <Search className="w-4 h-4" /> Where is? — Search items by name, serial, or location
        </label>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search items..."
          className="w-full border border-border-strong rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/30 focus:border-primary outline-none"
        />
        {searchResults && (
          <div className="mt-3">
            {searchResults.length === 0 ? (
              <EmptyState
                icon={MapPin}
                title="No items match your search"
                size="sm"
              />
            ) : (
              <div className="divide-y divide-border-subtle max-h-60 overflow-y-auto">
                {searchResults.map((item) => {
                  const loc = locationData[item.id];
                  return (
                    <div key={item.id} className="py-2 flex items-center justify-between">
                      <div>
                        <span className="text-sm font-medium text-fg">
                          {item.brand} {item.model || 'Unknown'}
                        </span>
                        {item.serialNumber && (
                          <span className="text-xs font-mono text-fg-subtle ml-2">{item.serialNumber}</span>
                        )}
                        <span className="text-xs text-fg-subtle ml-2">({item.lotName})</span>
                      </div>
                      <div className="flex items-center gap-2">
                        {loc?.zone ? (
                          <span className="text-xs px-2 py-0.5 bg-info-subtle text-info rounded-full font-medium">
                            {loc.zone}{loc.location ? ` - ${loc.location}` : ''}
                          </span>
                        ) : (
                          <span className="text-xs px-2 py-0.5 bg-muted text-fg-muted rounded-full">
                            Unassigned
                          </span>
                        )}
                        <button
                          onClick={() => startEdit(item.id)}
                          className="text-xs text-primary hover:underline"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => printLabel(item)}
                          className="p-1 hover:bg-muted rounded"
                          title="Print label"
                        >
                          <Printer className="w-3.5 h-3.5 text-fg-subtle" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Edit Modal ──────────────────────────────────────────────────── */}
      {editingItemId && (() => {
        const item = allItems.find((i) => i.id === editingItemId);
        if (!item) return null;
        return (
          <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={cancelEdit}>
            <div className="bg-surface rounded-xl shadow-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
              <h3 className="font-semibold text-fg mb-1">
                {item.brand} {item.model || 'Unknown'}
              </h3>
              {item.serialNumber && (
                <p className="text-xs font-mono text-fg-subtle mb-4">{item.serialNumber}</p>
              )}
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-fg-muted mb-1 block">Zone</label>
                  <select
                    value={editZone}
                    onChange={(e) => setEditZone(e.target.value)}
                    className="w-full border border-border-strong rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/30 focus:border-primary outline-none"
                  >
                    <option value="">Unassigned</option>
                    {ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-fg-muted mb-1 block">Specific Location (e.g. A-3)</label>
                  <input
                    type="text"
                    value={editLocation}
                    onChange={(e) => setEditLocation(e.target.value)}
                    placeholder="e.g. A-3, Top Shelf, Slot 7"
                    className="w-full border border-border-strong rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/30 focus:border-primary outline-none"
                  />
                </div>
                <div>
                  <label className="text-xs text-fg-muted mb-1 block">Notes</label>
                  <input
                    type="text"
                    value={editNotes}
                    onChange={(e) => setEditNotes(e.target.value)}
                    placeholder="Optional notes..."
                    className="w-full border border-border-strong rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/30 focus:border-primary outline-none"
                  />
                </div>
              </div>
              <div className="flex gap-2 mt-4 justify-end">
                <button onClick={cancelEdit} className="px-4 py-2 text-sm border border-border-strong rounded-lg hover:bg-muted/40">
                  Cancel
                </button>
                <button
                  onClick={saveEdit}
                  className="px-4 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary/90 flex items-center gap-1"
                >
                  <Save className="w-3.5 h-3.5" /> Save
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Zone Grid / List Overview ───────────────────────────────────── */}
      {viewMode === 'grid' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...ZONES, 'Unassigned'].map((zone) => {
            const items = grouped[zone] || [];
            if (items.length === 0 && zone === 'Unassigned') return null;
            return (
              <div key={zone} className="bg-surface rounded-xl border border-border shadow-sm p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-fg flex items-center gap-1">
                    <MapPin className="w-4 h-4 text-accent" /> {zone}
                  </h3>
                  <span className={`text-xs font-mono px-2 py-0.5 rounded-full ${
                    items.length > 0 ? 'bg-info-subtle text-info' : 'bg-muted text-fg-subtle'
                  }`}>
                    {items.length}
                  </span>
                </div>
                {items.length === 0 ? (
                  <p className="text-xs text-fg-subtle">Empty</p>
                ) : (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {items.map((item) => {
                      const loc = locationData[item.id];
                      return (
                        <div
                          key={item.id}
                          className="flex items-center justify-between text-xs bg-muted/40 rounded px-2 py-1.5 hover:bg-muted cursor-pointer group"
                          onClick={() => startEdit(item.id)}
                        >
                          <div className="truncate">
                            <span className="font-medium text-fg">
                              {item.brand} {item.model || ''}
                            </span>
                            {loc?.location && (
                              <span className="text-fg-subtle ml-1">({loc.location})</span>
                            )}
                          </div>
                          <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={(e) => { e.stopPropagation(); printLabel(item); }}
                              className="p-0.5 hover:bg-muted rounded"
                              title="Print label"
                            >
                              <Printer className="w-3 h-3 text-fg-subtle" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        /* List view */
        <div className="bg-surface rounded-xl border border-border shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/40 border-b border-border">
                <th className="text-center px-2 py-2 w-8">
                  <input
                    type="checkbox"
                    checked={selectedItemIds.size > 0 && selectedItemIds.size === allItems.length}
                    onChange={(ev) => {
                      if (ev.target.checked) setSelectedItemIds(new Set(allItems.map(i => i.id)));
                      else clearSelection();
                    }}
                    className="rounded border-border-strong text-primary focus:ring-primary/30"
                    title={selectedItemIds.size === allItems.length ? 'Clear all' : 'Select all'}
                  />
                </th>
                <th className="text-left px-4 py-2 text-xs font-medium text-fg-muted">Item</th>
                <th className="text-left px-4 py-2 text-xs font-medium text-fg-muted">Lot</th>
                <th className="text-left px-4 py-2 text-xs font-medium text-fg-muted">Zone</th>
                <th className="text-left px-4 py-2 text-xs font-medium text-fg-muted">Location</th>
                <th className="text-right px-4 py-2 text-xs font-medium text-fg-muted">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {allItems.map((item, idx) => {
                const loc = locationData[item.id];
                const isSelected = selectedItemIds.has(item.id);
                return (
                  <tr key={item.id} className={`${idx % 2 === 1 ? 'bg-muted/40' : ''} ${isSelected ? 'bg-primary/5' : ''}`}>
                    <td className="px-2 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleItemSelected(item.id)}
                        className="rounded border-border-strong text-primary focus:ring-primary/30"
                      />
                    </td>
                    <td className="px-4 py-2">
                      <span className="font-medium text-fg">{item.brand} {item.model || ''}</span>
                      {item.serialNumber && (
                        <span className="text-xs font-mono text-fg-subtle ml-2">{item.serialNumber}</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs text-fg-muted">{item.lotName}</td>
                    <td className="px-4 py-2">
                      {loc?.zone ? (
                        <span className="text-xs px-2 py-0.5 bg-info-subtle text-info rounded-full">
                          {loc.zone}
                        </span>
                      ) : (
                        <span className="text-xs text-fg-subtle">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs font-mono text-fg-muted">{loc?.location || '—'}</td>
                    <td className="px-4 py-2 text-right">
                      <div className="flex gap-1 justify-end">
                        <button
                          onClick={() => startEdit(item.id)}
                          className="text-xs text-primary hover:underline"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => printLabel(item)}
                          className="p-1 hover:bg-muted rounded"
                          title="Print label"
                        >
                          <Printer className="w-3.5 h-3.5 text-fg-subtle" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Sticky multi-select toolbar — appears when at least one item is
          checked. Pick a zone, click "Assign to N items". */}
      {selectedItemIds.size > 0 && (
        <div className="sticky bottom-2 z-20 bg-surface rounded-xl border border-border shadow-lg ring-1 ring-primary/10 p-3 flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold text-primary">
            {selectedItemIds.size} selected
          </span>
          <select
            value={multiZone}
            onChange={(ev) => setMultiZone(ev.target.value)}
            className="border border-border-strong rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-primary/30 focus:border-primary outline-none"
          >
            <option value="">Pick a zone…</option>
            {ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
          <button
            type="button"
            onClick={applyMultiZone}
            disabled={!multiZone}
            className="text-sm px-3 py-1.5 bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Assign to {selectedItemIds.size}
          </button>
          <button
            type="button"
            onClick={clearSelection}
            className="text-sm px-3 py-1.5 border border-border text-fg-muted rounded-lg hover:bg-muted/40"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
