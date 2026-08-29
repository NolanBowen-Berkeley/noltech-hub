// ─── Bundle Modal ─────────────────────────────────────────────────────────────
// Combine multiple items into a single bundled listing.
// Creates a new "bundle" item referencing child items + optionally marks them as bundled.

import { useState } from 'react';
import { motion } from 'framer-motion';
import { X, Package, DollarSign, Loader2, CheckCircle2 } from 'lucide-react';
import { fmt } from '../../utils/formatters';
import { getEbayFeeRate } from '../../utils/fees';
import { modalBackdrop, modalPanel } from '../../components/ui/motion';
import { Button, Input, Label, Textarea } from '../../components/ui';

const BUNDLES_KEY = 'noltech:inventory:bundles';

function uuid() { return crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2); }

export default function BundleModal({ selectedItems, onClose, onCreated }) {
  const [title, setTitle] = useState('');
  const [totalPrice, setTotalPrice] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  // Suggest a default title from the items
  const suggestTitle = () => {
    const brands = [...new Set(selectedItems.map(i => i.brand).filter(Boolean))];
    const categories = [...new Set(selectedItems.map(i => i.category).filter(Boolean))];
    const brandStr = brands.length === 1 ? brands[0] : brands.length > 1 ? 'Mixed' : '';
    const catStr = categories.length === 1 ? categories[0] : 'Electronics';
    return `Lot of ${selectedItems.length} ${brandStr} ${catStr}`.replace(/\s+/g, ' ').trim();
  };

  const suggestDescription = () => {
    return selectedItems.map((i, idx) => {
      const name = [i.brand, i.model].filter(Boolean).join(' ') || i.serialNumber || `Item ${idx + 1}`;
      const cond = i.conditionGrade ? ` (Grade ${i.conditionGrade})` : '';
      return `${idx + 1}. ${name}${cond}`;
    }).join('\n');
  };

  const totalCostBasis = selectedItems.reduce((sum, i) => sum + (parseFloat(i.costBasis) || 0), 0);

  const handleSave = async () => {
    if (!title.trim() || !totalPrice) return;
    setSaving(true);
    const bundle = {
      id: uuid(),
      title: title.trim(),
      totalPrice: parseFloat(totalPrice),
      description: description.trim() || suggestDescription(),
      itemIds: selectedItems.map(i => i.id),
      totalCostBasis,
      status: 'draft',
      createdAt: new Date().toISOString(),
    };
    try {
      const existing = (await window.storage.get(BUNDLES_KEY)) || [];
      await window.storage.set(BUNDLES_KEY, [bundle, ...existing]);
      onCreated(bundle);
    } catch (e) {
      console.error('Failed to save bundle:', e);
    }
    setSaving(false);
  };

  return (
    <motion.div {...modalBackdrop} className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
      <motion.div {...modalPanel} onClick={(e) => e.stopPropagation()} className="glossy-elevated w-full max-w-lg flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <div className="flex items-center gap-2">
            <Package className="w-4 h-4 text-primary" />
            <h3 className="font-semibold text-fg">Create Bundle Listing</h3>
          </div>
          <button onClick={onClose} className="p-1 text-fg-subtle hover:text-fg-muted rounded"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          {/* Selected items preview */}
          <div>
            <p className="text-[10px] font-semibold text-fg-muted uppercase tracking-wide mb-1.5">
              {selectedItems.length} items in bundle
            </p>
            <div className="max-h-32 overflow-y-auto bg-muted/40 rounded-lg p-2 space-y-1">
              {selectedItems.slice(0, 20).map(i => (
                <p key={i.id} className="text-xs text-fg truncate">
                  {[i.brand, i.model].filter(Boolean).join(' ') || i.serialNumber || 'Item'}
                  {i.conditionGrade && <span className="text-fg-muted ml-1">Grade {i.conditionGrade}</span>}
                </p>
              ))}
              {selectedItems.length > 20 && <p className="text-[10px] text-fg-muted italic">+{selectedItems.length - 20} more</p>}
            </div>
          </div>

          <div>
            <Label>Listing Title</Label>
            <div className="flex gap-2">
              <Input className="flex-1" value={title} onChange={e => setTitle(e.target.value)}
                placeholder="e.g. Lot of 5 Dell Laptops" />
              <Button variant="secondary" size="sm" onClick={() => setTitle(suggestTitle())}>
                Suggest
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Total Price</Label>
              <Input type="number" step="0.01" leadingIcon={DollarSign} value={totalPrice}
                onChange={e => setTotalPrice(e.target.value)}
                placeholder="0.00"
                className="font-mono" />
            </div>
            <div>
              <Label>Combined Cost Basis</Label>
              <div className="px-3 py-2 bg-muted/40 border border-border rounded-lg text-sm font-mono text-fg">
                {fmt(totalCostBasis)}
              </div>
            </div>
          </div>

          <div>
            <Label>Description</Label>
            <div className="flex gap-2">
              <Textarea className="flex-1 resize-none" value={description} onChange={e => setDescription(e.target.value)}
                rows={5} placeholder="Bundle description (auto-filled if blank)" />
              <Button variant="secondary" size="sm" className="self-start" onClick={() => setDescription(suggestDescription())}>
                Fill from items
              </Button>
            </div>
          </div>

          {/* Profit preview */}
          {totalPrice && parseFloat(totalPrice) > 0 && (() => {
            const price = parseFloat(totalPrice);
            const feeRate = getEbayFeeRate();
            const fees = price * feeRate;
            const profit = price - fees - totalCostBasis;
            return (
              <div className="bg-muted/40 rounded-lg p-3 text-xs space-y-1">
                <div className="flex justify-between"><span className="text-fg-muted">Sale price</span><span className="font-mono font-semibold">{fmt(price)}</span></div>
                <div className="flex justify-between"><span className="text-fg-muted">eBay fees (~{(feeRate * 100).toFixed(2)}%)</span><span className="font-mono text-danger">-{fmt(fees)}</span></div>
                <div className="flex justify-between"><span className="text-fg-muted">Cost basis</span><span className="font-mono text-danger">-{fmt(totalCostBasis)}</span></div>
                <div className="flex justify-between pt-1 border-t border-border font-semibold">
                  <span className="text-fg">Est. profit</span>
                  <span className={`font-mono ${profit > 0 ? 'text-success' : 'text-danger'}`}>
                    {fmt(profit)}
                  </span>
                </div>
              </div>
            );
          })()}
        </div>

        <div className="flex items-center gap-2 px-5 py-4 border-t border-border-subtle">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="accent" className="flex-1" onClick={handleSave} disabled={saving || !title.trim() || !totalPrice}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
            Create Bundle
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}

export { BUNDLES_KEY };
