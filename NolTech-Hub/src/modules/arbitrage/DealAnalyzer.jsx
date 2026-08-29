import { useState, useEffect, useCallback } from 'react';
import {
  Sparkles,
  AlertTriangle,
  TrendingUp,
  Package,
  Wrench,
  Ban,
  CheckCircle,
  Save,
  ChevronDown,
  Info,
} from 'lucide-react';
import { analyzeDeal } from '../../services/arbitrage.js';
import { COMPONENT_SEED } from './componentData.js';
import { decrypt } from '../../services/crypto';
import { fmt } from '../../utils/formatters';
import { Button, Input, Label, Select, Textarea } from '../../components/ui';
import SoldCompsPanel from '../../components/SoldCompsPanel';
import BidSimulatorPanel from './BidSimulatorPanel';

// ─── Storage Keys ─────────────────────────────────────────────────────────────

const KEY_API      = 'noltech:apikey';
const KEY_HISTORY  = 'noltech:arbitrage:history';
const KEY_COMP_DB  = 'noltech:arbitrage:components';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtRoi(n) {
  if (n === null || n === undefined || isNaN(n)) return '—%';
  return Number(n).toFixed(1) + '%';
}

function profitClass(n) {
  if (!n && n !== 0) return 'text-fg-muted';
  return n > 0 ? 'text-success' : 'text-danger';
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ScenarioRow({ label, value, mono = false, highlight = false }) {
  return (
    <div className={`flex items-center justify-between py-1.5 ${highlight ? 'font-semibold' : ''}`}>
      <span className="text-xs text-fg-muted">{label}</span>
      <span className={`text-sm ${mono ? 'font-mono' : ''} ${highlight ? 'text-fg' : 'text-fg-muted'}`}>
        {value}
      </span>
    </div>
  );
}

function ScenarioCard({ title, icon: Icon, isRecommended, accentClass, children }) {
  return (
    <div
      className={`bg-surface rounded-xl border shadow-sm p-4 flex flex-col gap-2 transition-shadow ${
        isRecommended
          ? `${accentClass} shadow-md`
          : 'border-border'
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        <Icon size={16} className={isRecommended ? 'text-primary' : 'text-fg-muted'} />
        <span className={`text-sm font-semibold ${isRecommended ? 'text-primary' : 'text-fg'}`}>
          {title}
        </span>
        {isRecommended && (
          <span className="ml-auto text-xs bg-primary text-white px-2 py-0.5 rounded-full">
            Recommended
          </span>
        )}
      </div>
      <div className="divide-y divide-border-subtle">
        {children}
      </div>
    </div>
  );
}

function RiskCard({ items, title, colorClass }) {
  if (!items || items.length === 0) return null;
  return (
    <div className={`rounded-xl border p-4 ${colorClass}`}>
      <div className="flex items-center gap-2 mb-2">
        <AlertTriangle size={15} />
        <span className="text-sm font-semibold">{title}</span>
      </div>
      <ul className="space-y-1">
        {items.map((item, i) => (
          <li key={i} className="text-sm flex items-start gap-2">
            <span className="mt-1 shrink-0">•</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function DealAnalyzer({ prefill = null }) {
  // ── Form state
  const [description,    setDescription]   = useState('');
  const [askingPrice,    setAskingPrice]   = useState('');
  const [condition,      setCondition]     = useState('unknown');
  const [sourcePlatform, setSourcePlatform] = useState('eBay');

  // ── App state
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState('');
  const [result,     setResult]     = useState(null);
  const [savedMsg,   setSavedMsg]   = useState(false);

  // ── Persisted
  const [apiKey,     setApiKey]     = useState('');
  const [history,    setHistory]    = useState([]);
  const [componentDB, setComponentDB] = useState([]);

  // ── Apply prefill when Browse Lots sends a lot over
  useEffect(() => {
    if (!prefill) return;
    if (prefill.description) setDescription(prefill.description);
    if (prefill.askingPrice) setAskingPrice(String(prefill.askingPrice));
    if (prefill.condition)   setCondition(prefill.condition);
    if (prefill.sourcePlatform) setSourcePlatform(prefill.sourcePlatform);
    setResult(null);
    setError('');
  }, [prefill]);

  // ── Load on mount
  useEffect(() => {
    (async () => {
      try {
        const raw = await window.storage.get(KEY_API);
        if (raw) setApiKey(await decrypt(raw));
      } catch (e) {
        console.error('Failed to load API key:', e);
      }

      try {
        const hist = await window.storage.get(KEY_HISTORY);
        if (hist && Array.isArray(hist)) setHistory(hist);
      } catch (e) {
        console.error('Failed to load history:', e);
      }

      try {
        const db = await window.storage.get(KEY_COMP_DB);
        if (db && Array.isArray(db) && db.length > 0) {
          setComponentDB(db);
        } else {
          await window.storage.set(KEY_COMP_DB, COMPONENT_SEED);
          setComponentDB(COMPONENT_SEED);
        }
      } catch (e) {
        console.error('Failed to load component DB:', e);
        setComponentDB(COMPONENT_SEED);
      }
    })();
  }, []);

  // ── Analyze
  const handleAnalyze = useCallback(async () => {
    setError('');
    setResult(null);

    if (!description.trim()) {
      setError('Paste a listing title or description.');
      return;
    }
    if (!askingPrice || isNaN(Number(askingPrice)) || Number(askingPrice) <= 0) {
      setError('Enter a valid asking price.');
      return;
    }
    if (!apiKey) {
      setError('No API key found. Add your Anthropic API key in Settings.');
      return;
    }

    setLoading(true);
    try {
      const analysis = await analyzeDeal(
        apiKey,
        description,
        Number(askingPrice),
        condition,
        componentDB
      );
      setResult(analysis);
    } catch (err) {
      setError(err.message || "Analysis didn't complete. Try again.");
    } finally {
      setLoading(false);
    }
  }, [description, askingPrice, condition, apiKey, componentDB]);

  // ── Save to history
  const handleSave = useCallback(async () => {
    if (!result) return;
    const entry = {
      id:           `deal-${Date.now()}`,
      analyzedAt:   new Date().toISOString(),
      sourcePlatform,
      askingPrice:  Number(askingPrice),
      condition,
      description:  description.slice(0, 200),
      result,
    };
    const updated = [entry, ...history].slice(0, 100); // cap at 100
    setHistory(updated);
    try {
      await window.storage.set(KEY_HISTORY, updated);
      setSavedMsg(true);
      setTimeout(() => setSavedMsg(false), 2500);
    } catch (e) {
      console.error('Failed to save history:', e);
      setError("Couldn't save to history: " + e.message);
    }
  }, [result, history, sourcePlatform, askingPrice, condition, description]);

  // ─── Render ───────────────────────────────────────────────────────────────

  const rec = result?.recommendation;

  const bannerConfig = {
    resell_whole: {
      bg:    'bg-success',
      text:  'text-white',
      label: 'BUY — Resell Whole',
      icon:  TrendingUp,
    },
    part_out: {
      bg:    'bg-primary',
      text:  'text-white',
      label: 'BUY — Part Out',
      icon:  Wrench,
    },
    pass: {
      bg:    'bg-danger',
      text:  'text-white',
      label: 'PASS',
      icon:  Ban,
    },
  };

  const banner = rec ? bannerConfig[rec] : null;

  return (
    <div className="space-y-5 max-w-4xl">
      {/* ── Bid simulator (Liquidation.com only) ─────────────────────────── */}
      {prefill && (prefill.source || '').toLowerCase().includes('liquidation') && (
        <BidSimulatorPanel lot={prefill} defaultBid={prefill.price || prefill.metrics?.bidCeilings?.at30pct || ''} />
      )}

      {/* ── Input Card ─────────────────────────────────────────────────────── */}
      <div className="bg-surface rounded-xl border border-border shadow-sm p-5">
        <h2 className="text-sm font-semibold text-fg mb-4">Listing Details</h2>

        {/* Description */}
        <div className="mb-4">
          <Label>Paste listing title, description, or URL</Label>
          <Textarea
            rows={5}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={`Example:\nDell Latitude 5480 i5-7300U 8GB RAM 256GB SSD 14in FHD — screen has small crack in bottom left corner, powers on, untested further. Asking $85 OBO on FB Marketplace.`}
            className="resize-none placeholder:text-fg-subtle"
          />
        </div>

        {/* Row: price, condition, platform */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
          {/* Asking Price */}
          <div>
            <Label>Asking Price ($)</Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted text-sm z-10">$</span>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={askingPrice}
                onChange={(e) => setAskingPrice(e.target.value)}
                placeholder="0.00"
                className="pl-7 font-mono"
              />
            </div>
          </div>

          {/* Condition */}
          <div>
            <Label>Condition</Label>
            <Select value={condition} onChange={(e) => setCondition(e.target.value)}>
              <option value="working">Working</option>
              <option value="unknown">Unknown / Untested</option>
              <option value="broken">Broken / For Parts</option>
            </Select>
          </div>

          {/* Source Platform */}
          <div>
            <Label>Source Platform</Label>
            <Select value={sourcePlatform} onChange={(e) => setSourcePlatform(e.target.value)}>
              <option>eBay</option>
              <option>FB Marketplace</option>
              <option>Craigslist</option>
              <option>OfferUp</option>
              <option>Local</option>
              <option>Other</option>
            </Select>
          </div>
        </div>

        {/* Analyze button */}
        <Button
          variant="accent"
          size="lg"
          onClick={handleAnalyze}
          disabled={loading}
          className="w-full"
        >
          {loading ? (
            <>
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Analyzing...
            </>
          ) : (
            <>
              <Sparkles size={17} />
              Analyze Deal
            </>
          )}
        </Button>

        {/* Error */}
        {error && (
          <div className="mt-3 flex items-start gap-2 bg-danger-subtle border border-danger/30 text-danger rounded-lg px-4 py-3 text-sm">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* ── Results ────────────────────────────────────────────────────────── */}
      {result && (
        <div className="space-y-4">
          {/* Recommendation Banner */}
          {banner && (
            <div className={`${banner.bg} ${banner.text} rounded-xl p-5`}>
              <div className="flex items-center gap-3 mb-2">
                <banner.icon size={22} />
                <span className="text-xl font-bold tracking-tight">{banner.label}</span>
              </div>
              <p className="text-sm opacity-90 leading-relaxed">
                {result.reasoning}
              </p>
            </div>
          )}

          {/* Product ID Card */}
          <div className="bg-surface rounded-xl border border-border shadow-sm p-5">
            <div className="flex flex-wrap items-start gap-3">
              <div className="flex-1 min-w-0">
                <h3 className="text-base font-semibold text-fg leading-tight">
                  {result.product?.fullName || 'Unknown Device'}
                </h3>
                {result.product?.specs && (
                  <p className="text-sm text-fg-muted mt-1">{result.product.specs}</p>
                )}
                {result.product?.notes && (
                  <p className="text-xs text-fg-muted mt-1 flex items-start gap-1">
                    <Info size={12} className="mt-0.5 shrink-0" />
                    {result.product.notes}
                  </p>
                )}
              </div>
              <div className="flex flex-col items-end gap-1.5 shrink-0">
                {result.product?.category && (
                  <span className="text-xs bg-info-subtle text-info px-2.5 py-1 rounded-full font-medium capitalize">
                    {result.product.category}
                  </span>
                )}
                {result.product?.confidence && (
                  <span
                    className={`text-xs px-2.5 py-1 rounded-full font-medium ${
                      result.product.confidence === 'high'
                        ? 'bg-success-subtle text-success'
                        : result.product.confidence === 'medium'
                        ? 'bg-warning-subtle text-warning'
                        : 'bg-muted text-fg-muted'
                    }`}
                  >
                    {result.product.confidence} confidence
                  </span>
                )}
              </div>
            </div>

            {/* Unit valuation strip */}
            {result.unitValuation && (
              <div className="mt-4 pt-4 border-t border-border-subtle grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
                <div>
                  <p className="text-xs text-fg-muted">Working Range</p>
                  <p className="text-sm font-mono font-semibold text-fg mt-0.5">
                    {fmt(result.unitValuation.workingRange?.[0])} – {fmt(result.unitValuation.workingRange?.[1])}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-fg-muted">Working Mid</p>
                  <p className="text-sm font-mono font-semibold text-success mt-0.5">
                    {fmt(result.unitValuation.workingMid)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-fg-muted">Broken Range</p>
                  <p className="text-sm font-mono font-semibold text-fg mt-0.5">
                    {fmt(result.unitValuation.brokenRange?.[0])} – {fmt(result.unitValuation.brokenRange?.[1])}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-fg-muted">Broken Mid</p>
                  <p className="text-sm font-mono font-semibold text-danger mt-0.5">
                    {fmt(result.unitValuation.brokenMid)}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Scenario Cards */}
          {result.scenarios && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Resell Whole */}
              <ScenarioCard
                title="Resell Whole"
                icon={TrendingUp}
                isRecommended={rec === 'resell_whole'}
                accentClass="border-2 border-primary"
              >
                <ScenarioRow label="Sale Price" value={fmt(result.scenarios.resellWhole?.salePrice)} mono />
                <ScenarioRow label="eBay Fee (9.35%)" value={`-${fmt(result.scenarios.resellWhole?.ebayFee)}`} mono />
                <ScenarioRow label="Shipping Out" value={`-${fmt(result.scenarios.resellWhole?.shippingOut)}`} mono />
                <ScenarioRow label="Net Revenue" value={fmt(result.scenarios.resellWhole?.netRevenue)} mono highlight />
                <div className="pt-2 border-t border-border-subtle mt-1 flex items-center justify-between">
                  <div>
                    <p className="text-xs text-fg-muted">Profit</p>
                    <p className={`text-xl font-mono font-bold mt-0.5 ${profitClass(result.scenarios.resellWhole?.profit)}`}>
                      {fmt(result.scenarios.resellWhole?.profit)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-fg-muted">ROI</p>
                    <p className={`text-xl font-mono font-bold mt-0.5 ${profitClass(result.scenarios.resellWhole?.profit)}`}>
                      {fmtRoi(result.scenarios.resellWhole?.roi)}
                    </p>
                  </div>
                </div>
                {result.scenarios.resellWhole?.viable ? (
                  <div className="flex items-center gap-1 text-xs text-success mt-1">
                    <CheckCircle size={12} /> Viable
                  </div>
                ) : (
                  <div className="flex items-center gap-1 text-xs text-danger mt-1">
                    <Ban size={12} /> Not viable
                  </div>
                )}
              </ScenarioCard>

              {/* Part Out */}
              <ScenarioCard
                title="Part Out"
                icon={Wrench}
                isRecommended={rec === 'part_out'}
                accentClass="border-2 border-success"
              >
                <ScenarioRow label="Total Parts Value" value={fmt(result.scenarios.partOut?.totalPartsValue)} mono />
                <ScenarioRow label="eBay Fees" value={`-${fmt(result.scenarios.partOut?.ebayFees)}`} mono />
                <ScenarioRow label="Shipping (all parts)" value={`-${fmt(result.scenarios.partOut?.shippingCosts)}`} mono />
                <ScenarioRow
                  label={`Labor (${result.scenarios.partOut?.laborHours ?? 0}h)`}
                  value={`-${fmt(result.scenarios.partOut?.laborCost)}`}
                  mono
                />
                <ScenarioRow label="Net Revenue" value={fmt(result.scenarios.partOut?.netRevenue)} mono highlight />
                <div className="pt-2 border-t border-border-subtle mt-1 flex items-center justify-between">
                  <div>
                    <p className="text-xs text-fg-muted">Profit</p>
                    <p className={`text-xl font-mono font-bold mt-0.5 ${profitClass(result.scenarios.partOut?.profit)}`}>
                      {fmt(result.scenarios.partOut?.profit)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-fg-muted">ROI</p>
                    <p className={`text-xl font-mono font-bold mt-0.5 ${profitClass(result.scenarios.partOut?.profit)}`}>
                      {fmtRoi(result.scenarios.partOut?.roi)}
                    </p>
                  </div>
                </div>
                {result.scenarios.partOut?.viable ? (
                  <div className="flex items-center gap-1 text-xs text-success mt-1">
                    <CheckCircle size={12} /> Viable
                  </div>
                ) : (
                  <div className="flex items-center gap-1 text-xs text-danger mt-1">
                    <Ban size={12} /> Not viable
                  </div>
                )}
              </ScenarioCard>
            </div>
          )}

          {/* Parts Breakdown Table */}
          {result.partsBreakdown && result.partsBreakdown.length > 0 && (
            <div className="bg-surface rounded-xl border border-border shadow-sm overflow-hidden">
              <div className="px-5 py-3 border-b border-border">
                <h4 className="text-sm font-semibold text-fg flex items-center gap-2">
                  <Package size={14} />
                  Parts Breakdown
                </h4>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/40 border-b border-border">
                    <th className="text-left px-5 py-2.5 font-semibold text-fg">Component</th>
                    <th className="text-right px-5 py-2.5 font-semibold text-fg">Est. Value</th>
                    <th className="text-center px-5 py-2.5 font-semibold text-fg hidden sm:table-cell">Demand</th>
                    <th className="text-left px-5 py-2.5 font-semibold text-fg hidden md:table-cell">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {result.partsBreakdown.map((part, i) => (
                    <tr
                      key={i}
                      className={`border-b border-border-subtle last:border-0 ${i % 2 === 1 ? 'bg-muted/40/50' : ''}`}
                    >
                      <td className="px-5 py-2.5 text-fg">{part.component}</td>
                      <td className="px-5 py-2.5 text-right font-mono font-semibold text-fg">
                        {fmt(part.value)}
                      </td>
                      <td className="px-5 py-2.5 text-center hidden sm:table-cell">
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                            part.demand === 'high'
                              ? 'bg-success-subtle text-success'
                              : part.demand === 'medium'
                              ? 'bg-warning-subtle text-warning'
                              : 'bg-muted text-fg-muted'
                          }`}
                        >
                          {part.demand}
                        </span>
                      </td>
                      <td className="px-5 py-2.5 text-xs text-fg-muted hidden md:table-cell">
                        {part.notes || '—'}
                      </td>
                    </tr>
                  ))}
                  {/* Total row */}
                  <tr className="bg-muted/40 border-t-2 border-border">
                    <td className="px-5 py-3 font-semibold text-fg">Total Parts Value</td>
                    <td className="px-5 py-3 text-right font-mono font-bold text-fg">
                      {fmt(result.partsBreakdown.reduce((sum, p) => sum + (p.value || 0), 0))}
                    </td>
                    <td className="hidden sm:table-cell" />
                    <td className="hidden md:table-cell" />
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {/* Risks & Red Flags */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <RiskCard
              items={result.risks}
              title="Risks"
              colorClass="bg-warning-subtle border border-warning/30 text-warning"
            />
            <RiskCard
              items={result.redFlags}
              title="Red Flags"
              colorClass="bg-danger-subtle border border-danger/30 text-danger"
            />
          </div>

          {/* Save button */}
          <div className="flex items-center gap-3">
            <Button variant="accent" onClick={handleSave}>
              <Save size={15} />
              {savedMsg ? 'Saved!' : 'Save to History'}
            </Button>
            {savedMsg && (
              <span className="text-success text-sm flex items-center gap-1">
                <CheckCircle size={14} /> Analysis saved
              </span>
            )}
          </div>

          {/* Sold-comps cross-check — what have similar items actually sold for? */}
          {result.product?.fullName && (
            <div>
              <h4 className="text-sm font-semibold text-fg mb-2">Recent eBay Sold Comps</h4>
              <SoldCompsPanel
                initialQuery={result.product.fullName}
                autoFetch
                compact
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
