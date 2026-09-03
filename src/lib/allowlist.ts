import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  serverTimestamp,
  setDoc,
  type Timestamp,
} from 'firebase/firestore'
import { db } from './firebase'

export interface AllowlistEntry {
  email: string
  role?: string
  addedAt?: Timestamp
}

function allowlistDoc(email: string) {
  return doc(db, 'allowlist', email.toLowerCase())
}

/**
 * Merge, never replace. Re-inviting someone who is already on the list must
 * not strip a `role` they have - the rules stop an owner clobbering their own
 * entry, but not another owner's.
 */
export async function addToAllowlist(email: string): Promise<void> {
  await setDoc(allowlistDoc(email), { addedAt: serverTimestamp() }, { merge: true })
}

export async function removeFromAllowlist(email: string): Promise<void> {
  await deleteDoc(allowlistDoc(email))
}

/** Owners only - the rules refuse the list query to anyone else. */
export async function listAllowlist(): Promise<AllowlistEntry[]> {
  const snap = await getDocs(collection(db, 'allowlist'))
  return snap.docs.map((d) => ({ email: d.id, ...d.data() }) as AllowlistEntry)
}
