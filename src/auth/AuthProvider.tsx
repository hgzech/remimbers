import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { FirebaseError } from 'firebase/app'
import { auth, db, googleProvider, DATABASE_ID } from '../lib/firebase'

type Access = 'loading' | 'signed-out' | 'not-allowed' | 'blocked' | 'ok'

interface AuthState {
  user: User | null
  access: Access
  /** Human-readable reason when access is 'not-allowed' or 'blocked'. */
  detail: string | null
  /**
   * Whether the allowlist entry carries `role: 'owner'`. Read off the same
   * snapshot as the access check, so it is known before the gate opens and
   * costs no extra round trip. The rules are the real guard - this only
   * decides whether to show the admin link.
   */
  isOwner: boolean
  /** True while a popup is open, so the button can refuse a second click. */
  signingIn: boolean
  signIn: () => Promise<void>
  signOutNow: () => Promise<void>
}

const Ctx = createContext<AuthState | null>(null)

/**
 * Sign-in outcomes that are not failures.
 *
 * - cancelled-popup-request: a SECOND popup was opened, so Firebase rejected
 *   the first one. Almost always a double-tap. The surviving popup is usually
 *   still going fine, which is why treating this as fatal is actively wrong.
 * - popup-closed-by-user / user-cancelled: they changed their mind.
 *
 * None of these should show an error. Just return to the sign-in screen.
 */
const BENIGN_SIGNIN_ERRORS = new Set([
  'auth/cancelled-popup-request',
  'auth/popup-closed-by-user',
  'auth/user-cancelled',
])

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [access, setAccess] = useState<Access>('loading')
  const [detail, setDetail] = useState<string | null>(null)
  const [isOwner, setIsOwner] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const inFlight = useRef(false)

  useEffect(() => {
    return onAuthStateChanged(auth, async (u) => {
      setUser(u)
      setDetail(null)
      setIsOwner(false)

      if (!u) {
        setAccess('signed-out')
        return
      }

      const email = (u.email ?? '').toLowerCase()

      try {
        const snap = await getDoc(doc(db, 'allowlist', email))
        if (snap.exists()) {
          setIsOwner(snap.data().role === 'owner')
          setAccess('ok')
        } else {
          setAccess('not-allowed')
          setDetail(
            `No document "allowlist/${email}" in the "${DATABASE_ID}" database.`,
          )
        }
      } catch (err) {
        // Distinguishing these two is the whole point. "Denied" means the read
        // never happened - rules missing or pointed at another database - which
        // looks identical to "not invited" unless we say so.
        const code = err instanceof FirebaseError ? err.code : String(err)
        setAccess('blocked')
        setDetail(
          code === 'permission-denied'
            ? `Firestore denied the read of "allowlist/${email}" in the ` +
                `"${DATABASE_ID}" database. The security rules probably were ` +
                `not deployed to THIS database: run ` +
                `\`firebase deploy --only firestore\`.`
            : `Could not read the allowlist: ${code}`,
        )
        console.error('[remimbers] allowlist check failed', err)
      }
    })
  }, [])

  const value: AuthState = {
    user,
    access,
    detail,
    isOwner,
    signingIn,
    signIn: async () => {
      // Guard at the source: a second popup is what generates
      // cancelled-popup-request in the first place.
      if (inFlight.current) return
      inFlight.current = true
      setSigningIn(true)

      try {
        await signInWithPopup(auth, googleProvider)
      } catch (err) {
        const code = err instanceof FirebaseError ? err.code : String(err)

        if (BENIGN_SIGNIN_ERRORS.has(code)) {
          console.warn('[remimbers] sign-in attempt abandoned:', code)
          return
        }

        // A rejected promise from a superseded attempt must never overwrite a
        // session that another attempt already established.
        if (auth.currentUser) {
          console.warn('[remimbers] ignoring stale sign-in error:', code)
          return
        }

        setAccess('blocked')
        setDetail(
          code === 'auth/popup-blocked'
            ? 'Your browser blocked the sign-in popup. Allow popups for this ' +
                'site, then try again.'
            : `Sign-in failed: ${code}`,
        )
        console.error('[remimbers] sign-in failed', err)
      } finally {
        inFlight.current = false
        setSigningIn(false)
      }
    },
    signOutNow: async () => {
      await signOut(auth)
    },
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
