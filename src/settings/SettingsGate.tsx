import { useState } from 'react'
import type { ReactNode } from 'react'
import { LanguagePicker } from '../components/LanguagePicker'
import { guessLanguages, MAX_LANGUAGES } from '../lib/settings'
import { useSettings } from './SettingsProvider'

/**
 * First-run question: which languages do you speak?
 *
 * Asked once, before the app is usable, because the very first capture is
 * already a transcription and there is no safe default to fall back on - an
 * unpinned one can come back translated into a language you do not speak
 * (see lib/settings.ts). Google sign-in has no sign-up step of its own, so
 * "the first time you arrive" is the only place this fits.
 */
export function SettingsGate({ children }: { children: ReactNode }) {
  const { status } = useSettings()

  if (status === 'loading') {
    return (
      <div className="centered">
        <div className="spinner" aria-label="Loading" />
      </div>
    )
  }

  if (status === 'needs-setup') return <LanguageSetup />

  return <>{children}</>
}

function LanguageSetup() {
  const { save } = useSettings()
  // Lazy initialiser: navigator.languages is read once, on mount, rather than
  // on every render.
  const [picked, setPicked] = useState<string[]>(() => guessLanguages())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    setSaving(true)
    setError(null)
    try {
      await save(picked)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  return (
    <div className="centered splash lang-setup">
      <h1 className="wordmark">remimbers</h1>
      <p className="tagline">
        Which languages do you speak? Your captures get transcribed as these.
      </p>
      <LanguagePicker value={picked} onChange={setPicked} />
      <p className="hint lang-hint">
        Pick only the ones you actually talk in — every extra language makes
        a short note more likely to be misheard. Up to {MAX_LANGUAGES}, and you
        can change this later in Settings.
      </p>
      {error && <p className="card-fail-msg">{error}</p>}
      <button
        className="btn btn-primary"
        onClick={() => void confirm()}
        disabled={picked.length === 0 || saving}
      >
        {saving ? 'Saving…' : 'Continue'}
      </button>
    </div>
  )
}
