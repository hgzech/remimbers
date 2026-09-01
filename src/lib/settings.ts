import { doc, serverTimestamp, setDoc } from 'firebase/firestore'
import { db } from './firebase'

/**
 * Which languages the user speaks, and where that lives.
 *
 * This exists because transcription without a language pin does not merely
 * mis-hear, it TRANSLATES: a short English utterance detected as German comes
 * back as fluent-ish German prose, which then becomes a note, which then
 * becomes cards. Nothing downstream can tell that apart from a real capture.
 * Auto-detect is therefore not an acceptable default for this app - a wrong
 * guess silently corrupts the one thing (rawText) the whole deck is derived
 * from (DESIGN.md section 5.2).
 *
 * Kept at `users/{uid}/settings/prefs` - a SUBCOLLECTION doc, deliberately.
 * The rules' `users/{uid}/{document=**}` match covers documents BELOW the user
 * path but not the `users/{uid}` document itself, so storing this on a user
 * profile doc would have needed a rules change and a rules deploy to work.
 */

export interface LanguageOption {
  /** ISO 639-1, or one of the regional codes OpenAI accepts (zh-cn, zh-tw). */
  code: string
  /** English name, for scanning the list. */
  name: string
  /** Endonym, for recognising your own language at a glance. */
  native: string
}

/**
 * Offered languages. Not exhaustive by design - a 100-row list is worse to
 * use, and this is an app for one household plus a few friends. Adding a code
 * here is the whole cost of supporting another language; the API takes any
 * ISO 639-1 code.
 */
export const LANGUAGES: LanguageOption[] = [
  { code: 'en', name: 'English', native: 'English' },
  { code: 'de', name: 'German', native: 'Deutsch' },
  { code: 'el', name: 'Greek', native: 'Ελληνικά' },
  { code: 'fr', name: 'French', native: 'Français' },
  { code: 'es', name: 'Spanish', native: 'Español' },
  { code: 'it', name: 'Italian', native: 'Italiano' },
  { code: 'pt', name: 'Portuguese', native: 'Português' },
  { code: 'nl', name: 'Dutch', native: 'Nederlands' },
  { code: 'da', name: 'Danish', native: 'Dansk' },
  { code: 'sv', name: 'Swedish', native: 'Svenska' },
  { code: 'nb', name: 'Norwegian', native: 'Norsk' },
  { code: 'fi', name: 'Finnish', native: 'Suomi' },
  { code: 'pl', name: 'Polish', native: 'Polski' },
  { code: 'cs', name: 'Czech', native: 'Čeština' },
  { code: 'hu', name: 'Hungarian', native: 'Magyar' },
  { code: 'ro', name: 'Romanian', native: 'Română' },
  { code: 'tr', name: 'Turkish', native: 'Türkçe' },
  { code: 'ru', name: 'Russian', native: 'Русский' },
  { code: 'uk', name: 'Ukrainian', native: 'Українська' },
  { code: 'he', name: 'Hebrew', native: 'עברית' },
  { code: 'ar', name: 'Arabic', native: 'العربية' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी' },
  { code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia' },
  { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt' },
  { code: 'th', name: 'Thai', native: 'ไทย' },
  { code: 'ja', name: 'Japanese', native: '日本語' },
  { code: 'ko', name: 'Korean', native: '한국어' },
  { code: 'zh-cn', name: 'Chinese (Simplified)', native: '简体中文' },
  { code: 'zh-tw', name: 'Chinese (Traditional)', native: '繁體中文' },
]

const VALID = new Set(LANGUAGES.map((l) => l.code))

/**
 * The fallback when a user somehow reaches transcription without having
 * answered. English rather than "no pin at all", because no pin is the bug
 * this file exists to fix - a wrong-but-stable language is recoverable, an
 * unpredictable one is not.
 */
export const DEFAULT_LANGUAGES = ['en']

/**
 * The picker's cap, and the reason it has one.
 *
 * `languages` is a hint that narrows the model's candidate set, so its value
 * decays with every entry added: pinning six languages is barely different
 * from pinning none. Four is generous for a capture app - you are unlikely to
 * think out loud in more than that - and keeping the list short is the entire
 * accuracy win, so the UI says so rather than quietly allowing it.
 */
export const MAX_LANGUAGES = 4

export interface UserSettings {
  languages: string[]
}

export function settingsDocRef(uid: string) {
  return doc(db, 'users', uid, 'settings', 'prefs')
}

/**
 * Drop anything not in the offered list, de-duplicate, and cap.
 *
 * Applied on read as well as write: the stored value can predate a change to
 * LANGUAGES, and a code the API rejects would fail the whole transcription
 * rather than degrading to auto-detect.
 */
export function sanitizeLanguages(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    const code = String(item).toLowerCase()
    if (VALID.has(code) && !out.includes(code)) out.push(code)
    if (out.length === MAX_LANGUAGES) break
  }
  return out
}

export async function saveLanguages(uid: string, languages: string[]): Promise<void> {
  await setDoc(
    settingsDocRef(uid),
    { languages: sanitizeLanguages(languages), updatedAt: serverTimestamp() },
    { merge: true },
  )
}

/** The endonym, for labelling a code that came back from storage. */
export function languageLabel(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.native ?? code
}

/**
 * A best guess at the browser's languages, used to pre-tick the first-run
 * picker. Only a starting point - the whole point of asking is that the
 * browser's answer is often wrong (a German-locale phone used to capture in
 * English is exactly the case that produced this bug).
 */
export function guessLanguages(): string[] {
  const tags = navigator.languages?.length
    ? navigator.languages
    : [navigator.language || 'en']
  const guessed: string[] = []
  for (const tag of tags) {
    const lower = tag.toLowerCase()
    const code = VALID.has(lower) ? lower : lower.split('-')[0]
    if (VALID.has(code) && !guessed.includes(code)) guessed.push(code)
    if (guessed.length === 2) break
  }
  return guessed.length ? guessed : DEFAULT_LANGUAGES
}
