import React, { useState } from 'react';
import { useApp } from '../context/AppContext.jsx';
import './LoginPage.css';

export default function LoginPage() {
  const { doLogin, loading, error } = useApp();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    try { await doLogin(username, password); }
    catch {}
  }

  return (
    <div className="login-root">
      <div className="login-bg">
        <div className="login-grid" aria-hidden="true">
          {Array.from({ length: 80 }).map((_, i) => <div key={i} className="login-grid-cell" />)}
        </div>
      </div>

      <div className="login-card">
        <div className="login-brand">
          <div className="login-brand-icon">⊞</div>
          <span className="login-brand-name">SchedulerSWE</span>
        </div>

        <h1 className="login-title">Sign in</h1>
        <p className="login-sub">Course Schedule Conflict Visualization System</p>

        <form className="login-form" onSubmit={handleSubmit}>
          <div className="login-field">
            <label>Username</label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="scheduler1"
              autoComplete="username"
              required
            />
          </div>
          <div className="login-field">
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              required
            />
          </div>

          {error && <div className="login-error">{error}</div>}

          <button type="submit" className="login-btn" disabled={loading}>
            {loading ? <span className="login-spinner" /> : 'Sign in →'}
          </button>
        </form>

        <p className="login-hint">Default: <code>scheduler1</code> / <code>password123</code></p>
      </div>
    </div>
  );
}
