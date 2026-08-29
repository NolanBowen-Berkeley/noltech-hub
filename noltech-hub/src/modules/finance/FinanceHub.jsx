import { useState, lazy, Suspense } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { BookOpen, FileText, DollarSign, Receipt, Users } from 'lucide-react';
import { viewTransition } from '../../components/ui/motion';
import { Tabs } from '../../components/ui';
import Bookkeeping from '../bookkeeping/Bookkeeping';
const LotProfitTracker = lazy(() => import('../lot-profit/LotProfitTracker'));
const TaxExport        = lazy(() => import('../bookkeeping/TaxExport'));
const SalesTaxReport   = lazy(() => import('../bookkeeping/SalesTaxReport'));
const BuyerHistory     = lazy(() => import('../bookkeeping/BuyerHistory'));

const TAB_ITEMS = [
  { id: 'lotpnl',      label: 'Lot P&L',     icon: DollarSign },
  { id: 'bookkeeping', label: 'Bookkeeping', icon: BookOpen },
  { id: 'buyers',      label: 'Buyers',      icon: Users },
  { id: 'sales-tax',   label: 'Sales Tax',   icon: Receipt },
  { id: 'tax-export',  label: 'Tax Export',  icon: FileText },
];

const SKELETON = <div className="h-64 bg-muted rounded-xl animate-pulse" />;

export default function FinanceHub() {
  const [tab, setTab] = useState('lotpnl');

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h1 className="text-xl md:text-2xl font-semibold text-fg tracking-tight">Profit & Finance</h1>
          <p className="text-xs text-fg-muted hidden md:block">Track lot profitability, bookkeeping, and taxes</p>
        </div>
        <Tabs items={TAB_ITEMS} value={tab} onChange={setTab} size="sm" />
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={tab} {...viewTransition}>
          {tab === 'lotpnl'      && <Suspense fallback={SKELETON}><LotProfitTracker /></Suspense>}
          {tab === 'bookkeeping' && <Bookkeeping />}
          {tab === 'buyers'      && <Suspense fallback={SKELETON}><BuyerHistory /></Suspense>}
          {tab === 'sales-tax'   && <Suspense fallback={SKELETON}><SalesTaxReport /></Suspense>}
          {tab === 'tax-export'  && <Suspense fallback={SKELETON}><TaxExport /></Suspense>}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
