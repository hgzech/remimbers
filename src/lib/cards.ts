import {
  arrayRemove,
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  writeBatch,
} from 'firebase/firestore'
import { db } from './firebase'
import type { Flashcard } from './types'

export function cardsCollection(uid: string) {
  return collection(db, 'users', uid, 'cards')
}

function noteDoc(uid: string, noteId: string) {
  return doc(collection(db, 'users', uid, 'notes'), noteId)
}

/**
 * Subscribe to recent cards and let the caller group them by note.
 *
 * One listener for the whole library rather than one per note: the library
 * shows at most 50 notes, so a per-note listener would mean 50 subscriptions
 * to fetch a few hundred documents that a single query already returns.
 */
export function subscribeToRecentCards(
  uid: string,
  count: number,
  cb: (cards: Flashcard[]) => void,
) {
  const q = query(cardsCollection(uid), orderBy('createdAt', 'desc'), limit(count))
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Flashcard))
  })
}

export function groupByNote(cards: Flashcard[]): Map<string, Flashcard[]> {
  const byNote = new Map<string, Flashcard[]>()
  for (const card of cards) {
    const list = byNote.get(card.noteId)
    if (list) list.push(card)
    else byNote.set(card.noteId, [card])
  }
  // Cards arrive newest-first; within a note, id order is generation order.
  for (const list of byNote.values()) list.sort((a, b) => a.id.localeCompare(b.id))
  return byNote
}

/**
 * Edit a card's text.
 *
 * Deliberately does not touch the note. Cards are build output and notes are
 * the source (DESIGN.md section 3) - fixing a card fixes this card, and
 * regenerating from the note later is expected to overwrite it.
 */
export function updateCardText(
  uid: string,
  cardId: string,
  fields: { front: string; back: string },
) {
  return updateDoc(doc(cardsCollection(uid), cardId), {
    front: fields.front.trim(),
    back: fields.back.trim(),
    updatedAt: serverTimestamp(),
  })
}

/**
 * Delete a card and drop it from its note's `cardIds`.
 *
 * Batched so the note can never list a card that no longer exists - the
 * library would render a phantom and Phase 2's queue would fetch a missing
 * document.
 */
export function deleteCard(uid: string, card: Pick<Flashcard, 'id' | 'noteId'>) {
  const batch = writeBatch(db)
  batch.delete(doc(cardsCollection(uid), card.id))
  batch.update(noteDoc(uid, card.noteId), { cardIds: arrayRemove(card.id) })
  return batch.commit()
}

/** Delete a note and every card derived from it. */
export function deleteNoteWithCards(
  uid: string,
  noteId: string,
  cards: Flashcard[],
) {
  const batch = writeBatch(db)
  for (const card of cards) batch.delete(doc(cardsCollection(uid), card.id))
  batch.delete(noteDoc(uid, noteId))
  return batch.commit()
}
