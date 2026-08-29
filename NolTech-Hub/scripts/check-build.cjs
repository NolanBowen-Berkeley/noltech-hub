// ─── Post-build health check ─────────────────────────────────────────────────
// Runs after `vite build` to surface common regressions before they ship:
//   1. Bundle size — flags if main chunk grows >10% from previous build
//   2. Hardcoded localhost:3001 outside constants.js (use SCRAPER_BASE)
//   3. Silent catch handlers (catch(() => {}) / catch{}) that hide bugs
//   4. Missing BACKUP_KEYS — every new storage key should be backed up
//   5. localStorage/sessionStorage usage (forbidden per CLAUDE.md)
//
// Exit code 0 = pass, 1 = at least one critical finding. Soft warnings
// print but don't fail the script (useful for CI-style checks).

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC  = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const BUDGET_FILE = path.join(__dirname, '.build-budget.json');

let warnings = 0;
let failures = 0;

const out = {
  warn: (msg) => { console.log(`  ⚠ ${msg}`); warnings++; },
  fail: (msg) => { console.log(`  ✗ ${msg}`); failures++; },
  ok:   (msg) => { console.log(`  ✓ ${msg}`); },
  section: (title) => { console.log(`\n${title}`); console.log('─'.repeat(title.length)); },
};

// ─── 1. Bundle size guardrail ───────────────────────────────────────────────
out.section('Bundle size');

function bundleSize() {
  const assets = path.join(DIST, 'assets');
  if (!fs.existsSync(assets)) {
    out.warn('dist/assets not found — did you run `vite build`?');
    return null;
  }
  const files = fs.readdirSync(assets).filter((f) => f.startsWith('index-') && f.endsWith('.js'));
  if (!files.length) return null;
  const totalBytes = files.reduce((s, f) => s + fs.statSync(path.join(assets, f)).size, 0);
  return { files: files.length, totalKb: Math.round(totalBytes / 1024) };
}

const current = bundleSize();
if (!current) {
  out.warn('Skipped bundle-size check');
} else {
  out.ok(`Main bundle: ${current.totalKb} KB across ${current.files} chunk(s)`);

  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8')); } catch {}

  if (prev?.totalKb) {
    const delta = current.totalKb - prev.totalKb;
    const deltaPct = (delta / prev.totalKb) * 100;
    if (delta > 0 && deltaPct > 10) {
      out.warn(`Bundle grew by ${delta} KB (${deltaPct.toFixed(1)}%) since last build`);
    } else if (delta < 0) {
      out.ok(`Bundle shrank by ${Math.abs(delta)} KB vs last build`);
    } else {
      out.ok(`Bundle within 10% of last build (delta ${delta >= 0 ? '+' : ''}${delta} KB)`);
    }
  } else {
    out.ok('First build — saving baseline');
  }

  try { fs.writeFileSync(BUDGET_FILE, JSON.stringify(current, null, 2)); } catch {}
}

// ─── Helpers for source-file scanning ───────────────────────────────────────

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(js|jsx|cjs|mjs)$/.test(entry.name)) yield full;
  }
}

// ─── 2. Hardcoded localhost:3001 outside constants.js ───────────────────────
out.section('Hardcoded scraper URL');

const localhostHits = [];
for (const file of walk(SRC)) {
  if (file.endsWith('constants.js')) continue;
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  lines.forEach((line, i) => {
    if (/localhost:3001/.test(line) && !line.trim().startsWith('//')) {
      localhostHits.push({ file: path.relative(ROOT, file), line: i + 1, text: line.trim().slice(0, 100) });
    }
  });
}
if (localhostHits.length === 0) {
  out.ok('No hardcoded localhost:3001 — all callers use SCRAPER_BASE');
} else {
  localhostHits.slice(0, 10).forEach((hit) => out.fail(`${hit.file}:${hit.line} — ${hit.text}`));
  if (localhostHits.length > 10) out.fail(`...and ${localhostHits.length - 10} more`);
}

// ─── 3. Silent catch handlers ───────────────────────────────────────────────
out.section('Silent catch handlers');

const silentCatches = [];
for (const file of walk(SRC)) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  lines.forEach((line, i) => {
    // catch(() => {}), catch{}, catch(e){} (no body)
    if (/catch\s*\([^)]*\)\s*=>\s*\{\s*\}|catch\s*\{\s*\}|catch\s*\([^)]*\)\s*\{\s*\}/.test(line)) {
      silentCatches.push({ file: path.relative(ROOT, file), line: i + 1, text: line.trim().slice(0, 100) });
    }
  });
}
if (silentCatches.length === 0) {
  out.ok('No silent catch handlers found');
} else {
  silentCatches.slice(0, 15).forEach((hit) => out.warn(`${hit.file}:${hit.line} — ${hit.text}`));
  if (silentCatches.length > 15) out.warn(`...and ${silentCatches.length - 15} more`);
  out.warn(`${silentCatches.length} silent catch handler(s) — these hide bugs. Replace with console.error or user-visible error.`);
}

// ─── 4. localStorage / sessionStorage usage (forbidden) ─────────────────────
out.section('Forbidden storage APIs');

const forbiddenStorage = [];
for (const file of walk(SRC)) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  lines.forEach((line, i) => {
    // Match localStorage.* or sessionStorage.* but skip comments
    if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;
    if (/\b(localStorage|sessionStorage)\./.test(line)) {
      forbiddenStorage.push({ file: path.relative(ROOT, file), line: i + 1, text: line.trim().slice(0, 100) });
    }
  });
}
if (forbiddenStorage.length === 0) {
  out.ok('No localStorage / sessionStorage usage — all storage goes through window.storage');
} else {
  forbiddenStorage.forEach((hit) => out.fail(`${hit.file}:${hit.line} — ${hit.text}`));
  out.fail('CLAUDE.md forbids localStorage/sessionStorage. Use window.storage instead.');
}

// ─── 5. BACKUP_KEYS coverage ────────────────────────────────────────────────
out.section('Backup coverage');

try {
  const backupKeysPath = path.join(SRC, 'utils', 'backupKeys.js');
  const backupKeysContent = fs.readFileSync(backupKeysPath, 'utf8');
  const declared = new Set();
  for (const m of backupKeysContent.matchAll(/['"](noltech:[^'"]+)['"]/g)) declared.add(m[1]);

  // Find every storage.set() / storage.get() string literal in src/
  const usedKeys = new Set();
  for (const file of walk(SRC)) {
    if (file.endsWith('backupKeys.js')) continue;
    const content = fs.readFileSync(file, 'utf8');
    for (const m of content.matchAll(/window\.storage\.(?:get|set|delete)\s*\(\s*['"](noltech:[^'"]+)['"]/g)) {
      usedKeys.add(m[1]);
    }
  }

  const missing = [...usedKeys].filter((k) => !declared.has(k));
  if (missing.length === 0) {
    out.ok(`All ${usedKeys.size} storage keys in use are declared in BACKUP_KEYS`);
  } else {
    missing.slice(0, 20).forEach((k) => out.warn(`Storage key not in BACKUP_KEYS: ${k}`));
    if (missing.length > 20) out.warn(`...and ${missing.length - 20} more`);
    out.warn('Add these to src/utils/backupKeys.js BACKUP_KEYS so daily snapshots include them.');
  }
} catch (e) {
  out.warn(`Backup coverage check failed: ${e.message}`);
}

// ─── Summary ────────────────────────────────────────────────────────────────
console.log('');
console.log('─'.repeat(50));
if (failures === 0 && warnings === 0) {
  console.log('Build health: ✓ All checks passed');
  process.exit(0);
} else if (failures === 0) {
  console.log(`Build health: ✓ Pass (${warnings} warning${warnings !== 1 ? 's' : ''})`);
  process.exit(0);
} else {
  console.log(`Build health: ✗ ${failures} failure${failures !== 1 ? 's' : ''}, ${warnings} warning${warnings !== 1 ? 's' : ''}`);
  process.exit(1);
}
