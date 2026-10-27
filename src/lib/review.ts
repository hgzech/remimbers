import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getCountFromServer,
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
import { State, type Grade } from 'ts-fsrs'
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
 * A study day starts at 4 am local time, as in Anki: a session after
 * midnight still counts toward the day before, so the new-card limit does not
 * reset while you are still up.
 */
export const DAY_STARTS_AT_HOUR = 4

export function studyDayStart(now: Date): Date {
  const start = new Date(now)
  start.setHours(DAY_STARTS_AT_HOUR, 0, 0, 0)
  if (now < start) start.setDate(start.getDate() - 1)
  return start
}

const LEARNED = [State.Learning, State.Review, State.Relearning]

/**
 * Due cards, split by whether you have met them yet. The daily new-card
 * limit needs the two apart: cards being learned are always served, new ones
 * only up to the day's allowance.
 *
 * Both ride one composite index (suspended, state, due). `now` is baked in,
 * so a listener on these will NOT notice a card becoming due as time passes -
 * only writes re-fire it. Callers that care re-issue the query.
 */
function learnedDueQuery(uid: string, now: Date, max: number) {
  return query(
    cardsCollection(uid),
    where('suspended', '==', false),
    where('state', 'in', LEARNED),
    where('due', '<=', Timestamp.fromDate(now)),
    orderBy('due'),
    limit(max),
  )
}

function newDueQuery(uid: string, now: Date, max?: number) {
  const parts = [
    where('suspended', '==', false),
    where('state', '==', State.New),
    where('due', '<=', Timestamp.fromDate(now)),
    orderBy('due'),
  ]
  return max === undefined
    ? query(cardsCollection(uid), ...parts)
    : query(cardsCollection(uid), ...parts, limit(max))
}

/** Cards answered for the first time since the study day began (see gradeCard). */
function introducedTodayQuery(uid: string, now: Date) {
  return query(
    cardsCollection(uid),
    where('introducedAt', '>=', Timestamp.fromDate(studyDayStart(now))),
  )
}

/**
 * How many new cards today's limit still allows.
 *
 * A plain read rather than a count aggregate: it is at most `perDay` small
 * documents, and unlike an aggregate it answers from the offline cache,
 * including cards graded a moment ago in this very session.
 */
async function newCardsLeftToday(uid: string, now: Date, perDay: number): Promise<number> {
  if (perDay <= 0) return 0
  const snap = await getDocs(introducedTodayQuery(uid, now))
  return Math.max(0, perDay - snap.size)
}

/**
 * Fetch the session's queue once, as a snapshot: cards being learned first,
 * then new cards up to what today's limit still allows.
 *
 * Deliberately getDocs and not onSnapshot. A live listener would re-add a card
 * the moment its own grade landed - a card rated `Again` is due in a minute, so
 * the query it just left is a query it immediately re-enters. The session owns
 * its queue in memory from here; the server is consulted again only when the
 * local queue runs dry, and that re-fetch sees the new cards met so far.
 *
 * Offline this resolves from the local cache rather than failing, which is the
 * whole point of persistence: the day's cards were already fetched.
 */
export async function fetchDueCards(
  uid: string,
  now: Date,
  newPerDay: number,
  max = QUEUE_LIMIT,
): Promise<Flashcard[]> {
  const toCard = (d: { id: string; data: () => object }) => ({ id: d.id, ...d.data() }) as Flashcard
  const learned = (await getDocs(learnedDueQuery(uid, now, max))).docs.map(toCard)
  const room = max - learned.length
  if (room <= 0) return learned
  const left = await newCardsLeftToday(uid, now, newPerDay)
  if (left <= 0) return learned
  const fresh = (await getDocs(newDueQuery(uid, now, Math.min(room, left)))).docs.map(toCard)
  return [...learned, ...fresh]
}

/**
 * New cards that are due but held back by today's limit - "12 new cards are
 * waiting" on the done screen. A server count, so null offline (the screen
 * then just leaves the line out).
 */
export async function countNewWaiting(uid: string, now: Date): Promise<number | null> {
  try {
    const snap = await getCountFromServer(newDueQuery(uid, now))
    return snap.data().count
  } catch {
    return null
  }
}

/**
 * Live count for the nav badge, capped: due cards being learned, plus new
 * cards up to what today's limit still allows. Three listeners combined, so
 * it stays current as cards are graded anywhere in the app. See the queries
 * on why it does not tick up on its own as cards come due.
 */
export function subscribeToDueCount(
  uid: string,
  now: Date,
  cap: number,
  newPerDay: number,
  cb: (count: number) => void,
) {
  let learned = 0
  let newDue = 0
  let introduced = 0
  const emit = () =>
    cb(Math.min(cap + 1, learned + Math.min(newDue, Math.max(0, newPerDay - introduced))))
  const unsubs = [
    onSnapshot(learnedDueQuery(uid, now, cap + 1), (snap) => ((learned = snap.size), emit()), () => cb(0)),
    onSnapshot(newDueQuery(uid, now, cap + 1), (snap) => ((newDue = snap.size), emit()), () => cb(0)),
    onSnapshot(introducedTodayQuery(uid, now), (snap) => ((introduced = snap.size), emit()), () => cb(0)),
  ]
  return () => unsubs.forEach((u) => u())
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
  /** Restarts of this card before this answer. See types.ts. */
  restartCount?: number
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
 * `reviewId` comes back for one reason: the session may have to undo this
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
    restartCount: telemetry.restartCount ?? 0,

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

  // The first answer ever given to a card is when it was "introduced": what
  // the daily new-card limit counts. Set once; undoGrade clears it again.
  const introduced = card.state === State.New ? { introducedAt: Timestamp.fromDate(now) } : {}

  const batch = writeBatch(db)
  // Only the scheduling fields. `updatedAt` means "the text changed" and a
  // review does not change the text - see Flashcard.updatedAt.
  batch.update(cardRef, { ...after, ...introduced })
  batch.set(reviewRef, review)

  return {
    next: { ...card, ...after, ...introduced },
    reviewId: reviewRef.id,
    committed: batch.commit(),
  }
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
    // Undoing a card's first answer makes it new again, so it stops counting
    // toward today's new cards. Otherwise the grade never touched the field.
    ...(before.state === State.New ? { introducedAt: deleteField() } : {}),
  })
  await deleteDoc(doc(collection(cardRef, 'reviews'), reviewId))
}
