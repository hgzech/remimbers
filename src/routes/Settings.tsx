import { useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { LanguagePicker } from '../components/LanguagePicker'
import { MAX_LANGUAGES } from '../lib/settings'
import { useSettings } from '../settings/SettingsProvider'

export function Settings() {
  const { user, signOutNow } = useAuth()
  const { languages, save } = useSettings()

  // Seeded once from the stored value and owned by this screen afterwards, so
  // a snapshot arriving mid-edit cannot yank a chip out from under your thumb.
  const [picked, setPicked] = useState<string[]>(languages)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dirty =
    picked.length !== languages.length ||
    picked.some((code) => !languages.includes(code))

  async function apply() {
    setSaving(true)
    setError(null)
    try {
      await save(picked)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings">
      <section className="settings-section">
        <h2 className="settings-label">Languages you speak</h2>
        <p className="hint">
          Captures are transcribed as one of these. Keeping the list short is
          what keeps a three-second note from being misheard — up to{' '}
          {MAX_LANGUAGES}.
        </p>
        <LanguagePicker value={picked} onChange={setPicked} />
        <div className="row">
          <button
            className="btn btn-primary btn-small"
            onClick={() => void apply()}
            disabled={!dirty || picked.length === 0 || saving}
          >
            {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </button>
        </div>
        {error && <p className="card-fail-msg">{error}</p>}
      </section>

      <section className="settings-section">
        <h2 className="settings-label">Account</h2>
        <p className="hint">{user?.email}</p>
        <div className="row">
          <button className="btn btn-small" onClick={() => void signOutNow()}>
            Sign out
          </button>
        </div>
      </section>
    </div>
  )
}
