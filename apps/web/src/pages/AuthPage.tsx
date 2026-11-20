import { useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router'
import { useAuth } from '../auth.tsx'
import { BrandMark } from '../components/Icon.tsx'
import { ThemeSwitch } from '../components/ThemeSwitch.tsx'
import { ThreadField } from '../components/ThreadField.tsx'

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { user, login, register } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const from = (location.state as { from?: string } | null)?.from ?? '/'
  if (user) return <Navigate to={from} replace />

  const isLogin = mode === 'login'

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (isLogin) await login(email, password)
      else await register(email, displayName, password)
      navigate(from, { replace: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth">
      <section className="auth-story">
        <div className="auth-brand">
          <BrandMark size={28} />
          <span className="brand-word">Converge</span>
        </div>
        <ThreadField />
        <div className="auth-copy">
          <p className="auth-headline">Your team and its agents, typing in one live file.</p>
          <p className="auth-sub">Edit together, run tests behind named approvals, and open pull requests from shared sessions. Every change says who made it.</p>
        </div>
      </section>
      <section className="auth-side">
        <div className="auth-tools"><ThemeSwitch /></div>
      <form className="card auth-card" onSubmit={submit}>
        <h1>{isLogin ? 'Welcome back' : 'Join Converge'}</h1>
        <p className="muted">{isLogin ? 'Sign in to your workspaces' : 'Create your account'}</p>
        <label>
          Email
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {!isLogin && (
          <label>
            Display name
            <input required maxLength={80} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </label>
        )}
        <label>
          Password
          <input
            type="password"
            autoComplete={isLogin ? 'current-password' : 'new-password'}
            required
            minLength={isLogin ? undefined : 8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Please wait…' : isLogin ? 'Sign in' : 'Create account'}
        </button>
        <p className="muted small">
          {isLogin ? (
            <>
              New here? <Link to="/register" state={location.state}>Create an account</Link>
            </>
          ) : (
            <>
              Already have an account? <Link to="/login" state={location.state}>Sign in</Link>
            </>
          )}
        </p>
      </form>
      </section>
    </main>
  )
}
