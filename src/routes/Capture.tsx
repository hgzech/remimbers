import { useEffect, useRef, useState } from 'react'
import type { PointerEvent } from 'react'
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
  // Tracks whether the button is still held. startRecording is async
  // (getUserMedia + setup), so a hold shorter than that would otherwise
  // arm a recording after the finger has already lifted.
  const heldRef = useRef(false)

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
    heldRef.current = true
    setMicError(null)
    try {
      const mimeType = pickMimeType()
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })

      // The button was released before permission/setup finished - the user
      // never meant to record anything, so don't arm anything and hand the
      // mic straight back.
      if (!heldRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }

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
    heldRef.current = false
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop()
    }
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

  // Pointer capture, not click: a press-and-hold control needs the down/up
  // pair to fire on this element even if the finger drifts off it mid-hold,
  // or release would never come and the mic would stay armed.
  function onRecordPointerDown(e: PointerEvent<HTMLButtonElement>) {
    e.currentTarget.setPointerCapture(e.pointerId)
    void startRecording()
  }
  function onRecordPointerUp() {
    stopRecording()
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
      <textarea
        ref={areaRef}
        className="capture-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Say what you just learned, or type it here."
        autoFocus
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save()
        }}
      />

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

      {/* Bottom, thumb-reach zone: exactly one primary action at a time. */}
      <div className="capture-bar">
        <span className={`flash ${flash ? 'on' : ''}`}>Captured</span>
        {text.trim() ? (
          <button className="btn btn-primary capture-cta" onClick={save}>
            Capture
          </button>
        ) : (
          <button
            type="button"
            className={`record-btn capture-cta ${recording ? 'recording' : ''}`}
            onPointerDown={onRecordPointerDown}
            onPointerUp={onRecordPointerUp}
            onPointerCancel={onRecordPointerUp}
            onContextMenu={(e) => e.preventDefault()}
            aria-label={recording ? 'Recording - release to send' : 'Hold to record a voice note'}
          >
            <span className="record-dot" />
            {recording ? 'Release to send' : 'Hold to speak'}
          </button>
        )}
      </div>
    </div>
  )
}
