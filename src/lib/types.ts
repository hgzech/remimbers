import type { Timestamp } from 'firebase/firestore'
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
  updatedAt: Timestamp
}

/**
 * One row per answer given. Append-only.
 *
 * `llmJudgedCorrect` vs `rating` is the calibration signal: the model decides
 * correct/incorrect, the human picks the difficulty. Logging both is the only
 * way to find out later whether the model's judgement can be trusted, and it
 * cannot be backfilled.
 */
export interface Review {
  id: string
  cardId: string
  rating: Grade
  llmJudgedCorrect: boolean | null
  userAnswerTranscript: string | null
  llmRationale: string | null
  mode: 'voice' | 'text'
  durationMs: number
  reviewedAt: Timestamp
}

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
