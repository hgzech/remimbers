import type { ReactNode } from 'react'
import { useAuth } from './AuthProvider'

export function AuthGate({ children }: { children: ReactNode }) {
  const { access, detail, user, signingIn, signIn, signOutNow } = useAuth()

  if (access === 'loading') {
    return (
      <div className="centered">
        <div className="spinner" aria-label="Loading" />
      </div>
    )
  }

  if (access === 'signed-out') {
    return (
      <div className="centered splash">
        <h1 className="wordmark">remimbers</h1>
        <p className="tagline">Catch the thought. Rehearse it later, out loud.</p>
        {/* Disabled while a popup is open: an impatient second tap is exactly
            what produced auth/cancelled-popup-request. */}
        <button className="btn btn-primary" onClick={signIn} disabled={signingIn}>
          {signingIn ? 'Waiting for Google…' : 'Sign in with Google'}
        </button>
      </div>
    )
  }

  if (access === 'not-allowed' || access === 'blocked') {
    return (
      <div className="centered splash">
        <h1 className="wordmark">remimbers</h1>
        <p className="tagline">
          {access === 'blocked'
            ? 'Something went wrong signing in.'
            : `${user?.email} isn't on the invite list yet.`}
        </p>
        {detail && <pre className="diag">{detail}</pre>}
        <div className="row">
          {access === 'blocked' && (
            <button className="btn btn-primary" onClick={signIn} disabled={signingIn}>
              Try again
            </button>
          )}
          <button className="btn" onClick={signOutNow}>
            Sign out
          </button>
        </div>
      </div>
    )
  }

  return <>{children}</>
}
