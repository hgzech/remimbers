/**
 * Transcription: audio bytes -> text.
 *
 * No `openai` package, same reasoning as generate.ts - one endpoint doesn't
 * justify a dependency in a function that cold-starts on every capture.
 */

const TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions'

/**
 * `gpt-4o-transcribe` (and whisper-1, and the -mini and -diarize variants)
 * retire 26 Feb 2027. `gpt-transcribe` is the replacement, and is also cheaper
 * - $0.0045/min against $0.006.
 *
 * The migration is not just a rename: `gpt-transcribe` takes `languages`
 * (plural, repeated as `languages[]` in multipart) INSTEAD of the singular
 * `language`, and the two must never both be sent.
 */
const MODEL = 'gpt-transcribe'

/**
 * Codes this function will forward, mirroring LANGUAGES in src/lib/settings.ts.
 *
 * Duplicated rather than imported because the Functions build is a separate
 * tsconfig with its own rootDir - but the duplication is deliberate for a
 * second reason too: the client's list is a UI affordance, and this one is the
 * guard. An unknown code makes OpenAI reject the whole request, so a stale
 * client must degrade to the default rather than fail the capture outright.
 */
const VALID_LANGUAGES = new Set([
  'en', 'de', 'el', 'fr', 'es', 'it', 'pt', 'nl', 'da', 'sv', 'nb', 'fi',
  'pl', 'cs', 'hu', 'ro', 'tr', 'ru', 'uk', 'he', 'ar', 'hi', 'id', 'vi',
  'th', 'ja', 'ko', 'zh-cn', 'zh-tw',
])

/**
 * The fallback when the client sends nothing usable.
 *
 * NOT "send no languages at all". Unpinned, the model detects the language
 * itself, and on a three-second clip from an accented speaker it does not just
 * mis-hear - it renders the utterance in the language it guessed. "My mom's
 * birthday is 19.3" came back as "Mein Mutter Geburtstag ist 19.3": the broken
 * grammar is the tell that this is generated text, not heard text. That note
 * is then indistinguishable from a real one forever, so a stable wrong guess
 * beats an unpredictable one.
 */
const DEFAULT_LANGUAGES = ['en']

/** At most this many, for the reason given in src/lib/settings.ts. */
const MAX_LANGUAGES = 4

/**
 * Parse the `languages` query parameter: "en,de" -> ['en', 'de'].
 *
 * Unknown codes are dropped rather than rejected. A client one deploy behind,
 * or a hand-typed URL, should cost you accuracy - never the capture.
 */
export function parseLanguages(raw: unknown): string[] {
  if (typeof raw !== 'string') return DEFAULT_LANGUAGES
  const out: string[] = []
  for (const part of raw.split(',')) {
    const code = part.trim().toLowerCase()
    if (VALID_LANGUAGES.has(code) && !out.includes(code)) out.push(code)
    if (out.length === MAX_LANGUAGES) break
  }
  return out.length ? out : DEFAULT_LANGUAGES
}

/**
 * OpenAI's endpoint wants multipart/form-data with a named file, so the
 * filename's extension has to agree with the bytes. The browser side only
 * ever sends what MediaRecorder feature-detected (DESIGN.md section 5.2):
 * WebM/Opus on Chrome, MP4/AAC on Safari.
 */
function filenameFor(mimeType: string): string {
  if (mimeType.includes('mp4')) return 'capture.mp4'
  if (mimeType.includes('ogg')) return 'capture.ogg'
  if (mimeType.includes('wav')) return 'capture.wav'
  return 'capture.webm'
}

export interface Transcription {
  text: string
  /**
   * What the model decided it actually heard, echoed back by the API.
   *
   * Logged, because without it a bad transcript is undiagnosable: "the model
   * misheard the words" and "the model picked the wrong language and rewrote
   * the sentence in it" produce the same symptom - a note that reads wrong -
   * and only the second one is this file's problem. Empty when the model
   * would not commit to a guess.
   */
  detected: string[]
}

export async function transcribeAudio(
  audio: Buffer,
  mimeType: string,
  apiKey: string,
  languages: string[] = DEFAULT_LANGUAGES,
): Promise<Transcription> {
  const form = new FormData()
  form.append(
    'file',
    new Blob([new Uint8Array(audio)], { type: mimeType }),
    filenameFor(mimeType),
  )
  form.append('model', MODEL)

  // Repeated `languages[]` fields - the multipart convention for an array.
  // A single comma-joined `languages` value is silently ignored.
  for (const code of languages) form.append('languages[]', code)

  const res = await fetch(TRANSCRIPTION_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })

  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`openai ${res.status}: ${detail.slice(0, 500)}`)
  }

  // `as any`: same reasoning as generate.ts's response parsing - the envelope
  // is small here, but the raw-fetch return type still isn't `any` by default.
  const body = (await res.json()) as any
  const text = String(body?.text ?? '').trim()
  if (!text) throw new Error('empty transcript')

  // Shape is `languages: [{ code: 'en' }]`, and absent on older models.
  const detected: string[] = Array.isArray(body?.languages)
    ? body.languages.map((l: any) => String(l?.code ?? '')).filter(Boolean)
    : []

  return { text, detected }
}
