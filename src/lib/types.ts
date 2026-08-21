import { Timestamp } from 'firebase/firestore'
import type { Card as FsrsCard, Grade, State } from 'ts-fsrs'

/**
 * A raw capture. Source of truth.
 *
 * Cards are DERIVED from notes, which is why rawText is kept forever even
 * though the audio is not: it lets us regenerate the whole deck when the
 * generation prompt improves, and gives the grader context during review.
 */
export interface Note {
  id: string
  rawText: string
  source: 'voice' | 'text' | 'share'
  status: 'transcribing' | 'generating' | 'done' | 'failed'
  error?: string
  cardIds: string[]
  createdAt: Timestamp
}

/**
 * FSRS scheduling state, stored flat on the card document.
 *
 * Flat rather than nested so Firestore can index `due` directly, and so the
 * shape round-trips to ts-fsrs's Card with only Date <-> Timestamp conversion.
 */
export interface SchedulingState {
  due: Timestamp
  stability: number
  difficulty: number
  scheduled_days: number
  learning_steps: number
  reps: number
  lapses: number
  state: State
  last_review: Timestamp | null
}

export interface Flashcard extends SchedulingState {
  id: string
  /** Provenance. Never drop this - it is how a bad card gets fixed at review time. */
  noteId: string
  front: string
  back: string
  type: 'qa' | 'cloze'
  tags: string[]
  suspended: boolean
  createdAt: Timestamp
  /**
   * When the card's TEXT last changed - not when it was last scheduled.
   *
   * Reviewing a card deliberately leaves this alone. It is the only marker of
   * "this card asked a different question before", which is what lets a review
   * history spanning an edit be split into comparable halves later. Bumping it
   * on every answer would erase that for the sake of a field nobody reads.
   */
  updatedAt: Timestamp
}

/**
 * The card's scheduling state as it stood immediately before a review.
 *
 * This is ts-fsrs's own ReviewLog, which is what the FSRS optimiser replays.
 * Storing it makes each review row self-describing: you can refit parameters
 * without reconstructing the deck's entire history in order, and a row stays
 * interpretable even if the card is later deleted or regenerated from its note.
 */
export interface ReviewBefore {
  state: State
  due: Timestamp
  stability: number
  difficulty: number
  scheduled_days: number
  learning_steps: number
  /** Days since the previous review. The optimiser's delta_t. */
  elapsed_days: number
  last_elapsed_days: number
  last_review: Timestamp | null
}

/** The state FSRS produced. Derivable from `before` + rating + params - kept as a check. */
export interface ReviewAfter {
  state: State
  due: Timestamp
  stability: number
  difficulty: number
  scheduled_days: number
  learning_steps: number
  reps: number
  lapses: number
}

/** The exact parameter set that produced `after`. */
export interface SchedulerSnapshot {
  version: string
  w: number[]
  request_retention: number
  maximum_interval: number
  enable_fuzz: boolean
  enable_short_term: boolean
  learning_steps: string[]
  relearning_steps: string[]
}

/**
 * One row per answer given, at `users/{uid}/cards/{cardId}/reviews/{id}`.
 * Append-only, and the only thing in this app that cannot be rebuilt.
 *
 * Cards and schedules are derived data - delete them and a regeneration pass
 * over the notes brings them back. A review is an event: it happened at a
 * moment, in a state that no longer exists, and nothing recreates it. That
 * asymmetry is why this schema is fixed before the UI that writes it, and why
 * it carries fields that Phase 2 has no use for.
 *
 * `llmJudgedCorrect` is the one to be careful about (DESIGN.md section 6.3):
 * it is the model's binary verdict, to be compared against the difficulty YOU
 * chose. In text mode no model runs, so it is `null` - explicitly "nobody
 * judged", never `false`, which would read as "the grader said you were wrong"
 * and quietly poison the calibration number Phase 4 exists to produce.
 */
export interface Review {
  id: string
  /** Denormalised from the path so a collection-group export needs no parsing. */
  cardId: string
  /** Denormalised too: a review outlives the card, but the note is forever. */
  noteId: string

  rating: Grade
  mode: 'voice' | 'text'

  /** The grader's binary verdict, or null when no grader ran. Never false-as-unknown. */
  llmJudgedCorrect: boolean | null
  userAnswerTranscript: string | null
  llmRationale: string | null

  /**
   * The instant handed to FSRS - not a server timestamp.
   *
   * The schedule was computed from this exact value, so logging anything else
   * would leave the row internally inconsistent, and a server timestamp would
   * be unavailable offline, where review is expressly meant to work.
   */
  reviewedAt: Timestamp
  /**
   * When the server accepted the write. Bounds `reviewedAt` from the outside,
   * which is the only defence against a wrong device clock silently corrupting
   * the intervals the optimiser learns from. Null until the write syncs.
   */
  syncedAt: Timestamp | null

  /** Card shown -> rating pressed. */
  durationMs: number
  /** Card shown -> answer revealed: retrieval effort, before you saw the answer. */
  revealMs: number | null

  /** The card's `updatedAt` at review time - see Flashcard.updatedAt. */
  cardEditedAt: Timestamp | null

  before: ReviewBefore
  after: ReviewAfter
  scheduler: SchedulerSnapshot

  /** Bumped only if the meaning of an existing field changes. */
  schemaVersion: number
}

export const REVIEW_SCHEMA_VERSION = 1

/** Convert a stored card into the shape ts-fsrs expects. */
export function toFsrsCard(card: SchedulingState): FsrsCard {
  return {
    due: card.due.toDate(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: 0, // deprecated in ts-fsrs; recomputed internally
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    last_review: card.last_review?.toDate(),
  }
}

/** And back again, for the card document. */
export function fromFsrsCard(card: FsrsCard): SchedulingState {
  return {
    due: Timestamp.fromDate(card.due),
    stability: card.stability,
    difficulty: card.difficulty,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    last_review: card.last_review ? Timestamp.fromDate(card.last_review) : null,
  }
}
