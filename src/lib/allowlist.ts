import { useEffect, useState } from 'react'
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  type Timestamp,
} from 'firebase/firestore'
import { db } from './firebase'
import { useAuth } from '../auth/AuthProvider'

export interface AllowlistEntry {
  email: string
  role?: string
  addedAt?: Timestamp
}

function allowlistDoc(email: string) {
  return doc(db, 'allowlist', email.toLowerCase())
}

/** Whether the signed-in user's allowlist doc has `role == 'owner'`. */
export function useIsOwner(): boolean {
  const { user } = useAuth()
  const [isOwner, setIsOwner] = useState(false)

  useEffect(() => {
    if (!user?.email) {
      setIsOwner(false)
      return
    }
    let cancelled = false
    getDoc(allowlistDoc(user.email)).then((snap) => {
      if (!cancelled) setIsOwner(snap.data()?.role === 'owner')
    })
    return () => {
      cancelled = true
    }
  }, [user])

  return isOwner
}

export async function addToAllowlist(email: string): Promise<void> {
  await setDoc(allowlistDoc(email), { addedAt: serverTimestamp() })
}

export async function removeFromAllowlist(email: string): Promise<void> {
  await deleteDoc(allowlistDoc(email))
}

export async function listAllowlist(): Promise<AllowlistEntry[]> {
  const snap = await getDocs(collection(db, 'allowlist'))
  return snap.docs.map((d) => ({ email: d.id, ...d.data() }) as AllowlistEntry)
}
