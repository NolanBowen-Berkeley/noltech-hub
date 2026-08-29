import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Camera, Upload, Trash2, Tag, ChevronLeft, ChevronRight,
  Image, ArrowUp, ArrowDown, Package, Layers, X, Check,
  AlertCircle, Loader2,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { useHiddenLots } from '../../hooks/useHiddenLots';
import EmptyState from '../../components/EmptyState';

// ─── Storage ─────────────────────────────────────────────────────────────────
const PHOTOS_KEY = 'noltech:photos';

const PHOTO_TAGS = [
  'Hero', 'Front', 'Back', 'Left', 'Right', 'Defect', 'Label', 'Serial', 'Other',
];

const TAG_COLORS = {
  Hero:   'bg-warning-subtle text-warning border-warning/30',
  Front:  'bg-info-subtle text-info border-info/30',
  Back:   'bg-accent-subtle text-accent border-accent/30',
  Left:   'bg-accent-subtle text-accent border-accent/30',
  Right:  'bg-accent-subtle text-accent border-accent/30',
  Defect: 'bg-danger-subtle text-danger border-danger/30',
  Label:  'bg-success-subtle text-success border-success/30',
  Serial: 'bg-info-subtle text-info border-info/30',
  Other:  'bg-muted text-fg-muted border-border-strong',
};

const MAX_PHOTOS_PER_ITEM = 5;

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ─── Component ───────────────────────────────────────────────────────────────
export default function PhotoWorkflow() {
  const { state } = useApp();
  const { lots: allLots, loading: lotsLoading } = state;
  const { filterVisible } = useHiddenLots();
  // Drop hidden lots from the picker. Memoized so identity is stable for
  // the useEffect dependency arrays below.
  const lots = useMemo(() => filterVisible(allLots), [allLots, filterVisible]);

  const [photoData, setPhotoData] = useState({});     // { [itemId]: { photos: [], updatedAt } }
  const [storageLoading, setStorageLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const [selectedLotId, setSelectedLotId] = useState('');
  const [currentItemIdx, setCurrentItemIdx] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [taggingPhotoId, setTaggingPhotoId] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);

  const fileInputRef = useRef(null);

  // ── Load storage ────────────────────────────────────────────────────────
  useEffect(() => {
    window.storage.get(PHOTOS_KEY)
      .then((data) => setPhotoData(data && typeof data === 'object' ? data : {}))
      .catch((err) => setError(err.message || "Couldn't load photos"))
      .finally(() => setStorageLoading(false));
  }, []);

  // ── Persist ─────────────────────────────────────────────────────────────
  const persist = useCallback(async (next) => {
    setSaving(true);
    try {
      await window.storage.set(PHOTOS_KEY, next);
      setPhotoData(next);
    } catch (err) {
      setError("Couldn't save photos: " + err.message);
    } finally {
      setSaving(false);
    }
  }, []);

  // ── Derived ─────────────────────────────────────────────────────────────
  const selectedLot = useMemo(
    () => lots.find((l) => l.id === selectedLotId) || null,
    [lots, selectedLotId],
  );

  const items = useMemo(
    () => (selectedLot?.items || []),
    [selectedLot],
  );

  const currentItem = items[currentItemIdx] || null;

  const currentPhotos = useMemo(
    () => (currentItem ? (photoData[currentItem.id]?.photos || []) : []),
    [currentItem, photoData],
  );

  // Auto-select first lot
  useEffect(() => {
    if (!selectedLotId && lots.length > 0) setSelectedLotId(lots[0].id);
  }, [lots, selectedLotId]);

  // Clamp item index when lot changes
  useEffect(() => { setCurrentItemIdx(0); }, [selectedLotId]);

  // ── Photo count per item (for badges) ───────────────────────────────────
  const photoCountForItem = useCallback(
    (itemId) => (photoData[itemId]?.photos?.length || 0),
    [photoData],
  );

  // ── Handlers ────────────────────────────────────────────────────────────
  const handleFiles = useCallback(async (files) => {
    if (!currentItem) return;
    const existing = photoData[currentItem.id]?.photos || [];
    const remaining = MAX_PHOTOS_PER_ITEM - existing.length;
    if (remaining <= 0) {
      setError(`Max ${MAX_PHOTOS_PER_ITEM} photos per item. Delete some first.`);
      return;
    }
    const toProcess = Array.from(files).slice(0, remaining);
    try {
      const newPhotos = await Promise.all(
        toProcess.map(async (file) => ({
          id: uid(),
          name: file.name,
          type: file.type,
          tag: 'Other',
          dataUrl: await fileToDataUrl(file),
        })),
      );
      const next = {
        ...photoData,
        [currentItem.id]: {
          photos: [...existing, ...newPhotos],
          updatedAt: new Date().toISOString(),
        },
      };
      await persist(next);
    } catch (err) {
      setError("Couldn't process images: " + err.message);
    }
  }, [currentItem, photoData, persist]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files?.length) handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  const deletePhoto = useCallback(async (photoId) => {
    if (!currentItem) return;
    const entry = photoData[currentItem.id];
    if (!entry) return;
    const next = {
      ...photoData,
      [currentItem.id]: {
        photos: entry.photos.filter((p) => p.id !== photoId),
        updatedAt: new Date().toISOString(),
      },
    };
    await persist(next);
  }, [currentItem, photoData, persist]);

  const setTag = useCallback(async (photoId, tag) => {
    if (!currentItem) return;
    const entry = photoData[currentItem.id];
    if (!entry) return;
    const next = {
      ...photoData,
      [currentItem.id]: {
        photos: entry.photos.map((p) => p.id === photoId ? { ...p, tag } : p),
        updatedAt: new Date().toISOString(),
      },
    };
    await persist(next);
    setTaggingPhotoId(null);
  }, [currentItem, photoData, persist]);

  const movePhoto = useCallback(async (photoId, direction) => {
    if (!currentItem) return;
    const entry = photoData[currentItem.id];
    if (!entry) return;
    const arr = [...entry.photos];
    const idx = arr.findIndex((p) => p.id === photoId);
    if (idx === -1) return;
    const swap = direction === 'up' ? idx - 1 : idx + 1;
    if (swap < 0 || swap >= arr.length) return;
    [arr[idx], arr[swap]] = [arr[swap], arr[idx]];
    const next = {
      ...photoData,
      [currentItem.id]: { photos: arr, updatedAt: new Date().toISOString() },
    };
    await persist(next);
  }, [currentItem, photoData, persist]);

  // ── Loading / Error ─────────────────────────────────────────────────────
  if (lotsLoading || storageLoading) {
    return (
      <div className="space-y-3">
        <div className="h-8 w-48 shimmer rounded-lg" />
        <div className="h-32 shimmer rounded-xl" />
        <div className="h-64 shimmer rounded-xl" />
      </div>
    );
  }

  if (lots.length === 0) {
    return (
      <div className="bg-surface rounded-xl border border-border shadow-sm p-12 text-center">
        <Camera className="w-12 h-12 text-fg-subtle mx-auto mb-3" />
        <p className="text-fg-muted font-medium">No lots in inventory</p>
        <p className="text-sm text-fg-subtle mt-1">Create a lot first, then add photos to items here.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-fg flex items-center gap-2">
          <Camera className="w-5 h-5 text-accent" /> Photo Workflow
        </h2>
        {saving && (
          <span className="text-xs text-fg-subtle flex items-center gap-1">
            <Loader2 className="w-3 h-3 animate-spin" /> Saving...
          </span>
        )}
      </div>

      {error && (
        <div className="bg-danger-subtle border border-danger/30 rounded-lg p-3 flex items-center gap-2 text-sm text-danger">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
          <button onClick={() => setError(null)} className="ml-auto text-danger hover:text-danger">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* ── Lot Selector ────────────────────────────────────────────────── */}
      <div className="bg-surface rounded-xl border border-border shadow-sm p-4">
        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-sm font-medium text-fg-muted flex items-center gap-1">
            <Layers className="w-4 h-4" /> Lot:
          </label>
          <select
            value={selectedLotId}
            onChange={(e) => setSelectedLotId(e.target.value)}
            className="border border-border-strong rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-accent focus:border-accent outline-none"
          >
            {lots.map((l) => (
              <option key={l.id} value={l.id}>
                {l.sourceName || l.source || 'Unnamed Lot'} ({(l.items || []).length} items)
              </option>
            ))}
          </select>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="bg-surface rounded-xl border border-border shadow-sm p-12 text-center">
          <Package className="w-10 h-10 text-fg-subtle mx-auto mb-2" />
          <p className="text-fg-muted">No items in this lot</p>
        </div>
      ) : (
        <>
          {/* ── Item Navigator ──────────────────────────────────────────── */}
          <div className="bg-surface rounded-xl border border-border shadow-sm p-4">
            <div className="flex items-center justify-between mb-3">
              <button
                onClick={() => setCurrentItemIdx((i) => Math.max(0, i - 1))}
                disabled={currentItemIdx === 0}
                className="px-3 py-1.5 text-sm border border-border-strong rounded-lg hover:bg-muted/40 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
              >
                <ChevronLeft className="w-4 h-4" /> Prev
              </button>
              <span className="text-sm font-medium text-fg-muted">
                Item {currentItemIdx + 1} of {items.length}
              </span>
              <button
                onClick={() => setCurrentItemIdx((i) => Math.min(items.length - 1, i + 1))}
                disabled={currentItemIdx === items.length - 1}
                className="px-3 py-1.5 text-sm border border-border-strong rounded-lg hover:bg-muted/40 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
              >
                Next <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            {/* Item strip */}
            <div className="flex gap-2 overflow-x-auto pb-2">
              {items.map((item, idx) => (
                <button
                  key={item.id}
                  onClick={() => setCurrentItemIdx(idx)}
                  className={`shrink-0 px-3 py-2 rounded-lg text-xs border transition-colors ${
                    idx === currentItemIdx
                      ? 'bg-accent text-white border-accent'
                      : 'bg-muted/40 text-fg-muted border-border hover:bg-muted'
                  }`}
                >
                  <div className="font-medium truncate max-w-[120px]">
                    {item.brand} {item.model || 'Item'}
                  </div>
                  <div className="flex items-center gap-1 mt-0.5">
                    <Image className="w-3 h-3" />
                    <span className="font-mono">{photoCountForItem(item.id)}/{MAX_PHOTOS_PER_ITEM}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* ── Current Item Info ───────────────────────────────────────── */}
          {currentItem && (
            <div className="bg-surface rounded-xl border border-border shadow-sm p-4">
              <div className="flex items-center justify-between mb-1">
                <h3 className="font-semibold text-fg">
                  {currentItem.brand} {currentItem.model || 'Unknown Model'}
                </h3>
                <span className="text-xs font-mono text-fg-subtle">{currentItem.serialNumber || 'No S/N'}</span>
              </div>
              <div className="flex gap-2 text-xs text-fg-muted">
                <span className="px-2 py-0.5 bg-muted rounded">{currentItem.category || 'other'}</span>
                <span className="px-2 py-0.5 bg-muted rounded">{currentItem.status || 'received'}</span>
                {currentItem.conditionGrade && (
                  <span className="px-2 py-0.5 bg-muted rounded">Grade {currentItem.conditionGrade}</span>
                )}
              </div>
            </div>
          )}

          {/* ── Drop Zone ──────────────────────────────────────────────── */}
          {currentItem && (
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`bg-surface rounded-xl border-2 border-dashed shadow-sm p-8 text-center cursor-pointer transition-colors ${
                dragOver
                  ? 'border-accent bg-accent/10'
                  : 'border-border-strong hover:border-border-strong'
              } ${currentPhotos.length >= MAX_PHOTOS_PER_ITEM ? 'opacity-50 pointer-events-none' : ''}`}
            >
              <Upload className="w-8 h-8 text-fg-subtle mx-auto mb-2" />
              <p className="text-sm text-fg-muted font-medium">
                Drag & drop photos here or click to browse
              </p>
              <p className="text-xs text-fg-subtle mt-1">
                {currentPhotos.length}/{MAX_PHOTOS_PER_ITEM} photos - accepts images only
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => { if (e.target.files?.length) handleFiles(e.target.files); e.target.value = ''; }}
              />
            </div>
          )}

          {/* ── Photo Grid ─────────────────────────────────────────────── */}
          {currentItem && currentPhotos.length > 0 && (
            <div className="bg-surface rounded-xl border border-border shadow-sm p-4">
              <h4 className="text-sm font-medium text-fg-muted mb-3 flex items-center gap-1">
                <Image className="w-4 h-4" /> Photos ({currentPhotos.length})
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {currentPhotos.map((photo, idx) => (
                  <div key={photo.id} className="border border-border rounded-lg overflow-hidden group">
                    {/* Thumbnail */}
                    <div
                      className="relative aspect-square bg-muted cursor-pointer"
                      onClick={() => setPreviewUrl(photo.dataUrl)}
                    >
                      <img
                        src={photo.dataUrl}
                        alt={photo.name}
                        className="w-full h-full object-cover"
                      />
                      <div className="absolute top-2 left-2">
                        {/* Tag pill is now click-to-cycle. Click advances to
                            the next tag in PHOTO_TAGS; right-click rewinds.
                            Replaces the old hidden popover, cuts photo
                            tagging from 2 clicks to 1. */}
                        <button
                          type="button"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            const idx = PHOTO_TAGS.indexOf(photo.tag);
                            const next = PHOTO_TAGS[(idx + 1) % PHOTO_TAGS.length];
                            setTag(photo.id, next);
                          }}
                          onContextMenu={(ev) => {
                            ev.preventDefault();
                            ev.stopPropagation();
                            const idx = PHOTO_TAGS.indexOf(photo.tag);
                            const prev = PHOTO_TAGS[(idx - 1 + PHOTO_TAGS.length) % PHOTO_TAGS.length];
                            setTag(photo.id, prev);
                          }}
                          title={`Tag: ${photo.tag} — click to cycle, right-click to rewind`}
                          className={`text-xs px-2 py-0.5 rounded-full border font-medium hover:ring-2 hover:ring-primary/40 transition-all ${TAG_COLORS[photo.tag] || TAG_COLORS.Other}`}
                        >
                          {photo.tag}
                        </button>
                      </div>
                      <div className="absolute top-2 right-2 text-xs bg-black/50 text-white px-1.5 py-0.5 rounded font-mono">
                        #{idx + 1}
                      </div>
                    </div>

                    {/* Controls */}
                    <div className="p-2 flex items-center justify-between bg-muted/40">
                      <div className="flex gap-1">
                        <button
                          onClick={() => movePhoto(photo.id, 'up')}
                          disabled={idx === 0}
                          className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
                          title="Move up"
                        >
                          <ArrowUp className="w-3.5 h-3.5 text-fg-muted" />
                        </button>
                        <button
                          onClick={() => movePhoto(photo.id, 'down')}
                          disabled={idx === currentPhotos.length - 1}
                          className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
                          title="Move down"
                        >
                          <ArrowDown className="w-3.5 h-3.5 text-fg-muted" />
                        </button>
                      </div>

                      {/* Tag now cycled via the click-to-cycle pill in
                          the photo's top-left corner — popover removed. */}

                      <button
                        onClick={() => deletePhoto(photo.id)}
                        className="p-1 rounded hover:bg-danger-subtle text-danger hover:text-danger"
                        title="Delete photo"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {currentItem && currentPhotos.length === 0 && (
            <EmptyState
              icon={Camera}
              title="No photos yet for this item"
              description={`Use the upload zone above to add up to ${MAX_PHOTOS_PER_ITEM} photos`}
            />
          )}
        </>
      )}

      {/* ── Full-size Preview Modal ────────────────────────────────────── */}
      {previewUrl && (
        <div
          className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4"
          onClick={() => setPreviewUrl(null)}
        >
          <div className="relative max-w-4xl max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
            <img src={previewUrl} alt="Preview" className="max-w-full max-h-[85vh] object-contain rounded-lg" />
            <button
              onClick={() => setPreviewUrl(null)}
              className="absolute top-2 right-2 bg-black/50 text-white rounded-full p-1.5 hover:bg-black/70"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
