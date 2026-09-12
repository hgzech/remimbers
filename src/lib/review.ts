import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore'
import type { Grade } from 'ts-fsrs'
import { db } from './firebase'
import { cardsCollection } from './cards'
import { scheduler, schedulerSnapshot } from './fsrs'
import {
  REVIEW_SCHEMA_VERSION,
  fromFsrsCard,
  toFsrsCard,
  type Flashcard,
} from './types'

/** DESIGN.md section 3: one screenful of work, fetched in a single read. */
export const QUEUE_LIMIT = 20

/**
 * The due query. One composite index (suspended, due), already deployed.
 *
 * `now` is baked into the query, so a listener on it will NOT notice a card
 * becoming due as time passes - only writes re-fire it. Callers that care about
 * the passage of time re-issue the query instead of trusting the listener.
 */
function dueQuery(uid: string, now: Date, max: number) {
  return query(
    cardsCollection(uid),
    where('suspended', '==', false),
    where('due', '<=', Timestamp.fromDate(now)),
    orderBy('due'),
    limit(max),
  )
}

/**
 * Fetch the session's queue once, as a snapshot.
 *
 * Deliberately getDocs and not onSnapshot. A live listener would re-add a card
 * the moment its own grade landed - a card rated `Again` is due in a minute, so
 * the query it just left is a query it immediately re-enters. The session owns
 * its queue in memory from here; the server is consulted again only when the
 * local queue runs dry.
 *
 * Offline this resolves from the local cache rather than failing, which is the
 * whole point of persistence: the day's cards were already fetched.
 */
export async function fetchDueCards(
  uid: string,
  now: Date,
  max = QUEUE_LIMIT,
): Promise<Flashcard[]> {
  const snap = await getDocs(dueQuery(uid, now, max))
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Flashcard)
}

/**
 * Live count for the nav badge, capped.
 *
 * Reads `cap + 1` documents so the UI can say "20+" without a second query,
 * and stays current as cards are graded elsewhere in the app. See dueQuery on
 * why this does not tick up on its own as cards come due.
 */
export function subscribeToDueCount(
  uid: string,
  now: Date,
  cap: number,
  cb: (count: number) => void,
) {
  return onSnapshot(
    dueQuery(uid, now, cap + 1),
    (snap) => cb(snap.size),
    () => cb(0),
  )
}

/**
 * Cards that are NOT yet due, soonest first - Anki's "review ahead".
 *
 * Same predicate as fetchNextDue, just more of them, so it rides the composite
 * index that query already needs. Nothing about grading changes: FSRS derives
 * elapsed time from `last_review` to now, so answering a card early is scored
 * on the interval actually served rather than the one that was scheduled, and
 * earns less stability accordingly. That is the honest behaviour and it is what
 * Anki does too - but it does mean reviewing ahead really does move the card's
 * schedule, including when it is only being used to exercise the voice path.
 */
export const AHEAD_LIMIT = 4

export async function fetchAheadCards(
  uid: string,
  now: Date,
  max = AHEAD_LIMIT,
): Promise<Flashcard[]> {
  const snap = await getDocs(
    query(
      cardsCollection(uid),
      where('suspended', '==', false),
      where('due', '>', Timestamp.fromDate(now)),
      orderBy('due'),
      limit(max),
    ),
  )
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Flashcard)
}

/** The soonest card that is NOT yet due - "next card in 4h" on the done screen. */
export async function fetchNextDue(uid: string, now: Date): Promise<Flashcard | null> {
  const snap = await getDocs(
    query(
      cardsCollection(uid),
      where('suspended', '==', false),
      where('due', '>', Timestamp.fromDate(now)),
      orderBy('due'),
      limit(1),
    ),
  )
  const d = snap.docs[0]
  return d ? ({ id: d.id, ...d.data() }) as Flashcard : null
}

export interface ReviewTelemetry {
  mode: 'voice' | 'text'
  /** Card shown -> rating pressed. */
  durationMs: number
  /** Card shown -> answer revealed. Null if the answer was never shown. */
  revealMs: number | null
  /**
   * Phase 4 fills these. Leaving llmJudgedCorrect undefined logs null, meaning
   * "no grader ran" - which is not the same claim as false. See types.ts.
   */
  llmJudgedCorrect?: boolean | null
  userAnswerTranscript?: string | null
  llmRationale?: string | null
  /**
   * Set when this answer is the re-run of a card a rollback discarded.
   * See types.ts - the flag is what keeps a replacement distinguishable from
   * an untouched first pass without hiding it from the optimiser.
   */
  afterRollback?: boolean
  replacesReviewId?: string | null
}

/**
 * Apply a rating: advance the card and append the review, atomically.
 *
 * The batch is the point. A card that advanced without a logged review has
 * destroyed data that no later pass can reconstruct, and a review logged
 * against a schedule that was not applied is worse than no review at all -
 * it would be indistinguishable from real data while being false.
 *
 * Returns synchronously-computed state plus the commit promise, and does NOT
 * await it: with offline persistence the write lands locally at once but the
 * promise only settles on server acknowledgement, which may be tomorrow. The
 * caller advances on `next` and merely reports failures from `committed`.
 *
 * `reviewId` comes back for one reason: a voice session may have to undo this
 * (undoGrade, below), and the id is generated here. Returning it beats having
 * the caller re-query for the row it just wrote - offline, that query would
 * be answered from cache and the caller would be guessing.
 */
export function gradeCard(
  uid: string,
  card: Flashcard,
  rating: Grade,
  telemetry: ReviewTelemetry,
  now: Date = new Date(),
): { next: Flashcard; reviewId: string; committed: Promise<void> } {
  const { card: scheduled, log } = scheduler.next(toFsrsCard(card), now, rating)
  const after = fromFsrsCard(scheduled)

  const cardRef = doc(cardsCollection(uid), card.id)
  const reviewRef = doc(collection(cardRef, 'reviews'))

  const review = {
    cardId: card.id,
    noteId: card.noteId,

    rating,
    mode: telemetry.mode,

    llmJudgedCorrect: telemetry.llmJudgedCorrect ?? null,
    userAnswerTranscript: telemetry.userAnswerTranscript ?? null,
    llmRationale: telemetry.llmRationale ?? null,

    reviewedAt: Timestamp.fromDate(now),
    syncedAt: serverTimestamp(),

    durationMs: telemetry.durationMs,
    revealMs: telemetry.revealMs,

    cardEditedAt: card.updatedAt ?? null,

    afterRollback: telemetry.afterRollback ?? false,
    replacesReviewId: telemetry.replacesReviewId ?? null,

    // ts-fsrs's own ReviewLog: the card exactly as the algorithm saw it.
    before: {
      state: log.state,
      due: Timestamp.fromDate(log.due),
      stability: log.stability,
      difficulty: log.difficulty,
      scheduled_days: log.scheduled_days,
      learning_steps: log.learning_steps,
      elapsed_days: log.elapsed_days,
      last_elapsed_days: log.last_elapsed_days,
      last_review: card.last_review ?? null,
    },
    after,
    scheduler: schedulerSnapshot(),

    schemaVersion: REVIEW_SCHEMA_VERSION,
  }

  const batch = writeBatch(db)
  // Only the scheduling fields. `updatedAt` means "the text changed" and a
  // review does not change the text - see Flashcard.updatedAt.
  batch.update(cardRef, { ...after })
  batch.set(reviewRef, review)

  return { next: { ...card, ...after }, reviewId: reviewRef.id, committed: batch.commit() }
}

/**
 * Undo the last grade: restore the card's schedule and DELETE the review row.
 *
 * This is the one place in the app that destroys a review, and it is a
 * deliberate exception to the append-only rule in DESIGN.md section 3.1,
 * argued in 3.2. The short version: that rule protects events, and a card
 * that broke mid-turn - the model cutting the user off, a garbled answer, a
 * grade logged against a rating nobody gave - did not produce an event worth
 * protecting. It produced a row that says a review happened at a moment when
 * what actually happened was a malfunction. Keeping it would mean the FSRS
 * optimiser fits an interval to a glitch, and every calibration number in
 * section 6.3 carries the glitch too. Deleting it is the honest option, and
 * it is only available because the very next thing that happens is the same
 * card being asked again properly.
 *
 * Restricted to the immediately preceding grade by the caller, not by this
 * function: one step back is a recovery, an arbitrary history rewrite is a
 * different feature with a different argument behind it.
 *
 * Not batched with anything, and deliberately ordered card-first: if the
 * delete fails, the worst outcome is an orphaned row whose schedule was rolled
 * back, which is visible and fixable. If the restore failed and the delete
 * landed, the card would be left on a schedule with nothing explaining it.
 */
export async function undoGrade(
  uid: string,
  before: Flashcard,
  reviewId: string,
): Promise<void> {
  const cardRef = doc(cardsCollection(uid), before.id)
  // Only the scheduling fields, exactly as gradeCard wrote them - putting the
  // whole card back would also rewrite `updatedAt`, which means "the text
  // changed" and would invent an edit that never happened (see types.ts).
  await updateDoc(cardRef, {
    due: before.due,
    stability: before.stability,
    difficulty: before.difficulty,
    scheduled_days: before.scheduled_days,
    learning_steps: before.learning_steps,
    reps: before.reps,
    lapses: before.lapses,
    state: before.state,
    last_review: before.last_review,
  })
  await deleteDoc(doc(collection(cardRef, 'reviews'), reviewId))
}
