import { useCallback, useEffect, useRef, useState } from 'react'
import { Rating, type Grade } from 'ts-fsrs'
import { useAuth } from '../auth/AuthProvider'
import { fetchDueCards, fetchNextDue, gradeCard } from '../lib/review'
import { SESSION_HORIZON_MS } from '../lib/fsrs'
import { createRealtimeSession, mintToken, type RealtimeSession } from '../lib/realtime'
import type { Flashcard } from '../lib/types'
import { DoneScreen } from './Review'

/**
 * DESIGN.md sections 4.2/4.3.
 *
 * The first cut injected front and back together and relied on this prompt not
 * to leak the answer. It did not hold: with the answer already in context the
 * model treated it as though the user had answered, skipped the question, and
 * graded on the spot.
 *
 * So the answer is withheld at question time, per DESIGN.md section 4.2. It is
 * handed over once the model has actually asked the question - which is the
 * point the skip-the-question failure becomes impossible - rather than once the
 * user has finished speaking as section 4.2 suggests. Waiting for the user
 * meant driving every model response by hand off a VAD event, and that made the
 * session glitchy. This keeps the structural guarantee and the standard
 * auto-response flow; the prompt covers the smaller remaining ask, which is not
 * to volunteer the answer during the few seconds the user is answering.
 */
const SYSTEM_PROMPT = `You are a spaced-repetition tutor helping the user review flashcards.
Cards are fed to you one at a time, in two halves - never both at once.

How a card runs:
1. You are given a card's question (front) only. Read it aloud, naturally, and then STOP. Do not grade, do not guess at an answer, do not call any tool - you have not heard the user yet and you do not have the correct answer at this point.
2. You are then handed the correct answer (back) in a system message. Say nothing when it arrives - it is for your judgement only. Never read it out or hint at it before the user has answered.
3. The user speaks their answer. Now judge it against the correct answer.

Judging and rating:
- Judge correct or incorrect on whether they retrieved the key information - substance, not word-for-word.
- If their answer was correct, fast, and clearly confident - no hesitation, no groping: say so warmly and call record_grade with rating "easy". This is the ONE case where you may log without confirming.
- If correct but anything else - hesitation, a pause, an unsure tone, or you simply aren't confident it was Easy: say so warmly, then turn your guess into a yes/no confirmation question, e.g. "That sounded like a Good - right?" Do not call record_grade yet.
- If incorrect: say "Not quite - the answer is [answer]." Then confirm before logging, e.g. "I'll mark that Again, ok?" Do not call record_grade yet.
- Critical: whenever you ask one of those confirmation questions, that ends your turn. Never call record_grade in the same turn as asking it. Wait for the user's reply in a separate turn - confirming, correcting, or naming a different rating - and only then call record_grade with what they settled on.
- If their reply is unclear, ask again rather than guessing or logging anything.
- After record_grade, say a brief word confirming what you logged, then move to the next card. Do this even for the last card of the session - always let the user hear how it was rated.
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
  /** Whether the current card's answer has been handed over yet - see injectCard. */
  const backInjectedRef = useRef(false)

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

  /** Send a system-role text item into the conversation. */
  const sendSystemText = useCallback((text: string) => {
    sessionRef.current?.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text }],
      },
    })
  }, [])

  /**
   * Start a card by injecting ONLY the front (DESIGN.md section 4.2).
   *
   * With both halves in context at question time, the model treated the answer
   * sitting there as though the user had already given it - skipping the
   * question entirely and grading it Easy on the spot. Withholding the back
   * until the question has actually been asked makes that impossible rather
   * than merely discouraged; the answer follows on response.done.
   */
  const injectCard = useCallback(
    (card: Flashcard) => {
      if (!sessionRef.current) return
      cardShownAtRef.current = Date.now()
      backInjectedRef.current = false
      sendSystemText(
        `New card. cardId: "${card.id}"\n` +
          `Question (front): ${card.front}\n` +
          `Ask this question now. You have NOT been given the answer yet - it ` +
          `follows once you have asked.`,
      )
      sessionRef.current.send({ type: 'response.create' })
    },
    [sendSystemText],
  )

  /**
   * End the session and show the done screen.
   *
   * Not immediate by default: the model speaks its grade confirmation in the
   * same turn as the record_grade call, and that audio is still draining out
   * of the browser's playout buffer the instant the tool call event arrives.
   * Closing the peer connection right then cuts the sentence off mid-word -
   * which is exactly what happened to the last card of a session, since nothing
   * comes after it to buy the trailing audio more time. A manual "End session"
   * tap means the user wants out now, so that path skips the grace period.
   */
  const finish = useCallback(
    async (opts?: { immediate?: boolean }) => {
      if (!opts?.immediate) {
        await new Promise((resolve) => setTimeout(resolve, 2500))
      }
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
    },
    [uid],
  )

  /**
   * Drop the finished card's messages (DESIGN.md section 4.2 - the Realtime API
   * resubmits full context every turn, so an unmanaged session grows
   * super-linearly in cost).
   *
   * Only `message` items are deleted. Deleting the model's `function_call` item
   * right after submitting a `function_call_output` that references its call_id
   * left the conversation with a dangling reference, and the model would stall
   * and mumble instead of moving on. Function-call items are small; leaving
   * them costs far less than corrupting the turn.
   */
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
          // Only messages are ever deleted between cards - see clearHistory.
          if (event.item?.id && event.item?.type === 'message') {
            itemIdsRef.current.push(event.item.id)
          }
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
          let graded = false
          for (const item of output) {
            if (item?.type === 'function_call' && item?.name === 'record_grade') {
              handleRecordGrade(item)
              graded = true
            }
          }
          // The model has just finished reading the question, so hand over the
          // answer now - it can no longer skip asking. Deliberately keyed off
          // response.done rather than a VAD event: turn detection fires
          // unevenly, and hanging the answer injection (and with it every
          // model response) off speech_stopped made the session feel glitchy.
          //
          // Skipped when this turn recorded a grade: handleRecordGrade has
          // already advanced to the next card and re-armed the flag, and that
          // card's question has not been read yet.
          const card = queueRef.current[0]
          if (!graded && card && !backInjectedRef.current) {
            backInjectedRef.current = true
            sendSystemText(
              `The correct answer (back) for the card you just asked is: ${card.back}\n` +
                `Keep it to yourself until the user has answered, then judge their ` +
                `spoken answer against it and follow the rating rules.`,
            )
          }
          break
        }
        case 'error':
          // Logged in full as well: the surfaced message is often generic, and
          // a broken session is very hard to diagnose from the UI alone.
          console.error('realtime error', event)
          setError(event.error?.message ?? 'Realtime error')
          break
        default:
          if (typeof event.type === 'string' && event.type.includes('audio') && event.type.includes('delta')) {
            setVoiceState('speaking')
          }
      }
    },
    [handleRecordGrade, sendSystemText],
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
          // Plain server VAD, auto-responding. Driving response.create by hand
          // off speech_stopped made every model reply hostage to a VAD event
          // firing cleanly, which it did not - the answer injection now hangs
          // off response.done instead (see handleEvent).
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
    void finish({ immediate: true })
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
