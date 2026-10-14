import { useState } from 'react';
import { api } from '../api/client';

/**
 * Login — the only entry point (no public registration; first admin is
 * created by `npm run setup:admin`, 施工 MD §13.2).
 */
export function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    if (busy) return; // double-submit guard
    setBusy(true);
    setError(null);
    try {
      const res = await api.post('/api/auth/login', { username, password });
      onLogin(res.user);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="card login-card" onSubmit={handleSubmit}>
        <h1>Water Army</h1>
        <p className="muted">Sign in to continue. There is no public registration.</p>
        <label>
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
            minLength={3}
            maxLength={32}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            minLength={8}
            maxLength={128}
          />
        </label>
        {error ? (
          <div className="error-box" role="alert">
            <strong>{error.code ?? 'ERROR'}</strong>
            {' '}
            {error.message}
            {error.code === 'RATE_LIMITED' ? ' — too many attempts, wait a minute.' : ''}
          </div>
        ) : null}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

export default Login;
