import { useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { LanguagePicker } from '../components/LanguagePicker'
import { MAX_LANGUAGES, MAX_NEW_CARDS_PER_DAY } from '../lib/settings'
import { useSettings } from '../settings/SettingsProvider'

export function Settings() {
  const { user, signOutNow } = useAuth()
  const { languages, save, feedbackOptIn, saveFeedback, newCardsPerDay, saveNewCardsPerDay } =
    useSettings()

  // Seeded once from the stored value and owned by this screen afterwards, so
  // a snapshot arriving mid-edit cannot yank a chip out from under your thumb.
  const [picked, setPicked] = useState<string[]>(languages)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [feedbackError, setFeedbackError] = useState<string | null>(null)
  // A string while typing, so the field can be empty for a moment.
  const [newPerDay, setNewPerDay] = useState(String(newCardsPerDay))
  const [newError, setNewError] = useState<string | null>(null)
  const newParsed = Number(newPerDay)
  const newValid =
    newPerDay.trim() !== '' &&
    Number.isInteger(newParsed) &&
    newParsed >= 0 &&
    newParsed <= MAX_NEW_CARDS_PER_DAY
  const newDirty = newValid && newParsed !== newCardsPerDay

  async function applyNewPerDay() {
    setNewError(null)
    try {
      await saveNewCardsPerDay(newParsed)
    } catch (err) {
      setNewError(err instanceof Error ? err.message : String(err))
    }
  }

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
        <h2 className="settings-label">New cards per day</h2>
        <p className="hint">
          The most cards you meet for the first time in a day. The rest wait
          their turn, so a big import arrives gradually. Cards you are already
          learning are never held back. A day starts at 4 am.
        </p>
        <div className="row settings-inline">
          <input
            className="settings-number"
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_NEW_CARDS_PER_DAY}
            value={newPerDay}
            onChange={(e) => setNewPerDay(e.target.value)}
            aria-label="New cards per day"
          />
          <button
            className="btn btn-primary btn-small"
            onClick={() => void applyNewPerDay()}
            disabled={!newDirty}
          >
            {newDirty ? 'Save' : 'Saved'}
          </button>
        </div>
        {!newValid && (
          <p className="card-fail-msg">A whole number from 0 to {MAX_NEW_CARDS_PER_DAY}.</p>
        )}
        {newError && <p className="card-fail-msg">{newError}</p>}
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
