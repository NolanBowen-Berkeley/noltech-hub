// ─── NolTech Hub — Electron Main Process ──────────────────────────────────────

const { app, BrowserWindow, shell, nativeImage, session } = require('electron');
const path = require('path');
const { startPipeline, stopPipeline } = require('./pipeline.cjs');

const isDev = process.env.NODE_ENV === 'development';

// Where the local pipeline listens. Must match PIPELINE_BASE in
// src/utils/constants.js — the renderer talks to it over plain HTTP, so the
// CSP below has to allow this exact origin.
const PIPELINE_PORT = Number(process.env.PIPELINE_PORT) || 3001;
const PIPELINE_ORIGIN = `http://localhost:${PIPELINE_PORT}`;
const PIPELINE_ORIGIN_IP = `http://127.0.0.1:${PIPELINE_PORT}`;

let mainWindow = null;

// ── Backend ───────────────────────────────────────────────────────────────────
// The noltech-pipeline Node service runs locally and owns all scraping,
// manifest enrichment, sold-comps pricing, the image proxy, and the background
// discovery/analysis/refresh/alerts crons. It is started as a child process
// below (see electron/pipeline.cjs) and stopped on quit.

// ── Main window ───────────────────────────────────────────────────────────────

function createWindow() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.ico'));
  mainWindow = new BrowserWindow({
    width:     1400,
    height:    900,
    minWidth:   900,
    minHeight:  600,
    title: 'NolTech Hub',
    icon,
    backgroundColor: '#1A5276',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Open external links in system browser — only allow http/https protocols
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        shell.openExternal(url);
      }
    } catch {}
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Security headers
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        // The production policy must allow the local pipeline origin in BOTH
        // connect-src (API calls) and img-src (the /lots/image proxy,
        // which loads through <img src>). Omitting either silently breaks
        // scraping in packaged builds while dev keeps working, because the dev
        // policy is permissive.
        'Content-Security-Policy': [
          isDev
            ? `default-src 'self' 'unsafe-inline' 'unsafe-eval'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https: ${PIPELINE_ORIGIN} ${PIPELINE_ORIGIN_IP}; connect-src 'self' https: wss: ${PIPELINE_ORIGIN} ${PIPELINE_ORIGIN_IP}`
            : `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https: ${PIPELINE_ORIGIN} ${PIPELINE_ORIGIN_IP}; connect-src 'self' ${PIPELINE_ORIGIN} ${PIPELINE_ORIGIN_IP} https://api.anthropic.com https://generativelanguage.googleapis.com https://api.ebay.com https://svcs.ebay.com https://*.supabase.co wss://*.supabase.co https://ntfy.sh https://discord.com https://discordapp.com`
        ],
      },
    });
  });

  // Start the pipeline alongside the window. Not awaited — the UI shouldn't
  // block on it, and every pipeline call already handles an unreachable
  // backend (SystemHealthCard surfaces it as "Not running").
  startPipeline(app.getAppPath()).catch((e) => {
    console.error('[pipeline] start failed:', e?.message);
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Stop the child on quit. 'will-quit' rather than 'window-all-closed' so the
// pipeline survives closing the last window on macOS, where the app stays
// resident and a window can be reopened from the dock.
app.on('will-quit', stopPipeline);
// Covers hard-exit paths that skip the normal quit sequence.
process.on('exit', stopPipeline);
