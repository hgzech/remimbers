import { useState } from 'react'
import { deleteCard, updateCardText } from '../lib/cards'
import { formatAgo } from '../lib/cardStats'
import { fetchNote } from '../lib/notes'
import type { Flashcard, Note } from '../lib/types'
import { CardForm } from './CardForm'

type Mode = 'view' | 'edit' | 'confirm-delete'

/** Note lookup state: not asked yet, loading, or answered (null = note is gone). */
type SourceState = { status: 'closed' } | { status: 'loading' } | { status: 'open'; note: Note | null }

const DATE = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

/**
 * Everything you can do with one card: see when it was added and last
 * reviewed, edit it, delete it, and - only if you ask - see what it was made
 * from. Used below a tapped card on the phone; the large-screen layout will
 * show the same thing in a side panel.
 */
export function CardDetail({
  card,
  uid,
  now,
  onDeleted,
}: {
  card: Flashcard
  uid: string
  now: Date
  onDeleted: () => void
}) {
  const [mode, setMode] = useState<Mode>('view')
  const [source, setSource] = useState<SourceState>({ status: 'closed' })

  if (mode === 'edit') {
    return (
      <div className="card-detail">
        <CardForm
          initialFront={card.front}
          initialBack={card.back}
          submitLabel="Save"
          onSubmit={(fields) => {
            void updateCardText(uid, card.id, fields).written
            setMode('view')
          }}
          onCancel={() => setMode('view')}
        />
      </div>
    )
  }

  function toggleSource() {
    if (source.status !== 'closed') {
      setSource({ status: 'closed' })
      return
    }
    setSource({ status: 'loading' })
    fetchNote(uid, card.noteId)
      .then((note) => setSource({ status: 'open', note }))
      .catch(() => setSource({ status: 'open', note: null }))
  }

  const created = card.createdAt?.toDate()
  // Generated cards get createdAt and updatedAt from the same instant, so any
  // gap means someone changed the text afterwards.
  const edited =
    card.updatedAt && card.createdAt && card.updatedAt.toMillis() - card.createdAt.toMillis() > 1000
      ? card.updatedAt.toDate()
      : null
  const meta = [
    created ? `Added ${DATE.format(created)}` : null,
    card.last_review ? `last reviewed ${formatAgo(card.last_review.toDate(), now)}` : 'not reviewed yet',
    edited ? `edited ${formatAgo(edited, now)}` : null,
  ].filter(Boolean)

  return (
    <div className="card-detail">
      <p className="card-detail-meta">{meta.join(' · ')}</p>

      {source.status !== 'closed' && (
        <p className="card-detail-source">
          {source.status === 'loading'
            ? 'Loading…'
            : source.note === null
              ? 'The note this came from is gone.'
              : source.note.source === 'manual'
                ? 'You added this card by hand.'
                : source.note.rawText}
        </p>
      )}

      {mode === 'confirm-delete' ? (
        <div className="card-detail-actions">
          <span className="card-detail-ask">Delete this card?</span>
          <span className="card-spacer" />
          <button className="linkbtn" onClick={() => setMode('view')}>
            Cancel
          </button>
          <button
            className="btn btn-small btn-danger"
            onClick={() => {
              void deleteCard(uid, card)
              onDeleted()
            }}
          >
            Delete
          </button>
        </div>
      ) : (
        <div className="card-detail-actions">
          <button className="linkbtn" onClick={toggleSource}>
            {source.status === 'closed' ? 'Source' : 'Hide source'}
          </button>
          <span className="card-spacer" />
          <button className="linkbtn" onClick={() => setMode('edit')}>
            Edit
          </button>
          <button className="linkbtn danger" onClick={() => setMode('confirm-delete')}>
            Delete
          </button>
        </div>
      )}
    </div>
  )
}
