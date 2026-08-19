import { onRequest } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'

initializeApp()

/**
 * The only real secret in the system. Set it once, from your own terminal:
 *
 *   firebase functions:secrets:set OPENAI_API_KEY
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

// Phase 1 adds: generateCards (Firestore onCreate trigger)
// Phase 3 adds: transcribe   (POST audio -> text)
// Phase 4 adds: realtimeToken (mint ephemeral client secret, with a daily cap)
