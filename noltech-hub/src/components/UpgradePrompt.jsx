import { useState } from 'react';
import { motion } from 'framer-motion';
import { Lock, Sparkles, Crown, Check, X } from 'lucide-react';
import { TIERS, getRequiredTier, startTrial, setUserTier } from '../services/tiers';
import { modalBackdrop, modalPanel } from './ui/motion';

const TIER_ICONS = {
  free: Lock,
  pro: Sparkles,
  business: Crown,
};

const TIER_GRADIENTS = {
  slate: 'from-slate-600 to-slate-800',
  primary: 'from-accent to-accent-hover',
  accent: 'from-warning to-warning',
};

export default function UpgradePrompt({ featureId, featureName, onClose }) {
  const [loading, setLoading] = useState(false);
  const required = getRequiredTier(featureId);
  const TierIcon = TIER_ICONS[required.key] || Sparkles;
  const gradient = TIER_GRADIENTS[required.color] || TIER_GRADIENTS.primary;

  const handleTrial = async () => {
    setLoading(true);
    try {
      await startTrial();
      window.location.reload();
    } catch {
      setLoading(false);
    }
  };

  const handleUpgrade = async (tierKey) => {
    setLoading(true);
    try {
      await setUserTier(tierKey);
      window.location.reload();
    } catch {
      setLoading(false);
    }
  };

  return (
    <motion.div {...modalBackdrop} className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
      {/* Modal */}
      <motion.div {...modalPanel} onClick={(e) => e.stopPropagation()} className="glossy-elevated relative max-w-md w-full overflow-hidden">
        {/* Header — brand gradient is exactly the "use sparingly" moment per spec */}
        <div className="relative bg-brand-gradient px-6 py-10 text-center overflow-hidden">
          <button
            onClick={onClose}
            className="absolute top-3 right-3 p-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white/80 hover:text-white transition-colors z-10"
          >
            <X className="w-4 h-4" />
          </button>

          <div className="relative inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-white/15 backdrop-blur-sm mb-4 shadow-[inset_0_1px_0_0_rgb(255_255_255_/_0.2)]">
            <TierIcon className="w-8 h-8 text-white" />
          </div>

          <p className="text-[11px] uppercase tracking-eyebrow font-medium text-white/70 mb-2">
            {required.label}
          </p>
          <h2 className="h-page-title text-white mb-1 tracking-heading">
            Unlock {featureName}
          </h2>
          <p className="text-white/80 text-sm">
            Requires <span className="font-semibold text-white">{required.name}</span> or higher
          </p>
        </div>

        {/* Content */}
        <div className="px-6 py-5 bg-surface">
          <p className="text-sm text-fg-muted mb-4">
            {required.description}
          </p>

          {/* Feature list */}
          <div className="space-y-2 mb-6">
            <p className="ui-eyebrow">
              {required.name} includes
            </p>
            {required.features.map((f) => (
              <div key={f} className="flex items-center gap-2 text-sm text-fg">
                <Check className="w-4 h-4 text-success flex-shrink-0" />
                <span className="capitalize">{f === 'lotsitems' ? 'Lots & Items' : f === 'ebaysync' ? 'eBay Sync' : f === 'lotprofit' ? 'Lot P&L' : f}</span>
              </div>
            ))}
          </div>

          {/* Actions */}
          <div className="space-y-2.5">
            <button
              onClick={handleTrial}
              disabled={loading}
              className="btn-accent text-accent-fg w-full py-2.5 px-4 rounded-xl text-sm font-semibold disabled:opacity-50"
            >
              {loading ? 'Activating...' : 'Start 7-Day Free Trial'}
            </button>

            <button
              onClick={() => handleUpgrade(required.key)}
              disabled={loading}
              className="w-full py-2.5 px-4 rounded-xl text-sm font-medium text-fg bg-muted border border-border hover:bg-subtle hover:border-border-strong transition-colors disabled:opacity-50"
            >
              Upgrade to {required.name} ({required.label})
            </button>
          </div>

          {/* Branding */}
          <p className="text-center text-[10px] text-fg-subtle mt-4">
            NolTech Hub — Built for resellers, by a reseller
          </p>
        </div>
      </motion.div>
    </motion.div>
  );
}
