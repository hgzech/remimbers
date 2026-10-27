import { cardStats } from '../lib/cardStats'
import type { Flashcard } from '../lib/types'

/** "8 reviews · forgot 2× · next in 12 days", or "New · due now". */
export function CardStatsLine({
  card,
  now,
  className = 'lib-stats',
}: {
  card: Flashcard
  now: Date
  className?: string
}) {
  const stats = cardStats(card, now)
  return (
    <p className={className}>
      {stats.isNew ? <span className="lib-new">New</span> : stats.reviews}
      {stats.forgot && (
        <>
          {' · '}
          <span className="lib-forgot">{stats.forgot}</span>
        </>
      )}
      {' · '}
      {stats.next}
    </p>
  )
}
