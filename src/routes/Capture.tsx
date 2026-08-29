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

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  )
}

export function Capture() {
  const { user } = useAuth()
  const [text, setText] = useState('')
  const [flash, setFlash] = useState(false)
  const [recording, setRecording] = useState(false)
  const [starting, setStarting] = useState(false)
  const [micError, setMicError] = useState<string | null>(null)
  const [queue, setQueue] = useState<QueueEntry[]>([])
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
      setFlash(true)
      setTimeout(() => setFlash(false), 1400)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setQueue((q) =>
        q.map((e) => (e.id === item.id ? { ...e, status: 'error', error: message } : e)),
      )
    }
  }

  function retryFailed() {
    queue.filter((item) => item.status === 'error').forEach((item) => void processItem(item))
  }

  async function startRecording() {
    setStarting(true)
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
    } finally {
      setStarting(false)
    }
  }

  function stopRecording() {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop()
    }
    setRecording(false)
  }

  function toggleRecording() {
    if (recording) {
      stopRecording()
    } else if (!starting) {
      void startRecording()
    }
  }

  async function handleRecorded(blob: Blob, mimeType: string) {
    // IndexedDB first, always - a failed upload must not lose the thought.
    const id = await enqueue(blob, mimeType)
    setQueue((q) => [...q, { id, blob, mimeType, status: 'uploading' }])
    await processItem({ id, blob, mimeType })
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
  }

  const hasFailed = queue.some((item) => item.status === 'error')
  const transcribing = queue.some((item) => item.status === 'uploading')

  let status: string | null = null
  let statusIsError = false
  if (micError) {
    status = micError
    statusIsError = true
  } else if (recording) {
    status = 'Recording…'
  } else if (transcribing) {
    status = 'Transcribing…'
  } else if (flash) {
    status = 'Captured'
  }

  return (
    <div className="capture">
      <div className="capture-voice">
        <button
          type="button"
          className={`mic-btn ${recording ? 'recording' : ''}`}
          onClick={toggleRecording}
          disabled={starting}
          aria-label={recording ? 'Stop recording' : 'Start voice capture'}
        >
          {recording ? <StopIcon /> : <MicIcon />}
        </button>

        <p className={`capture-status ${statusIsError ? 'error' : ''}`}>{status ?? ' '}</p>

        {hasFailed && (
          <button type="button" className="linkbtn capture-retry" onClick={retryFailed}>
            Retry failed recording
          </button>
        )}
      </div>

      <div className="capture-text">
        <p className="capture-text-label">or type</p>
        <textarea
          className="capture-text-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type a note instead"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save()
          }}
        />
        {text.trim() && (
          <button className="btn btn-primary capture-text-save" onClick={save}>
            Capture
          </button>
        )}
      </div>
    </div>
  )
}
