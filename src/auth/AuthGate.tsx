import type { ReactNode } from 'react'
import { useAuth } from './AuthProvider'

export function AuthGate({ children }: { children: ReactNode }) {
  const { access, detail, user, signIn, signOutNow } = useAuth()

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
        <button className="btn btn-primary" onClick={signIn}>
          Sign in with Google
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
            ? 'Something is misconfigured.'
            : `${user?.email} isn't on the invite list yet.`}
        </p>
        {detail && <pre className="diag">{detail}</pre>}
        <button className="btn" onClick={signOutNow}>
          Sign out
        </button>
      </div>
    )
  }

  return <>{children}</>
}
