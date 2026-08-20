import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { retryNote, subscribeToRecentNotes } from '../lib/notes'
import {
  deleteCard,
  deleteNoteWithCards,
  groupByNote,
  subscribeToRecentCards,
  updateCardText,
} from '../lib/cards'
import type { Flashcard, Note } from '../lib/types'

const NOTE_LIMIT = 50
// Five cards per note is the generation ceiling, so this covers the notes above
// it with room to spare. One query, grouped client-side.
const CARD_LIMIT = NOTE_LIMIT * 5

export function Library() {
  const { user } = useAuth()
  const [notes, setNotes] = useState<Note[] | null>(null)
  const [cards, setCards] = useState<Flashcard[]>([])

  useEffect(() => {
    if (!user) return
    return subscribeToRecentNotes(user.uid, NOTE_LIMIT, setNotes)
  }, [user])

  useEffect(() => {
    if (!user) return
    return subscribeToRecentCards(user.uid, CARD_LIMIT, setCards)
  }, [user])

  const cardsByNote = useMemo(() => groupByNote(cards), [cards])

  if (notes === null) {
    return (
      <div className="centered">
        <div className="spinner" aria-label="Loading" />
      </div>
    )
  }

  if (notes.length === 0) {
    return (
      <div className="centered">
        <p className="empty">Nothing captured yet.</p>
      </div>
    )
  }

  return (
    <>
      <p className="hint list-note">
        Your notes, and the cards written from them. Edit a card that reads
        badly &mdash; the note stays as it was.
      </p>
      <ul className="note-list">
        {notes.map((note) => (
          <NoteRow
            key={note.id}
            note={note}
            cards={cardsByNote.get(note.id) ?? []}
            uid={user!.uid}
          />
        ))}
      </ul>
    </>
  )
}

function NoteRow({
  note,
  cards,
  uid,
}: {
  note: Note
  cards: Flashcard[]
  uid: string
}) {
  return (
    <li className="note">
      <p className="note-text">{note.rawText}</p>

      <div className="note-meta">
        <span>{note.createdAt?.toDate().toLocaleDateString() ?? 'just now'}</span>
        {note.status === 'generating' && (
          <span className="badge badge-live">writing cards…</span>
        )}
        {note.status === 'failed' && <span className="badge badge-bad">failed</span>}
        {note.status === 'done' && (
          <span className="badge">
            {cards.length === 1 ? '1 card' : `${cards.length} cards`}
          </span>
        )}
        <button
          className="linkbtn danger note-delete"
          onClick={() => {
            if (confirm('Delete this note and its cards?')) {
              void deleteNoteWithCards(uid, note.id, cards)
            }
          }}
        >
          Delete note
        </button>
      </div>

      {note.status === 'failed' && (
        <div className="card-fail">
          <p className="card-fail-msg">{note.error ?? 'Generation failed.'}</p>
          <button className="btn btn-small" onClick={() => void retryNote(uid, note)}>
            Try again
          </button>
        </div>
      )}

      {cards.length > 0 && (
        <ul className="card-list">
          {cards.map((card) => (
            <CardRow key={card.id} card={card} uid={uid} />
          ))}
        </ul>
      )}
    </li>
  )
}

function CardRow({ card, uid }: { card: Flashcard; uid: string }) {
  const [editing, setEditing] = useState(false)
  const [front, setFront] = useState(card.front)
  const [back, setBack] = useState(card.back)

  function cancel() {
    setFront(card.front)
    setBack(card.back)
    setEditing(false)
  }

  function save() {
    if (!front.trim() || !back.trim()) return
    void updateCardText(uid, card.id, { front, back })
    setEditing(false)
  }

  if (editing) {
    return (
      <li className="card card-editing">
        <label className="card-label" htmlFor={`front-${card.id}`}>
          Question
        </label>
        <textarea
          id={`front-${card.id}`}
          className="card-input"
          value={front}
          rows={2}
          onChange={(e) => setFront(e.target.value)}
          autoFocus
        />
        <label className="card-label" htmlFor={`back-${card.id}`}>
          Answer
        </label>
        <textarea
          id={`back-${card.id}`}
          className="card-input"
          value={back}
          rows={2}
          onChange={(e) => setBack(e.target.value)}
        />
        <div className="card-actions">
          <button className="linkbtn" onClick={cancel}>
            Cancel
          </button>
          <button
            className="btn btn-primary btn-small"
            onClick={save}
            disabled={!front.trim() || !back.trim()}
          >
            Save
          </button>
        </div>
      </li>
    )
  }

  return (
    <li className="card">
      <p className="card-front">{card.front}</p>
      <p className="card-back">{card.back}</p>
      <div className="card-actions">
        {card.type === 'cloze' && <span className="badge badge-quiet">cloze</span>}
        {card.tags.map((tag) => (
          <span key={tag} className="badge badge-quiet">
            {tag}
          </span>
        ))}
        <span className="card-spacer" />
        <button className="linkbtn" onClick={() => setEditing(true)}>
          Edit
        </button>
        <button
          className="linkbtn danger"
          onClick={() => {
            if (confirm('Delete this card?')) void deleteCard(uid, card)
          }}
        >
          Delete
        </button>
      </div>
    </li>
  )
}
