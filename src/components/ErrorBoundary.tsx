import React from 'react';
import { RefreshCw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: string | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(err: Error): ErrorBoundaryState {
    return { error: err.message || String(err) };
  }

  componentDidCatch(err: Error) {
    console.error('Folio render error:', err);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="w-screen h-screen flex items-center justify-center p-6 theme-bg">
          <div className="glass-panel max-w-md w-full p-6 text-center animate-modal-in">
            <h1 className="text-sm font-bold theme-text">Folio hit a problem</h1>
            <p className="text-xs theme-muted mt-2 leading-relaxed">
              Something unexpected happened. Your notes are stored as plain text files next to
              the app — reloading will not lose them.
            </p>
            <p className="text-[11px] theme-danger mt-2 font-mono break-all">{this.state.error}</p>
            <button
              onClick={() => window.location.reload()}
              className="mt-4 px-4 py-2 rounded-xl btn-accent text-xs font-semibold inline-flex items-center gap-2"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
