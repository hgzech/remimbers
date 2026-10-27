import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { CardDetail } from '../components/CardDetail'
import { CardForm } from '../components/CardForm'
import { addManualCard, subscribeToAllCards } from '../lib/cards'
import { cardStats, matchesQuery, searchText } from '../lib/cardStats'
import { deleteNote, retryNote, subscribeToUnfinishedNotes } from '../lib/notes'
import type { Flashcard, Note } from '../lib/types'

/** Cards rendered before "Show more". Search runs over the whole deck regardless. */
const PAGE = 100

/**
 * The library: every card, newest first, with search and manual adding.
 *
 * Cards, not notes. The note a card came from is one tap away in the card's
 * detail, and otherwise stays out of sight. The only notes shown here are
 * captures that have no card yet - still being written, or failed - because
 * this is the one place those can be seen and retried.
 */
export function Library() {
  const { user } = useAuth()
  const uid = user?.uid
  // `at` is when the snapshot arrived. Relative times ("next in 3 days") are
  // computed against it rather than against a clock read during render.
  const [deck, setDeck] = useState<{ cards: Flashcard[]; at: Date } | null>(null)
  const [unfinished, setUnfinished] = useState<Note[]>([])
  const [search, setSearch] = useState('')
  const [shown, setShown] = useState(PAGE)
  const [openId, setOpenId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [addedCount, setAddedCount] = useState(0)

  useEffect(() => {
    if (!uid) return
    return subscribeToAllCards(uid, (cards) => setDeck({ cards, at: new Date() }))
  }, [uid])

  useEffect(() => {
    if (!uid) return
    return subscribeToUnfinishedNotes(uid, setUnfinished)
  }, [uid])

  const haystacks = useMemo(
    () => new Map((deck?.cards ?? []).map((c) => [c.id, searchText(c)])),
    [deck],
  )

  const results = useMemo(() => {
    const cards = deck?.cards ?? []
    if (!search.trim()) return cards
    return cards.filter((c) => matchesQuery(haystacks.get(c.id) ?? '', search))
  }, [deck, haystacks, search])

  if (!uid || deck === null) {
    return (
      <div className="centered">
        <div className="spinner" aria-label="Loading" />
      </div>
    )
  }

  const total = deck.cards.length
  const searching = search.trim() !== ''

  return (
    <div className="library">
      <div className="lib-bar">
        <input
          type="search"
          className="lib-search"
          placeholder={total > 0 ? `Search ${total} cards` : 'Search'}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setShown(PAGE)
          }}
          aria-label="Search cards"
        />
        {!adding && (
          <button
            className="btn btn-primary btn-small lib-add-btn"
            onClick={() => {
              setAdding(true)
              setAddedCount(0)
              setSearch('')
            }}
          >
            Add card
          </button>
        )}
      </div>

      {adding && (
        <section className="lib-add">
          <CardForm
            key={addedCount}
            submitLabel="Add"
            cancelLabel="Done"
            onSubmit={(fields) => {
              void addManualCard(uid, fields).written
              setAddedCount((n) => n + 1)
            }}
            onCancel={() => setAdding(false)}
          />
          {addedCount > 0 && (
            <p className="lib-add-note">
              {addedCount === 1 ? 'Card added.' : `${addedCount} cards added.`} Type the next
              one, or tap Done.
            </p>
          )}
        </section>
      )}

      {unfinished.length > 0 && !searching && (
        <ul className="lib-pending">
          {unfinished.map((note) => (
            <UnfinishedNote key={note.id} note={note} uid={uid} />
          ))}
        </ul>
      )}

      {total === 0 ? (
        <p className="empty lib-empty">
          No cards yet. Capture something, or add a card by hand.
        </p>
      ) : results.length === 0 ? (
        <p className="empty lib-empty">No cards match “{search.trim()}”.</p>
      ) : (
        <>
          {searching && (
            <p className="lib-count">
              {results.length === 1 ? '1 card' : `${results.length} cards`}
            </p>
          )}
          <ul className="lib-list">
            {results.slice(0, shown).map((card) => (
              <LibraryCard
                key={card.id}
                card={card}
                uid={uid}
                now={deck.at}
                open={openId === card.id}
                onToggle={() => setOpenId((id) => (id === card.id ? null : card.id))}
              />
            ))}
          </ul>
          {results.length > shown && (
            <button className="btn btn-small lib-more" onClick={() => setShown((n) => n + PAGE)}>
              Show more ({results.length - shown} left)
            </button>
          )}
        </>
      )}
    </div>
  )
}

function LibraryCard({
  card,
  uid,
  now,
  open,
  onToggle,
}: {
  card: Flashcard
  uid: string
  now: Date
  open: boolean
  onToggle: () => void
}) {
  const stats = cardStats(card, now)
  return (
    <li className={`lib-card${open ? ' open' : ''}`}>
      <button className="lib-card-face" onClick={onToggle} aria-expanded={open}>
        <p className="lib-front">{card.front}</p>
        <p className="lib-back">{card.back}</p>
        <p className="lib-stats">
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
      </button>
      {open && <CardDetail key={card.id} card={card} uid={uid} now={now} onDeleted={onToggle} />}
    </li>
  )
}

/** A capture with no cards yet: being written, or failed and waiting for a retry. */
function UnfinishedNote({ note, uid }: { note: Note; uid: string }) {
  const [confirming, setConfirming] = useState(false)
  const failed = note.status === 'failed'

  return (
    <li className="lib-pending-item">
      <p className="lib-pending-text">{note.rawText}</p>
      {failed ? (
        <div className="lib-pending-actions">
          <span className="lib-pending-status bad">{note.error ?? 'Could not write cards'}</span>
          <span className="card-spacer" />
          {confirming ? (
            <>
              <button className="linkbtn" onClick={() => setConfirming(false)}>
                Keep
              </button>
              <button className="btn btn-small btn-danger" onClick={() => void deleteNote(uid, note.id)}>
                Delete
              </button>
            </>
          ) : (
            <>
              <button className="linkbtn danger" onClick={() => setConfirming(true)}>
                Delete
              </button>
              <button className="btn btn-small" onClick={() => void retryNote(uid, note)}>
                Try again
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="lib-pending-actions">
          <span className="lib-pending-status">Writing cards…</span>
        </div>
      )}
    </li>
  )
}
