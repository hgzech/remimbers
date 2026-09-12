import { useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { LanguagePicker } from '../components/LanguagePicker'
import { MAX_LANGUAGES } from '../lib/settings'
import { useSettings } from '../settings/SettingsProvider'

export function Settings() {
  const { user, signOutNow } = useAuth()
  const { languages, save, feedbackOptIn, saveFeedback } = useSettings()

  // Seeded once from the stored value and owned by this screen afterwards, so
  // a snapshot arriving mid-edit cannot yank a chip out from under your thumb.
  const [picked, setPicked] = useState<string[]>(languages)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [feedbackError, setFeedbackError] = useState<string | null>(null)

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

  async function toggleFeedback() {
    setFeedbackError(null)
    try {
      await saveFeedback(!feedbackOptIn)
    } catch (err) {
      setFeedbackError(err instanceof Error ? err.message : String(err))
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
        <h2 className="settings-label">Help improve the app</h2>
        <p className="hint">
          When a card goes wrong in voice review, you can say so and the session
          will ask what happened. Turning this on lets that one exchange be
          saved — what you said, what the app said back, and the card it was
          about — so the problem can actually be found and fixed.{' '}
          {feedbackOptIn
            ? 'Nothing is saved unless you report something.'
            : 'With this off you will not be asked, and nothing is saved.'}{' '}
          Audio is never saved either way.
        </p>
        <div className="row">
          <button
            className={`btn btn-small ${feedbackOptIn ? 'btn-primary' : ''}`}
            onClick={() => void toggleFeedback()}
          >
            {feedbackOptIn ? 'On' : 'Off'}
          </button>
        </div>
        {feedbackError && <p className="card-fail-msg">{feedbackError}</p>}
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
