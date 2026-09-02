import { useState } from 'react';
import { useSession } from '../lib/session';
import { api, ApiError } from '../lib/api';
import { Icon } from '../components/Icons';

/**
 * Sign-in.
 *
 * Deliberately plain: one card, no marketing, and the error message the
 * server actually returned — including how long a locked account has left,
 * which is the difference between a call to the office and a person waiting.
 */
export function Login() {
  const { signIn } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await signIn(username, password, needsTotp ? totp : undefined);
      if (res.needsTotp) { setNeedsTotp(true); setBusy(false); }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in. Try again.');
      setBusy(false);
    }
  }

  return (
    <div style={{
      minHeight: '100dvh', display: 'grid', placeItems: 'center',
      padding: 'var(--s-4)', background: 'var(--bg-sunken)',
    }}>
      <div style={{ width: 'min(400px, 100%)' }} className="col">
        <div className="col" style={{ alignItems: 'center', gap: 'var(--s-2)', marginBottom: 'var(--s-2)' }}>
          <span className="brand-mark" style={{ width: 44, height: 44, borderRadius: 12, fontSize: 17 }}>HX</span>
          <h1 style={{ fontSize: 'var(--text-xl)' }}>HUEREX</h1>
          <p className="tiny subtle" style={{ letterSpacing: '0.09em', textTransform: 'uppercase' }}>
            Garment factory execution
          </p>
        </div>

        <form className="card card-pad col" style={{ gap: 'var(--s-4)' }} onSubmit={submit}>
          {error && <div className="banner banner-danger"><Icon.Alert size={16} /><span>{error}</span></div>}

          {!needsTotp ? (
            <>
              <div className="field">
                <label htmlFor="u">Username</label>
                <input id="u" className="input" autoComplete="username" autoFocus autoCapitalize="none"
                  value={username} onChange={(e) => setUsername(e.target.value)} required />
              </div>
              <div className="field">
                <label htmlFor="p">Password</label>
                <input id="p" className="input" type="password" autoComplete="current-password"
                  value={password} onChange={(e) => setPassword(e.target.value)} required />
              </div>
            </>
          ) : (
            <div className="field">
              <label htmlFor="t">Six-digit code</label>
              <input id="t" className="input" inputMode="numeric" autoComplete="one-time-code"
                autoFocus maxLength={6} placeholder="000000"
                style={{ fontSize: 'var(--text-xl)', letterSpacing: '0.3em', textAlign: 'center' }}
                value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))} required />
              <span className="help">From the authenticator app on your phone.</span>
            </div>
          )}

          <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy}>
            {busy && <span className="spinner" />}
            {needsTotp ? 'Verify' : 'Sign in'}
          </button>

          {needsTotp && (
            <button type="button" className="btn btn-ghost btn-sm"
              onClick={() => { setNeedsTotp(false); setTotp(''); setError(''); }}>
              Back
            </button>
          )}
        </form>

        <p className="tiny subtle center">
          Forgotten your password? An administrator can reset it for you.
        </p>
      </div>
    </div>
  );
}

/** Shown when a temporary password has to be replaced before anything else. */
export function ForcePasswordChange({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirm) { setError('The two new passwords do not match.'); return; }
    setBusy(true); setError('');
    try {
      await api.post('/api/auth/password', { current_password: current, new_password: next });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the password.');
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 'var(--s-4)', background: 'var(--bg-sunken)' }}>
      <form className="card card-pad col" style={{ width: 'min(420px, 100%)', gap: 'var(--s-4)' }} onSubmit={submit}>
        <div>
          <h1 style={{ fontSize: 'var(--text-lg)' }}>Choose your own password</h1>
          <p className="muted tiny" style={{ marginTop: 4 }}>
            You are signed in with a temporary password. Pick one only you know before carrying on.
          </p>
        </div>
        {error && <div className="banner banner-danger">{error}</div>}
        <div className="field">
          <label htmlFor="cur">Temporary password</label>
          <input id="cur" className="input" type="password" autoComplete="current-password" autoFocus
            value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="new">New password</label>
          <input id="new" className="input" type="password" autoComplete="new-password"
            value={next} onChange={(e) => setNext(e.target.value)} required />
          <span className="help">At least 10 characters, with an upper case letter and a digit.</span>
        </div>
        <div className="field">
          <label htmlFor="cnf">New password again</label>
          <input id="cnf" className="input" type="password" autoComplete="new-password"
            value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </div>
        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy}>
          {busy && <span className="spinner" />}Save and continue
        </button>
      </form>
    </div>
  );
}
