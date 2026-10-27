import { State } from 'ts-fsrs'
import type { Flashcard } from './types'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** "now", "in 20 min", "in 5 hours", "in 12 days", "in 3 months". */
export function formatUntil(due: Date, now: Date): string {
  const ms = due.getTime() - now.getTime()
  if (ms <= 0) return 'now'
  if (ms < HOUR) return `in ${Math.max(1, Math.round(ms / MIN))} min`
  if (ms < DAY) return `in ${plural(Math.round(ms / HOUR), 'hour')}`
  const days = Math.round(ms / DAY)
  if (days < 45) return `in ${plural(days, 'day')}`
  const months = Math.round(days / 30.44)
  if (months < 18) return `in ${plural(months, 'month')}`
  return `in ${(days / 365.25).toFixed(1)} years`
}

/** "3 days ago", "today". Coarse on purpose: this is for people, not for analysis. */
export function formatAgo(at: Date, now: Date): string {
  const days = Math.floor((now.getTime() - at.getTime()) / DAY)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 45) return `${days} days ago`
  const months = Math.round(days / 30.44)
  if (months < 18) return `${plural(months, 'month')} ago`
  return `${(days / 365.25).toFixed(1)} years ago`
}

/**
 * The one-line summary under a card in the library.
 *
 * Read straight off the card's FSRS state: `reps` and `lapses` are maintained
 * by the scheduler on every grade, so no review rows need fetching. `lapses`
 * counts the times a card you had learned was forgotten (rated Again from
 * the review state) - "forgot" is that, not every Again.
 */
export interface CardStatParts {
  isNew: boolean
  reviews: string | null
  forgot: string | null
  next: string
}

export function cardStats(card: Flashcard, now: Date): CardStatParts {
  const isNew = card.state === State.New
  const until = formatUntil(card.due.toDate(), now)
  return {
    isNew,
    reviews: isNew ? null : plural(card.reps, 'review'),
    forgot: card.lapses > 0 ? `forgot ${card.lapses}×` : null,
    next: until === 'now' ? 'due now' : `next ${until}`,
  }
}

/** Case- and accent-insensitive, so "muller" finds "Müller" and "αθηνα" finds "Αθήνα". */
export function normalize(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

/** The text a search runs against. Precomputed once per card, not per keystroke. */
export function searchText(card: Flashcard): string {
  return normalize([card.front, card.back, ...card.tags].join('\n'))
}

/** Every word of the query must appear somewhere in the card, in any order. */
export function matchesQuery(haystack: string, query: string): boolean {
  const terms = normalize(query).split(/\s+/).filter(Boolean)
  return terms.every((t) => haystack.includes(t))
}
