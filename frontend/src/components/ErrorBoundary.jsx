import React from 'react';

/**
 * NEW-FU-34: top-level React error boundary.
 *
 * Without this, any descendant component throwing during render (e.g. an
 * unexpected null in `state.sections[i].day`) unmounts the entire tree
 * and the user sees a blank white page with no recovery path. This
 * boundary catches the throw, logs it, and renders a minimal recovery
 * surface with a "Refresh" button.
 *
 * Must be a class component — React 18 still has no hook-based error
 * boundary equivalent. `getDerivedStateFromError` is sync (no side
 * effects); `componentDidCatch` is where we put the log.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    // Sync state update only; no logging or side effects here, otherwise
    // React would complain about "Cannot update during render".
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    // Log so dev tools / production error trackers can see the stack.
    // Caller doesn't see this; the UI below is what the user sees.
    console.error('[ErrorBoundary] caught render error:', error, info?.componentStack);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      const msg = this.state.error?.message || 'An unexpected error occurred.';
      return (
        <div role="alert" style={{
          minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'system-ui, -apple-system, sans-serif', padding: '24px',
          background: '#fef2f2', color: '#7f1d1d',
        }}>
          <div style={{
            maxWidth: 480, width: '100%', background: '#fff',
            border: '1px solid #fecaca', borderRadius: 12,
            padding: '28px 32px', boxShadow: '0 4px 24px rgba(127,29,29,.12)',
          }}>
            <h1 style={{ fontSize: '1.25rem', margin: '0 0 8px', color: '#991b1b' }}>
              Something went wrong
            </h1>
            <p style={{ fontSize: '.92rem', lineHeight: 1.55, color: '#475569', margin: '0 0 16px' }}>
              The app hit an unexpected error and can't continue. Refresh to try again.
              If the problem persists, contact support with the message below.
            </p>
            <code style={{
              display: 'block', background: '#f1f5f9', color: '#1e293b',
              padding: '10px 12px', borderRadius: 6, fontSize: '.78rem',
              wordBreak: 'break-word', margin: '0 0 18px',
            }}>{msg}</code>
            <button
              onClick={this.handleReload}
              style={{
                background: '#dc2626', color: '#fff', border: 'none',
                padding: '10px 18px', borderRadius: 6, fontSize: '.9rem',
                fontWeight: 600, cursor: 'pointer',
              }}
            >
              Refresh page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
