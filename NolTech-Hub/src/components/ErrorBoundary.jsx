import { Component } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('[ErrorBoundary] Caught error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center min-h-screen bg-bg">
          <div className="bg-surface border border-danger/30 rounded-xl p-8 max-w-md text-center shadow-sm">
            <AlertTriangle className="w-10 h-10 text-danger mx-auto mb-3" />
            <h2 className="text-lg font-semibold text-fg mb-2">Something went wrong</h2>
            <p className="text-fg-muted text-sm mb-1">
              {this.state.error?.message || 'An unexpected error occurred'}
            </p>
            <p className="text-fg-muted text-xs mb-4">
              Try reloading the page. If the problem persists, check Settings → Data Backup.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="flex items-center gap-2 mx-auto px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-dark transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              Reload App
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
