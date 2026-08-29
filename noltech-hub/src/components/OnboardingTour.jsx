import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  Rocket,
  Search,
  BarChart2,
  Gavel,
  Package,
  ClipboardCheck,
  ShoppingCart,
  BookOpen,
  FolderKanban,
  PartyPopper,
  X,
  ChevronRight,
  ChevronLeft,
} from 'lucide-react';
import { modalBackdrop, modalPanel } from './ui/motion';

// ─── Constants ────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'noltech:onboarding:completed';

const STEPS = [
  {
    icon: Rocket,
    title: 'Welcome to NolTech Hub',
    description:
      'Your all-in-one platform for electronics resale. NolTech Hub connects every step of the liquidation-to-resale pipeline — from sourcing lots to tracking profits. Everything lives in one place so you can move fast and make smarter decisions.',
    color: 'bg-accent',
    iconColor: 'text-white',
  },
  {
    icon: Search,
    title: 'Browse & Scrape Lots',
    description:
      'The Arbitrage Scanner helps you find profitable lots on liquidation sites. Scrape listings, view manifests, and run instant pricing against real market data to know what a lot is actually worth before you bid.',
    color: 'bg-accent-hover',
    iconColor: 'text-white',
  },
  {
    icon: BarChart2,
    title: 'Analyze Deals',
    description:
      'Get bid guidance powered by signal badges and UPC-level pricing. See estimated profit, ROI, and risk level for every lot. Green means go, red means walk away — no guesswork needed.',
    color: 'bg-success',
    iconColor: 'text-white',
  },
  {
    icon: Gavel,
    title: 'Track Your Bids',
    description:
      'The Bid Tracker keeps all your active bids, watchlist items, and budget in one dashboard. Set max bids, get alerts when auctions are ending, and never lose track of what you are bidding on.',
    color: 'bg-warning',
    iconColor: 'text-white',
  },
  {
    icon: Package,
    title: 'Import Won Lots',
    description:
      'When you win a lot, import it directly into your inventory. The won lot importer auto-creates items from the manifest, assigns cost basis, and gets everything ready for processing.',
    color: 'bg-accent-hover',
    iconColor: 'text-white',
  },
  {
    icon: ClipboardCheck,
    title: 'Test & Label Items',
    description:
      'Run testing checklists per device type, assign condition grades, generate SKUs, and print labels. Every item gets tracked from the moment it arrives to the moment it ships.',
    color: 'bg-accent',
    iconColor: 'text-white',
  },
  {
    icon: ShoppingCart,
    title: 'List & Sell',
    description:
      'Generate optimized listings with AI-powered titles and descriptions. Cross-list to eBay, Mercari, and Facebook Marketplace. Manage photos and pricing from one place.',
    color: 'bg-success',
    iconColor: 'text-white',
  },
  {
    icon: BookOpen,
    title: 'Track Finances',
    description:
      'Automatic bookkeeping tracks every dollar — purchase costs, platform fees, shipping, and net profit. View ROI dashboards, per-lot P&L, and export clean records for tax time.',
    color: 'bg-accent',
    iconColor: 'text-white',
  },
  {
    icon: FolderKanban,
    title: 'Stay Organized',
    description:
      'Assign storage locations, get dead stock alerts for items sitting too long, and use notifications to stay on top of auctions, pricing, and inventory that needs attention.',
    color: 'bg-warning',
    iconColor: 'text-white',
  },
  {
    icon: PartyPopper,
    title: "You're Ready!",
    description:
      'You are all set to start using NolTech Hub. Head to Settings any time to customize dark mode, manage backups, or re-run this tour. Time to find some deals.',
    color: 'bg-accent',
    iconColor: 'text-white',
  },
];

// ─── OnboardingTour ───────────────────────────────────────────────────────────

export default function OnboardingTour({ onComplete }) {
  const [show, setShow] = useState(false);
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);

  // ── Check if onboarding was already completed ─────────────────────────

  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const completed = await window.storage.get(STORAGE_KEY);
        if (!cancelled) {
          setShow(!completed);
          setLoading(false);
        }
      } catch (err) {
        console.error('Failed to check onboarding status:', err);
        if (!cancelled) {
          setShow(true);
          setLoading(false);
        }
      }
    }
    check();
    return () => { cancelled = true; };
  }, []);

  // ── Complete the tour ─────────────────────────────────────────────────

  const completeTour = useCallback(async () => {
    try {
      await window.storage.set(STORAGE_KEY, true);
    } catch (err) {
      console.error('Failed to save onboarding completion:', err);
    }
    setShow(false);
    onComplete?.();
  }, [onComplete]);

  // ── Skip the tour ─────────────────────────────────────────────────────

  const skipTour = useCallback(() => {
    completeTour();
  }, [completeTour]);

  // ── Navigation ────────────────────────────────────────────────────────

  const goNext = useCallback(() => {
    if (step < STEPS.length - 1) {
      setStep(s => s + 1);
    } else {
      completeTour();
    }
  }, [step, completeTour]);

  const goPrev = useCallback(() => {
    if (step > 0) setStep(s => s - 1);
  }, [step]);

  // ── Don't render if loading or already completed ──────────────────────

  if (loading || !show) return null;

  const current = STEPS[step];
  const Icon = current.icon;
  const isLast = step === STEPS.length - 1;
  const isFirst = step === 0;

  return (
    <motion.div {...modalBackdrop} className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={(e) => e.stopPropagation()}>
      {/* Modal */}
      <motion.div {...modalPanel} onClick={(e) => e.stopPropagation()} className="glossy-elevated relative w-full max-w-lg overflow-hidden">
        {/* Skip button */}
        <button
          onClick={skipTour}
          className="absolute top-4 right-4 z-10 p-1.5 rounded-lg text-fg-muted hover:text-fg hover:bg-muted transition-colors"
          title="Skip tour"
        >
          <X size={18} />
        </button>

        {/* Icon banner — brand gradient wash on first/last, semantic surface elsewhere */}
        <div className="relative px-8 pt-10 pb-8 flex justify-center bg-recessed overflow-hidden">
          {(isFirst || isLast) && <div className="hero-mesh" />}
          <div className="relative z-10 w-20 h-20 rounded-2xl bg-brand-gradient flex items-center justify-center shadow-accent-glow">
            <Icon size={36} className="text-white" />
          </div>
        </div>

        {/* Content */}
        <div className="px-8 pt-6 pb-4">
          {/* Step indicator */}
          <div className="flex items-center gap-1 mb-3 justify-center">
            <span className="ui-eyebrow">
              Step {step + 1} of {STEPS.length}
            </span>
          </div>

          <h2 className="h-page-title text-fg text-center mb-3 tracking-heading">
            {current.title}
          </h2>
          <p className="text-sm text-fg-muted leading-relaxed text-center">
            {current.description}
          </p>
        </div>

        {/* Footer */}
        <div className="px-8 pb-6 pt-4">
          {/* Progress dots */}
          <div className="flex items-center justify-center gap-1.5 mb-5">
            {STEPS.map((_, i) => (
              <button
                key={i}
                onClick={() => setStep(i)}
                className={`rounded-full transition-all duration-200 ${
                  i === step
                    ? 'w-6 h-2 bg-brand-gradient'
                    : i < step
                    ? 'w-2 h-2 bg-fg'
                    : 'w-2 h-2 bg-muted'
                }`}
                title={`Go to step ${i + 1}`}
              />
            ))}
          </div>

          {/* Navigation buttons */}
          <div className="flex items-center justify-between gap-3">
            {/* Back button */}
            {!isFirst ? (
              <button
                onClick={goPrev}
                className="flex items-center gap-1 px-4 py-2.5 text-sm font-medium text-fg-muted hover:text-fg hover:bg-muted rounded-xl transition-colors"
              >
                <ChevronLeft size={16} />
                Back
              </button>
            ) : (
              <button
                onClick={skipTour}
                className="px-4 py-2.5 text-sm font-medium text-fg-muted hover:text-fg hover:bg-muted rounded-xl transition-colors"
              >
                Skip Tour
              </button>
            )}

            {/* Next / Finish button */}
            <button
              onClick={goNext}
              className="btn-accent text-accent-fg flex items-center gap-1 px-6 py-2.5 text-sm font-semibold rounded-xl"
            >
              {isLast ? 'Get Started' : 'Next'}
              {!isLast && <ChevronRight size={16} />}
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
