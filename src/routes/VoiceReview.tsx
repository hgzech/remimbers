import { useCallback, useEffect, useRef, useState } from 'react'
import { Rating, type Grade } from 'ts-fsrs'
import { useAuth } from '../auth/AuthProvider'
import { fetchDueCards, fetchNextDue, gradeCard } from '../lib/review'
import { SESSION_HORIZON_MS } from '../lib/fsrs'
import { createRealtimeSession, mintToken, type RealtimeSession } from '../lib/realtime'
import type { Flashcard } from '../lib/types'
import { DoneScreen } from './Review'

/**
 * DESIGN.md section 4.2/4.3, adapted per the Phase 4 spec: no mid-session
 * answer-leak injection yet (that's the "inject front, then back" plumbing
 * DESIGN.md describes) - the front and back are both injected up front and
 * the prompt itself is relied on not to leak the answer before you've had a
 * go. Simpler for a first cut; revisit if the model leaks in practice.
 */
const SYSTEM_PROMPT = `You are a spaced-repetition tutor helping the user review flashcards.
You have access to the card's question and answer.

Rules:
- Read the question naturally. Wait for the user to answer.
- Never reveal the answer before the user responds.
- After they answer, judge correct or incorrect based on whether they retrieved the key information (not word-for-word, but the substance).
- If correct: say so warmly, then infer a difficulty from their delivery (confidence, hesitation, speed) and turn it into a yes/no confirmation question - e.g. "That sounded like an Easy - sound right?" Do not just announce the rating as a fact.
- If incorrect: say "Not quite - the answer is [answer]." Then ask how they'd like to rate it: Hard, Good, or Easy is not relevant here - confirm "Again", e.g. "I'll mark that Again, ok?"
- Critical: never call record_grade in the same turn as asking the confirmation question above. Ask, then stop and wait for the user's actual reply in a separate turn. Only after they reply - confirming, correcting, or naming a different rating - do you call record_grade with the value they settled on.
- If their reply is unclear or doesn't answer the question, ask again rather than guessing or logging anything.
- After record_grade is called, immediately move to the next card.
- Be concise. This is a drill, not a tutoring session.`

const RECORD_GRADE_TOOL = {
  type: 'function',
  name: 'record_grade',
  description:
    "Record the outcome of the current flashcard once you've judged correctness and a difficulty rating has been determined.",
  parameters: {
    type: 'object',
    properties: {
      cardId: { type: 'string', description: 'The cardId given to you when this card was presented.' },
      rating: { type: 'string', enum: ['again', 'hard', 'good', 'easy'] },
      judgedCorrect: { type: 'boolean', description: 'Whether the user retrieved the key information.' },
      rationale: { type: 'string', description: 'One short sentence on what they got right or missed.' },
    },
    required: ['cardId', 'rating', 'judgedCorrect', 'rationale'],
    additionalProperties: false,
  },
}

const RATING_BY_NAME: Record<string, Grade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
}

type Phase = 'loading' | 'idle' | 'connecting' | 'active' | 'done'
type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking'

export function VoiceReview() {
  const { user } = useAuth()
  const uid = user?.uid

  const [phase, setPhase] = useState<Phase>('loading')
  const [voiceState, setVoiceState] = useState<VoiceState>('idle')
  const [muted, setMuted] = useState(false)
  const [reviewed, setReviewed] = useState(0)
  const [total, setTotal] = useState(0)
  const [remaining, setRemaining] = useState(0)
  const [nextDue, setNextDue] = useState<Flashcard | null>(null)
  const [error, setError] = useState<string | null>(null)

  const sessionRef = useRef<RealtimeSession | null>(null)
  const queueRef = useRef<Flashcard[]>([])
  const itemIdsRef = useRef<string[]>([])
  const pendingTranscriptRef = useRef<string | null>(null)
  const cardShownAtRef = useRef(0)
  const gradedCallIdsRef = useRef<Set<string>>(new Set())

  // Load the queue up front (cheap, no mic) so an empty deck skips straight
  // to the done screen instead of offering to start a session for nothing.
  useEffect(() => {
    if (!uid) return
    let cancelled = false
    fetchDueCards(uid, new Date())
      .then((cards) => {
        if (cancelled) return
        queueRef.current = cards
        setTotal(cards.length)
        setRemaining(cards.length)
        setPhase(cards.length > 0 ? 'idle' : 'done')
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setPhase('done')
      })
    return () => {
      cancelled = true
    }
  }, [uid])

  useEffect(() => {
    return () => {
      sessionRef.current?.close()
    }
  }, [])

  const injectCard = useCallback((card: Flashcard) => {
    const session = sessionRef.current
    if (!session) return
    cardShownAtRef.current = Date.now()
    session.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [
          {
            type: 'input_text',
            text:
              `New card. cardId: "${card.id}"\n` +
              `Question (front): ${card.front}\n` +
              `Answer (back, for your judgement only): ${card.back}`,
          },
        ],
      },
    })
    session.send({ type: 'response.create' })
  }, [])

  const finish = useCallback(async () => {
    sessionRef.current?.close()
    sessionRef.current = null
    if (uid) {
      try {
        setNextDue(await fetchNextDue(uid, new Date()))
      } catch {
        // Nothing worth surfacing - the done screen just won't show a next-due hint.
      }
    }
    setPhase('done')
  }, [uid])

  const clearHistory = useCallback(() => {
    const session = sessionRef.current
    if (!session) return
    for (const id of itemIdsRef.current) {
      session.send({ type: 'conversation.item.delete', item_id: id })
    }
    itemIdsRef.current = []
  }, [])

  const handleRecordGrade = useCallback(
    (item: any) => {
      if (!uid) return
      if (gradedCallIdsRef.current.has(item.call_id)) return
      gradedCallIdsRef.current.add(item.call_id)

      const card = queueRef.current[0]
      if (!card) return

      let args: any = {}
      try {
        args = JSON.parse(item.arguments ?? '{}')
      } catch {
        // Fall through with an empty args object - rating defaults to Good below.
      }

      const rating = RATING_BY_NAME[args.rating] ?? Rating.Good
      const now = new Date()

      const { next, committed } = gradeCard(
        uid,
        card,
        rating,
        {
          mode: 'voice',
          durationMs: now.getTime() - cardShownAtRef.current,
          // Voice mode has no discrete "reveal" moment - the model paces that.
          revealMs: null,
          llmJudgedCorrect: typeof args.judgedCorrect === 'boolean' ? args.judgedCorrect : null,
          userAnswerTranscript: pendingTranscriptRef.current,
          llmRationale: typeof args.rationale === 'string' ? args.rationale : null,
        },
        now,
      )
      committed.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      pendingTranscriptRef.current = null

      // Ack the tool call so the model isn't left waiting on it.
      sessionRef.current?.send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: item.call_id, output: '{"ok":true}' },
      })

      setReviewed((n) => n + 1)

      const t = now.getTime()
      const rest = queueRef.current.slice(1)
      // Still inside a learning step, same rule as text mode (fsrs.ts).
      const soon = next.due.toDate().getTime() - t < SESSION_HORIZON_MS
      const nextQueue = soon ? [...rest, next] : rest
      queueRef.current = nextQueue
      setRemaining(nextQueue.length)
      if (soon) setTotal((n) => n + 1)

      // DESIGN.md section 4.2: clear conversation history between cards - each
      // card is independent, and an unmanaged session grows super-linearly in
      // cost. TODO(cost cap): a per-user daily cap on minted tokens belongs in
      // the /realtime-token Function, not here (functions/src/index.ts).
      clearHistory()

      if (nextQueue.length > 0) {
        injectCard(nextQueue[0])
      } else {
        void finish()
      }
    },
    [uid, clearHistory, injectCard, finish],
  )

  const handleEvent = useCallback(
    (event: any) => {
      switch (event.type) {
        case 'conversation.item.created':
          if (event.item?.id) itemIdsRef.current.push(event.item.id)
          break
        case 'conversation.item.input_audio_transcription.completed':
          pendingTranscriptRef.current = event.transcript ?? null
          break
        case 'input_audio_buffer.speech_started':
          setVoiceState('listening')
          break
        case 'input_audio_buffer.speech_stopped':
        case 'response.created':
          setVoiceState('thinking')
          break
        case 'response.done': {
          setVoiceState('listening')
          const output = event.response?.output ?? []
          for (const item of output) {
            if (item?.type === 'function_call' && item?.name === 'record_grade') {
              handleRecordGrade(item)
            }
          }
          break
        }
        case 'error':
          setError(event.error?.message ?? 'Realtime error')
          break
        default:
          if (typeof event.type === 'string' && event.type.includes('audio') && event.type.includes('delta')) {
            setVoiceState('speaking')
          }
      }
    },
    [handleRecordGrade],
  )

  // Starting requires a direct tap: iOS only grants microphone access inside
  // a user-gesture call chain, same constraint Capture.tsx works around.
  const start = useCallback(async () => {
    setError(null)
    setPhase('connecting')
    try {
      const token = await mintToken()
      const session = await createRealtimeSession(token, handleEvent)
      sessionRef.current = session

      session.send({
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: SYSTEM_PROMPT,
          tools: [RECORD_GRADE_TOOL],
          audio: { input: { turn_detection: { type: 'server_vad' } } },
        },
      })

      setPhase('active')
      setVoiceState('thinking')
      injectCard(queueRef.current[0])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start voice review')
      sessionRef.current?.close()
      sessionRef.current = null
      setPhase('idle')
    }
  }, [handleEvent, injectCard])

  const toggleMuted = useCallback(() => {
    setMuted((m) => {
      sessionRef.current?.setMuted(!m)
      return !m
    })
  }, [])

  const endSession = useCallback(() => {
    void finish()
  }, [finish])

  if (!uid || phase === 'loading') {
    return (
      <div className="centered">
        <div className="spinner" aria-label="Loading" />
      </div>
    )
  }

  if (phase === 'done') {
    return <DoneScreen reviewed={reviewed} nextDue={nextDue} error={error} />
  }

  if (phase === 'idle') {
    return (
      <div className="centered voice-idle">
        <p className="review-done">{total} card{total === 1 ? '' : 's'} due</p>
        <p className="empty">Voice review reads each question aloud and grades your answer.</p>
        {error && <p className="review-error">{error}</p>}
        <button className="btn btn-primary" onClick={() => void start()}>
          Start voice review
        </button>
      </div>
    )
  }

  if (phase === 'connecting') {
    return (
      <div className="centered">
        <div className="spinner" aria-label="Connecting" />
        <p className="empty">Connecting…</p>
      </div>
    )
  }

  return (
    <div className="voice-review">
      <div className="review-progress">
        <span>{remaining} left</span>
        {reviewed > 0 && <span className="review-count">{reviewed} done</span>}
      </div>

      {error && <p className="review-error">{error}</p>}

      <div className="voice-stage">
        <div className={`voice-indicator voice-${voiceState}`} aria-label={voiceState} />
        <p className="voice-state-label">
          {voiceState === 'listening' && 'Listening…'}
          {voiceState === 'thinking' && 'Thinking…'}
          {voiceState === 'speaking' && 'Speaking…'}
          {voiceState === 'idle' && ' '}
        </p>
      </div>

      <div className="voice-actions">
        <button className={`btn ${muted ? 'btn-primary' : ''}`} onClick={toggleMuted}>
          {muted ? 'Unmute' : 'Mute'}
        </button>
        <button className="btn" onClick={endSession}>
          End session
        </button>
      </div>
    </div>
  )
}
