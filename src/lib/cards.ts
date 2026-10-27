import {
  arrayRemove,
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
  writeBatch,
} from 'firebase/firestore'
import { createEmptyCard } from 'ts-fsrs'
import { db } from './firebase'
import { notesCollection } from './notes'
import { fromFsrsCard, type Flashcard } from './types'

export function cardsCollection(uid: string) {
  return collection(db, 'users', uid, 'cards')
}

/**
 * Subscribe to the whole deck, newest first.
 *
 * Unlimited on purpose: the library searches every card, and search is done
 * in the browser. A personal deck is hundreds to a few thousand small
 * documents, which one listener handles fine. If that ever stops being true,
 * this is the place to page.
 */
export function subscribeToAllCards(uid: string, cb: (cards: Flashcard[]) => void) {
  const q = query(cardsCollection(uid), orderBy('createdAt', 'desc'))
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Flashcard))
  })
}

/**
 * Add a card typed in by hand.
 *
 * Every card points at a note (`noteId` is how review rows, the review screen
 * and the trigger all find a card's origin), so a hand-made card gets a small
 * note of its own with `source: 'manual'`. Note and card are written in one
 * batch, and the note is born `done` with its card listed: that is exactly
 * the condition under which `onNoteCreated` skips without calling the model.
 * `rawText` must be non-empty for the same reason - the trigger marks an
 * empty note failed before it checks anything else.
 *
 * Same id scheme as generated cards (`{noteId}_0`), and the same fresh FSRS
 * state, so the card is due at once like any other new card. Not awaited by
 * the UI, same reasoning as addNote.
 */
export function addManualCard(
  uid: string,
  fields: { front: string; back: string },
): { cardId: string; written: Promise<void> } {
  const front = fields.front.trim()
  const back = fields.back.trim()
  const note = doc(notesCollection(uid))
  const cardId = `${note.id}_0`
  const now = Timestamp.now()

  const batch = writeBatch(db)
  batch.set(note, {
    rawText: `${front}\n${back}`,
    source: 'manual',
    status: 'done',
    cardIds: [cardId],
    createdAt: serverTimestamp(),
  })
  batch.set(doc(cardsCollection(uid), cardId), {
    noteId: note.id,
    front,
    back,
    type: 'qa',
    tags: [],
    suspended: false,
    createdAt: now,
    updatedAt: now,
    ...fromFsrsCard(createEmptyCard(now.toDate())),
  })
  return { cardId, written: batch.commit() }
}

/**
 * Edit a card's text.
 *
 * Deliberately does not touch the note: a card is fixed in place, and the
 * note is only kept as its origin.
 *
 * `updatedAt` is a client Timestamp rather than serverTimestamp(), and handed
 * back to the caller, because it is not an audit trail - it is a content
 * version. Every review logs the value in force when it was answered, which is
 * what lets a history spanning an edit be split into comparable halves later.
 * A server sentinel is unknowable locally, so a review taken straight after an
 * edit would log the pre-edit value and invent a boundary in the wrong place.
 * Sub-second fidelity does not matter here; the field agreeing with itself does.
 */
export function updateCardText(
  uid: string,
  cardId: string,
  fields: { front: string; back: string },
): { updatedAt: Timestamp; written: Promise<void> } {
  const updatedAt = Timestamp.now()
  const written = updateDoc(doc(cardsCollection(uid), cardId), {
    front: fields.front.trim(),
    back: fields.back.trim(),
    updatedAt,
  })
  return { updatedAt, written }
}

/**
 * Delete a card and drop it from its note's `cardIds`.
 *
 * Batched so the note can never list a card that no longer exists.
 *
 * The card's `reviews` subcollection is deliberately NOT deleted. Firestore
 * keeps subcollection documents when their parent goes, and that is what we
 * want: a card you deleted because it was bad is exactly the calibration data
 * worth having. Reviews carry their own `cardId` and `noteId` so an orphaned
 * row still says what it was about.
 */
export function deleteCard(uid: string, card: Pick<Flashcard, 'id' | 'noteId'>) {
  const batch = writeBatch(db)
  batch.delete(doc(cardsCollection(uid), card.id))
  batch.update(doc(notesCollection(uid), card.noteId), { cardIds: arrayRemove(card.id) })
  return batch.commit()
}
