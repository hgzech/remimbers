import {
  addDoc,
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
} from 'firebase/firestore'
import { db } from './firebase'
import type { Note } from './types'

export function notesCollection(uid: string) {
  return collection(db, 'users', uid, 'notes')
}

/**
 * Write a note and return immediately.
 *
 * Deliberately NOT awaited by the UI. With Firestore offline persistence the
 * local write lands synchronously, so the capture screen can clear and say
 * "captured" without a network round trip. The returned promise resolves when
 * the server acknowledges, which nobody needs to wait for.
 */
export function addNote(uid: string, rawText: string, source: Note['source'] = 'text') {
  return addDoc(notesCollection(uid), {
    rawText: rawText.trim(),
    source,
    // Phase 1 flips this to 'generating' and a Cloud Function moves it to 'done'.
    status: 'done',
    cardIds: [],
    createdAt: serverTimestamp(),
  })
}

export function subscribeToRecentNotes(
  uid: string,
  count: number,
  cb: (notes: Note[]) => void,
) {
  const q = query(notesCollection(uid), orderBy('createdAt', 'desc'), limit(count))
  return onSnapshot(q, (snap) => {
    cb(
      snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Note),
    )
  })
}
