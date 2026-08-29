/**
 * Transcription: audio bytes -> text.
 *
 * No `openai` package, same reasoning as generate.ts - one endpoint doesn't
 * justify a dependency in a function that cold-starts on every capture.
 */

const TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions'
const MODEL = 'gpt-4o-transcribe'

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

export async function transcribeAudio(
  audio: Buffer,
  mimeType: string,
  apiKey: string,
): Promise<string> {
  const form = new FormData()
  form.append(
    'file',
    new Blob([new Uint8Array(audio)], { type: mimeType }),
    filenameFor(mimeType),
  )
  form.append('model', MODEL)

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
  return text
}
