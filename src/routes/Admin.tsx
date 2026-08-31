import { useEffect, useState } from 'react'
import {
  addToAllowlist,
  listAllowlist,
  removeFromAllowlist,
  useIsOwner,
  type AllowlistEntry,
} from '../lib/allowlist'

export function Admin() {
  const isOwner = useIsOwner()
  const [entries, setEntries] = useState<AllowlistEntry[] | null>(null)
  const [email, setEmail] = useState('')
  const [inviting, setInviting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function refresh() {
    void listAllowlist().then(setEntries)
  }

  useEffect(() => {
    if (isOwner) refresh()
  }, [isOwner])

  if (!isOwner) {
    return (
      <div className="centered">
        <p className="empty">Not authorized.</p>
      </div>
    )
  }

  async function invite() {
    const trimmed = email.trim()
    if (!trimmed) return
    setInviting(true)
    setError(null)
    try {
      await addToAllowlist(trimmed)
      setEmail('')
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setInviting(false)
    }
  }

  async function remove(memberEmail: string) {
    if (!confirm(`Remove ${memberEmail} from the allowlist?`)) return
    await removeFromAllowlist(memberEmail)
    refresh()
  }

  return (
    <>
      <p className="hint list-note">Invite friends, or remove someone's access.</p>

      <div className="row">
        <input
          className="card-input"
          type="email"
          placeholder="friend@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void invite()
          }}
        />
        <button
          className="btn btn-primary"
          onClick={() => void invite()}
          disabled={!email.trim() || inviting}
        >
          {inviting ? 'Inviting…' : 'Invite'}
        </button>
      </div>
      {error && <p className="card-fail-msg">{error}</p>}

      {entries === null ? (
        <div className="centered">
          <div className="spinner" aria-label="Loading" />
        </div>
      ) : (
        <ul className="note-list">
          {entries.map((entry) => (
            <li key={entry.email} className="note">
              <p className="note-text">{entry.email}</p>
              <div className="note-meta">
                {entry.role && <span className="badge">{entry.role}</span>}
                {!entry.role && (
                  <button
                    className="linkbtn danger note-delete"
                    onClick={() => void remove(entry.email)}
                  >
                    Remove
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
