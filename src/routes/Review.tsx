import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Rating, type Grade } from 'ts-fsrs'
import { useAuth } from '../auth/AuthProvider'
import { deleteCard, updateCardText } from '../lib/cards'
import { fetchNote } from '../lib/notes'
import {
  fetchDueCards,
  fetchNextDue,
  gradeCard,
  QUEUE_LIMIT,
} from '../lib/review'
import {
  GRADES,
  SESSION_HORIZON_MS,
  formatInterval,
  scheduler,
} from '../lib/fsrs'
import { toFsrsCard, type Flashcard, type Note } from '../lib/types'
import { VoiceReview } from './VoiceReview'

export function Review() {
  const [voice, setVoice] = useState(false)

  return (
    <div className="review-shell">
      <div className="review-mode-toggle">
        <button
          className={`review-mode-btn ${voice ? '' : 'active'}`}
          onClick={() => setVoice(false)}
        >
          Text
        </button>
        <button
          className={`review-mode-btn ${voice ? 'active' : ''}`}
          onClick={() => setVoice(true)}
        >
          Voice review
        </button>
      </div>
      {voice ? <VoiceReview /> : <TextReview />}
    </div>
  )
}

/** The original button-and-reveal review, kept fully intact as the fallback (DESIGN.md section 4.4). */
function TextReview() {
  const { user } = useAuth()
  const uid = user?.uid

  const [queue, setQueue] = useState<Flashcard[] | null>(null)
  const [exhausted, setExhausted] = useState(false)
  const [nextDue, setNextDue] = useState<Flashcard | null>(null)
  const [reviewed, setReviewed] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const [revealed, setRevealed] = useState(false)
  const [editing, setEditing] = useState(false)

  // Set at every card transition rather than in an effect, because the queue
  // can hand back the same card id twice running - rate the last card `Again`
  // and it comes straight back - so no derived signal marks a fresh card.
  const shownAt = useRef(0)
  const revealedAt = useRef<number | null>(null)

  // One grade per card shown. Two taps inside a single frame would otherwise
  // both run against the same pre-review state and write two review rows, the
  // second of them describing a schedule that was never applied.
  const shownGen = useRef(0)
  const gradedGen = useRef(-1)

  const card = queue?.[0] ?? null

  const showFrom = useCallback((cards: Flashcard[]) => {
    shownGen.current += 1
    shownAt.current = Date.now()
    revealedAt.current = null
    setRevealed(false)
    setEditing(false)
    setQueue(cards)
  }, [])

  useEffect(() => {
    if (!uid) return
    let cancelled = false
    fetchDueCards(uid, new Date())
      .then((cards) => !cancelled && showFrom(cards))
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setQueue([])
      })
    return () => {
      cancelled = true
    }
  }, [uid, showFrom])

  // Local queue ran dry: ask the server once more, in case the deck had more
  // than one screenful due, or a learning step has come round again.
  useEffect(() => {
    if (!uid || queue === null || queue.length > 0 || exhausted) return
    let cancelled = false
    void (async () => {
      try {
        const more = await fetchDueCards(uid, new Date())
        if (cancelled) return
        if (more.length > 0) {
          showFrom(more)
          return
        }
        setExhausted(true)
        setNextDue(await fetchNextDue(uid, new Date()))
      } catch {
        if (!cancelled) setExhausted(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [uid, queue, exhausted, showFrom])

  const reveal = useCallback(() => {
    if (revealedAt.current === null) revealedAt.current = Date.now()
    setRevealed(true)
  }, [])

  const grade = useCallback(
    (rating: Grade) => {
      if (!uid || !card) return
      if (gradedGen.current === shownGen.current) return
      gradedGen.current = shownGen.current

      const now = new Date()
      const t = now.getTime()

      const { next, committed } = gradeCard(
        uid,
        card,
        rating,
        {
          mode: 'text',
          durationMs: t - shownAt.current,
          revealMs:
            revealedAt.current === null ? null : revealedAt.current - shownAt.current,
          // No model judged this answer. Explicitly null, never false.
          llmJudgedCorrect: null,
        },
        now,
      )

      // Not awaited: the write is already durable locally, and offline the
      // promise would not settle until the device reconnects.
      committed.catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e)),
      )

      setReviewed((n) => n + 1)
      const rest = (queue ?? []).slice(1)
      // Still inside a learning step - it belongs to this session, not to some
      // future one. Anything further out leaves the queue for good.
      const soon = next.due.toDate().getTime() - t < SESSION_HORIZON_MS
      showFrom(soon ? [...rest, next] : rest)
    },
    [uid, card, queue, showFrom],
  )

  const drop = useCallback(() => {
    showFrom((queue ?? []).slice(1))
  }, [queue, showFrom])

  // Keyboard for the desk, taps for the phone. Space reveals, 1-4 rate.
  useEffect(() => {
    if (!card || editing) return
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === ' ' || e.key === 'Enter') {
        // Space and Enter are how a browser activates a focused button. If one
        // has focus - you just clicked it - let it do its own job rather than
        // grading twice.
        if ((e.target as HTMLElement | null)?.tagName === 'BUTTON') return
        e.preventDefault()
        if (!revealed) reveal()
        else grade(Rating.Good)
        return
      }
      if (!revealed) return
      const g = GRADES.find((x) => x.key === e.key)
      if (g) {
        e.preventDefault()
        grade(g.rating)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [card, editing, revealed, reveal, grade])

  if (!uid || queue === null) {
    return (
      <div className="centered">
        <div className="spinner" aria-label="Loading" />
      </div>
    )
  }

  if (!card) {
    return <DoneScreen reviewed={reviewed} nextDue={nextDue} error={error} />
  }

  return (
    <div className="review">
      <div className="review-progress">
        <span>{queue.length === QUEUE_LIMIT ? `${QUEUE_LIMIT}+` : queue.length} left</span>
        {reviewed > 0 && <span className="review-count">{reviewed} done</span>}
      </div>

      {error && <p className="review-error">{error}</p>}

      {editing ? (
        <CardEditor
          card={card}
          uid={uid}
          onDone={(patched) => {
            setEditing(false)
            if (patched) setQueue([patched, ...queue.slice(1)])
          }}
        />
      ) : (
        <button
          className="review-face"
          onClick={reveal}
          // Once revealed there is nothing left to reveal, so stop pretending
          // the whole card is a button.
          disabled={revealed}
        >
          <p className="review-front">{card.front}</p>
          {revealed && (
            <>
              <hr className="review-rule" />
              <p className="review-back">{card.back}</p>
            </>
          )}
        </button>
      )}

      {revealed && !editing && (
        <CardContext
          key={card.id}
          card={card}
          uid={uid}
          onEdit={() => setEditing(true)}
          onDrop={drop}
        />
      )}

      {!editing &&
        (revealed ? (
          <GradeButtons card={card} onGrade={grade} />
        ) : (
          <div className="review-actions">
            <button className="btn btn-primary review-reveal" onClick={reveal}>
              Show answer
            </button>
          </div>
        ))}
    </div>
  )
}

/**
 * The four buttons, each wearing the interval it would produce.
 *
 * `repeat` runs the same scheduler that `next` will run a moment later, so
 * what you are shown is what you get - no second implementation to drift.
 */
function GradeButtons({
  card,
  onGrade,
}: {
  card: Flashcard
  onGrade: (rating: Grade) => void
}) {
  const { now, preview } = useMemo(() => {
    const at = new Date()
    return { now: at, preview: scheduler.repeat(toFsrsCard(card), at) }
  }, [card])

  return (
    <div className="grade-row">
      {GRADES.map((g) => (
        <button
          key={g.rating}
          className={`grade grade-${g.label.toLowerCase()}`}
          onClick={() => onGrade(g.rating)}
        >
          <span className="grade-label">{g.label}</span>
          <span className="grade-interval">
            {formatInterval(now, preview[g.rating].card.due)}
          </span>
        </button>
      ))}
    </div>
  )
}

/**
 * The source note, plus the two repairs.
 *
 * DESIGN.md section 4.1a: cards are auto-accepted, so the moment a bad one
 * annoys you is the moment it gets fixed. Showing the note here is what makes
 * that possible - it is the only place you can see what the card was made from.
 */
function CardContext({
  card,
  uid,
  onEdit,
  onDrop,
}: {
  card: Flashcard
  uid: string
  onEdit: () => void
  onDrop: () => void
}) {
  const [note, setNote] = useState<Note | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchNote(uid, card.noteId)
      .then((n) => !cancelled && setNote(n))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [uid, card.noteId])

  return (
    <div className="review-context">
      <div className="review-context-bar">
        <button className="linkbtn" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide note' : 'Source note'}
        </button>
        <span className="card-spacer" />
        <button className="linkbtn" onClick={onEdit}>
          Edit
        </button>
        <button
          className="linkbtn danger"
          onClick={() => {
            if (!confirm('Delete this card?')) return
            void deleteCard(uid, card)
            onDrop()
          }}
        >
          Delete
        </button>
      </div>
      {open && (
        <p className="review-note">
          {note ? note.rawText : 'The note this came from is gone.'}
        </p>
      )}
    </div>
  )
}

function CardEditor({
  card,
  uid,
  onDone,
}: {
  card: Flashcard
  uid: string
  onDone: (patched: Flashcard | null) => void
}) {
  const [front, setFront] = useState(card.front)
  const [back, setBack] = useState(card.back)

  function save() {
    if (!front.trim() || !back.trim()) return
    const patch = updateCardText(uid, card.id, { front, back })
    patch.written.catch(() => {})
    onDone({ ...card, front: front.trim(), back: back.trim(), updatedAt: patch.updatedAt })
  }

  return (
    <div className="review-editor">
      <label className="card-label" htmlFor="rev-front">
        Question
      </label>
      <textarea
        id="rev-front"
        className="card-input"
        rows={2}
        value={front}
        onChange={(e) => setFront(e.target.value)}
        autoFocus
      />
      <label className="card-label" htmlFor="rev-back">
        Answer
      </label>
      <textarea
        id="rev-back"
        className="card-input"
        rows={2}
        value={back}
        onChange={(e) => setBack(e.target.value)}
      />
      <div className="card-actions">
        <button className="linkbtn" onClick={() => onDone(null)}>
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
    </div>
  )
}

export function DoneScreen({
  reviewed,
  nextDue,
  error,
}: {
  reviewed: number
  nextDue: Flashcard | null
  error: string | null
}) {
  const now = new Date()

  return (
    <div className="centered">
      {error && <p className="review-error">{error}</p>}

      {reviewed > 0 ? (
        <>
          <p className="review-done">Done.</p>
          <p className="empty">
            {reviewed === 1 ? '1 card reviewed' : `${reviewed} cards reviewed`}.
          </p>
        </>
      ) : (
        <p className="review-done">Nothing due.</p>
      )}

      <p className="empty">
        {nextDue ? (
          <>Next card in {formatInterval(now, nextDue.due.toDate())}.</>
        ) : (
          <>
            No cards waiting. <Link to="/">Capture something</Link> and it will be
            due straight away.
          </>
        )}
      </p>
    </div>
  )
}
