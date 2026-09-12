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
  /**
   * What the user said when they answered - their first utterance on the card,
   * not their last. See REVIEW_SCHEMA_VERSION: rows at schemaVersion 1 hold the
   * spoken rating here instead, and cannot be repaired.
   */
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

  /**
   * This row replaced one that a rollback discarded (DESIGN.md section 3.2).
   *
   * The append-only rule has exactly one exception: a card that broke mid-turn
   * produced a row describing an event that never properly happened, and
   * keeping it would mean the optimiser fits a schedule to a glitch. The
   * rollback deletes it and the re-run writes a clean replacement.
   *
   * Flagged rather than silently identical because a replacement is not quite
   * an ordinary review either - the user has now heard the card twice, so its
   * `durationMs` and its rating are both measured after a failed first pass.
   * A calibration pass that wants only untouched rows can exclude these; one
   * looking for what went wrong can find them.
   */
  afterRollback: boolean
  /**
   * The id of the discarded row, kept even though that document is gone.
   *
   * It is the join key to the feedback row, which was written against the
   * original id while it still existed. Without it the only record of the
   * failure and the only record of the retry cannot be lined up.
   */
  replacesReviewId: string | null

  before: ReviewBefore
  after: ReviewAfter
  scheduler: SchedulerSnapshot

  /** Bumped only if the meaning of an existing field changes. */
  schemaVersion: number
}

/**
 * 2 as of 12 Sep 2026, and this is what the field is for.
 *
 * `userAnswerTranscript` did not change its meaning on paper - it was always
 * the user's answer. It changed what it CONTAINED. Voice mode wrote whichever
 * transcription arrived last, which on any card that reached a rating is the
 * spoken rating: "Good" sitting in the slot reserved for the retrieval attempt.
 * Nothing about the row said so, which is exactly the failure a schema version
 * exists to prevent - an analysis of why cards fail would have read a column of
 * rating words and drawn conclusions from it.
 *
 * So: rows at 1 mean "the last thing the user said on this card", rows at 2
 * mean "the answer they gave". Old rows are not repairable - the audio is gone
 * by design (DESIGN.md 5.1) and the transcripts were never stored - so the only
 * honest thing available is to make them identifiable and exclude them.
 *
 * `afterRollback` and `replacesReviewId`, added in the same change, did NOT
 * warrant a bump on their own: they are additions, and a row written before
 * they existed reads as undefined, which is honest - it predates rollback and
 * so cannot be a replacement.
 */
export const REVIEW_SCHEMA_VERSION = 2

/**
 * One row per piece of spoken feedback, at the TOP level in `feedback/{id}`.
 *
 * Deliberately not under `users/{uid}` like everything else. The point of this
 * collection is to be read as a corpus - every failure across every user, in
 * one query, as the raw material for the next prompt revision (DESIGN.md
 * section 4.5). Scattered under user paths that would need a collection-group
 * read and a rules exemption to gather; at the top level it is one query and
 * one rule, with `uid` denormalised onto the row.
 *
 * The rows carry more context than the complaint itself because the complaint
 * alone is not diagnosable. "It cut me off and got it wrong" says nothing
 * without what the user actually said and what the model actually said back -
 * and when the review row was rolled back, this is the ONLY surviving record
 * that the failure happened at all.
 */
export interface Feedback {
  id: string
  /** Who reported it. Denormalised - this collection is not under a user path. */
  uid: string

  /** What the user said when asked what went wrong. */
  transcript: string
  /**
   * Whether this came attached to a rollback or was volunteered on its own.
   * A rollback means the user thought the turn was unsalvageable; standalone
   * means the grade stood and something else was wrong.
   */
  kind: 'rollback' | 'standalone'

  cardId: string | null
  /**
   * The review row this is about. For a rollback the document is already
   * gone - the id survives here and on the replacement row's
   * `replacesReviewId`, which is what lets the two be joined.
   */
  reviewId: string | null
  /**
   * The card's text as it stood. Cards get edited at review time by design
   * (DESIGN.md section 4.1a), so a cardId alone can point at a different
   * question by the time anyone reads this.
   */
  cardFront: string | null
  cardBack: string | null

  /**
   * The turn as both sides actually performed it.
   *
   * These are the fields the collection exists for. A complaint about tone or
   * about a garbled answer is unfalsifiable without the model's own words, and
   * a complaint about being misjudged is unreadable without the user's.
   *
   * Held in memory during the turn and written ONLY when feedback fires, which
   * is what keeps DESIGN.md section 5.1's "audio is never persisted" promise
   * intact and costs nothing on the normal path. Audio itself stays out of
   * scope - see section 4.5.
   */
  userTranscript: string | null
  assistantTranscript: string | null

  /** What produced the behaviour: enough to tell a prompt bug from a model change. */
  realtimeModel: string
  transcribeModel: string
  promptVersion: string

  /** Client clock, for ordering against the session the user remembers. */
  createdAt: Timestamp
  /** Server clock, for ordering against everyone else's rows. Null until synced. */
  syncedAt: Timestamp | null

  schemaVersion: number
}

export const FEEDBACK_SCHEMA_VERSION = 1

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
