import { useRef, useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { addNote } from '../lib/notes'

export function Capture() {
  const { user } = useAuth()
  const [text, setText] = useState('')
  const [flash, setFlash] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement>(null)

  function save() {
    const trimmed = text.trim()
    if (!trimmed || !user) return

    // Fire and forget. Offline persistence means this is durable the moment
    // it is called; blocking the UI on the server would defeat the point.
    void addNote(user.uid, trimmed, 'text')

    setText('')
    setFlash(true)
    setTimeout(() => setFlash(false), 1400)
    areaRef.current?.focus()
  }

  return (
    <div className="capture">
      <textarea
        ref={areaRef}
        className="capture-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What do you want to remember?"
        autoFocus
        // On iOS, tapping this and hitting the keyboard's mic key gives you
        // system dictation for free - the fallback until Phase 3 lands.
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save()
        }}
      />

      <div className="capture-actions">
        <span className={`flash ${flash ? 'on' : ''}`}>Captured</span>
        <button className="btn btn-primary" onClick={save} disabled={!text.trim()}>
          Capture
        </button>
      </div>

      <p className="hint">
        Voice capture arrives in Phase&nbsp;3. For now, tap the mic on your
        keyboard &mdash; or press&nbsp;&#8984;&#8629;.
      </p>
    </div>
  )
}
