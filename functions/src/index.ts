import { onRequest } from 'firebase-functions/v2/https'
import { onDocumentCreated } from 'firebase-functions/v2/firestore'
import { defineSecret } from 'firebase-functions/params'
import { logger } from 'firebase-functions'
import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore'
import { createEmptyCard } from 'ts-fsrs'
import { generateCards } from './generate.js'

const app = initializeApp()

/**
 * The only real secret in the system. Set it once, from your own terminal:
 *
 *   firebase functions:secrets:set OPENAI_API_KEY --project remimbers
 *
 * It is stored in Google Secret Manager and injected at runtime. It never
 * touches the repo, the bundle, or your shell history.
 */
export const openaiKey = defineSecret('OPENAI_API_KEY')

/**
 * GitHub Pages cannot proxy /api/** to Cloud Functions the way Firebase
 * Hosting can, so the browser calls these endpoints cross-origin and CORS
 * has to be explicit. Keep this list tight - it is what stops a random site
 * from spending your OpenAI credit.
 */
export const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'https://hgzech.github.io',
]

const opts = {
  region: 'europe-west1' as const,
  cors: ALLOWED_ORIGINS,
}

/**
 * We use the NAMED database, not '(default)'.
 *
 * The admin SDK defaults to '(default)' exactly like the web SDK does, so this
 * argument is not optional decoration - without it the trigger below would
 * write into the empty accidental database in nam5 and every card would vanish
 * silently. Same failure mode, same fix, as src/lib/firebase.ts.
 */
const DATABASE_ID = 'remimbers'
const db = getFirestore(app, DATABASE_ID)

/**
 * Firestore triggers are Eventarc triggers, and Eventarc requires the trigger
 * to live where the database lives. The 'remimbers' database is in
 * europe-west3, so this function is too - even though every HTTP function here
 * is in europe-west1. Deploying it alongside them fails with "unsupported
 * Cloud Firestore region", which does not name the database as the cause.
 */
const FIRESTORE_TRIGGER_REGION = 'europe-west3' as const

/**
 * Verify the Firebase ID token on every call.
 *
 * CORS is not access control - it is a browser convention and curl ignores it.
 * Any endpoint that spends money must check the caller's identity itself.
 */
export async function requireUser(authHeader: string | undefined) {
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) throw new Error('unauthenticated')
  return getAuth().verifyIdToken(token)
}

/** Phase 0 smoke test: proves deploy, region, CORS and auth all line up. */
export const ping = onRequest(opts, async (req, res) => {
  try {
    const user = await requireUser(req.headers.authorization)
    res.json({ ok: true, uid: user.uid, at: new Date().toISOString() })
  } catch {
    res.status(401).json({ ok: false, error: 'unauthenticated' })
  }
})

/** Deterministic so a redelivered event overwrites rather than duplicates. */
const cardId = (noteId: string, index: number) => `${noteId}_${index}`

/** Ceiling enforced in generate.ts; repeated here for the stale-card sweep. */
const MAX_CARDS = 5

/**
 * Note created -> cards written.
 *
 * Notes are the source of truth and cards are build output (DESIGN.md section 3),
 * so this function only ever adds derived data. It never edits `rawText`.
 */
export const onNoteCreated = onDocumentCreated(
  {
    document: 'users/{uid}/notes/{noteId}',
    database: DATABASE_ID,
    region: FIRESTORE_TRIGGER_REGION,
    secrets: [openaiKey],
    // One note is one cheap call; a stuck retry loop would just burn credit.
    retry: false,
  },
  async (event) => {
    const snap = event.data
    if (!snap) return

    const { uid, noteId } = event.params
    const note = snap.data()
    const rawText: string = (note?.rawText ?? '').trim()

    if (!rawText) {
      logger.warn('empty note, nothing to generate', { uid, noteId })
      await snap.ref.update({ status: 'failed', error: 'empty note' })
      return
    }

    // Event delivery is at-least-once. A redelivery after a successful run
    // should cost nothing, so bail before spending a token.
    if (note?.status === 'done' && (note?.cardIds?.length ?? 0) > 0) {
      logger.info('note already has cards, skipping', { uid, noteId })
      return
    }

    try {
      const result = await generateCards(rawText, openaiKey.value())

      const now = Timestamp.now()
      const batch = db.batch()
      const cardsRef = db.collection(`users/${uid}/cards`)
      const ids: string[] = []

      result.cards.forEach((card, i) => {
        const id = cardId(noteId, i)
        ids.push(id)

        // A brand-new FSRS card is due immediately, which is what makes a
        // freshly captured note reviewable the same day in Phase 2.
        const empty = createEmptyCard(now.toDate())

        batch.set(cardsRef.doc(id), {
          noteId,
          front: card.front,
          back: card.back,
          type: card.type,
          tags: card.tags,
          suspended: false,
          createdAt: now,
          updatedAt: now,
          due: Timestamp.fromDate(empty.due),
          stability: empty.stability,
          difficulty: empty.difficulty,
          scheduled_days: empty.scheduled_days,
          learning_steps: empty.learning_steps,
          reps: empty.reps,
          lapses: empty.lapses,
          state: empty.state,
          last_review: null,
        })
      })

      // A retry that produces fewer cards than the first attempt would
      // otherwise leave orphans behind, since the ids are deterministic.
      for (let i = result.cards.length; i < MAX_CARDS; i++) {
        batch.delete(cardsRef.doc(cardId(noteId, i)))
      }

      batch.update(snap.ref, {
        status: 'done',
        cardIds: ids,
        error: FieldValue.delete(),
      })

      await batch.commit()

      logger.info('cards generated', {
        uid,
        noteId,
        count: ids.length,
        fellBack: result.fellBack,
        usage: result.usage,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('card generation failed', { uid, noteId, message })

      // Leave the note intact and say so in the UI. rawText is the source of
      // truth, so a failure here is always recoverable by regenerating.
      await snap.ref.update({ status: 'failed', error: message.slice(0, 500) })
    }
  },
)

/**
 * Prompt iteration endpoint. Generates cards and writes nothing.
 *
 * Phase 1 lives or dies on card quality, and the only honest way to judge a
 * prompt change is to run a corpus of real notes through it and read the
 * output. Doing that through the trigger would mean a deploy per wording and a
 * Firestore full of junk notes. This endpoint takes an optional
 * `promptOverride` so a whole sweep costs one deploy and leaves no trace.
 *
 * It spends money, so it verifies the caller's ID token like every other
 * endpoint here. The allowlist in firestore.rules does not apply to Functions -
 * this is signed-in-user access, which for a friends-only app is the same set.
 */
export const dryRunCards = onRequest(
  { ...opts, secrets: [openaiKey] },
  async (req, res) => {
    let uid: string
    try {
      uid = (await requireUser(req.headers.authorization)).uid
    } catch {
      res.status(401).json({ ok: false, error: 'unauthenticated' })
      return
    }

    const rawText: string = (req.body?.rawText ?? '').toString().trim()
    const promptOverride: string | undefined = req.body?.promptOverride

    if (!rawText) {
      res.status(400).json({ ok: false, error: 'rawText required' })
      return
    }

    try {
      const result = await generateCards(rawText, openaiKey.value(), promptOverride)
      logger.info('dry run', { uid, chars: rawText.length, usage: result.usage })
      res.json({ ok: true, ...result })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('dry run failed', { uid, message })
      res.status(502).json({ ok: false, error: message })
    }
  },
)

// Phase 3 adds: transcribe    (POST audio -> text)
// Phase 4 adds: realtimeToken (mint ephemeral client secret, with a daily cap)
