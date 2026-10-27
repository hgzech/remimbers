import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  where,
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

/**
 * One note, for the card in front of you.
 *
 * Review shows the source note beside the answer (DESIGN.md section 4.1a), and
 * a session touches a handful of notes, so a per-card read is cheaper and far
 * simpler than keeping the whole library subscribed. Returns null if the note
 * is gone, which is possible: the note is deletable and the card outlives it.
 */
export async function fetchNote(uid: string, noteId: string): Promise<Note | null> {
  const snap = await getDoc(doc(notesCollection(uid), noteId))
  return snap.exists() ? ({ id: snap.id, ...snap.data() } as Note) : null
}

/**
 * Captures that have not turned into cards (yet): still generating, or failed.
 *
 * The library lists cards, not notes, so these are the only notes it shows -
 * a failed capture has no card to find it by, and the library is the one
 * place it can be retried. Sorted client-side: an `in` filter plus orderBy
 * would need a composite index for a list that is almost always empty.
 */
export function subscribeToUnfinishedNotes(uid: string, cb: (notes: Note[]) => void) {
  const q = query(notesCollection(uid), where('status', 'in', ['generating', 'failed']))
  return onSnapshot(q, (snap) => {
    const notes = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Note)
    notes.sort((a, b) => (b.createdAt?.toMillis() ?? Infinity) - (a.createdAt?.toMillis() ?? Infinity))
    cb(notes)
  })
}

/** Delete a note that produced no cards (a failed capture). */
export function deleteNote(uid: string, noteId: string) {
  return deleteDoc(doc(notesCollection(uid), noteId))
}
