import { LANGUAGES, MAX_LANGUAGES } from '../lib/settings'

/**
 * The one language chip grid, shared by first-run setup and Settings so the
 * two cannot drift into disagreeing about the cap or the option list.
 */
export function LanguagePicker({
  value,
  onChange,
}: {
  value: string[]
  onChange: (next: string[]) => void
}) {
  const full = value.length >= MAX_LANGUAGES

  function toggle(code: string) {
    if (value.includes(code)) {
      onChange(value.filter((c) => c !== code))
    } else if (!full) {
      onChange([...value, code])
    }
  }

  return (
    <div className="lang-grid" role="group" aria-label="Languages you speak">
      {LANGUAGES.map((lang) => {
        const on = value.includes(lang.code)
        return (
          <button
            key={lang.code}
            type="button"
            className={`lang-chip${on ? ' on' : ''}`}
            aria-pressed={on}
            // Greying out unpicked chips at the cap explains the limit by
            // demonstration, which beats an error message after the tap.
            disabled={!on && full}
            onClick={() => toggle(lang.code)}
            title={lang.name}
          >
            {lang.native}
          </button>
        )
      })}
    </div>
  )
}
