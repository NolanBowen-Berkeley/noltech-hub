// ─── Local pipeline supervisor ───────────────────────────────────────────────
// Starts and babysits the noltech-pipeline Node service that serves the lot
// routes and runs the background crons. See noltech-pipeline/README.md.
//
// Behavior:
//   - Probes /health first. If something already answers on the port, we
//     ATTACH rather than spawn — that's the case when the pipeline is already
//     running as a systemd/Task Scheduler service, or a second Hub window is
//     open. Two processes on one data dir would fight over the cache files.
//   - Otherwise spawns the service as a child process and restarts it with
//     exponential backoff if it exits unexpectedly.
//   - Stops it on app quit.
//
// Node binary: we spawn Electron's own executable with ELECTRON_RUN_AS_NODE=1,
// which makes it behave as a plain Node runtime. That way a packaged Hub
// doesn't require a separate Node install on the machine.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const DEFAULT_PORT = 3001;

let child = null;
let stopping = false;
let restartCount = 0;
let restartTimer = null;
let attachedToExisting = false;

const log = (...args) => console.log('[pipeline]', ...args);

// ─── Locating the service ────────────────────────────────────────────────────

// Checked in order. PIPELINE_DIR wins so an unusual layout can be pointed at
// without editing this file.
function candidateDirs(appPath) {
  const dirs = [];
  if (process.env.PIPELINE_DIR) dirs.push(process.env.PIPELINE_DIR);
  // Dev + repo layout: personal application/{NolTech-Hub,noltech-pipeline}
  dirs.push(path.join(appPath, '..', 'noltech-pipeline'));
  dirs.push(path.join(appPath, '..', '..', 'noltech-pipeline'));
  // Packaged: bundled under resources/
  if (process.resourcesPath) {
    dirs.push(path.join(process.resourcesPath, 'noltech-pipeline'));
    dirs.push(path.join(process.resourcesPath, 'app', 'noltech-pipeline'));
  }
  return dirs;
}

function resolvePipelineDir(appPath) {
  for (const dir of candidateDirs(appPath)) {
    try {
      if (fs.existsSync(path.join(dir, 'src', 'server.js'))) return path.resolve(dir);
    } catch { /* unreadable candidate — keep looking */ }
  }
  return null;
}

// ─── Health probe ────────────────────────────────────────────────────────────

async function probeHealth(port, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json().catch(() => ({}));
  } catch {
    return null;
  }
}

// ─── Spawn ───────────────────────────────────────────────────────────────────

function spawnChild(dir, port) {
  const serverJs = path.join(dir, 'src', 'server.js');

  child = spawn(process.execPath, [serverJs], {
    cwd: dir,
    env: {
      ...process.env,
      // Makes the Electron binary run as plain Node.
      ELECTRON_RUN_AS_NODE: '1',
      PIPELINE_PORT: String(port),
      // Closing stdin is our graceful-stop signal on Windows, which has no
      // real SIGTERM for child processes.
      PIPELINE_EXIT_ON_STDIN_CLOSE: '1',
    },
    // stdin piped so we can close it to request shutdown; stdout/stderr piped
    // so pipeline logs land in the Hub's console instead of vanishing.
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (b) => process.stdout.write(`[pipeline] ${b}`));
  child.stderr.on('data', (b) => process.stderr.write(`[pipeline] ${b}`));

  child.on('exit', (code, signal) => {
    const wasRunning = child;
    child = null;
    if (stopping || !wasRunning) return;

    log(`exited (code=${code}, signal=${signal})`);

    // Exponential backoff capped at 30s, and give up after 5 tries so a
    // permanently broken install doesn't spin forever writing logs.
    restartCount += 1;
    if (restartCount > 5) {
      log('too many restarts — giving up. Start it manually: npm start in noltech-pipeline/');
      return;
    }
    const delay = Math.min(30000, 1000 * 2 ** (restartCount - 1));
    log(`restarting in ${delay}ms (attempt ${restartCount}/5)`);
    restartTimer = setTimeout(() => spawnChild(dir, port), delay);
    restartTimer.unref?.();
  });

  child.on('error', (e) => {
    log('spawn error:', e?.message);
  });

  log(`started (pid ${child.pid}) on port ${port} from ${dir}`);
}

// ─── Public API ──────────────────────────────────────────────────────────────

async function startPipeline(appPath) {
  const port = Number(process.env.PIPELINE_PORT) || DEFAULT_PORT;

  // Someone already serving this port? Attach instead of fighting over it.
  const existing = await probeHealth(port);
  if (existing) {
    attachedToExisting = true;
    log(`already running on port ${port} (pid ${existing.pid ?? 'unknown'}) — attaching`);
    return { started: false, attached: true, port };
  }

  const dir = resolvePipelineDir(appPath);
  if (!dir) {
    log('service not found — scraping will be unavailable.');
    log('Looked in:', candidateDirs(appPath).join(', '));
    return { started: false, attached: false, port, error: 'not_found' };
  }

  if (!fs.existsSync(path.join(dir, 'node_modules'))) {
    log(`dependencies missing — run "npm install" in ${dir}`);
    return { started: false, attached: false, port, error: 'no_node_modules' };
  }

  restartCount = 0;
  spawnChild(dir, port);
  return { started: true, attached: false, port, dir };
}

function stopPipeline() {
  stopping = true;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (!child || attachedToExisting) return;

  const proc = child;
  log('stopping…');
  try {
    // Graceful first: closing stdin triggers the service's shutdown path,
    // which drains in-flight cache writes before exiting.
    proc.stdin?.end();
    proc.kill('SIGTERM');
  } catch { /* already gone */ }

  // Hard kill anything still alive after the drain window.
  const t = setTimeout(() => {
    try { if (!proc.killed) proc.kill('SIGKILL'); } catch { /* already gone */ }
  }, 4000);
  t.unref?.();
}

module.exports = { startPipeline, stopPipeline };
