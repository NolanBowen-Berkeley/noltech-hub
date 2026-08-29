import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { Eye, EyeOff, Save, KeyRound, RefreshCw, Trash2, AlertTriangle, Moon, Sun, Percent, Cloud, HardDrive, CheckCircle2, XCircle, Loader2, User, Plug, DollarSign, Tag, Zap, Lock, Database, Palette, Smartphone, Send } from 'lucide-react';
import { getPhoneWebhookUrl, setPhoneWebhookUrl, testPhoneAlert } from '../../services/phoneAlerts';
import { cn } from '../../components/ui/cn';
import ModuleHeader from '../../components/ui/ModuleHeader';
import Card from '../../components/ui/Card';
import Button from '../../components/ui/Button';
const DataBackup = lazy(() => import('./DataBackup'));
const ErrorLogPanel = lazy(() => import('./ErrorLogPanel'));
const DiagnosticExport = lazy(() => import('./DiagnosticExport'));
const WorkspaceSettings = lazy(() => import('./WorkspaceSettings'));
const AuditLogViewer = lazy(() => import('./AuditLogViewer'));
const MessageTemplates = lazy(() => import('./MessageTemplates'));
import CategoryManager from './CategoryManager';
import SourceManager from './SourceManager';
import { API_KEY_STORAGE, PIN_KEY, SETTINGS_KEY, EBAY_TOKEN_KEY, PIPELINE_BASE, PIPELINE_BASE_KEY, PIPELINE_TOKEN_KEY } from '../../utils/constants';
import { setEbayFeeRate, setResaleRealizationRate, setActiveAskBuffer, getResaleRealizationRate, getActiveAskBuffer, setEbayConditionHaircuts, getEbayConditionHaircuts, DEFAULT_EBAY_CONDITION_HAIRCUTS, setAuctionFeeRates, getAuctionFeeRates, DEFAULT_AUCTION_FEE_RATES } from '../../utils/fees';
import { TIERS, getUserTier, setUserTier, checkTrial } from '../../services/tiers';
import { encrypt, decrypt, encryptObject, decryptObject } from '../../services/crypto';
import { KEY_LAMBDA_URL, KEY_AUTH_SECRET, KEY_LAST_SUCCESS, testLambdaConnection } from '../../services/soldComps';
import eventBus from '../../services/eventBus';
import useDarkMode from '../../hooks/useDarkMode';

const inputCls =
  'w-full border border-border rounded-lg px-3 py-2.5 text-sm text-fg bg-surface ' +
  'focus:outline-none focus:ring-2 focus:ring-secondary/30 focus:border-secondary transition-colors';
const labelCls = 'block text-xs font-semibold text-fg-muted uppercase tracking-wide mb-1.5';

// ─── API Key section ──────────────────────────────────────────────────────────

function ApiKeySection() {
  const [key, setKey]   = useState('');
  const [show, setShow] = useState(false);
  const [saved, setSaved] = useState(false);

  useState(() => {
    window.storage.get(API_KEY_STORAGE).then(async (raw) => {
      const k = raw ? await decrypt(raw) : '';
      setKey(k);
    }).catch(() => {});
  });

  const save = async () => {
    await window.storage.set(API_KEY_STORAGE, await encrypt(key.trim())).catch(console.error);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <Card padding="lg">
      <div className="flex items-center gap-2 mb-4">
        <KeyRound className="w-4 h-4 text-fg-muted" />
        <h3 className="text-sm font-semibold text-fg">Anthropic API Key</h3>
      </div>
      <p className="text-xs text-fg-muted mb-4 leading-relaxed">
        Required for AI Analyzer (manifest parsing + valuation). Stored locally — never sent anywhere except Anthropic's API.
      </p>
      <label className={labelCls}>API Key</label>
      <div className="relative mb-3">
        <input
          type={show ? 'text' : 'password'}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="sk-ant-api03-..."
          className={inputCls + ' font-mono pr-10'}
        />
        <button onClick={() => setShow((s) => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-muted hover:text-fg transition-colors">
          {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
      <button
        onClick={save}
        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
          saved ? 'bg-success text-white' : 'bg-primary text-white hover:bg-primary-dark'
        }`}
      >
        <Save className="w-4 h-4" />
        {saved ? 'Saved!' : 'Save Key'}
      </button>
    </Card>
  );
}

// ─── Gemini API Key section ──────────────────────────────────────────────────
// Used by Listing Generator's per-item auto-fill (description, condition
// description, item specifics). Separate from the Anthropic key — different
// vendor, different account.

const GEMINI_KEY = 'noltech:gemini:apikey';
const GEMINI_TIER_KEY = 'noltech:gemini:tier';

function GeminiKeySection() {
  const [key, setKey]   = useState('');
  const [show, setShow] = useState(false);
  const [saved, setSaved] = useState(false);
  const [tier, setTier] = useState('free');  // 'free' | 'paid-tier1' | 'paid-tier2'

  useEffect(() => {
    window.storage.get(GEMINI_KEY).then(async (raw) => {
      const k = raw ? await decrypt(raw) : '';
      setKey(k);
    }).catch(() => {});
    window.storage.get(GEMINI_TIER_KEY).then((v) => {
      if (typeof v === 'string') setTier(v);
    }).catch(() => {});
  }, []);

  const save = async () => {
    await window.storage.set(GEMINI_KEY, await encrypt(key.trim())).catch(console.error);
    await window.storage.set(GEMINI_TIER_KEY, tier).catch(console.error);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <Card padding="lg">
      <div className="flex items-center gap-2 mb-4">
        <KeyRound className="w-4 h-4 text-fg-muted" />
        <h3 className="text-sm font-semibold text-fg">Google Gemini API Key</h3>
      </div>
      <p className="text-xs text-fg-muted mb-4 leading-relaxed">
        Powers the Listing Generator's <strong>Auto-fill with Gemini</strong> and the UPC cache <strong>Clean with Gemini</strong> button. Get a key at <span className="font-mono">aistudio.google.com</span>. Stored locally and encrypted; only sent to Google's API.
      </p>
      <label className={labelCls}>API Key</label>
      <div className="relative mb-3">
        <input
          type={show ? 'text' : 'password'}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="AIza..."
          className={inputCls + ' font-mono pr-10'}
        />
        <button onClick={() => setShow((s) => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-muted hover:text-fg transition-colors">
          {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>

      <label className={labelCls}>Billing Tier</label>
      <select
        value={tier}
        onChange={(e) => setTier(e.target.value)}
        className={inputCls + ' mb-2'}
      >
        <option value="free">Free (10 RPM · 250 requests/day · safe pacing)</option>
        <option value="paid-tier1">Paid Tier 1 (1,000 RPM · 10K req/day · fast)</option>
        <option value="paid-tier2">Paid Tier 2+ (2,000+ RPM · maximum parallelism)</option>
      </select>
      <p className="text-[11px] text-fg-muted mb-3 leading-relaxed">
        Controls how aggressively the Hub paces batched Gemini calls. <strong>Free</strong> sleeps 6.5s between batches to stay under the per-minute cap. <strong>Paid Tier 1</strong> drops pacing to 200ms (about 30× faster on big runs). <strong>Tier 2+</strong> removes pacing entirely. Only switch off Free if you've added prepaid credits or postpay billing in <span className="font-mono">aistudio.google.com → Billing</span>.
      </p>

      <button
        onClick={save}
        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
          saved ? 'bg-success text-white' : 'bg-primary text-white hover:bg-primary-dark'
        }`}
      >
        <Save className="w-4 h-4" />
        {saved ? 'Saved!' : 'Save'}
      </button>
    </Card>
  );
}

// ─── PIN section ──────────────────────────────────────────────────────────────

function PinSection() {
  const [current, setCurrent]   = useState('');
  const [newPin, setNewPin]     = useState('');
  const [confirm, setConfirm]   = useState('');
  const [error, setError]       = useState('');
  const [success, setSuccess]   = useState('');
  const [resetConfirm, setResetConfirm] = useState(false);

  async function hashPin(pin, salt) {
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(pin),
      'PBKDF2',
      false,
      ['deriveBits']
    );
    const saltBytes = salt || new TextEncoder().encode('noltech-hub-2025');
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: saltBytes, iterations: 100000, hash: 'SHA-256' },
      keyMaterial,
      256
    );
    return Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  const changePin = async () => {
    setError(''); setSuccess('');
    if (!current || !newPin || !confirm) { setError('Fill in all fields.'); return; }
    if (newPin !== confirm) { setError('New PINs do not match.'); return; }
    if (!/^\d{4,6}$/.test(newPin)) { setError('PIN must be 4–6 digits.'); return; }
    const stored = await window.storage.get(PIN_KEY).catch(() => null);
    // Handle new format (object with hash + salt) and old format (plain hash string)
    const oldSalt = stored?.salt ? Uint8Array.from(atob(stored.salt), c => c.charCodeAt(0)) : null;
    const currentHash = await hashPin(current, oldSalt);
    const expectedHash = stored?.hash || stored;
    if (expectedHash && currentHash !== expectedHash) { setError('Current PIN is incorrect.'); return; }
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const saltB64 = btoa(String.fromCharCode(...salt));
    const newHash = await hashPin(newPin, salt);
    await window.storage.set(PIN_KEY, { hash: newHash, salt: saltB64 });
    setCurrent(''); setNewPin(''); setConfirm('');
    setSuccess('PIN changed successfully.');
    setTimeout(() => setSuccess(''), 3000);
  };

  const resetPin = async () => {
    await window.storage.delete(PIN_KEY);
    setResetConfirm(false);
    setSuccess('PIN removed. Reload the page to set a new one.');
  };

  return (
    <Card padding="lg">
      <div className="flex items-center gap-2 mb-4">
        <KeyRound className="w-4 h-4 text-fg-muted" />
        <h3 className="text-sm font-semibold text-fg">PIN Security</h3>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
        {[
          { label: 'Current PIN', val: current, set: setCurrent, placeholder: '••••' },
          { label: 'New PIN',     val: newPin,  set: setNewPin,  placeholder: '4–6 digits' },
          { label: 'Confirm New', val: confirm, set: setConfirm, placeholder: '4–6 digits' },
        ].map(({ label, val, set, placeholder }) => (
          <div key={label}>
            <label className={labelCls}>{label}</label>
            <input type="password" inputMode="numeric" pattern="[0-9]*" maxLength={6}
              value={val} onChange={(e) => set(e.target.value.replace(/\D/g, ''))}
              placeholder={placeholder} className={inputCls + ' font-mono tracking-widest'} />
          </div>
        ))}
      </div>
      {error   && <p className="text-xs text-danger mb-3 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" />{error}</p>}
      {success && <p className="text-xs text-success mb-3">{success}</p>}
      <div className="flex gap-2">
        <button onClick={changePin}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-dark transition-colors">
          <Save className="w-4 h-4" /> Change PIN
        </button>
        {resetConfirm ? (
          <span className="flex items-center gap-2 text-sm">
            <span className="text-danger font-medium">Remove PIN lock?</span>
            <button onClick={resetPin}
              className="px-3 py-1.5 bg-danger text-white rounded-lg text-sm font-medium hover:bg-danger/90 transition-colors">
              Yes, Remove
            </button>
            <button onClick={() => setResetConfirm(false)}
              className="px-3 py-1.5 border border-border text-fg-muted rounded-lg text-sm font-medium hover:bg-muted/40 transition-colors">
              Cancel
            </button>
          </span>
        ) : (
          <button onClick={() => setResetConfirm(true)}
            className="flex items-center gap-2 px-4 py-2 border border-danger/30 text-danger rounded-lg text-sm font-medium hover:bg-danger/5 transition-colors">
            <RefreshCw className="w-4 h-4" /> Reset PIN
          </button>
        )}
      </div>
    </Card>
  );
}

// ─── Default settings ─────────────────────────────────────────────────────────

function DefaultsSection() {
  const [margin,      setMargin]      = useState(40);
  const [shipping,    setShipping]    = useState(8);
  const [profitGoal,  setProfitGoal]  = useState('');
  const [saved, setSaved]             = useState(false);

  useState(() => {
    window.storage.get(SETTINGS_KEY).then((s) => {
      if (s?.targetMargin)  setMargin(s.targetMargin);
      if (s?.avgShipping)   setShipping(s.avgShipping);
      if (s?.monthlyProfitGoal != null) setProfitGoal(String(s.monthlyProfitGoal));
    }).catch(() => {});
  });

  const save = async () => {
    await window.storage.set(SETTINGS_KEY, {
      targetMargin: margin,
      avgShipping: shipping,
      monthlyProfitGoal: parseFloat(profitGoal) || 0,
    }).catch(console.error);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <Card padding="lg">
      <h3 className="text-sm font-semibold text-fg mb-4">Default Calculations</h3>
      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <label className={labelCls}>Target Margin (%)</label>
          <input type="number" step="1" min="0" max="100" value={margin}
            onChange={(e) => setMargin(parseFloat(e.target.value) || 40)}
            className={inputCls + ' font-mono'} />
          <p className="text-[11px] text-fg-muted mt-1">Used in Lot Evaluator and AI Analyzer bid ceilings.</p>
        </div>
        <div>
          <label className={labelCls}>Avg Shipping / Item ($)</label>
          <input type="number" step="0.50" min="0" value={shipping}
            onChange={(e) => setShipping(parseFloat(e.target.value) || 8)}
            className={inputCls + ' font-mono'} />
          <p className="text-[11px] text-fg-muted mt-1">Per-item eBay shipping estimate.</p>
        </div>
        <div>
          <label className={labelCls}>Monthly Profit Goal ($)</label>
          <input type="number" step="100" min="0" placeholder="e.g. 3000"
            value={profitGoal}
            onChange={(e) => setProfitGoal(e.target.value)}
            className={inputCls + ' font-mono'} />
          <p className="text-[11px] text-fg-muted mt-1">Shown as a progress bar on the Hub dashboard.</p>
        </div>
      </div>
      <button onClick={save}
        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
          saved ? 'bg-success text-white' : 'bg-primary text-white hover:bg-primary-dark'
        }`}>
        <Save className="w-4 h-4" />
        {saved ? 'Saved!' : 'Save Defaults'}
      </button>
    </Card>
  );
}

// ─── Phone alert webhook section ─────────────────────────────────────────────
// One URL field, three supported destinations (auto-detected by URL):
//   • https://ntfy.sh/<topic>       → ntfy.sh app on your phone (zero account)
//   • https://discord.com/api/webhooks/... → Discord channel webhook
//   • any other URL                 → custom JSON POST {title, message, at}

function PhoneAlertSection() {
  const [url, setUrl] = useState('');
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);   // { ok, error } | null

  useEffect(() => {
    getPhoneWebhookUrl().then((v) => setUrl(v || ''));
  }, []);

  const detectedKind = (() => {
    if (!url) return null;
    if (/ntfy\.sh/i.test(url)) return 'ntfy.sh';
    if (/discord\.com\/api\/webhooks/i.test(url)) return 'Discord webhook';
    if (/^https?:\/\//i.test(url)) return 'Custom JSON webhook';
    return 'invalid';
  })();

  const save = async () => {
    await setPhoneWebhookUrl(url);
    setSaved(true);
    setTestResult(null);
    setTimeout(() => setSaved(false), 2000);
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    // Save first so the test uses the URL currently in the box.
    await setPhoneWebhookUrl(url);
    const r = await testPhoneAlert();
    setTestResult(r);
    setTesting(false);
  };

  return (
    <Card padding="lg">
      <div className="flex items-center gap-2 mb-4">
        <Smartphone className="w-4 h-4 text-fg-muted" />
        <h3 className="text-sm font-semibold text-fg">Phone Alerts (bid notifications)</h3>
      </div>
      <p className="text-xs text-fg-muted mb-4 leading-relaxed">
        Forward bid-closing alerts (last 30 min, still under your ceiling) to
        your phone via one of the free push services below. The Hub
        auto-detects which format to use from the URL.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-4 text-[11px]">
        <div className="rounded-lg border border-border-subtle bg-muted/20 px-3 py-2">
          <div className="font-semibold text-fg mb-0.5">ntfy.sh (easiest)</div>
          <div className="text-fg-muted">Install the <em>ntfy</em> app on your phone. Subscribe to a topic name only you know (e.g. <span className="font-mono">noltech-Yh7Q2k</span>). URL: <span className="font-mono break-all">https://ntfy.sh/&lt;topic&gt;</span></div>
        </div>
        <div className="rounded-lg border border-border-subtle bg-muted/20 px-3 py-2">
          <div className="font-semibold text-fg mb-0.5">Discord webhook</div>
          <div className="text-fg-muted">Discord channel → Edit Channel → Integrations → Webhooks → New Webhook → Copy URL. Notification arrives in Discord on your phone.</div>
        </div>
        <div className="rounded-lg border border-border-subtle bg-muted/20 px-3 py-2">
          <div className="font-semibold text-fg mb-0.5">Custom</div>
          <div className="text-fg-muted">Any URL accepting POST <span className="font-mono">{`{title, message, at}`}</span> JSON. For Zapier, IFTTT, or your own server.</div>
        </div>
      </div>

      <label className={labelCls}>Webhook URL</label>
      <input
        type="text"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://ntfy.sh/your-unguessable-topic"
        className={inputCls}
      />
      {detectedKind && (
        <p className="text-[11px] text-fg-muted mt-1">
          Detected: <span className="font-semibold text-fg">{detectedKind}</span>
          {detectedKind === 'invalid' && <span className="text-danger"> — must start with https://</span>}
        </p>
      )}

      <div className="flex items-center gap-2 mt-3">
        <Button onClick={save} size="sm">
          <Save className="w-3.5 h-3.5" />
          {saved ? 'Saved' : 'Save'}
        </Button>
        <Button onClick={runTest} size="sm" variant="secondary" disabled={testing || !url}>
          {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
          Send test
        </Button>
        {testResult && (
          <span className={`text-[11px] ${testResult.ok ? 'text-success' : 'text-danger'}`}>
            {testResult.ok ? '✓ Sent — check your phone' : `✗ ${testResult.error}`}
          </span>
        )}
      </div>
    </Card>
  );
}

// ─── Cloud Scraper section ────────────────────────────────────────────────────
// Optional override that points lot scraping / manifest fetch / image proxy
// to the noltech-scraper Cloudflare Worker instead of the local Express
// server. Leave blank to keep using the local backend. eBay XML endpoints
// always stay local (they pass plaintext creds and aren't safe in the cloud).

function LocalPipelineSection() {
  const [base, setBase] = useState('');
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);  // { ok, message }

  useEffect(() => {
    window.storage.get(PIPELINE_BASE_KEY).then((v) => {
      if (typeof v === 'string') setBase(v);
    }).catch(() => {});
    window.storage.get(PIPELINE_TOKEN_KEY).then(async (raw) => {
      if (!raw) return;
      try { setToken(await decrypt(raw)); }
      catch (e) { console.warn('[LocalPipelineSection] token decrypt failed:', e?.message); }
    }).catch(() => {});
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const cleanBase = base.trim().replace(/\/+$/, '');
      const cleanToken = token.trim();
      await window.storage.set(PIPELINE_BASE_KEY, cleanBase);
      if (cleanToken) {
        await window.storage.set(PIPELINE_TOKEN_KEY, await encrypt(cleanToken));
      } else {
        await window.storage.set(PIPELINE_TOKEN_KEY, '');
      }
      // Tell the pipelineFetch helper to reload its cached config.
      eventBus.emit('settings:pipeline-updated');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      console.error('[LocalPipelineSection] save failed:', e);
    } finally {
      setSaving(false);
    }
  };

  const clearAll = async () => {
    if (!confirm(`Reset to the default pipeline URL (${PIPELINE_BASE})?`)) return;
    await window.storage.set(PIPELINE_BASE_KEY, '');
    await window.storage.set(PIPELINE_TOKEN_KEY, '');
    setBase(''); setToken(''); setTestResult(null);
    eventBus.emit('settings:pipeline-updated');
  };

  // Test connection: hits /health, then a bearer-gated route. The first
  // confirms the service is up; the second confirms the token — which is only
  // meaningful when the service was started with SHARED_AUTH_SECRET set.
  const testConnection = async () => {
    setTesting(true); setTestResult(null);
    try {
      const cleanBase  = (base.trim() || PIPELINE_BASE).replace(/\/+$/, '');
      const cleanToken = token.trim();

      let health;
      try {
        health = await fetch(cleanBase + '/health', { signal: AbortSignal.timeout(8000) });
      } catch (e) {
        setTestResult({
          ok: false,
          message: e?.name === 'TimeoutError'
            ? 'Timed out — is the pipeline running?'
            : `Can't reach ${cleanBase}. The pipeline service isn't running.`,
        });
        return;
      }
      if (!health.ok) {
        setTestResult({ ok: false, message: `Health check failed (HTTP ${health.status}).` });
        return;
      }

      const info = await health.json().catch(() => null);

      // A token is only required when the service enforces auth. Sending one
      // it doesn't need is harmless; omitting one it does need is a 401.
      const headers = cleanToken ? { Authorization: `Bearer ${cleanToken}` } : {};
      const authed = await fetch(cleanBase + '/lots/mock?count=1', {
        headers,
        signal: AbortSignal.timeout(20000),
      });
      if (authed.status === 401 || authed.status === 403) {
        setTestResult({
          ok: false,
          message: cleanToken
            ? `Authentication failed (HTTP ${authed.status}). Token doesn't match SHARED_AUTH_SECRET.`
            : 'This pipeline requires a bearer token. Paste its SHARED_AUTH_SECRET above.',
        });
        return;
      }
      if (!authed.ok) {
        setTestResult({ ok: false, message: `Route test returned HTTP ${authed.status}.` });
        return;
      }

      // Surface capability gaps here rather than letting them show up later as
      // mystery scrape failures.
      const gaps = [];
      if (info && info.brightdataConfigured === false) gaps.push('no Bright Data token (scraping disabled)');
      if (info && info.supabaseConfigured  === false) gaps.push('no Supabase (crons disabled)');
      setTestResult({
        ok: true,
        message: gaps.length
          ? `Connected, but: ${gaps.join('; ')}.`
          : `Connected. Pipeline up ${info?.uptimeSeconds != null ? `${Math.round(info.uptimeSeconds / 60)}m` : ''}, all crons registered.`,
      });
    } catch (e) {
      setTestResult({ ok: false, message: e?.name === 'TimeoutError' ? 'Timed out.' : (e?.message || 'Failed.') });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card padding="lg">
      <div className="flex items-center gap-2 mb-4">
        <HardDrive className="w-4 h-4 text-fg-muted" />
        <h3 className="text-sm font-semibold text-fg">Local Pipeline</h3>
      </div>
      <p className="text-xs text-fg-muted mb-4 leading-relaxed">
        The <code className="font-mono bg-muted px-1 py-0.5 rounded">noltech-pipeline</code> service handles
        all lot scraping, manifests, sold-comps pricing, the image proxy, and the background
        discovery/analysis crons. The Hub starts it automatically on <span className="font-mono">{PIPELINE_BASE}</span> —
        leave these blank unless you run it elsewhere (a different port, or another machine on your LAN).
      </p>

      <label className={labelCls}>Pipeline URL</label>
      <input
        type="url"
        value={base}
        onChange={(e) => setBase(e.target.value)}
        placeholder={PIPELINE_BASE}
        className={inputCls + ' font-mono mb-3'}
      />

      <label className={labelCls}>Shared Auth Secret</label>
      <div className="relative mb-1">
        <input
          type={showToken ? 'text' : 'password'}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Only needed if the pipeline runs off-machine"
          className={inputCls + ' font-mono pr-10'}
        />
        <button
          type="button"
          onClick={() => setShowToken((s) => !s)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-muted hover:text-fg transition-colors"
          aria-label={showToken ? 'Hide token' : 'Show token'}
        >
          {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
      <p className="text-[11px] text-fg-muted mb-3 leading-relaxed">
        Must match <span className="font-mono">SHARED_AUTH_SECRET</span> in the pipeline's{' '}
        <span className="font-mono">.env</span>. A loopback-only pipeline runs without one.
      </p>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button
          onClick={save}
          disabled={saving}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            saved ? 'bg-success text-white' : 'bg-primary text-white hover:bg-primary-dark'
          } disabled:opacity-50`}
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {saved ? 'Saved!' : 'Save'}
        </button>
        <button
          onClick={testConnection}
          disabled={testing}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-border text-fg hover:bg-muted/50 disabled:opacity-50"
        >
          {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plug className="w-4 h-4" />}
          Test Connection
        </button>
        {(base || token) && (
          <button
            onClick={clearAll}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-danger hover:bg-danger-subtle"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Reset to default
          </button>
        )}
      </div>

      {testResult && (
        <div className={`flex items-start gap-2 px-3 py-2 rounded-lg text-xs ${
          testResult.ok ? 'bg-success-subtle text-success' : 'bg-danger-subtle text-danger'
        }`}>
          {testResult.ok ? <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" /> : <XCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />}
          <span>{testResult.message}</span>
        </div>
      )}
    </Card>
  );
}

// ─── eBay Credentials section ─────────────────────────────────────────────────

function EbaySection() {
  const [token,  setToken]  = useState('');
  const [oauthToken, setOauthToken] = useState('');
  const [refreshToken, setRefreshToken] = useState('');
  const [appId,  setAppId]  = useState('');
  const [devId,  setDevId]  = useState('');
  const [certId, setCertId] = useState('');
  const [show,   setShow]   = useState(false);
  const [showOauth, setShowOauth] = useState(false);
  const [showRefresh, setShowRefresh] = useState(false);
  const [saved,  setSaved]  = useState(false);
  const [refreshTesting, setRefreshTesting] = useState(false);
  const [refreshResult, setRefreshResult] = useState(null);
  // Connect-eBay code-exchange flow state
  const [ruName, setRuName] = useState('');
  const [callbackUrl, setCallbackUrl] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectResult, setConnectResult] = useState(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectResult, setDisconnectResult] = useState(null);

  useState(() => {
    window.storage.get(EBAY_TOKEN_KEY).then(async (raw) => {
      const creds = await decryptObject(raw || {});
      if (creds) {
        setToken(creds.token || '');
        setOauthToken(creds.oauthUserToken || '');
        setRefreshToken(creds.oauthRefreshToken || '');
        setRuName(creds.oauthRuName || '');
        setAppId(creds.appId || '');
        setDevId(creds.devId || '');
        setCertId(creds.certId || '');
      }
    }).catch(() => {});
  });

  const save = async () => {
    await window.storage.set(EBAY_TOKEN_KEY, await encryptObject({
      token: token.trim(),
      oauthUserToken: oauthToken.trim(),
      oauthRefreshToken: refreshToken.trim(),
      oauthRuName: ruName.trim(),
      appId: appId.trim(),
      devId: devId.trim(),
      certId: certId.trim(),
    })).catch(console.error);
    // Wipe any cached access token so the next sync mints one from the new
    // refresh token instead of using the stale cache.
    await window.storage.set('noltech:ebay:oauth-cache', {}).catch(() => {});
    // Safety: disable auto price reduction whenever credentials change
    const autoConfig = await window.storage.get('noltech:pricereductor:auto').catch(() => null);
    if (autoConfig?.enabled) {
      await window.storage.set('noltech:pricereductor:auto', { ...autoConfig, enabled: false }).catch(() => {});
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <Card padding="lg">
      <div className="flex items-center gap-2 mb-1">
        <KeyRound className="w-4 h-4 text-fg-muted" />
        <h3 className="text-sm font-semibold text-fg">eBay Credentials</h3>
      </div>
      <p className="text-xs text-fg-muted mb-4 leading-relaxed">
        Used to sync active listings into Inventory and import sales into Bookkeeping.
        Get your User Token from <span className="font-mono">developer.ebay.com</span> → User Tokens.
      </p>
      <div className="space-y-3">
        <div>
          <label className={labelCls}>User Token *</label>
          <div className="relative">
            <input
              type={show ? 'text' : 'password'}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="AgAAAA..."
              className={inputCls + ' font-mono pr-10'}
            />
            <button onClick={() => setShow((s) => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-muted hover:text-fg">
              {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {[['App ID',  appId,  setAppId], ['Dev ID', devId, setDevId], ['Cert ID', certId, setCertId]].map(([lbl, val, set]) => (
            <div key={lbl}>
              <label className={labelCls}>{lbl} <span className="normal-case font-normal">(optional)</span></label>
              <input type="text" value={val} onChange={(e) => set(e.target.value)}
                className={inputCls + ' font-mono text-xs'} placeholder="—" />
            </div>
          ))}
        </div>

        {/* OAuth2 User Token — required to pull Promoted Listings / Ad Fees
            from the REST Finances API (sell.finances scope). Generated separately
            from the AuthNAuth Trading API token above. */}
        <div className="pt-1">
          <label className={labelCls}>
            OAuth2 User Token <span className="normal-case font-normal">(for Ad Fees + Finances API)</span>
          </label>
          <div className="relative">
            <input
              type={showOauth ? 'text' : 'password'}
              value={oauthToken}
              onChange={(e) => setOauthToken(e.target.value)}
              placeholder="v^1.1#i^1#f^0#r^0#I^3#p^1#t^H4sI..."
              className={inputCls + ' font-mono pr-10 text-xs'}
            />
            <button onClick={() => setShowOauth((s) => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-muted hover:text-fg">
              {showOauth ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          <div className="text-[11px] text-fg-muted mt-1.5 leading-relaxed space-y-1">
            <p>
              Optional, but <strong>required to auto-pull Promoted Listings / Ad Fee General charges</strong> (the Trading API's GetOrders doesn't return them).
            </p>
            <p>
              Get it at <span className="font-mono">developer.ebay.com → My Account → Application Keys → User Tokens → <em>OAuth</em> tab</span>.
              Select scopes <span className="font-mono">sell.finances</span> +
              <span className="font-mono"> sell.marketing</span> when generating.
              Starts with <span className="font-mono">v^1.1#</span>.
            </p>
            <p className="text-warning">
              <strong>Heads up:</strong> Access tokens expire every ~2 hours. For hands-off
              auto-refresh, fill in the Refresh Token below instead — that lasts ~18 months
              and the app mints fresh access tokens automatically before each sync.
            </p>
          </div>
        </div>

        {/* OAuth2 Refresh Token — long-lived. When set with App ID + Cert ID, the
            app auto-refreshes the access token every couple of hours so the user
            never has to re-paste it. */}
        <div className="pt-1">
          <label className={labelCls}>
            OAuth2 Refresh Token <span className="normal-case font-normal">(auto-refresh, ~18-month lifespan)</span>
          </label>
          <div className="relative">
            <input
              type={showRefresh ? 'text' : 'password'}
              value={refreshToken}
              onChange={(e) => { setRefreshToken(e.target.value); setRefreshResult(null); }}
              placeholder="v^1.1#i^1#p^1#r^1#... (refresh token)"
              className={inputCls + ' font-mono pr-10 text-xs'}
            />
            <button onClick={() => setShowRefresh((s) => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-muted hover:text-fg">
              {showRefresh ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          <div className="text-[11px] text-fg-muted mt-1.5 leading-relaxed space-y-1">
            <p>
              When generating OAuth2 user tokens at <span className="font-mono">developer.ebay.com</span>,
              the page returns BOTH a User Access Token (above) AND a Refresh Token. Paste
              the refresh token here; combined with App ID + Cert ID below, the app will
              mint fresh access tokens automatically — no more re-pasting every 2 hours.
            </p>
            <p>
              Requires App ID and Cert ID filled in below. Stored encrypted at rest.
            </p>
          </div>
          <button
            onClick={async () => {
              if (!refreshToken.trim() || !appId.trim() || !certId.trim()) {
                setRefreshResult({ ok: false, msg: 'Need Refresh Token + App ID + Cert ID to test.' });
                return;
              }
              setRefreshTesting(true);
              setRefreshResult(null);
              try {
                const r = await fetch(`${PIPELINE_BASE}/api/ebay/oauth/refresh`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    refreshToken: refreshToken.trim(),
                    clientId:     appId.trim(),
                    clientSecret: certId.trim(),
                  }),
                  signal: AbortSignal.timeout(20000),
                });
                const d = await r.json();
                if (d.success) {
                  const mins = Math.round((d.expiresIn || 7200) / 60);
                  setRefreshResult({ ok: true, msg: `Success. New access token valid for ~${mins} minutes.` });
                } else {
                  setRefreshResult({ ok: false, msg: d.error || 'Refresh failed.' });
                }
              } catch (e) {
                setRefreshResult({ ok: false, msg: e.message });
              } finally {
                setRefreshTesting(false);
              }
            }}
            disabled={refreshTesting}
            className="mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-muted text-fg hover:bg-subtle transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${refreshTesting ? 'animate-spin' : ''}`} />
            {refreshTesting ? 'Testing…' : 'Test refresh now'}
          </button>
          {refreshResult && (
            <p className={`text-[11px] mt-1.5 ${refreshResult.ok ? 'text-success' : 'text-danger'}`}>
              {refreshResult.ok ? '✓ ' : '✗ '}{refreshResult.msg}
            </p>
          )}
        </div>

        {/* One-button Connect flow — runs the full Authorization Code grant
            so the user never has to find a refresh token in eBay's UI.
            They just click a link, sign in on eBay, paste the redirect URL
            back, and we extract + exchange the auth code for both tokens. */}
        <div className="pt-3 border-t border-border-subtle">
          <p className="text-xs font-semibold text-fg uppercase tracking-wide mb-1">Easier: connect with one click</p>
          <p className="text-[11px] text-fg-muted mb-2 leading-relaxed">
            If the dev portal didn't show a Refresh Token, do the full Authorization Code flow
            here instead. One-time eBay portal setup, then we capture both tokens automatically.
          </p>

          <div className="text-[11px] text-fg-muted leading-relaxed mb-3 p-2.5 bg-warning-subtle border border-warning/30 rounded-lg space-y-1.5">
            <p className="font-semibold text-warning-fg">One-time eBay portal setup:</p>
            <ol className="list-decimal list-inside space-y-0.5 ml-1">
              <li>On the User Tokens page, scroll to "Get a Token from eBay via Your Application" and click <strong>Add eBay Redirect URL</strong>.</li>
              <li>Display Title: "NolTech Hub". Auth Accepted URL / Declined URL / Privacy: <span className="font-mono">https://www.ebay.com/</span>.</li>
              <li>Save. eBay assigns a <strong>RuName</strong> like <span className="font-mono">NolanBow-Practice-PRD-abc123-xyz4567</span>.</li>
              <li>Paste that RuName below and click "Connect eBay account".</li>
            </ol>
          </div>

          <label className={labelCls}>RuName (eBay Redirect URL Name)</label>
          <input
            type="text"
            value={ruName}
            onChange={(e) => { setRuName(e.target.value); setConnectResult(null); }}
            placeholder="NolanBow-Practice-PRD-..."
            className={inputCls + ' font-mono text-xs'}
          />

          {(() => {
            const canBuild = appId.trim() && ruName.trim();
            if (!canBuild) {
              return (
                <p className="text-[11px] text-fg-subtle mt-2">
                  Fill in App ID + RuName above to enable the connect flow.
                </p>
              );
            }
            const scopes = [
              'https://api.ebay.com/oauth/api_scope/sell.finances',
              'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
              'https://api.ebay.com/oauth/api_scope/sell.marketing',
            ].join(' ');
            const authUrl = `https://auth.ebay.com/oauth2/authorize?client_id=${encodeURIComponent(appId.trim())}&response_type=code&redirect_uri=${encodeURIComponent(ruName.trim())}&scope=${encodeURIComponent(scopes)}`;
            return (
              <>
                <a
                  href={authUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-primary text-white hover:bg-primary-dark transition-colors"
                >
                  <KeyRound className="w-3 h-3" />
                  1. Open eBay authorization page
                </a>
                <p className="text-[11px] text-fg-muted mt-2 leading-relaxed">
                  Sign in with your seller account, approve the scopes. eBay redirects to a
                  URL like <span className="font-mono">https://www.ebay.com/?code=v^1.1...&expires_in=299</span>.
                  Copy that ENTIRE URL from your browser's address bar and paste below:
                </p>
                <textarea
                  rows={2}
                  value={callbackUrl}
                  onChange={(e) => { setCallbackUrl(e.target.value); setConnectResult(null); }}
                  placeholder="https://www.ebay.com/?code=v^1.1...&expires_in=299"
                  className={inputCls + ' font-mono text-[10px] mt-2 resize-none'}
                />
                <button
                  disabled={connecting || !callbackUrl.trim()}
                  onClick={async () => {
                    setConnecting(true);
                    setConnectResult(null);
                    try {
                      let code = '';
                      try {
                        const u = new URL(callbackUrl.trim());
                        code = u.searchParams.get('code') || '';
                      } catch {
                        const m = callbackUrl.match(/[?&]code=([^&\s]+)/);
                        if (m) code = decodeURIComponent(m[1]);
                      }
                      if (!code) throw new Error('No ?code= parameter found in that URL.');
                      if (!certId.trim()) throw new Error('Cert ID is required to exchange the code.');

                      const r = await fetch(`${PIPELINE_BASE}/api/ebay/oauth/exchange-code`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          code,
                          clientId:     appId.trim(),
                          clientSecret: certId.trim(),
                          redirectUri:  ruName.trim(),
                        }),
                        signal: AbortSignal.timeout(20000),
                      });
                      const d = await r.json();
                      if (!d.success) throw new Error(d.error || 'Code exchange failed');

                      // Persist refresh + access tokens to encrypted creds.
                      // Wipe access-token cache so next sync mints fresh.
                      await window.storage.set(EBAY_TOKEN_KEY, await encryptObject({
                        token: token.trim(),
                        oauthUserToken: d.accessToken,
                        oauthRefreshToken: d.refreshToken,
                        oauthRuName: ruName.trim(),
                        appId: appId.trim(),
                        devId: devId.trim(),
                        certId: certId.trim(),
                      }));
                      await window.storage.set('noltech:ebay:oauth-cache', {}).catch(() => {});
                      setRefreshToken(d.refreshToken);
                      setOauthToken(d.accessToken);
                      setCallbackUrl('');
                      const days = Math.round((d.refreshExpiresAt - Date.now()) / 86400000);
                      setConnectResult({
                        ok: true,
                        msg: `Connected. Refresh token saved (~${days}-day lifespan). Auto-refresh active.`,
                      });
                    } catch (e) {
                      setConnectResult({ ok: false, msg: e.message });
                    } finally {
                      setConnecting(false);
                    }
                  }}
                  className="mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-success text-white hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  <Save className="w-3 h-3" />
                  {connecting ? 'Exchanging…' : '2. Connect eBay account'}
                </button>
                {connectResult && (
                  <p className={`text-[11px] mt-1.5 ${connectResult.ok ? 'text-success' : 'text-danger'}`}>
                    {connectResult.ok ? '✓ ' : '✗ '}{connectResult.msg}
                  </p>
                )}
              </>
            );
          })()}

          {/* Disconnect — revokes the refresh token at eBay (so it can't be
              used even if someone had a copy) and wipes all OAuth secrets
              from local storage. Trading API token + App ID/Cert ID are
              kept, since those aren't part of the OAuth flow. */}
          {refreshToken.trim() && (
            <div className="mt-4 pt-3 border-t border-border-subtle">
              <button
                disabled={disconnecting}
                onClick={async () => {
                  if (!confirm(
                    'Disconnect eBay account?\n\n' +
                    '• Refresh token will be revoked at eBay (server-side).\n' +
                    '• Stored OAuth tokens + cached access token will be wiped.\n' +
                    '• Auto-refresh will stop until you reconnect.\n\n' +
                    'Trading API User Token, App ID, and Cert ID are kept — only OAuth credentials are removed.'
                  )) return;
                  setDisconnecting(true);
                  setDisconnectResult(null);
                  let revokeStatus = 'skipped';
                  try {
                    // Best-effort server-side revoke. If it fails (network,
                    // scraper down, eBay 5xx), we still proceed with the
                    // local wipe so the UI never gets stuck.
                    if (refreshToken.trim() && appId.trim() && certId.trim()) {
                      try {
                        const r = await fetch(`${PIPELINE_BASE}/api/ebay/oauth/revoke`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            token: refreshToken.trim(),
                            clientId: appId.trim(),
                            clientSecret: certId.trim(),
                            tokenTypeHint: 'refresh_token',
                          }),
                          signal: AbortSignal.timeout(15000),
                        });
                        const d = await r.json().catch(() => ({}));
                        revokeStatus = d.success ? 'revoked' : `local-only (${d.error || 'eBay revoke failed'})`;
                      } catch (e) {
                        revokeStatus = `local-only (${e.message})`;
                      }
                    } else {
                      revokeStatus = 'local-only (no Cert ID — server-side revoke skipped)';
                    }

                    // Wipe OAuth bits from encrypted creds, keep Trading API
                    // token + appId/certId since those aren't part of OAuth.
                    await window.storage.set(EBAY_TOKEN_KEY, await encryptObject({
                      token: token.trim(),
                      oauthUserToken: '',
                      oauthRefreshToken: '',
                      oauthRuName: ruName.trim(),
                      appId: appId.trim(),
                      devId: devId.trim(),
                      certId: certId.trim(),
                    }));
                    // Wipe encrypted access-token cache
                    await window.storage.set('noltech:ebay:oauth-cache', await encryptObject({}));

                    setRefreshToken('');
                    setOauthToken('');
                    setCallbackUrl('');
                    setConnectResult(null);
                    setRefreshResult(null);
                    setDisconnectResult({
                      ok: true,
                      msg: revokeStatus === 'revoked'
                        ? 'Disconnected. Refresh token revoked at eBay; local OAuth data wiped.'
                        : `Disconnected locally. ${revokeStatus}`,
                    });
                  } catch (e) {
                    setDisconnectResult({ ok: false, msg: `Local wipe failed: ${e.message}` });
                  } finally {
                    setDisconnecting(false);
                  }
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-danger/30 text-danger hover:bg-danger/10 transition-colors disabled:opacity-50"
              >
                <Trash2 className="w-3 h-3" />
                {disconnecting ? 'Disconnecting…' : 'Disconnect eBay account'}
              </button>
              {disconnectResult && (
                <p className={`text-[11px] mt-1.5 ${disconnectResult.ok ? 'text-success' : 'text-danger'}`}>
                  {disconnectResult.ok ? '✓ ' : '✗ '}{disconnectResult.msg}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
      <button onClick={save}
        className={`mt-4 flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
          saved ? 'bg-success text-white' : 'bg-primary text-white hover:bg-primary-dark'
        }`}>
        <Save className="w-4 h-4" />
        {saved ? 'Saved!' : 'Save Credentials'}
      </button>
    </Card>
  );
}

// ─── Sold-Comps Service section ───────────────────────────────────────────────
// Optional: connects the Hub to the AWS Lambda Function URL that scrapes
// recent eBay sold listings on demand. Without these settings, the Sold Comps
// panel still works in read-only mode against whatever's already cached in
// Supabase from another device's scrape.

// ─── eBay Business Policies section ──────────────────────────────────────────
// Picker for the user's payment / shipping / return profile IDs. Populated
// by calling GetUserPreferences against eBay. Used by ListingGenerator's
// "Push to eBay" button so listings inherit the right profiles instead of
// requiring inline shipping/return XML.

function EbayPoliciesSection() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [profiles, setProfiles] = useState({ payment: [], shipping: [], return: [] });
  const [selected, setSelected] = useState({ paymentProfileId: '', shippingProfileId: '', returnProfileId: '' });
  const [saved, setSaved] = useState(false);

  // Load saved selections on mount.
  useState(() => {
    window.storage.get('noltech:ebay:policies').then((v) => {
      if (v && typeof v === 'object') setSelected({
        paymentProfileId: v.paymentProfileId || '',
        shippingProfileId: v.shippingProfileId || '',
        returnProfileId: v.returnProfileId || '',
      });
    }).catch(() => {});
  });

  const loadProfiles = async () => {
    setLoading(true);
    setError('');
    try {
      const rawCreds = await window.storage.get(EBAY_TOKEN_KEY).catch(() => null);
      const creds = await decryptObject(rawCreds || {});
      if (!creds?.token) throw new Error('Add an eBay user token above first.');
      const resp = await fetch(`${PIPELINE_BASE}/api/ebay/policies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userToken: creds.token,
          appId: creds.appId,
          devId: creds.devId,
          certId: creds.certId,
        }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || 'Failed to load policies');
      setProfiles({ payment: data.payment || [], shipping: data.shipping || [], return: data.return || [] });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    await window.storage.set('noltech:ebay:policies', selected);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const renderPicker = (label, key, list) => (
    <div>
      <label className={labelCls}>{label}</label>
      <select
        value={selected[key]}
        onChange={(e) => setSelected((prev) => ({ ...prev, [key]: e.target.value }))}
        className={inputCls + ' text-sm'}
      >
        <option value="">— pick a policy —</option>
        {list.map((p) => (
          <option key={p.id} value={p.id}>{p.name} ({p.id})</option>
        ))}
      </select>
    </div>
  );

  const allFilled = !!(selected.paymentProfileId && selected.shippingProfileId && selected.returnProfileId);

  return (
    <Card padding="lg">
      <div className="flex items-center gap-2 mb-1">
        <KeyRound className="w-4 h-4 text-fg-muted" />
        <h3 className="text-sm font-semibold text-fg">eBay Business Policies</h3>
      </div>
      <p className="text-xs text-fg-muted mb-4 leading-relaxed">
        Required by the <strong>Listing Generator → Push to eBay</strong> flow. Pick which payment, shipping, and return policies new listings should inherit. Your policies live in eBay Seller Hub → Account → Business Policies — this just lets the Hub reference them by ID.
      </p>

      <div className="flex items-center gap-2 mb-3">
        <button
          onClick={loadProfiles}
          disabled={loading}
          className="text-xs px-3 py-1.5 bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Load my policies from eBay'}
        </button>
        {profiles.payment.length + profiles.shipping.length + profiles.return.length > 0 && (
          <span className="text-xs text-fg-muted">
            {profiles.payment.length} payment · {profiles.shipping.length} shipping · {profiles.return.length} return
          </span>
        )}
      </div>

      {error && <p className="text-xs text-danger mb-3">{error}</p>}

      {(profiles.payment.length > 0 || profiles.shipping.length > 0 || profiles.return.length > 0 || allFilled) && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {renderPicker('Payment policy', 'paymentProfileId', profiles.payment)}
          {renderPicker('Shipping policy', 'shippingProfileId', profiles.shipping)}
          {renderPicker('Return policy', 'returnProfileId', profiles.return)}
        </div>
      )}

      <div className="flex items-center gap-2 mt-4">
        <button
          onClick={save}
          disabled={!allFilled || saved}
          className="text-sm px-3 py-1.5 bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50"
        >
          {saved ? 'Saved ✓' : 'Save selections'}
        </button>
        {!allFilled && (
          <span className="text-[11px] text-fg-muted">
            Click "Load my policies" first, then pick all three.
          </span>
        )}
      </div>
    </Card>
  );
}

function SoldCompsSection() {
  const [url, setUrl]         = useState('');
  const [secret, setSecret]   = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [saved, setSaved]     = useState(false);
  const [lastOk, setLastOk]   = useState(null);

  // Test-connection state
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null); // { ok, message }

  useEffect(() => {
    (async () => {
      try {
        const u = await window.storage.get(KEY_LAMBDA_URL);
        if (u) setUrl(String(u));
        const enc = await window.storage.get(KEY_AUTH_SECRET);
        if (enc) {
          // Show only a placeholder mask; the user can paste a new value to overwrite.
          setSecret(await decrypt(enc));
        }
        const ok = await window.storage.get(KEY_LAST_SUCCESS);
        if (ok) setLastOk(String(ok));
      } catch (e) { console.error('[SoldComps settings] load failed:', e); }
    })();
  }, []);

  const save = async () => {
    try {
      await window.storage.set(KEY_LAMBDA_URL, url.trim());
      // Encrypt the secret at rest. Empty string clears it.
      if (secret.trim()) {
        await window.storage.set(KEY_AUTH_SECRET, await encrypt(secret.trim()));
      } else {
        await window.storage.set(KEY_AUTH_SECRET, '');
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      console.error('[SoldComps settings] save failed:', e);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      // Save current values first so testLambdaConnection() reads what's typed.
      await save();
      const res = await testLambdaConnection();
      setTestResult(res);
      if (res.ok) {
        const ts = new Date().toISOString();
        await window.storage.set(KEY_LAST_SUCCESS, ts).catch(() => {});
        setLastOk(ts);
      }
    } catch (e) {
      setTestResult({ ok: false, message: e?.message || 'Test failed' });
    } finally {
      setTesting(false);
    }
  };

  const lastOkLabel = lastOk
    ? new Date(lastOk).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'never';

  return (
    <Card padding="lg">
      <div className="flex items-center gap-2 mb-1">
        <Cloud className="w-4 h-4 text-fg-muted" />
        <h3 className="text-sm font-semibold text-fg">Sold-Comps Service</h3>
        <span className="text-[10px] uppercase tracking-wide text-fg-muted ml-2">Optional</span>
      </div>
      <p className="text-xs text-fg-muted mb-4 leading-relaxed">
        Fetches recent eBay sold listings via Bright Data. Point this at the
        local pipeline's <span className="font-mono">/comps/lookup</span> endpoint
        (<span className="font-mono">{PIPELINE_BASE}/comps/lookup</span>), which replaced both the
        Cloudflare Worker and the legacy AWS Lambda. Without these settings
        configured, the Sold Comps panel falls back to read-only cached results.
      </p>

      <div className="space-y-3">
        <div>
          <label className={labelCls}>Sold-Comps Endpoint URL</label>
          <input
            type="url"
            value={url}
            onChange={(e) => { setUrl(e.target.value); setTestResult(null); }}
            placeholder={`${PIPELINE_BASE}/comps/lookup`}
            className={inputCls + ' font-mono text-xs'}
          />
        </div>

        <div>
          <label className={labelCls}>Shared Auth Secret</label>
          <div className="relative">
            <input
              type={showSecret ? 'text' : 'password'}
              value={secret}
              onChange={(e) => { setSecret(e.target.value); setTestResult(null); }}
              placeholder="Blank unless the pipeline sets SHARED_AUTH_SECRET"
              className={inputCls + ' font-mono pr-10 text-xs'}
            />
            <button
              type="button"
              onClick={() => setShowSecret((s) => !s)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-muted hover:text-fg"
            >
              {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          <p className="text-[11px] text-fg-muted mt-1">
            Stored encrypted (AES-256-GCM) on this device only.
          </p>
        </div>

        <div className="flex items-center justify-between gap-3 flex-wrap pt-1">
          <div className="text-[11px] text-fg-muted flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5 text-fg-subtle" />
            <span>Last successful call: <span className="font-mono">{lastOkLabel}</span></span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={runTest}
              disabled={testing || !url.trim() || !secret.trim()}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-border text-fg hover:bg-muted/40 disabled:opacity-50"
            >
              {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            <button
              type="button"
              onClick={save}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                saved ? 'bg-success text-white' : 'bg-primary text-white hover:bg-primary-dark'
              }`}
            >
              <Save className="w-4 h-4" />
              {saved ? 'Saved!' : 'Save'}
            </button>
          </div>
        </div>

        {testResult && (
          <div className={`mt-2 flex items-start gap-2 rounded-lg px-3 py-2 text-xs leading-relaxed ${
            testResult.ok
              ? 'bg-success-subtle border border-success/30 text-success-fg'
              : 'bg-danger-subtle border border-danger/30 text-danger-fg'
          }`}>
            {testResult.ok
              ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              : <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />}
            <span>{testResult.message}</span>
          </div>
        )}
      </div>
    </Card>
  );
}

// ─── Dark Mode toggle ────────────────────────────────────────────────────────

function DarkModeSection({ isDark, toggleDark, mode, setMode }) {
  const opts = [
    { id: 'light', label: 'Light', icon: Sun },
    { id: 'dark',  label: 'Dark',  icon: Moon },
    { id: 'auto',  label: 'Auto',  icon: Cloud },
  ];
  return (
    <Card padding="lg">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          {isDark
            ? <Moon className="w-5 h-5 text-accent" />
            : <Sun  className="w-5 h-5 text-warning" />
          }
          <div>
            <h3 className="text-sm font-semibold text-fg">Theme</h3>
            <p className="text-xs text-fg-muted mt-0.5">
              {mode === 'auto'
                ? `Following system preference — currently ${isDark ? 'dark' : 'light'}.`
                : isDark
                  ? 'Dark theme is active. Easy on the eyes.'
                  : 'Light theme is active.'}
            </p>
          </div>
        </div>

        {/* Tri-state segmented pill: Light / Dark / Auto */}
        <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-muted/60 border border-border-subtle">
          {opts.map(({ id, label, icon: Icon }) => {
            const active = (mode || (isDark ? 'dark' : 'light')) === id;
            return (
              <button
                key={id}
                onClick={() => setMode ? setMode(id) : (id === 'dark' ? !isDark && toggleDark() : id === 'light' ? isDark && toggleDark() : null)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  active
                    ? 'bg-surface text-fg shadow-sm border border-border'
                    : 'text-fg-muted hover:text-fg hover:bg-muted'
                }`}
                title={id === 'auto' ? 'Follow system preference' : `Always ${label.toLowerCase()}`}
              >
                <Icon size={13} />
                {label}
              </button>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

// ─── eBay Fee Rate section ─────────────────────────────────────────────────────

const FEE_KEY = 'noltech:settings:ebay-fee-rate';

function FeeRateSection() {
  const [rate, setRate]   = useState('9.35');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    window.storage.get(FEE_KEY).then(v => {
      if (v != null) {
        setRate(String(v));
        setEbayFeeRate(parseFloat(v) / 100);
      }
    }).catch(() => {});
  }, []);

  const save = async () => {
    const num = parseFloat(rate);
    if (isNaN(num) || num < 0 || num > 50) return;
    await window.storage.set(FEE_KEY, num).catch(console.error);
    setEbayFeeRate(num / 100);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <Card padding="lg">
      <div className="flex items-center gap-2 mb-1">
        <Percent className="w-4 h-4 text-fg-muted" />
        <h3 className="text-sm font-semibold text-fg">eBay Fee Rate</h3>
      </div>
      <p className="text-xs text-fg-muted mb-4 leading-relaxed">
        Final value fee percentage applied to all eBay profit calculations. Default is 9.35%. Change this if your eBay store has a different rate.
      </p>
      <div className="flex items-center gap-3">
        <div className="relative w-32">
          <input
            type="number"
            min="0" max="50" step="0.01"
            value={rate}
            onChange={e => setRate(e.target.value)}
            className={inputCls + ' font-mono pr-8'}
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-muted text-sm">%</span>
        </div>
        <button
          onClick={save}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            saved ? 'bg-success text-white' : 'bg-primary text-white hover:bg-primary-dark'
          }`}
        >
          <Save className="w-4 h-4" />
          {saved ? 'Saved!' : 'Save'}
        </button>
      </div>
    </Card>
  );
}

// ─── Resale Realization Rate section ──────────────────────────────────────────
// What % of estimated/MSRP value you actually realize at sale. Drives bid
// guidance + signal margins when set below 100% (e.g., 80% if you list at
// 20% under market to push sell-through).

const REALIZATION_KEY = 'noltech:settings:resale-realization-rate';

function RealizationRateSection() {
  const [rate, setRate]   = useState('100');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    window.storage.get(REALIZATION_KEY).then(v => {
      if (v != null) {
        setRate(String(v));
        setResaleRealizationRate(parseFloat(v) / 100);
      }
    }).catch(() => {});
  }, []);

  const save = async () => {
    const num = parseFloat(rate);
    if (isNaN(num) || num < 1 || num > 200) return;
    await window.storage.set(REALIZATION_KEY, num).catch(console.error);
    setResaleRealizationRate(num / 100);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const numeric = parseFloat(rate) || 100;
  const discountPct = Math.max(0, 100 - numeric);

  return (
    <Card padding="lg">
      <div className="flex items-center gap-2 mb-1">
        <Percent className="w-4 h-4 text-fg-muted" />
        <h3 className="text-sm font-semibold text-fg">Realized Sale Price %</h3>
      </div>
      <p className="text-xs text-fg-muted mb-1 leading-relaxed">
        What fraction of estimated / MSRP value you typically realize at sale. If you list at 20% under market to push sell-through,
        set this to <span className="font-mono font-semibold">80</span>. Lots' bid guidance, manifest resale estimates, and the
        signal margin (Buy / Watch / Pass) all multiply by this factor so bid ceilings reflect what you actually make on average.
      </p>
      <p className="text-[11px] text-fg-subtle mb-4 leading-relaxed">
        Default is <span className="font-mono">100</span> (no discount). Range 1–200.
      </p>
      <div className="flex items-center gap-3">
        <div className="relative w-32">
          <input
            type="number"
            min="1" max="200" step="0.5"
            value={rate}
            onChange={e => setRate(e.target.value)}
            className={inputCls + ' font-mono pr-8'}
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-muted text-sm">%</span>
        </div>
        <button
          onClick={save}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            saved ? 'bg-success text-white' : 'bg-primary text-white hover:bg-primary-dark'
          }`}
        >
          <Save className="w-4 h-4" />
          {saved ? 'Saved!' : 'Save'}
        </button>
        {numeric !== 100 && (
          <span className="text-[11px] text-fg-muted">
            {discountPct > 0
              ? <>Bid guidance discounted by <span className="font-mono font-semibold">{discountPct.toFixed(1)}%</span></>
              : <>Bid guidance scaled up by <span className="font-mono font-semibold">{(numeric - 100).toFixed(1)}%</span></>}
          </span>
        )}
      </div>
    </Card>
  );
}

// ─── Active-listing ask buffer ────────────────────────────────────────────────
// Compensates for the gap between active asking prices (what the Browse API
// returns) and actual sold prices. Multiplies with the realization rate so
// bid guidance reflects realized-sale reality.

const ASK_BUFFER_KEY = 'noltech:settings:active-ask-buffer';

function ActiveAskBufferSection() {
  const [defaultRate,    setDefaultRate]    = useState('85');
  const [overrides,      setOverrides]      = useState([]); // [{ category, rate }]
  const [newCategory,    setNewCategory]    = useState('');
  const [newRate,        setNewRate]        = useState('80');
  const [saved,          setSaved]          = useState(false);
  const [realization,    setRealization]    = useState(100);

  useEffect(() => {
    window.storage.get(ASK_BUFFER_KEY).then(v => {
      if (v == null) return;
      // Backward compat: a single number means "default rate, no overrides"
      if (typeof v === 'number' || (typeof v === 'string' && !isNaN(parseFloat(v)))) {
        const n = parseFloat(v);
        setDefaultRate(String(n));
        setActiveAskBuffer(n / 100);
        return;
      }
      if (typeof v === 'object') {
        const dPct = v.default != null
          ? (v.default > 1 ? v.default : v.default * 100)
          : 85;
        setDefaultRate(String(Math.round(dPct * 100) / 100));
        const ovr = Object.entries(v.byCategory || {}).map(([category, rate]) => ({
          category,
          rate: String(Math.round((rate > 1 ? rate : rate * 100) * 100) / 100),
        }));
        setOverrides(ovr);
        setActiveAskBuffer(v);
      }
    }).catch(() => {});
    setRealization(Math.round(getResaleRealizationRate() * 100));
  }, []);

  const save = async () => {
    const dflt = parseFloat(defaultRate);
    if (isNaN(dflt) || dflt < 1 || dflt > 200) return;
    const byCategory = {};
    for (const { category, rate } of overrides) {
      const cat = (category || '').trim();
      const n = parseFloat(rate);
      if (!cat || isNaN(n) || n < 1 || n > 200) continue;
      byCategory[cat] = n / 100;
    }
    const config = { default: dflt / 100, byCategory };
    await window.storage.set(ASK_BUFFER_KEY, config).catch(console.error);
    setActiveAskBuffer(config);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const addOverride = () => {
    const cat = newCategory.trim();
    const n   = parseFloat(newRate);
    if (!cat || isNaN(n) || n < 1 || n > 200) return;
    if (overrides.some((o) => o.category.toLowerCase() === cat.toLowerCase())) return;
    setOverrides((prev) => [...prev, { category: cat, rate: String(n) }]);
    setNewCategory('');
    setNewRate('80');
  };
  const removeOverride = (i) => setOverrides((prev) => prev.filter((_, idx) => idx !== i));
  const updateOverride = (i, field, value) =>
    setOverrides((prev) => prev.map((o, idx) => (idx === i ? { ...o, [field]: value } : o)));

  const numericDefault = parseFloat(defaultRate) || 100;
  const combined = (numericDefault * realization) / 100;

  return (
    <Card padding="lg">
      <div className="flex items-center gap-2 mb-1">
        <Percent className="w-4 h-4 text-fg-muted" />
        <h3 className="text-sm font-semibold text-fg">Active-Listing Buffer %</h3>
      </div>
      <p className="text-xs text-fg-muted mb-1 leading-relaxed">
        eBay's Browse API returns asking prices (active listings), which skew higher than what items actually sell for.
        Set a default below, plus per-category overrides for product types with bigger or smaller
        ask-vs-sold gaps (e.g. Nintendo consoles 90% vs Apple iPads 75%).
      </p>
      <p className="text-[11px] text-fg-subtle mb-4 leading-relaxed">
        Suggested defaults: <span className="font-mono">90</span> for current/hot ·
        <span className="font-mono"> 85</span> for standard tech ·
        <span className="font-mono"> 75</span> for niche/older. Multiplies with Realized Sale Price % above.
      </p>

      {/* Default rate */}
      <div className="mb-4 pb-4 border-b border-border-subtle">
        <label className={labelCls}>Default buffer (used when no category override matches)</label>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative w-32">
            <input
              type="number"
              min="1" max="200" step="0.5"
              value={defaultRate}
              onChange={(e) => setDefaultRate(e.target.value)}
              className={inputCls + ' font-mono pr-8'}
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-muted text-sm">%</span>
          </div>
          <span className="text-[11px] text-fg-muted">
            Combined effective:{' '}
            <span className="font-mono font-semibold text-fg">
              {realization}% × {numericDefault.toFixed(0)}% = {combined.toFixed(0)}%
            </span>
          </span>
        </div>
      </div>

      {/* Per-category overrides */}
      <div className="mb-4">
        <label className={labelCls}>Per-category overrides</label>
        {overrides.length === 0 && (
          <p className="text-[11px] text-fg-subtle italic mb-2">
            No overrides yet — every category falls back to {numericDefault.toFixed(0)}%.
          </p>
        )}
        {overrides.map((o, i) => {
          const ovrCombined = (parseFloat(o.rate) || 0) * realization / 100;
          return (
            <div key={i} className="flex items-center gap-2 mb-2">
              <input
                type="text"
                value={o.category}
                onChange={(e) => updateOverride(i, 'category', e.target.value)}
                placeholder="Category (e.g. Tablets, Video Game Consoles)"
                className={inputCls + ' flex-1 text-sm'}
              />
              <div className="relative w-24">
                <input
                  type="number"
                  min="1" max="200" step="0.5"
                  value={o.rate}
                  onChange={(e) => updateOverride(i, 'rate', e.target.value)}
                  className={inputCls + ' font-mono pr-7 text-sm'}
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-muted text-xs">%</span>
              </div>
              <span className="text-[10px] text-fg-subtle w-16 text-right font-mono">
                = {ovrCombined.toFixed(0)}%
              </span>
              <button
                onClick={() => removeOverride(i)}
                className="text-fg-muted hover:text-danger hover:bg-danger/10 p-1.5 rounded transition-colors"
                title="Remove this override"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}

        {/* Add row */}
        <div className="flex items-center gap-2 mt-3 pt-2 border-t border-border-subtle">
          <input
            type="text"
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            placeholder="Add: e.g. Tablets, Video Game Consoles, Cell Phones"
            className={inputCls + ' flex-1 text-sm'}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addOverride(); } }}
          />
          <div className="relative w-24">
            <input
              type="number"
              min="1" max="200" step="0.5"
              value={newRate}
              onChange={(e) => setNewRate(e.target.value)}
              className={inputCls + ' font-mono pr-7 text-sm'}
            />
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-muted text-xs">%</span>
          </div>
          <button
            onClick={addOverride}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-muted text-fg hover:bg-subtle transition-colors"
          >
            Add
          </button>
        </div>
        <p className="text-[10px] text-fg-subtle mt-2 leading-relaxed">
          Matching is case-insensitive and supports partial names — typing
          <span className="font-mono"> Video Game</span> will match a lot tagged
          <span className="font-mono"> Video Game Consoles</span>, and
          <span className="font-mono"> Tablet</span> matches <span className="font-mono">Tablets</span> /
          <span className="font-mono"> Apple Tablets</span>. When multiple overrides match,
          the most-specific (longest) one wins.
        </p>
      </div>

      <button
        onClick={save}
        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
          saved ? 'bg-success text-white' : 'bg-primary text-white hover:bg-primary-dark'
        }`}
      >
        <Save className="w-4 h-4" />
        {saved ? 'Saved!' : 'Save'}
      </button>
    </Card>
  );
}

// ─── eBay-pricer Condition Haircut ────────────────────────────────────────────
// Per-condition multiplier applied AFTER eBay UPC pricing. Browse API asks
// reflect working/used items; if the lot is salvage/for-parts/broken, those
// asks overstate realizable value. Stacks with realization × ask buffer.

const EBAY_HAIRCUT_KEY = 'noltech:settings:ebay-condition-haircuts';

const HAIRCUT_LABELS = {
  new: 'New', sealed: 'Sealed', open_box: 'Open Box', like_new: 'Like New',
  refurbished: 'Refurbished', grade_a: 'Grade A', grade_b: 'Grade B', grade_c: 'Grade C', grade_d: 'Grade D',
  good: 'Good', used: 'Used', fair: 'Fair', poor: 'Poor',
  broken: 'Broken', for_parts: 'For Parts', salvage: 'Salvage',
  as_is: 'As-Is', untested: 'Untested', unknown: 'Unknown', mixed: 'Mixed',
};

function EbayConditionHaircutSection() {
  const [vals, setVals] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    window.storage.get(EBAY_HAIRCUT_KEY)
      .then(v => setVals(v && typeof v === 'object' ? { ...DEFAULT_EBAY_CONDITION_HAIRCUTS, ...v } : { ...DEFAULT_EBAY_CONDITION_HAIRCUTS }))
      .catch(() => setVals({ ...DEFAULT_EBAY_CONDITION_HAIRCUTS }));
  }, []);

  const handleChange = (cond, pctValue) => {
    const num = parseFloat(pctValue);
    if (isNaN(num)) return;
    setVals(prev => ({ ...prev, [cond]: num / 100 }));
  };

  const handleSave = async () => {
    try {
      await window.storage.set(EBAY_HAIRCUT_KEY, vals);
      setEbayConditionHaircuts(vals);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      console.error('Failed to save eBay condition haircuts:', e);
    }
  };

  const handleReset = () => setVals({ ...DEFAULT_EBAY_CONDITION_HAIRCUTS });

  if (!vals) return <div className="h-32 bg-muted rounded-xl animate-pulse" />;

  const conditions = Object.keys(DEFAULT_EBAY_CONDITION_HAIRCUTS);

  return (
    <Card padding="lg">
      <div className="flex items-center gap-2 mb-1">
        <Percent className="w-4 h-4 text-fg-muted" />
        <h3 className="text-sm font-semibold text-fg">eBay-Pricer Condition Haircut</h3>
      </div>
      <p className="text-xs text-fg-muted mb-1 leading-relaxed">
        eBay's Browse API returns asks for working/used items. When the lot in hand is salvage,
        for-parts, or broken, those asks wildly overstate realizable value. This map applies a
        per-condition haircut to the eBay-priced manifest total used for bid guidance.
      </p>
      <p className="text-[11px] text-fg-subtle mb-4 leading-relaxed">
        Defaults: <span className="font-mono">used/working = 100%</span> (no haircut),{' '}
        <span className="font-mono">salvage = 45%</span>,{' '}
        <span className="font-mono">for-parts/broken = 30%</span>. This <em>multiplies</em> with
        the realized rate and ask buffer above.
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-3">
        {conditions.map(cond => {
          const val = vals[cond] ?? DEFAULT_EBAY_CONDITION_HAIRCUTS[cond] ?? 1.0;
          const pct = Math.round(val * 100);
          const color = pct >= 80 ? 'border-success/30' : pct >= 50 ? 'border-warning/30' : 'border-danger/30';
          return (
            <div key={cond} className={`flex items-center gap-2 border ${color} rounded-lg px-2.5 py-1.5`}>
              <label className="text-[11px] text-fg flex-1 truncate" title={HAIRCUT_LABELS[cond] || cond}>
                {HAIRCUT_LABELS[cond] || cond}
              </label>
              <div className="relative w-16">
                <input
                  type="number"
                  min="0" max="200" step="1"
                  value={pct}
                  onChange={e => handleChange(cond, e.target.value)}
                  className="w-full text-right font-mono text-xs border-0 bg-transparent focus:outline-none focus:ring-0 pr-4 py-0"
                />
                <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[10px] text-fg-muted">%</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={handleSave}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            saved ? 'bg-success text-white' : 'bg-primary text-white hover:bg-primary-dark'
          }`}
        >
          <Save className="w-4 h-4" />
          {saved ? 'Saved!' : 'Save'}
        </button>
        <button
          onClick={handleReset}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-muted text-fg-muted hover:bg-subtle transition-colors"
        >
          <RefreshCw className="w-3 h-3" />
          Reset to defaults
        </button>
      </div>
    </Card>
  );
}

// ─── Auction Buyer's Premium ─────────────────────────────────────────────────
// Most liquidation auctions add a buyer's premium on top of the winning bid.
// Bid ceilings are scaled by 1/(1+premium) so the displayed "bid up to" value
// is the max bid that, after premium, stays under the cost target.

const AUCTION_FEE_KEY = 'noltech:settings:auction-fee-rates';

const AUCTION_SOURCE_LABELS = {
  techliquidators: 'TechLiquidators',
  liquidation:     'Liquidation.com',
  bstock:          'B-Stock',
};

function AuctionFeeSection() {
  const [vals, setVals] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    window.storage.get(AUCTION_FEE_KEY)
      .then(v => setVals(v && typeof v === 'object' ? { ...DEFAULT_AUCTION_FEE_RATES, ...v } : { ...DEFAULT_AUCTION_FEE_RATES }))
      .catch(() => setVals({ ...DEFAULT_AUCTION_FEE_RATES }));
  }, []);

  const handleChange = (source, pctValue) => {
    const num = parseFloat(pctValue);
    if (isNaN(num)) return;
    setVals(prev => ({ ...prev, [source]: num / 100 }));
  };

  const handleSave = async () => {
    try {
      await window.storage.set(AUCTION_FEE_KEY, vals);
      setAuctionFeeRates(vals);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      console.error('Failed to save auction fee rates:', e);
    }
  };

  const handleReset = () => setVals({ ...DEFAULT_AUCTION_FEE_RATES });

  if (!vals) return <div className="h-32 bg-muted rounded-xl animate-pulse" />;

  const sources = Object.keys(DEFAULT_AUCTION_FEE_RATES);

  return (
    <Card padding="lg">
      <div className="flex items-center gap-2 mb-1">
        <Percent className="w-4 h-4 text-fg-muted" />
        <h3 className="text-sm font-semibold text-fg">Auction Buyer's Premium</h3>
      </div>
      <p className="text-xs text-fg-muted mb-1 leading-relaxed">
        Per-source premium added to your winning bid at checkout. TechLiquidators charges 5%,
        Liquidation.com 10%. Bid ceilings divide by (1 + premium) so the displayed max bid is
        what you can actually place.
      </p>
      <p className="text-[11px] text-fg-subtle mb-4 leading-relaxed">
        Example: at a 30% margin target the cost ceiling is $1,050. With a 5% premium the
        max bid shown is <span className="font-mono">$1,000</span> — bidding $1,000 means
        you pay $1,050 after premium.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-3">
        {sources.map(src => {
          const val = vals[src] ?? DEFAULT_AUCTION_FEE_RATES[src] ?? 0;
          const pct = Math.round(val * 1000) / 10;
          return (
            <div key={src} className="flex items-center gap-2 border border-border rounded-lg px-2.5 py-1.5">
              <label className="text-[11px] text-fg flex-1 truncate" title={AUCTION_SOURCE_LABELS[src] || src}>
                {AUCTION_SOURCE_LABELS[src] || src}
              </label>
              <div className="relative w-20">
                <input
                  type="number"
                  min="0" max="50" step="0.5"
                  value={pct}
                  onChange={e => handleChange(src, e.target.value)}
                  className="w-full text-right font-mono text-xs border-0 bg-transparent focus:outline-none focus:ring-0 pr-4 py-0"
                />
                <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[10px] text-fg-muted">%</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={handleSave}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            saved ? 'bg-success text-white' : 'bg-primary text-white hover:bg-primary-dark'
          }`}
        >
          <Save className="w-4 h-4" />
          {saved ? 'Saved!' : 'Save'}
        </button>
        <button
          onClick={handleReset}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-muted text-fg-muted hover:bg-subtle transition-colors"
        >
          <RefreshCw className="w-3 h-3" />
          Reset to defaults
        </button>
      </div>
    </Card>
  );
}

// ─── Condition Multiplier Editor ───────────────────────────────────────────────

const MULT_KEY = 'noltech:settings:condition-multipliers';

const DEFAULT_MULTS = {
  techliquidators: {
    new: 0.82, sealed: 0.85, open_box: 0.73, like_new: 0.70,
    refurbished: 0.62, grade_a: 0.65, grade_b: 0.52, grade_c: 0.38, grade_d: 0.20,
    good: 0.55, fair: 0.38, poor: 0.22, broken: 0.12, for_parts: 0.12,
    salvage: 0.15, as_is: 0.22, untested: 0.22, unknown: 0.30, mixed: 0.40,
  },
  liquidation: {
    new: 0.82, sealed: 0.85, open_box: 0.73, like_new: 0.70,
    refurbished: 0.62, grade_a: 0.65, grade_b: 0.52, grade_c: 0.38, grade_d: 0.20,
    good: 0.55, fair: 0.38, poor: 0.22, broken: 0.12, for_parts: 0.12,
    salvage: 0.15, as_is: 0.22, untested: 0.22, unknown: 0.30, mixed: 0.40,
    _divisor_general: 4.0, _divisor_gpu: 2.0,
  },
  bstock: {
    new: 0.82, sealed: 0.85, open_box: 0.73, like_new: 0.70,
    refurbished: 0.62, grade_a: 0.65, grade_b: 0.52, grade_c: 0.38, grade_d: 0.20,
    good: 0.55, fair: 0.38, poor: 0.22, broken: 0.12, for_parts: 0.12,
    salvage: 0.15, as_is: 0.22, untested: 0.22, unknown: 0.30, mixed: 0.40,
  },
};

const CONDITION_LABELS = {
  new: 'New', sealed: 'Sealed', open_box: 'Open Box', like_new: 'Like New',
  refurbished: 'Refurbished', grade_a: 'Grade A', grade_b: 'Grade B', grade_c: 'Grade C', grade_d: 'Grade D',
  good: 'Good', fair: 'Fair', poor: 'Poor', broken: 'Broken', for_parts: 'For Parts',
  salvage: 'Salvage', as_is: 'As-Is', untested: 'Untested', unknown: 'Unknown', mixed: 'Mixed',
  _divisor_general: 'MSRP Divisor (General)', _divisor_gpu: 'MSRP Divisor (GPU)',
};

function ConditionMultiplierSection() {
  const [mults, setMults] = useState(null);
  const [activeSource, setActiveSource] = useState('techliquidators');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    window.storage.get(MULT_KEY)
      .then(v => setMults(v && typeof v === 'object' ? { ...DEFAULT_MULTS, ...v } : { ...DEFAULT_MULTS }))
      .catch(() => setMults({ ...DEFAULT_MULTS }));
  }, []);

  const handleChange = (source, condition, value) => {
    const num = parseFloat(value);
    if (isNaN(num)) return;
    setMults(prev => ({
      ...prev,
      [source]: { ...(prev[source] || DEFAULT_MULTS[source] || {}), [condition]: num },
    }));
  };

  const handleSave = async () => {
    try {
      await window.storage.set(MULT_KEY, mults);
      // NOTE: these multipliers currently have no consumer. They used to be
      // pushed to the local Express scraper's utils/msrp.js, which was deleted
      // in the Cloudflare cutover; noltech-pipeline derives item condition via
      // shared/condition.js and doesn't apply a per-condition MSRP multiplier.
      // The value is still persisted, synced, and backed up, so wiring it back
      // in is a matter of teaching the pipeline's scorer to read it.
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      console.error('Failed to save multipliers:', e);
    }
  };

  const handleReset = (source) => {
    setMults(prev => ({ ...prev, [source]: { ...DEFAULT_MULTS[source] } }));
  };

  if (!mults) return <div className="h-32 bg-muted rounded-xl animate-pulse" />;

  const sources = Object.keys(DEFAULT_MULTS);
  const currentMults = mults[activeSource] || DEFAULT_MULTS[activeSource] || {};
  const conditions = Object.keys(currentMults);

  // Split into regular conditions and special divisors
  const regularConditions = conditions.filter(c => !c.startsWith('_'));
  const specialKeys = conditions.filter(c => c.startsWith('_'));

  return (
    <Card padding="lg">
      <div className="flex items-center gap-2 mb-1">
        <Percent className="w-4 h-4 text-fg-muted" />
        <h3 className="text-sm font-semibold text-fg">Condition Multipliers</h3>
      </div>
      <p className="text-xs text-fg-muted mb-4 leading-relaxed">
        Adjust how much of MSRP each condition retains. These multipliers determine estimated resale values and bid ceilings per source.
      </p>

      {/* Source tabs */}
      <div className="flex gap-1 mb-4">
        {sources.map(s => (
          <button
            key={s}
            onClick={() => setActiveSource(s)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              activeSource === s ? 'bg-primary text-white' : 'bg-muted text-fg-muted hover:bg-subtle'
            }`}
          >
            {s === 'techliquidators' ? 'TechLiquidators' : s === 'liquidation' ? 'Liquidation.com' : s}
          </button>
        ))}
      </div>

      {/* Condition grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-3">
        {regularConditions.map(cond => {
          const val = currentMults[cond] ?? 0;
          const pct = Math.round(val * 100);
          const color = pct >= 60 ? 'border-success/30' : pct >= 30 ? 'border-warning/30' : 'border-danger/30';
          return (
            <div key={cond} className={`flex items-center gap-2 border ${color} rounded-lg px-2.5 py-1.5`}>
              <label className="text-[11px] text-fg flex-1 truncate" title={CONDITION_LABELS[cond]}>
                {CONDITION_LABELS[cond] || cond}
              </label>
              <div className="relative w-16">
                <input
                  type="number"
                  min="0" max="100" step="1"
                  value={pct}
                  onChange={e => handleChange(activeSource, cond, (parseFloat(e.target.value) || 0) / 100)}
                  className="w-full text-right font-mono text-xs border-0 bg-transparent focus:outline-none focus:ring-0 pr-4 py-0"
                />
                <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[10px] text-fg-muted">%</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Special keys (divisors for Liquidation.com) */}
      {specialKeys.length > 0 && (
        <div className="border-t border-border-subtle pt-3 mt-3">
          <p className="text-[10px] font-semibold text-fg-muted uppercase tracking-wide mb-2">MSRP Divisors</p>
          <div className="grid grid-cols-2 gap-2">
            {specialKeys.map(key => (
              <div key={key} className="flex items-center gap-2 border border-border rounded-lg px-2.5 py-1.5">
                <label className="text-[11px] text-fg flex-1">{CONDITION_LABELS[key] || key}</label>
                <input
                  type="number"
                  min="1" max="20" step="0.5"
                  value={currentMults[key] ?? 4}
                  onChange={e => handleChange(activeSource, key, parseFloat(e.target.value) || 4)}
                  className="w-14 text-right font-mono text-xs border border-border rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-primary/30"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 mt-4">
        <button
          onClick={handleSave}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            saved ? 'bg-success text-white' : 'bg-primary text-white hover:bg-primary-dark'
          }`}
        >
          <Save className="w-4 h-4" />
          {saved ? 'Saved!' : 'Save'}
        </button>
        <button
          onClick={() => handleReset(activeSource)}
          className="flex items-center gap-2 px-4 py-2 border border-border text-fg-muted rounded-lg text-sm font-medium hover:bg-muted/40 transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          Reset to Defaults
        </button>
      </div>
    </Card>
  );
}

// ─── Auto-Sync section ────────────────────────────────────────────────────────

// ─── B-Stock Marketplace Picker ────────────────────────────────────────────────

const BSTOCK_KEY = 'noltech:settings:bstock-marketplaces';

const BSTOCK_MARKETPLACES = [
  { key: 'walmart',  name: 'Walmart',     status: 'public',     note: 'Publicly accessible' },
  { key: 'target',   name: 'Target',      status: 'cloudflare', note: 'Requires auth (Cloudflare)' },
  { key: 'bestbuy',  name: 'Best Buy',    status: 'cloudflare', note: 'Requires auth (Cloudflare)' },
  { key: 'lowes',    name: "Lowe's",      status: 'cloudflare', note: 'Requires auth (Cloudflare)' },
  { key: 'costco',   name: 'Costco',      status: 'unknown',    note: 'Not yet tested' },
  { key: 'wayfair',  name: 'Wayfair',     status: 'unknown',    note: 'Not yet tested' },
];

function BStockMarketplaceSection() {
  const [selected, setSelected] = useState(['walmart']);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    window.storage.get(BSTOCK_KEY)
      .then(v => { if (Array.isArray(v) && v.length > 0) setSelected(v); })
      .catch(() => {});
  }, []);

  const toggle = (key) => {
    setSelected(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  };

  const save = async () => {
    await window.storage.set(BSTOCK_KEY, selected).catch(console.error);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <Card padding="lg">
      <div className="flex items-center gap-2 mb-1">
        <Save className="w-4 h-4 text-fg-muted" />
        <h3 className="text-sm font-semibold text-fg">B-Stock Marketplaces</h3>
      </div>
      <p className="text-xs text-fg-muted mb-4 leading-relaxed">
        Choose which B-Stock marketplaces to scrape. Only public marketplaces work without authentication.
      </p>

      <div className="grid grid-cols-2 gap-2 mb-4">
        {BSTOCK_MARKETPLACES.map(mp => (
          <label key={mp.key}
            className={`flex items-start gap-2.5 p-2.5 rounded-lg border cursor-pointer transition-colors ${
              selected.includes(mp.key) ? 'border-primary/30 bg-primary/5' : 'border-border-subtle hover:bg-muted/40'
            } ${mp.status !== 'public' ? 'opacity-60' : ''}`}>
            <input
              type="checkbox"
              checked={selected.includes(mp.key)}
              onChange={() => toggle(mp.key)}
              className="mt-0.5 accent-primary"
            />
            <div>
              <span className="text-sm font-medium text-fg">{mp.name}</span>
              <p className="text-[10px] text-fg-muted">{mp.note}</p>
            </div>
          </label>
        ))}
      </div>

      <button onClick={save}
        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
          saved ? 'bg-success text-white' : 'bg-primary text-white hover:bg-primary/90'
        }`}>
        <Save className="w-3.5 h-3.5" />
        {saved ? 'Saved!' : 'Save Marketplaces'}
      </button>
    </Card>
  );
}

const SYNC_KEY = 'noltech:settings:auto-sync';

function AutoSyncSection() {
  const [config, setConfig] = useState({
    scrapeEnabled: false, scrapeInterval: 30,
    priceEnabled: false, priceAfterScrape: true,
    ebayEnabled: false, ebayInterval: 60, ebayDaysBack: 90,
    offersAutoEnabled: false, offersAutoInterval: 15,
  });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    window.storage.get(SYNC_KEY)
      .then(v => { if (v) setConfig(prev => ({ ...prev, ...v })); })
      .catch(() => {});
  }, []);

  const set = (key, value) => setConfig(prev => ({ ...prev, [key]: value }));

  const save = async () => {
    await window.storage.set(SYNC_KEY, config).catch(console.error);
    // Notify the auto-sync hook to restart timers. Goes through the same
    // eventBus the listener subscribes to — previously we emitted on
    // `window.noltech.events` (a different channel), so the listener never
    // fired and timer changes silently failed to take effect.
    eventBus.emit('autosync:config-changed');
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const toggleCls = (on) => `relative inline-flex h-6 w-11 items-center rounded-full cursor-pointer transition-colors ${on ? 'bg-primary' : 'bg-border-strong'}`;
  const dotCls = (on) => `inline-block h-4 w-4 rounded-full bg-surface transition-transform shadow-sm ${on ? 'translate-x-6' : 'translate-x-1'}`;

  return (
    <Card padding="lg">
      <div className="flex items-center gap-2 mb-1">
        <RefreshCw className="w-4 h-4 text-fg-muted" />
        <h3 className="text-sm font-semibold text-fg">Auto-Sync</h3>
      </div>
      <p className="text-xs text-fg-muted mb-4 leading-relaxed">
        Automatically scrape lots, price manifests, and sync eBay orders on a timer. Runs in the background while the app is open.
      </p>

      <div className="space-y-4">
        {/* Auto-scrape */}
        <div className="flex items-start gap-3 p-3 border border-border-subtle rounded-lg">
          <button onClick={() => set('scrapeEnabled', !config.scrapeEnabled)} className={toggleCls(config.scrapeEnabled)}>
            <span className={dotCls(config.scrapeEnabled)} />
          </button>
          <div className="flex-1">
            <p className="text-sm font-medium text-fg">Auto-Scrape Lots</p>
            <p className="text-xs text-fg-muted">Fetch new lots from enabled sources on a timer</p>
            {config.scrapeEnabled && (
              <div className="flex items-center gap-2 mt-2">
                <label className="text-xs text-fg-muted">Every</label>
                <input type="number" min="5" max="240" value={config.scrapeInterval}
                  onChange={e => set('scrapeInterval', parseInt(e.target.value) || 30)}
                  className="w-16 border border-border rounded px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary/30"
                />
                <label className="text-xs text-fg-muted">minutes</label>
              </div>
            )}
          </div>
        </div>

        {/* Auto-price */}
        <div className="flex items-start gap-3 p-3 border border-border-subtle rounded-lg">
          <button onClick={() => set('priceEnabled', !config.priceEnabled)} className={toggleCls(config.priceEnabled)}>
            <span className={dotCls(config.priceEnabled)} />
          </button>
          <div className="flex-1">
            <p className="text-sm font-medium text-fg">Auto-Price Manifests</p>
            <p className="text-xs text-fg-muted">Automatically run UPC pricing after each scrape</p>
            {config.priceEnabled && (
              <p className="text-[10px] text-warning mt-1">Uses eBay API calls - make sure you have an App ID + Cert ID set</p>
            )}
          </div>
        </div>

        {/* Auto eBay sync */}
        <div className="flex items-start gap-3 p-3 border border-border-subtle rounded-lg">
          <button onClick={() => set('ebayEnabled', !config.ebayEnabled)} className={toggleCls(config.ebayEnabled)}>
            <span className={dotCls(config.ebayEnabled)} />
          </button>
          <div className="flex-1">
            <p className="text-sm font-medium text-fg">Auto-Sync eBay Orders</p>
            <p className="text-xs text-fg-muted">Pull sold orders and match to inventory automatically</p>
            {config.ebayEnabled && (
              <div className="space-y-2 mt-2">
                <div className="flex items-center gap-2">
                  <label className="text-xs text-fg-muted">Every</label>
                  <input type="number" min="15" max="480" value={config.ebayInterval}
                    onChange={e => set('ebayInterval', parseInt(e.target.value) || 60)}
                    className="w-16 border border-border rounded px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary/30"
                  />
                  <label className="text-xs text-fg-muted">minutes</label>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-fg-muted">Sync last</label>
                  <input type="number" min="7" max="365" value={config.ebayDaysBack || 90}
                    onChange={e => set('ebayDaysBack', parseInt(e.target.value) || 90)}
                    className="w-16 border border-border rounded px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary/30"
                  />
                  <label className="text-xs text-fg-muted">days of orders</label>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <button
        onClick={save}
        className={`mt-4 flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
          saved ? 'bg-success text-white' : 'bg-primary text-white hover:bg-primary-dark'
        }`}
      >
        <Save className="w-4 h-4" />
        {saved ? 'Saved!' : 'Save'}
      </button>
    </Card>
  );
}

// ─── Account Tier section ─────────────────────────────────────────────────────

function AccountTierSection() {
  const [currentTier, setCurrentTier] = useState(getUserTier());
  const [trial, setTrial] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    checkTrial().then(setTrial).catch(() => {});
  }, []);

  const handleChange = async (tier) => {
    await setUserTier(tier);
    setCurrentTier(tier);
    setSaved(true);
    setTimeout(() => {
      setSaved(false);
      window.location.reload();
    }, 1000);
  };

  const TIER_COLORS = { free: 'border-border-strong', pro: 'border-primary', business: 'border-accent' };
  const TIER_BG = { free: 'bg-muted/40', pro: 'bg-info-subtle', business: 'bg-warning-subtle' };

  return (
    <Card padding="lg">
      <div className="flex items-center gap-2 mb-1">
        <KeyRound className="w-4 h-4 text-fg-muted" />
        <h3 className="text-sm font-semibold text-fg">Account Tier</h3>
      </div>
      <p className="text-xs text-fg-muted mb-4 leading-relaxed">
        Controls which features are visible. For testing the tiered experience — in production this would be tied to a subscription.
      </p>
      {trial?.active && (
        <div className="mb-3 px-3 py-2 bg-warning-subtle border border-warning/30 rounded-lg text-xs text-warning-fg">
          Trial active — {trial.remaining} day{trial.remaining !== 1 ? 's' : ''} remaining
        </div>
      )}
      {saved && (
        <div className="mb-3 px-3 py-2 bg-success-subtle border border-success/30 rounded-lg text-xs text-success font-medium">
          Tier changed! Reloading…
        </div>
      )}
      <div className="grid grid-cols-3 gap-3">
        {Object.entries(TIERS).map(([key, tier]) => (
          <button
            key={key}
            onClick={() => handleChange(key)}
            className={`relative p-4 rounded-xl border-2 text-left transition-all ${
              currentTier === key
                ? `${TIER_COLORS[key]} ${TIER_BG[key]} shadow-sm`
                : 'border-border hover:border-border-strong'
            }`}
          >
            {currentTier === key && (
              <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-success" />
            )}
            <p className="text-sm font-bold text-fg">{tier.name}</p>
            <p className="text-xs text-fg-muted mt-0.5">{tier.label}</p>
            <p className="text-[10px] text-fg-muted mt-2 leading-relaxed">{tier.description}</p>
            <p className="text-[10px] text-fg-muted mt-1">{tier.features.length} features</p>
          </button>
        ))}
      </div>
    </Card>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const SUSPENSE_LG = <div className="h-32 bg-muted rounded-xl animate-pulse" />;
const SUSPENSE_SM = <div className="h-24 bg-muted rounded-xl animate-pulse" />;

// Category tabs. Each holds a logically related cluster of sections — keeps
// the settings page from being one 2000-line scroll. Order is intentional:
// the most-touched categories (Account, Connections) sit at the top.
const CATEGORIES = [
  { id: 'account',     label: 'Account',      icon: User,       blurb: 'Workspace, billing, and audit history.' },
  { id: 'connections', label: 'Connections',  icon: Plug,       blurb: 'API keys and external integrations.' },
  { id: 'pricing',     label: 'Pricing',      icon: DollarSign, blurb: 'Fees, realization rates, and condition haircuts.' },
  { id: 'catalog',     label: 'Catalog',      icon: Tag,        blurb: 'Categories, sources, and marketplaces.' },
  { id: 'automation',  label: 'Automation',   icon: Zap,        blurb: 'Background syncing and saved templates.' },
  { id: 'appearance',  label: 'Appearance',   icon: Palette,    blurb: 'Theme and global default values.' },
  { id: 'security',    label: 'Security',     icon: Lock,       blurb: 'PIN protection and sign-in behavior.' },
  { id: 'data',        label: 'Data',         icon: Database,   blurb: 'Local backups, exports, and diagnostics.' },
];

const CATEGORY_KEY = 'noltech:ui:settings-category';

export default function Settings() {
  const [isDark, toggleDark, themeMode, setThemeMode] = useDarkMode();
  const [activeTab, setActiveTab] = useState('account');
  const templatesRef = useRef(null);

  // Restore the last category the user was on, so jumping around doesn't
  // dump them back at "Account" every time.
  useEffect(() => {
    window.storage.get(CATEGORY_KEY).then((v) => {
      if (typeof v === 'string' && CATEGORIES.some((c) => c.id === v)) setActiveTab(v);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    window.storage.set(CATEGORY_KEY, activeTab).catch(() => {});
  }, [activeTab]);

  // External deep-link: command palette / hubs fire `ui:settings-section`
  // when they want to drop the user on a specific section. We map the
  // section id to its parent category, switch tabs, then scroll the
  // section into view once it's actually mounted.
  useEffect(() => {
    const SECTION_TO_CATEGORY = { templates: 'automation' };
    const h = (e) => {
      const section = e.detail?.section;
      if (!section) return;
      const category = SECTION_TO_CATEGORY[section];
      if (category) setActiveTab(category);
      // Wait a tick for the new tab content to mount before scrolling.
      setTimeout(() => {
        if (section === 'templates' && templatesRef.current) {
          templatesRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
          templatesRef.current.classList.add('ring-2', 'ring-accent/50');
          setTimeout(() => templatesRef.current?.classList.remove('ring-2', 'ring-accent/50'), 1500);
        }
      }, 60);
    };
    window.addEventListener('ui:settings-section', h);
    return () => window.removeEventListener('ui:settings-section', h);
  }, []);

  const activeMeta = CATEGORIES.find((c) => c.id === activeTab) || CATEGORIES[0];

  // Render the section list for the active category. Kept as a switch so
  // unselected tabs don't pay any render cost (especially the lazy-loaded
  // ones — DataBackup, AuditLogViewer, etc).
  const renderSections = () => {
    switch (activeTab) {
      case 'account':
        return (
          <>
            <Suspense fallback={SUSPENSE_LG}><WorkspaceSettings /></Suspense>
            <AccountTierSection />
            <Suspense fallback={SUSPENSE_LG}><AuditLogViewer /></Suspense>
          </>
        );
      case 'connections':
        return (
          <>
            <ApiKeySection />
            <GeminiKeySection />
            <PhoneAlertSection />
            <LocalPipelineSection />
            <EbaySection />
            <EbayPoliciesSection />
            <SoldCompsSection />
          </>
        );
      case 'pricing':
        return (
          <>
            <FeeRateSection />
            <RealizationRateSection />
            <ActiveAskBufferSection />
            <EbayConditionHaircutSection />
            <AuctionFeeSection />
            <ConditionMultiplierSection />
          </>
        );
      case 'catalog':
        return (
          <>
            <CategoryManager />
            <SourceManager />
            <BStockMarketplaceSection />
          </>
        );
      case 'automation':
        return (
          <>
            <AutoSyncSection />
            <div ref={templatesRef} id="templates" className="rounded-xl transition-shadow">
              <Suspense fallback={SUSPENSE_LG}><MessageTemplates /></Suspense>
            </div>
          </>
        );
      case 'appearance':
        return (
          <>
            <DarkModeSection isDark={isDark} toggleDark={toggleDark} mode={themeMode} setMode={setThemeMode} />
            <DefaultsSection />
          </>
        );
      case 'security':
        return <PinSection />;
      case 'data':
        return (
          <>
            <Suspense fallback={SUSPENSE_LG}><DataBackup /></Suspense>
            <Suspense fallback={SUSPENSE_SM}><ErrorLogPanel /></Suspense>
            <Suspense fallback={SUSPENSE_SM}><DiagnosticExport /></Suspense>
          </>
        );
      default:
        return null;
    }
  };

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto">
      <ModuleHeader
        title="Settings"
        description="Configure your workspace, integrations, and preferences. All data is stored locally on this device."
        eyebrow="WORKSPACE"
        className="mb-5"
      />

      {/* Mobile: horizontal scrollable category bar */}
      <div className="md:hidden -mx-4 px-4 mb-4 overflow-x-auto">
        <div className="flex gap-1.5 min-w-max">
          {CATEGORIES.map(({ id, label, icon: Icon }) => {
            const active = activeTab === id;
            return (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={cn(
                  'inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap',
                  active
                    ? 'bg-primary text-white shadow-sm'
                    : 'bg-surface border border-border text-fg-muted hover:text-fg hover:bg-muted',
                )}
              >
                <Icon className="size-4" />
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex gap-6">
        {/* Desktop: left rail */}
        <nav className="hidden md:block w-56 shrink-0">
          <div className="sticky top-6 space-y-1">
            {CATEGORIES.map(({ id, label, icon: Icon }) => {
              const active = activeTab === id;
              return (
                <button
                  key={id}
                  onClick={() => setActiveTab(id)}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors text-left',
                    active
                      ? 'bg-primary text-white shadow-sm'
                      : 'text-fg-muted hover:text-fg hover:bg-muted',
                  )}
                >
                  <Icon className={cn('size-4 shrink-0', active ? 'text-white' : 'text-fg-subtle')} />
                  <span className="flex-1">{label}</span>
                </button>
              );
            })}
          </div>
        </nav>

        {/* Right pane */}
        <div className="flex-1 min-w-0 space-y-5">
          {/* Section header — orients the user on which category they're in */}
          <div className="border-b border-border-subtle pb-3">
            <div className="flex items-center gap-2.5">
              <activeMeta.icon className="size-5 text-accent" />
              <h2 className="text-lg font-semibold text-fg">{activeMeta.label}</h2>
            </div>
            <p className="text-xs text-fg-muted mt-1">{activeMeta.blurb}</p>
          </div>

          {renderSections()}
        </div>
      </div>
    </div>
  );
}
