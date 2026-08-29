import { useState, useEffect, useRef } from 'react';
import { Lock, Eye, EyeOff, ShieldCheck, AlertCircle } from 'lucide-react';
import { PIN_KEY } from '../utils/constants';

// ─── Hash helper (PBKDF2 with random salt) ──────────────────────────────────

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

// Constant-time string comparison. `===` short-circuits on the first mismatched
// byte, which leaks timing info — irrelevant for a 4-digit PIN in practice
// (10k entries, locked out at 3 attempts), but cheap to fix correctly.
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ─── Numeric keypad ───────────────────────────────────────────────────────────

function Keypad({ onDigit, onDelete }) {
  const keys = ['1','2','3','4','5','6','7','8','9','','0','⌫'];
  return (
    <div className="grid grid-cols-3 gap-2 mt-4">
      {keys.map((k, i) => (
        <button
          key={i}
          onClick={() => k === '⌫' ? onDelete() : k ? onDigit(k) : null}
          disabled={!k}
          className={`h-14 rounded-xl text-lg font-semibold transition-all select-none
            ${k === '⌫'
              ? 'bg-muted text-fg-muted hover:bg-subtle active:scale-95'
              : k
                ? 'bg-surface border border-border text-fg hover:bg-muted hover:border-border-strong active:scale-95 shadow-glow-sm'
                : 'invisible'
            }`}
        >
          {k}
        </button>
      ))}
    </div>
  );
}

// ─── PIN dots ─────────────────────────────────────────────────────────────────

function PinDots({ value, maxLen, error }) {
  return (
    <div className="flex items-center justify-center gap-2.5 my-4">
      {Array.from({ length: maxLen }).map((_, i) => (
        <div
          key={i}
          className={`w-3 h-3 rounded-full border-2 transition-all ${
            i < value.length
              ? error
                ? 'bg-danger border-danger'
                : 'bg-fg border-fg'
              : 'border-border-strong'
          }`}
        />
      ))}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function PinLock({ onUnlock }) {
  const [storedHash, setStoredHash]   = useState(null);
  const [isFirstRun, setIsFirstRun]   = useState(false);
  const [pin, setPin]                 = useState('');
  const [confirmPin, setConfirmPin]   = useState('');
  const [stage, setStage]             = useState('enter'); // 'enter' | 'confirm'
  const [error, setError]             = useState('');
  const [lockout, setLockout]         = useState(0);  // seconds remaining
  const [attempts, setAttempts]       = useState(0);
  const [loading, setLoading]         = useState(true);
  const lockoutRef = useRef(null);

  const PIN_LEN = 4;

  // ── Load stored PIN hash ──────────────────────────────────────────────────
  useEffect(() => {
    window.storage.get(PIN_KEY).then(async (hash) => {
      if (hash && typeof hash === 'object' && hash.hash && hash.salt) {
        // New format — use as-is
        setStoredHash(hash);
      } else if (hash) {
        // Old format (pre-PBKDF2) — incompatible, clear and ask user to set new PIN
        console.warn('[PinLock] Old PIN format detected — resetting. Please set a new PIN.');
        await window.storage.delete(PIN_KEY);
        setIsFirstRun(true);
      } else {
        setIsFirstRun(true);
      }
      setLoading(false);
    }).catch(() => {
      setIsFirstRun(true);
      setLoading(false);
    });
  }, []);

  // ── Lockout countdown ─────────────────────────────────────────────────────
  useEffect(() => {
    if (lockout <= 0) return;
    lockoutRef.current = setInterval(() => {
      setLockout((l) => {
        if (l <= 1) { clearInterval(lockoutRef.current); return 0; }
        return l - 1;
      });
    }, 1000);
    return () => clearInterval(lockoutRef.current);
  }, [lockout]);

  // ── Auto-submit when PIN_LEN digits entered ───────────────────────────────
  useEffect(() => {
    if (pin.length < PIN_LEN) return;

    if (isFirstRun) {
      if (stage === 'enter') {
        setStage('confirm');
        setConfirmPin('');
        return;
      }
      if (stage === 'confirm') {
        if (pin === confirmPin) {
          handleSetPin();
        } else {
          setError('PINs do not match. Try again.');
          setPin('');
          setConfirmPin('');
          setStage('enter');
        }
      }
    } else {
      handleCheckPin();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);

  useEffect(() => {
    if (stage === 'confirm' && confirmPin.length === PIN_LEN) {
      if (pin === confirmPin) {
        handleSetPin();
      } else {
        setError('PINs do not match. Try again.');
        setPin('');
        setConfirmPin('');
        setStage('enter');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmPin]);

  const handleSetPin = async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const saltB64 = btoa(String.fromCharCode(...salt));
    const hash = await hashPin(pin, salt);
    await window.storage.set(PIN_KEY, { hash, salt: saltB64 });
    onUnlock();
  };

  const handleCheckPin = async () => {
    if (lockout > 0) return;
    // Handle new format (object with hash + salt) and old format (plain hash string)
    const salt = storedHash?.salt ? Uint8Array.from(atob(storedHash.salt), c => c.charCodeAt(0)) : null;
    const hash = await hashPin(pin, salt);
    const expectedHash = storedHash?.hash || storedHash;
    if (constantTimeEqual(hash, expectedHash)) {
      onUnlock();
    } else {
      const newAttempts = attempts + 1;
      setAttempts(newAttempts);
      if (newAttempts >= 3) {
        setLockout(30);
        setAttempts(0);
        setError('Too many attempts. Locked for 30 seconds.');
      } else {
        setError(`Incorrect PIN. ${3 - newAttempts} attempt${3 - newAttempts !== 1 ? 's' : ''} remaining.`);
      }
      setPin('');
    }
  };

  const addDigit = (d) => {
    setError('');
    if (isFirstRun && stage === 'confirm') {
      if (confirmPin.length < PIN_LEN) setConfirmPin((p) => p + d);
    } else {
      if (pin.length < PIN_LEN) setPin((p) => p + d);
    }
  };

  const deleteDigit = () => {
    setError('');
    if (isFirstRun && stage === 'confirm') {
      setConfirmPin((p) => p.slice(0, -1));
    } else {
      setPin((p) => p.slice(0, -1));
    }
  };

  const currentPin = isFirstRun && stage === 'confirm' ? confirmPin : pin;

  if (loading) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="relative min-h-screen bg-bg flex items-center justify-center p-4 overflow-hidden">
      <div className="hero-mesh" />
      <div className="relative z-10 bg-surface rounded-2xl shadow-glow-lg border border-border w-full max-w-xs p-8">
        {/* Logo / icon */}
        <div className="text-center mb-6">
          <div className="relative w-16 h-16 mx-auto mb-4">
            <div className="absolute inset-0 rounded-2xl bg-brand-gradient shadow-accent-glow" />
            <div className="absolute inset-[2px] rounded-[14px] bg-fg flex items-center justify-center">
              {isFirstRun ? (
                <ShieldCheck className="w-7 h-7 text-bg" />
              ) : (
                <Lock className="w-7 h-7 text-bg" />
              )}
            </div>
          </div>
          <p className="ui-eyebrow">{isFirstRun ? (stage === 'confirm' ? 'CONFIRM' : 'SET PIN') : 'LOCKED'}</p>
          <h1 className="h-section text-fg tracking-heading">
            NolTech <span className="gradient-text">Hub</span>
          </h1>
          <p className="text-sm text-fg-muted mt-1">
            {isFirstRun
              ? stage === 'enter'
                ? 'Set a PIN to secure your Hub'
                : 'Confirm your PIN'
              : 'Enter your PIN'}
          </p>
        </div>

        {/* PIN dots */}
        <PinDots value={currentPin} maxLen={PIN_LEN} error={!!error} />

        {/* Error / lockout */}
        {error && (
          <div className="flex items-center gap-1.5 text-xs text-danger text-center justify-center mb-2">
            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
            {error}
          </div>
        )}
        {lockout > 0 && (
          <p className="text-xs text-fg-muted text-center mb-2">
            Retry in {lockout}s…
          </p>
        )}

        {/* Keypad */}
        <Keypad onDigit={addDigit} onDelete={deleteDigit} />

        {/* First run note */}
        {isFirstRun && stage === 'enter' && (
          <p className="text-xs text-fg-subtle text-center mt-4">
            This PIN will be required each time you open the Hub.
          </p>
        )}
      </div>
    </div>
  );
}
