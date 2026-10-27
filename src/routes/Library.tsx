import { useEffect, useMemo, useState } from 'react'
import { State } from 'ts-fsrs'
import { useAuth } from '../auth/AuthProvider'
import { CardDetail } from '../components/CardDetail'
import { CardForm } from '../components/CardForm'
import { CardStatsLine } from '../components/CardStatsLine'
import { ImportPanel } from '../components/ImportPanel'
import { addManualCard, subscribeToAllCards } from '../lib/cards'
import {
  FIRST_DIR,
  formatUntil,
  matchesQuery,
  searchText,
  sortCards,
  type Sort,
  type SortKey,
} from '../lib/cardStats'
import { deleteNote, retryNote, subscribeToUnfinishedNotes } from '../lib/notes'
import type { Flashcard, Note } from '../lib/types'
import { useMediaQuery } from '../lib/useMediaQuery'

/** Cards rendered before "Show more". Search and sorting cover the whole deck regardless. */
const PAGE = 100

/**
 * The width from which the library becomes a table with a side panel.
 * Low enough that an iPad in portrait (about 810 px) gets it.
 */
const WIDE = '(min-width: 768px)'

const SHORT_DATE = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })

/**
 * The library: every card, with search, manual adding and CSV import.
 *
 * Two layouts over the same data and the same card component. On a phone,
 * a list where tapping a card opens it in place. On a large screen, a
 * sortable table with the selected card in a panel beside it.
 *
 * Cards, not notes. The note a card came from is one tap away in the card,
 * and otherwise stays out of sight. The only notes shown here are captures
 * that have no card yet - still being written, or failed - because this is
 * the one place those can be seen and retried.
 */
export function Library() {
  const { user } = useAuth()
  const uid = user?.uid
  const wide = useMediaQuery(WIDE)

  // `at` is when the snapshot arrived. Relative times ("next in 3 days") are
  // computed against it rather than against a clock read during render.
  const [deck, setDeck] = useState<{ cards: Flashcard[]; at: Date } | null>(null)
  const [unfinished, setUnfinished] = useState<Note[]>([])
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<Sort>({ key: 'added', dir: 'desc' })
  const [shown, setShown] = useState(PAGE)
  const [openId, setOpenId] = useState<string | null>(null)
  // What the add area shows: nothing, the new-card form, or the file import.
  const [adding, setAdding] = useState<false | 'card' | 'file'>(false)
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
    const found = search.trim()
      ? cards.filter((c) => matchesQuery(haystacks.get(c.id) ?? '', search))
      : cards
    // The query already returns newest first, so the default needs no work.
    return sort.key === 'added' && sort.dir === 'desc' ? found : sortCards(found, sort)
  }, [deck, haystacks, search, sort])

  if (!uid || deck === null) {
    return (
      <div className="centered">
        <div className="spinner" aria-label="Loading" />
      </div>
    )
  }

  const total = deck.cards.length
  const searching = search.trim() !== ''
  const openCard = openId ? deck.cards.find((c) => c.id === openId) : undefined

  function toggle(id: string) {
    setOpenId((current) => (current === id ? null : id))
    setAdding(false)
  }

  function startAdding() {
    setAdding('card')
    setAddedCount(0)
    setSearch('')
    setOpenId(null)
  }

  function sortBy(key: SortKey) {
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: FIRST_DIR[key] },
    )
    setShown(PAGE)
  }

  const addPanel =
    adding === 'file' ? (
      <ImportPanel uid={uid} existing={deck.cards} onClose={() => setAdding(false)} />
    ) : adding === 'card' && (
    <section className="lib-add">
      <p className="lib-panel-title">New card</p>
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
          {addedCount === 1 ? 'Card added.' : `${addedCount} cards added.`} Type the next one, or
          {wide ? ' click' : ' tap'} Done.
        </p>
      )}
      {addedCount === 0 && (
        <button className="linkbtn lib-import-link" onClick={() => setAdding('file')}>
          Import many from a file…
        </button>
      )}
    </section>
  )

  const cardsView =
    total === 0 ? (
      <p className="empty lib-empty">No cards yet. Capture something, or add a card by hand.</p>
    ) : results.length === 0 ? (
      <p className="empty lib-empty">No cards match “{search.trim()}”.</p>
    ) : (
      <>
        {searching && (
          <p className="lib-count">{results.length === 1 ? '1 card' : `${results.length} cards`}</p>
        )}
        {wide ? (
          <CardTable
            cards={results.slice(0, shown)}
            now={deck.at}
            sort={sort}
            onSort={sortBy}
            selectedId={openId}
            onSelect={toggle}
          />
        ) : (
          <ul className="lib-list">
            {results.slice(0, shown).map((card) => (
              <LibraryCard
                key={card.id}
                card={card}
                uid={uid}
                now={deck.at}
                open={openId === card.id}
                onToggle={() => toggle(card.id)}
              />
            ))}
          </ul>
        )}
        {results.length > shown && (
          <button className="btn btn-small lib-more" onClick={() => setShown((n) => n + PAGE)}>
            Show more ({results.length - shown} left)
          </button>
        )}
      </>
    )

  // On a large screen the panel holds whatever you are working on: the new
  // card form, or the selected card. Nothing selected, no panel.
  const panel = wide && (addPanel || (openCard && (
    <section className="lib-panel-card">
      <CardDetail
        key={`${openCard.id}:${openCard.updatedAt?.toMillis()}`}
        card={openCard}
        uid={uid}
        now={deck.at}
        onClose={() => setOpenId(null)}
      />
    </section>
  )))

  return (
    <div className={`library${wide ? ' library-wide' : ''}`}>
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
          <button className="btn btn-primary btn-small lib-add-btn" onClick={startAdding}>
            Add card
          </button>
        )}
      </div>

      {!wide && addPanel}

      {unfinished.length > 0 && !searching && (
        <ul className="lib-pending">
          {unfinished.map((note) => (
            <UnfinishedNote key={note.id} note={note} uid={uid} />
          ))}
        </ul>
      )}

      {wide ? (
        <div className={`lib-split${panel ? ' with-panel' : ''}`}>
          <div className="lib-main">{cardsView}</div>
          {panel && <aside className="lib-panel">{panel}</aside>}
        </div>
      ) : (
        cardsView
      )}
    </div>
  )
}

/** Phone: a card in the list. Tapping it opens it in place, ready to edit. */
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
  if (open) {
    return (
      <li className="lib-card open">
        <CardDetail
          key={`${card.id}:${card.updatedAt?.toMillis()}`}
          card={card}
          uid={uid}
          now={now}
          onClose={onToggle}
        />
      </li>
    )
  }
  return (
    <li className="lib-card">
      <button className="lib-card-face" onClick={onToggle} aria-expanded={false}>
        <p className="lib-front">{card.front}</p>
        <p className="lib-back">{card.back}</p>
        <CardStatsLine card={card} now={now} />
      </button>
    </li>
  )
}

const COLUMNS: { key: SortKey | null; label: string; className: string }[] = [
  { key: 'question', label: 'Question', className: 'col-q' },
  { key: null, label: 'Answer', className: 'col-a' },
  { key: 'reviews', label: 'Reviews', className: 'col-num col-reviews' },
  { key: 'forgot', label: 'Forgot', className: 'col-num col-forgot' },
  { key: 'due', label: 'Next', className: 'col-next' },
  { key: 'added', label: 'Added', className: 'col-added' },
]

/** Large screen: one row per card, sortable by clicking a column heading. */
function CardTable({
  cards,
  now,
  sort,
  onSort,
  selectedId,
  onSelect,
}: {
  cards: Flashcard[]
  now: Date
  sort: Sort
  onSort: (key: SortKey) => void
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  return (
    <div className="lib-table-wrap">
      <table className="lib-table">
        <thead>
          <tr>
            {COLUMNS.map((col) => (
              <th
                key={col.label}
                className={col.className}
                aria-sort={
                  col.key && sort.key === col.key
                    ? sort.dir === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : undefined
                }
              >
                {col.key ? (
                  <button
                    className={`lib-sort${sort.key === col.key ? ' active' : ''}`}
                    onClick={() => onSort(col.key!)}
                  >
                    {col.label}
                    <span className="lib-sort-arrow" aria-hidden>
                      {sort.key === col.key ? (sort.dir === 'asc' ? '↑' : '↓') : ''}
                    </span>
                  </button>
                ) : (
                  col.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cards.map((card) => {
            const until = formatUntil(card.due.toDate(), now)
            const isNew = card.state === State.New
            return (
              <tr
                key={card.id}
                className={card.id === selectedId ? 'selected' : undefined}
                onClick={() => onSelect(card.id)}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelect(card.id)
                  }
                }}
              >
                <td className="col-q">
                  <span className="lib-clamp">{card.front}</span>
                </td>
                <td className="col-a">
                  <span className="lib-clamp">{card.back}</span>
                </td>
                <td className="col-num col-reviews">
                  {isNew ? <span className="lib-new">New</span> : card.reps}
                </td>
                <td className="col-num col-forgot">
                  {card.lapses > 0 ? (
                    <span className="lib-forgot">{card.lapses}×</span>
                  ) : (
                    <span className="lib-dim">–</span>
                  )}
                </td>
                <td className="col-next">{until === 'now' ? 'due now' : until.replace(/^in /, '')}</td>
                <td className="col-added">
                  {card.createdAt ? SHORT_DATE.format(card.createdAt.toDate()) : ''}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
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
