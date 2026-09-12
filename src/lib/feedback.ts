import { addDoc, collection, serverTimestamp, Timestamp } from 'firebase/firestore'
import { db } from './firebase'
import { FEEDBACK_SCHEMA_VERSION, type Feedback } from './types'

/**
 * Spoken feedback from a review session, at the top level in `feedback/{id}`.
 *
 * Top level rather than under `users/{uid}` - the only collection in the app
 * that is. The reason is in types.ts: this exists to be read as a corpus. One
 * query returns every failure anyone has reported, which is exactly the
 * material the next prompt revision should be driven by (DESIGN.md 4.5), and
 * a per-user path would need a collection-group read and a rules exemption to
 * produce the same list.
 *
 * The rules that go with it are narrow and worth knowing without opening
 * firestore.rules: an allowlisted user may CREATE a row stamped with their own
 * uid and nothing else. No read, no update, no delete from the client. A user
 * cannot enumerate other people's complaints, and cannot quietly retract their
 * own after the fact - which matters, because a corpus you can edit is not
 * evidence.
 */
export function feedbackCollection() {
  return collection(db, 'feedback')
}

export interface FeedbackDraft {
  uid: string
  transcript: string
  kind: Feedback['kind']
  cardId: string | null
  reviewId: string | null
  cardFront: string | null
  cardBack: string | null
  userTranscript: string | null
  assistantTranscript: string | null
  realtimeModel: string
  transcribeModel: string
  promptVersion: string
}

/**
 * Write one feedback row.
 *
 * Returns the promise without awaiting it, same reasoning as gradeCard: with
 * offline persistence the write lands locally at once and the promise settles
 * whenever the server is reachable. A session must not stall mid-conversation
 * waiting for a complaint to sync.
 *
 * Nothing here is sanitised or truncated. The transcripts are the payload, and
 * a clipped one is a row that cannot answer the question it was written to
 * answer.
 */
export function logFeedback(draft: FeedbackDraft): Promise<unknown> {
  return addDoc(feedbackCollection(), {
    uid: draft.uid,

    transcript: draft.transcript,
    kind: draft.kind,

    cardId: draft.cardId,
    reviewId: draft.reviewId,
    cardFront: draft.cardFront,
    cardBack: draft.cardBack,

    userTranscript: draft.userTranscript,
    assistantTranscript: draft.assistantTranscript,

    realtimeModel: draft.realtimeModel,
    transcribeModel: draft.transcribeModel,
    promptVersion: draft.promptVersion,

    createdAt: Timestamp.now(),
    syncedAt: serverTimestamp(),

    schemaVersion: FEEDBACK_SCHEMA_VERSION,
  })
}
