import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { subscribeToRecentNotes } from '../lib/notes'
import type { Note } from '../lib/types'

export function Library() {
  const { user } = useAuth()
  const [notes, setNotes] = useState<Note[] | null>(null)

  useEffect(() => {
    if (!user) return
    return subscribeToRecentNotes(user.uid, 50, setNotes)
  }, [user])

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
    <ul className="note-list">
      {notes.map((n) => (
        <li key={n.id} className="note">
          <p className="note-text">{n.rawText}</p>
          <div className="note-meta">
            <span>{n.createdAt?.toDate().toLocaleDateString() ?? 'just now'}</span>
            {n.status !== 'done' && <span className="badge">{n.status}</span>}
            {n.cardIds.length > 0 && (
              <span className="badge">
                {n.cardIds.length} card{n.cardIds.length > 1 ? 's' : ''}
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}
