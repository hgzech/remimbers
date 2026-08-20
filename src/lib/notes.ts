import {
  addDoc,
  collection,
  deleteDoc,
  doc,
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
    // The onNoteCreated function moves this to 'done' (with cardIds) or to
    // 'failed' (with an error). Writing 'generating' here rather than letting
    // the function set it means the library shows the right state the instant
    // the note appears - including offline, where the trigger has not run and
    // will not until the write syncs.
    status: 'generating',
    cardIds: [],
    createdAt: serverTimestamp(),
  })
}

/**
 * Re-capture a failed note's text as a new note.
 *
 * Generation fires on document *creation*, so a failed note cannot be retried
 * in place - updating it re-runs nothing. Creating a fresh note from the same
 * rawText is the honest retry, and it is safe precisely because a failed note
 * never produced any cards to orphan.
 */
export async function retryNote(
  uid: string,
  note: Pick<Note, 'id' | 'rawText' | 'source'>,
) {
  await addNote(uid, note.rawText, note.source)
  await deleteDoc(doc(notesCollection(uid), note.id))
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
