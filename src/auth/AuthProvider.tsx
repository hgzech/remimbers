import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db, googleProvider } from '../lib/firebase'

type Access = 'loading' | 'signed-out' | 'not-allowed' | 'ok'

interface AuthState {
  user: User | null
  access: Access
  signIn: () => Promise<void>
  signOutNow: () => Promise<void>
}

const Ctx = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [access, setAccess] = useState<Access>('loading')

  useEffect(() => {
    return onAuthStateChanged(auth, async (u) => {
      setUser(u)
      if (!u) {
        setAccess('signed-out')
        return
      }
      // The allowlist is enforced for real in firestore.rules. This read only
      // decides what UI to show - a determined user could fake it client-side
      // and still be unable to read or write a single document.
      try {
        const email = (u.email ?? '').toLowerCase()
        const snap = await getDoc(doc(db, 'allowlist', email))
        setAccess(snap.exists() ? 'ok' : 'not-allowed')
      } catch {
        setAccess('not-allowed')
      }
    })
  }, [])

  const value: AuthState = {
    user,
    access,
    signIn: async () => {
      await signInWithPopup(auth, googleProvider)
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
