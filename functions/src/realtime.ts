/**
 * Realtime ephemeral token minting for Phase 4 voice review.
 *
 * No `openai` package, same reasoning as generate.ts and transcribe.ts - one
 * POST doesn't justify a dependency in a function that cold-starts per call.
 */

const CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets'

/**
 * The full model, not -mini. DESIGN.md section 4.2 assumed -mini, but we are
 * starting with quality and will step down to -mini later if the cost (about
 * 3x, per DESIGN.md section 7) turns out not to be worth it.
 */
export const REALTIME_MODEL = 'gpt-realtime-2.1'

/** OpenAI recommends `marin` or `cedar` for quality; Hilmar's pick. */
export const REALTIME_VOICE = 'marin'

/**
 * Mint a short-lived client secret scoped to one Realtime session.
 *
 * This is the only thing that ever sees the real OPENAI_API_KEY for voice
 * review - the browser gets back a token that expires in minutes and can only
 * open the one session it was minted for.
 */
export async function mintRealtimeToken(apiKey: string): Promise<string> {
  const res = await fetch(CLIENT_SECRETS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      session: {
        type: 'realtime',
        model: REALTIME_MODEL,
        audio: { output: { voice: REALTIME_VOICE } },
      },
    }),
  })

  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`openai ${res.status}: ${detail.slice(0, 500)}`)
  }

  // `as any`: same reasoning as generate.ts - a small, versioned envelope that
  // isn't worth a hand-typed interface for the one field we read.
  const body = (await res.json()) as any
  const token = body?.value ?? body?.client_secret?.value
  if (!token) throw new Error('no client secret in realtime token response')
  return token
}
