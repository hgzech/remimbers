import {
  ConvertStepUnitToMinutes,
  FSRSVersion,
  fsrs,
  generatorParameters,
  Rating,
  type Grade,
} from 'ts-fsrs'

/**
 * One scheduler, one parameter set, constructed once.
 *
 * This module exists so that the numbers used to schedule a card and the
 * numbers written into its review log are provably the same object. If a
 * second `fsrs()` call appeared somewhere in the UI with slightly different
 * options, the log would claim a schedule that was never actually applied and
 * Phase 5's optimisation would be fitting to a fiction.
 */
export const FSRS_PARAMS = generatorParameters()

export const scheduler = fsrs(FSRS_PARAMS)

/** e.g. "v5.4.1 using FSRS-6.0" - logged so a library upgrade is visible later. */
export const FSRS_VERSION = FSRSVersion

/**
 * The parameters as a plain, Firestore-safe object.
 *
 * ts-fsrs hands back readonly arrays; Firestore rejects those, and we want a
 * detached copy anyway so a later mutation cannot retroactively change what a
 * historical review appears to have been scheduled with.
 */
export function schedulerSnapshot() {
  return {
    version: FSRS_VERSION,
    w: [...FSRS_PARAMS.w],
    request_retention: FSRS_PARAMS.request_retention,
    maximum_interval: FSRS_PARAMS.maximum_interval,
    enable_fuzz: FSRS_PARAMS.enable_fuzz,
    enable_short_term: FSRS_PARAMS.enable_short_term,
    learning_steps: [...FSRS_PARAMS.learning_steps],
    relearning_steps: [...FSRS_PARAMS.relearning_steps],
  }
}

/**
 * How far ahead a card can be scheduled and still be shown again this session.
 *
 * FSRS's learning steps are measured in minutes: a card you rate `Again` is due
 * in one minute, not tomorrow. A queue that dropped it the moment it was graded
 * would silently turn `Again` into "see you next week", which is the opposite of
 * what the button means. So anything landing inside the longest (re)learning
 * step goes back into the local queue instead.
 *
 * Derived from the parameters rather than hardcoded, so changing the steps in
 * Phase 5 cannot leave this stale. The five-minute cushion covers the time you
 * spend on the cards in between.
 */
const stepMinutes = [
  ...FSRS_PARAMS.learning_steps,
  ...FSRS_PARAMS.relearning_steps,
].map(ConvertStepUnitToMinutes)

export const SESSION_HORIZON_MS = (Math.max(0, ...stepMinutes) + 5) * 60_000

export const GRADES: { rating: Grade; label: string; key: string }[] = [
  { rating: Rating.Again, label: 'Again', key: '1' },
  { rating: Rating.Hard, label: 'Hard', key: '2' },
  { rating: Rating.Good, label: 'Good', key: '3' },
  { rating: Rating.Easy, label: 'Easy', key: '4' },
]

/**
 * Human interval, Anki-style: "10m", "1d", "3.2mo".
 *
 * Shown on the buttons before you press them. This is the one piece of the
 * scheduler the user actually sees, and seeing it is most of what makes the
 * four ratings feel like choices rather than a guess.
 */
export function formatInterval(from: Date, to: Date): string {
  const minutes = Math.round((to.getTime() - from.getTime()) / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`

  const hours = minutes / 60
  if (hours < 24) return `${Math.round(hours)}h`

  const days = hours / 24
  if (days < 30) return days < 10 ? `${round1(days)}d` : `${Math.round(days)}d`

  const months = days / 30.44
  if (months < 12) return `${round1(months)}mo`

  return `${round1(days / 365.25)}y`
}

function round1(n: number): string {
  return (Math.round(n * 10) / 10).toString()
}
