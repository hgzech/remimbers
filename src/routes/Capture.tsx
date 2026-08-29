import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { addNote } from '../lib/notes'
import { transcribeAudio } from '../lib/functions'
import { dequeue, enqueue, getPending, type QueuedAudio } from '../lib/audioQueue'

/**
 * Feature-detect rather than hardcode (DESIGN.md section 5.2) - Chrome emits
 * WebM/Opus, Safari has never supported it and emits MP4/AAC instead.
 */
function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  return MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/mp4'
}

interface QueueEntry extends QueuedAudio {
  status: 'uploading' | 'error'
  error?: string
}

export function Capture() {
  const { user } = useAuth()
  const [text, setText] = useState('')
  const [flash, setFlash] = useState(false)
  const [recording, setRecording] = useState(false)
  const [micError, setMicError] = useState<string | null>(null)
  const [queue, setQueue] = useState<QueueEntry[]>([])
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const chunksRef = useRef<Blob[]>([])
  const recorderRef = useRef<MediaRecorder | null>(null)

  // Crash insurance (DESIGN.md section 5.1): anything still in IndexedDB from
  // a previous session - a dropped signal, a killed tab mid-upload - retries
  // the moment the app is open again, rather than waiting to be noticed.
  useEffect(() => {
    if (!user) return
    let cancelled = false
    void getPending().then((items) => {
      if (cancelled) return
      items.forEach((item) => {
        setQueue((q) => [...q, { ...item, status: 'uploading' }])
        void processItem(item)
      })
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  async function processItem(item: QueuedAudio) {
    if (!user) return
    setQueue((q) =>
      q.map((e) => (e.id === item.id ? { ...e, status: 'uploading', error: undefined } : e)),
    )
    try {
      const transcript = await transcribeAudio(item.blob)
      // Fire and forget, same as text capture: the local write is durable the
      // moment it's called, and nothing downstream needs to wait for it.
      void addNote(user.uid, transcript, 'voice')
      await dequeue(item.id)
      setQueue((q) => q.filter((e) => e.id !== item.id))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setQueue((q) =>
        q.map((e) => (e.id === item.id ? { ...e, status: 'error', error: message } : e)),
      )
    }
  }

  async function startRecording() {
    setMicError(null)
    try {
      const mimeType = pickMimeType()
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      chunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorder.onstop = () => {
        // Release the mic the instant we're done with it, not when the
        // upload finishes - iOS treats a held mic track as an active call.
        stream.getTracks().forEach((t) => t.stop())
        const type = recorder.mimeType || mimeType || 'audio/webm'
        void handleRecorded(new Blob(chunksRef.current, { type }), type)
      }

      recorderRef.current = recorder
      recorder.start()
      setRecording(true)
    } catch (err) {
      setMicError(err instanceof Error ? err.message : 'Microphone unavailable')
    }
  }

  function stopRecording() {
    recorderRef.current?.stop()
    setRecording(false)
  }

  async function handleRecorded(blob: Blob, mimeType: string) {
    // IndexedDB first, always - a failed upload must not lose the thought.
    const id = await enqueue(blob, mimeType)
    setQueue((q) => [...q, { id, blob, mimeType, status: 'uploading' }])
    setFlash(true)
    setTimeout(() => setFlash(false), 1400)
    await processItem({ id, blob, mimeType })
  }

  function toggleRecording() {
    if (recording) stopRecording()
    else void startRecording()
  }

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
      <button
        type="button"
        className={`record-btn ${recording ? 'recording' : ''}`}
        onClick={toggleRecording}
        aria-pressed={recording}
      >
        <span className="record-dot" />
        {recording ? 'Tap to stop' : 'Tap to speak'}
      </button>
      {micError && <p className="queue-error">{micError}</p>}

      {queue.length > 0 && (
        <ul className="queue-list">
          {queue.map((item) => (
            <li key={item.id} className="queue-item">
              {item.status === 'uploading' ? (
                <span>Transcribing&hellip;</span>
              ) : (
                <>
                  <span className="queue-error">Couldn&rsquo;t transcribe &mdash; still saved</span>
                  <button className="btn btn-small" onClick={() => processItem(item)}>
                    Retry
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <textarea
        ref={areaRef}
        className="capture-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Or type it. Cards get written for you either way."
        autoFocus
        // On iOS, tapping this and hitting the keyboard's mic key gives you
        // system dictation too - a second way in, not the only one anymore.
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
        One field on purpose &mdash; you&rsquo;re dumping a thought, not
        authoring a flashcard. Splitting it into question and answer is the
        LLM&rsquo;s job.
      </p>
    </div>
  )
}
