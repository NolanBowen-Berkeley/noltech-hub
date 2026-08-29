// ─── ModuleErrorBoundary ────────────────────────────────────────────────────
// Inline error boundary for individual hub modules. When a module crashes,
// only THAT module shows the error pane — the sidebar, header, and other
// modules stay usable. The top-level ErrorBoundary in App.jsx is the
// last-resort full-screen fallback for crashes outside any module.
//
// Each module render in App.jsx Shell should wrap its component:
//   <ModuleErrorBoundary moduleName="Bookkeeping">
//     <Bookkeeping />
//   </ModuleErrorBoundary>
//
// Crashes are logged to console + optionally to a local error log key so
// they survive reloads (useful when debugging a hard-to-reproduce crash).

import { Component } from 'react';
import { AlertTriangle, RefreshCw, Home, Copy } from 'lucide-react';

const ERROR_LOG_KEY = 'noltech:errors:recent';
const MAX_LOG_ENTRIES = 25;

async function appendErrorLog(entry) {
  try {
    const log = (await window.storage.get(ERROR_LOG_KEY)) || [];
    log.unshift(entry);
    if (log.length > MAX_LOG_ENTRIES) log.length = MAX_LOG_ENTRIES;
    await window.storage.set(ERROR_LOG_KEY, log);
  } catch (e) {
    // If even error logging fails, last resort is console
    console.error('[ModuleErrorBoundary] failed to persist error:', e);
  }
}

export default class ModuleErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    const moduleName = this.props.moduleName || 'unknown-module';
    console.error(`[ModuleErrorBoundary:${moduleName}]`, error, info);
    this.setState({ info });
    appendErrorLog({
      module: moduleName,
      message: error?.message || String(error),
      stack:   error?.stack?.slice(0, 4000) || null,
      componentStack: info?.componentStack?.slice(0, 2000) || null,
      at:      new Date().toISOString(),
    });
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, info: null });
  };

  handleCopyDiagnostics = async () => {
    const moduleName = this.props.moduleName || 'unknown';
    const text = [
      `Module: ${moduleName}`,
      `Time:   ${new Date().toISOString()}`,
      `Error:  ${this.state.error?.message || this.state.error}`,
      '',
      'Stack:',
      this.state.error?.stack || '(no stack)',
      '',
      'Component stack:',
      this.state.info?.componentStack || '(no component stack)',
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard might fail (no permission) — fall back to selecting in textarea
      console.log(text);
    }
  };

  render() {
    if (this.state.hasError) {
      const moduleName = this.props.moduleName || 'this module';
      return (
        <div className="p-6 max-w-2xl mx-auto">
          <div className="bg-danger-subtle border border-danger/30 rounded-xl p-5">
            <div className="flex items-start gap-3 mb-4">
              <AlertTriangle className="w-5 h-5 text-danger shrink-0 mt-0.5" />
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-fg">
                  {moduleName} crashed
                </h3>
                <p className="text-xs text-fg-muted mt-1">
                  This module hit an error. The rest of the app is still usable — use the sidebar to switch to another section.
                </p>
              </div>
            </div>

            <div className="bg-surface rounded-lg p-3 mb-4 font-mono text-xs text-fg-muted max-h-32 overflow-y-auto">
              {this.state.error?.message || String(this.state.error)}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={this.handleReset}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-white text-xs font-medium hover:bg-primary-dark"
              >
                <RefreshCw size={12} /> Try again
              </button>
              <button
                onClick={() => window.location.reload()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-fg-muted hover:bg-muted text-xs font-medium"
              >
                <Home size={12} /> Reload app
              </button>
              <button
                onClick={this.handleCopyDiagnostics}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-fg-muted hover:bg-muted text-xs font-medium"
              >
                <Copy size={12} /> Copy diagnostics
              </button>
            </div>

            <p className="text-[11px] text-fg-subtle mt-3">
              Recent errors are saved to <code className="font-mono">noltech:errors:recent</code> for debugging.
              View them via Settings → Data → Diagnostic Export.
            </p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
