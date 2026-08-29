import { useState, useEffect } from 'react';
import { Save, Plus, Trash2, Pencil, ChevronUp, ChevronDown, RotateCcw, AlertTriangle, Tag } from 'lucide-react';
import { DEFAULT_CATEGORIES, getCategories, setCategories } from '../../utils/constants';
import { STORAGE_KEY } from '../../utils/constants';
import eventBus from '../../services/eventBus';
import { withErrorToast } from '../../utils/withErrorToast';

const inputCls =
  'w-full border border-border rounded-lg px-3 py-2.5 text-sm text-fg bg-surface ' +
  'focus:outline-none focus:ring-2 focus:ring-secondary/30 focus:border-secondary transition-colors';
const labelCls = 'block text-xs font-semibold text-fg-muted uppercase tracking-wide mb-1.5';

const CATEGORIES_STORAGE_KEY = 'noltech:settings:categories';

export default function CategoryManager() {
  const [categories, setCats] = useState([]);
  const [newValue, setNewValue] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newIcon, setNewIcon] = useState('');
  const [editIdx, setEditIdx] = useState(-1);
  const [editLabel, setEditLabel] = useState('');
  const [saved, setSaved] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(-1);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [itemCounts, setItemCounts] = useState({});

  // Load categories and count items per category
  useEffect(() => {
    setCats([...getCategories()]);

    // Count items using each category for delete warnings
    window.storage.get(STORAGE_KEY).then(lots => {
      if (!Array.isArray(lots)) return;
      const counts = {};
      for (const lot of lots) {
        for (const item of (lot.items || [])) {
          if (item.category) {
            counts[item.category] = (counts[item.category] || 0) + 1;
          }
        }
      }
      setItemCounts(counts);
    }).catch(e => console.error('[CategoryManager] item counts load failed:', e));
  }, []);

  // Cross-device sync — when another device updates the workspace's category
  // list, syncEngine writes it locally and emits sync:object-updated. Refresh
  // the module-level cache (setCategories) AND the local state so the panel
  // doesn't keep showing the stale list until next reload.
  useEffect(() => {
    const off = eventBus.on('sync:object-updated', ({ storageKey, value }) => {
      if (storageKey === CATEGORIES_STORAGE_KEY && Array.isArray(value)) {
        setCategories(value);
        setCats([...value]);
      }
    });
    return off;
  }, []);

  const persist = async (updated) => {
    setCats(updated);
    setCategories(updated);
    const { ok } = await withErrorToast(
      () => window.storage.set(CATEGORIES_STORAGE_KEY, updated),
      { title: 'Categories save failed', tag: 'CategoryManager' },
    );
    if (ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  const addCategory = () => {
    const val = newValue.trim().toLowerCase().replace(/\s+/g, '_');
    const lbl = newLabel.trim();
    if (!val || !lbl) return;
    if (categories.some(c => c.value === val)) return;
    const entry = { value: val, label: lbl };
    if (newIcon.trim()) entry.icon = newIcon.trim();
    persist([...categories, entry]);
    setNewValue('');
    setNewLabel('');
    setNewIcon('');
  };

  const startEdit = (idx) => {
    setEditIdx(idx);
    setEditLabel(categories[idx].label);
  };

  const saveEdit = () => {
    if (editIdx < 0 || !editLabel.trim()) return;
    const updated = [...categories];
    updated[editIdx] = { ...updated[editIdx], label: editLabel.trim() };
    persist(updated);
    setEditIdx(-1);
    setEditLabel('');
  };

  const deleteCategory = (idx) => {
    const updated = categories.filter((_, i) => i !== idx);
    persist(updated);
    setDeleteConfirm(-1);
  };

  const moveUp = (idx) => {
    if (idx <= 0) return;
    const updated = [...categories];
    [updated[idx - 1], updated[idx]] = [updated[idx], updated[idx - 1]];
    persist(updated);
  };

  const moveDown = (idx) => {
    if (idx >= categories.length - 1) return;
    const updated = [...categories];
    [updated[idx], updated[idx + 1]] = [updated[idx + 1], updated[idx]];
    persist(updated);
  };

  const resetToDefaults = () => {
    persist([...DEFAULT_CATEGORIES]);
    setResetConfirm(false);
  };

  return (
    <div className="bg-surface rounded-xl border border-border shadow-sm p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Tag className="w-4 h-4 text-fg-muted" />
          <h3 className="text-sm font-semibold text-fg">Item Categories</h3>
        </div>
        {saved && <span className="text-xs text-success font-medium">Saved!</span>}
      </div>
      <p className="text-xs text-fg-muted mb-4 leading-relaxed">
        Customize the categories available for inventory items. Reorder, rename, or add new categories to match your product lines.
      </p>

      {/* Category list */}
      <div className="border border-border rounded-lg overflow-hidden mb-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/40 text-xs text-fg-muted uppercase tracking-wide">
              <th className="text-left px-3 py-2 w-8">#</th>
              <th className="text-left px-3 py-2">Slug</th>
              <th className="text-left px-3 py-2">Label</th>
              <th className="text-left px-3 py-2 w-16">Items</th>
              <th className="text-right px-3 py-2 w-32">Actions</th>
            </tr>
          </thead>
          <tbody>
            {categories.map((cat, idx) => (
              <tr key={cat.value} className={idx % 2 === 0 ? 'bg-surface' : 'bg-muted/40'}>
                <td className="px-3 py-2 text-fg-muted font-mono text-xs">{idx + 1}</td>
                <td className="px-3 py-2 font-mono text-xs">{cat.value}</td>
                <td className="px-3 py-2">
                  {editIdx === idx ? (
                    <div className="flex items-center gap-1">
                      <input
                        type="text"
                        value={editLabel}
                        onChange={e => setEditLabel(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditIdx(-1); }}
                        className="border border-secondary rounded px-2 py-1 text-sm w-full focus:outline-none focus:ring-1 focus:ring-secondary/30"
                        autoFocus
                      />
                      <button onClick={saveEdit} className="text-success hover:text-success/80 p-1" title="Save">
                        <Save className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <span>{cat.label}</span>
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-fg-muted">
                  {itemCounts[cat.value] || 0}
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="flex items-center justify-end gap-0.5">
                    <button onClick={() => moveUp(idx)} disabled={idx === 0}
                      className="p-1 text-fg-muted hover:text-fg disabled:opacity-30 transition-colors" title="Move up">
                      <ChevronUp className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => moveDown(idx)} disabled={idx === categories.length - 1}
                      className="p-1 text-fg-muted hover:text-fg disabled:opacity-30 transition-colors" title="Move down">
                      <ChevronDown className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => startEdit(idx)}
                      className="p-1 text-fg-muted hover:text-secondary transition-colors" title="Edit label">
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    {deleteConfirm === idx ? (
                      <span className="flex items-center gap-1 ml-1">
                        <button onClick={() => deleteCategory(idx)}
                          className="px-2 py-0.5 bg-danger text-white rounded text-xs font-medium hover:bg-danger/90">
                          Delete
                        </button>
                        <button onClick={() => setDeleteConfirm(-1)}
                          className="px-2 py-0.5 border border-border text-fg-muted rounded text-xs hover:bg-muted/40">
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button onClick={() => setDeleteConfirm(idx)}
                        className="p-1 text-fg-muted hover:text-danger transition-colors" title="Delete">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  {deleteConfirm === idx && itemCounts[cat.value] > 0 && (
                    <p className="text-[10px] text-danger mt-1 flex items-center gap-1 justify-end">
                      <AlertTriangle className="w-3 h-3" />
                      {itemCounts[cat.value]} item{itemCounts[cat.value] !== 1 ? 's' : ''} use this category
                    </p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Add new category */}
      <div className="bg-muted/40 rounded-lg p-3 mb-4">
        <p className="text-xs font-semibold text-fg-muted uppercase tracking-wide mb-2">Add Category</p>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className={labelCls}>Slug (value)</label>
            <input
              type="text"
              value={newValue}
              onChange={e => setNewValue(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
              placeholder="e.g. printer"
              className={inputCls + ' font-mono text-xs'}
            />
          </div>
          <div>
            <label className={labelCls}>Display Label</label>
            <input
              type="text"
              value={newLabel}
              onChange={e => setNewLabel(e.target.value)}
              placeholder="e.g. Printer"
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>Icon Name <span className="normal-case font-normal">(optional)</span></label>
            <input
              type="text"
              value={newIcon}
              onChange={e => setNewIcon(e.target.value)}
              placeholder="e.g. printer"
              className={inputCls + ' text-xs'}
            />
          </div>
        </div>
        <button
          onClick={addCategory}
          disabled={!newValue.trim() || !newLabel.trim()}
          className="mt-2 flex items-center gap-2 px-3 py-1.5 bg-secondary text-white rounded-lg text-sm font-medium hover:bg-secondary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Plus className="w-3.5 h-3.5" /> Add
        </button>
      </div>

      {/* Reset to defaults */}
      {resetConfirm ? (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-danger font-medium">Reset all categories to defaults?</span>
          <button onClick={resetToDefaults}
            className="px-3 py-1.5 bg-danger text-white rounded-lg text-sm font-medium hover:bg-danger/90 transition-colors">
            Yes, Reset
          </button>
          <button onClick={() => setResetConfirm(false)}
            className="px-3 py-1.5 border border-border text-fg-muted rounded-lg text-sm font-medium hover:bg-muted/40 transition-colors">
            Cancel
          </button>
        </div>
      ) : (
        <button onClick={() => setResetConfirm(true)}
          className="flex items-center gap-2 px-3 py-1.5 border border-border text-fg-muted rounded-lg text-sm font-medium hover:bg-muted/40 transition-colors">
          <RotateCcw className="w-3.5 h-3.5" /> Reset to Defaults
        </button>
      )}
    </div>
  );
}
