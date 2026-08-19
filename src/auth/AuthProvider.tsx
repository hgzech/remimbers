import { createContext, useContext, useEffect, useState } from 'react'
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
  signIn: () => Promise<void>
  signOutNow: () => Promise<void>
}

const Ctx = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [access, setAccess] = useState<Access>('loading')
  const [detail, setDetail] = useState<string | null>(null)

  useEffect(() => {
    return onAuthStateChanged(auth, async (u) => {
      setUser(u)
      setDetail(null)

      if (!u) {
        setAccess('signed-out')
        return
      }

      const email = (u.email ?? '').toLowerCase()

      try {
        const snap = await getDoc(doc(db, 'allowlist', email))
        if (snap.exists()) {
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
    signIn: async () => {
      try {
        await signInWithPopup(auth, googleProvider)
      } catch (err) {
        const code = err instanceof FirebaseError ? err.code : String(err)
        // Popup failures are silent by nature - the window just closes.
        setAccess('blocked')
        setDetail(`Sign-in failed: ${code}`)
        console.error('[remimbers] sign-in failed', err)
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
