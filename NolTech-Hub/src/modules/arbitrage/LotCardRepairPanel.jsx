// ─── Lot Card — bent-pin repair-cost panel ───────────────────────────────────
// Shows the per-socket shopping list + total cost to re-socket every
// motherboard in the lot. Renders only when the priced manifest contains
// motherboards; quietly hides otherwise. See src/utils/motherboardRepair.js.

import { memo } from 'react';
import { Wrench, HelpCircle } from 'lucide-react';

function LotCardRepairPanelInner({ summary }) {
  if (!summary || summary.totalBoards === 0) return null;

  return (
    <div className="rounded-lg bg-secondary-subtle border border-secondary/30 px-3 py-2">
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-[10px] uppercase tracking-wide text-fg-muted flex items-center gap-1">
          <Wrench size={11} className="text-secondary" />
          Repair Costs · bent-pin sockets
        </p>
        <p className="text-[11px] text-fg-muted">
          Est.{' '}
          <span className="font-mono font-semibold text-secondary">
            ${summary.totalCost.toLocaleString()}
          </span>
          <span className="text-fg-subtle">
            {' / '}{summary.totalBoards} board{summary.totalBoards !== 1 ? 's' : ''}
          </span>
        </p>
      </div>

      {/* Two-column shopping list. Known sockets first (aggregated), then each
          unknown-socket board as its own 1× row so the user can eyeball them. */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
        {summary.bySocket.map((row) => (
          <div key={row.socket} className="flex items-center justify-between">
            <span className="text-fg font-medium">{row.socket}</span>
            <span className="text-fg-muted">
              <span className="font-mono font-semibold">{row.count}×</span>
              <span className="text-fg-subtle"> (${row.cost})</span>
            </span>
          </div>
        ))}
        {summary.unknowns.map((u, idx) => (
          <div
            key={`unknown-${idx}`}
            className="flex items-center justify-between"
            title={u.title ? `Unknown socket — ${u.title}` : 'Unknown socket'}
          >
            <span className="text-fg-muted inline-flex items-center gap-1">
              <HelpCircle size={10} className="text-fg-subtle" />
              <span>?</span>
            </span>
            <span className="text-fg-muted">
              <span className="font-mono font-semibold">1×</span>
              <span className="text-fg-subtle"> ($5)</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const LotCardRepairPanel = memo(LotCardRepairPanelInner);
export default LotCardRepairPanel;
