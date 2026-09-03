import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import {
  addToAllowlist,
  listAllowlist,
  removeFromAllowlist,
  type AllowlistEntry,
} from '../lib/allowlist'

export function Admin() {
  const { isOwner } = useAuth()
  const [entries, setEntries] = useState<AllowlistEntry[] | null>(null)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function refresh() {
    listAllowlist().then(setEntries, (err) => setError(describe(err)))
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

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      refresh()
    } catch (err) {
      setError(describe(err))
    } finally {
      setBusy(false)
    }
  }

  function invite() {
    const trimmed = email.trim()
    if (!trimmed) return
    void run(async () => {
      await addToAllowlist(trimmed)
      setEmail('')
    })
  }

  function remove(memberEmail: string) {
    if (!confirm(`Remove ${memberEmail} from the allowlist?`)) return
    void run(() => removeFromAllowlist(memberEmail))
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
            if (e.key === 'Enter') invite()
          }}
        />
        <button
          className="btn btn-primary"
          onClick={invite}
          disabled={!email.trim() || busy}
        >
          {busy ? 'Working…' : 'Invite'}
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
                {/* Owners are managed from the console; the rules refuse the
                    delete anyway, so don't offer a button that can't work. */}
                {entry.role !== 'owner' && (
                  <button
                    className="linkbtn danger note-delete"
                    onClick={() => remove(entry.email)}
                    disabled={busy}
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

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
