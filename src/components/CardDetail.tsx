import { useId, useState, type KeyboardEvent } from 'react'
import { deleteCard, updateCardText } from '../lib/cards'
import { formatAgo } from '../lib/cardStats'
import { fetchNote } from '../lib/notes'
import type { Flashcard, Note } from '../lib/types'
import { CardStatsLine } from './CardStatsLine'

/** Note lookup state: not asked yet, loading, or answered (null = note is gone). */
type SourceState = { status: 'closed' } | { status: 'loading' } | { status: 'open'; note: Note | null }

const DATE = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

/**
 * Rows for a textarea that fits its text, so an opened card looks like the
 * card rather than like a form. Rough on purpose (about 42 characters a line
 * at phone width); CSS `field-sizing: content` refines it where supported.
 */
function rowsFor(text: string) {
  const lines = text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 42)), 0)
  return Math.min(10, Math.max(1, lines))
}

/**
 * One card, opened: question and answer as editable text, its stats and
 * dates, its source on request, and Delete.
 *
 * Opening a card IS editing it - there is no separate Edit step. The fields
 * are not focused on open, so on a phone the keyboard only appears when you
 * tap into one. Save and Cancel appear once something has changed.
 *
 * The draft is taken from the card when this mounts. The parent keys it on
 * the card's `updatedAt`, so a change saved elsewhere remounts it with the
 * new text instead of leaving a stale draft that looks like an edit.
 */
export function CardDetail({
  card,
  uid,
  now,
  onClose,
}: {
  card: Flashcard
  uid: string
  now: Date
  onClose: () => void
}) {
  const id = useId()
  const [front, setFront] = useState(card.front)
  const [back, setBack] = useState(card.back)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [source, setSource] = useState<SourceState>({ status: 'closed' })

  const dirty = front.trim() !== card.front || back.trim() !== card.back
  const valid = front.trim() !== '' && back.trim() !== ''

  function save() {
    if (!dirty || !valid) return
    void updateCardText(uid, card.id, { front, back }).written
    onClose()
  }

  function revert() {
    setFront(card.front)
    setBack(card.back)
  }

  // Ctrl/Cmd+Enter saves, Escape throws the edit away (or closes the card).
  // Free on a laptop, invisible on a phone.
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      save()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (dirty) revert()
      else onClose()
    }
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
  // gap means the text was changed afterwards.
  const edited =
    card.updatedAt && card.createdAt && card.updatedAt.toMillis() - card.createdAt.toMillis() > 1000
      ? card.updatedAt.toDate()
      : null
  const dates = [
    created ? `Added ${DATE.format(created)}` : null,
    card.last_review ? `last reviewed ${formatAgo(card.last_review.toDate(), now)}` : null,
    edited ? `edited ${formatAgo(edited, now)}` : null,
  ].filter(Boolean)

  return (
    <div className="card-detail">
      <label className="sr-only" htmlFor={`${id}-front`}>
        Question
      </label>
      <textarea
        id={`${id}-front`}
        className="card-detail-input card-detail-front"
        value={front}
        rows={rowsFor(front)}
        onChange={(e) => setFront(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Question"
      />
      <label className="sr-only" htmlFor={`${id}-back`}>
        Answer
      </label>
      <textarea
        id={`${id}-back`}
        className="card-detail-input card-detail-back"
        value={back}
        rows={rowsFor(back)}
        onChange={(e) => setBack(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Answer"
      />

      <CardStatsLine card={card} now={now} className="lib-stats card-detail-stats" />
      {dates.length > 0 && <p className="card-detail-meta">{dates.join(' · ')}</p>}

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

      <div className="card-detail-actions">
        {dirty ? (
          <>
            <span className="card-detail-ask">Edited</span>
            <span className="card-spacer" />
            <button className="linkbtn" onClick={revert}>
              Cancel
            </button>
            <button className="btn btn-primary btn-small" onClick={save} disabled={!valid}>
              Save
            </button>
          </>
        ) : confirmingDelete ? (
          <>
            <span className="card-detail-ask">Delete this card?</span>
            <span className="card-spacer" />
            <button className="linkbtn" onClick={() => setConfirmingDelete(false)}>
              Keep
            </button>
            <button
              className="btn btn-small btn-danger"
              onClick={() => {
                void deleteCard(uid, card)
                onClose()
              }}
            >
              Delete
            </button>
          </>
        ) : (
          <>
            <button className="linkbtn" onClick={toggleSource}>
              {source.status === 'closed' ? 'Source' : 'Hide source'}
            </button>
            <button className="linkbtn danger" onClick={() => setConfirmingDelete(true)}>
              Delete
            </button>
            <span className="card-spacer" />
            <button className="linkbtn" onClick={onClose}>
              Close
            </button>
          </>
        )}
      </div>
    </div>
  )
}
