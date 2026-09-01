import { useCallback, useEffect, useRef, useState } from 'react'
import { Rating, type Grade } from 'ts-fsrs'
import { useAuth } from '../auth/AuthProvider'
import { fetchAheadCards, fetchDueCards, fetchNextDue, gradeCard } from '../lib/review'
import { SESSION_HORIZON_MS } from '../lib/fsrs'
import { createRealtimeSession, mintToken, type RealtimeSession } from '../lib/realtime'
import type { Flashcard } from '../lib/types'
import { useLanguages } from '../settings/SettingsProvider'
import { DoneScreen } from './Review'

/**
 * Transcription of what the USER says, for the review log - not the voice the
 * model speaks with, which is the Realtime model itself (lib/realtime.ts).
 *
 * `gpt-4o-transcribe` retires 26 Feb 2027. `gpt-transcribe` replaces it, and
 * is the right half of the pair here: it transcribes each committed turn once,
 * which is exactly what a log field wants. `gpt-live-transcribe` streams
 * incremental deltas for live captions nobody in this app is reading, at
 * roughly four times the price.
 */
const TRANSCRIBE_MODEL = 'gpt-transcribe'

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
 *
 * On rating, the prompt is back to DESIGN.md section 4.3 exactly: the model
 * calls the binary (retrieved it or not), the user calls the difficulty, every
 * time. An earlier cut let the model skip the ask and log Easy by itself when
 * an answer sounded fast and confident. Its intuitions were not good enough,
 * and section 4.3 gives the reason they were never going to be - a listener
 * genuinely cannot tell "instant" from "dragged it up after four seconds of
 * straining", which is precisely what the rating is meant to encode.
 *
 * One asymmetry survives that, from watching it work: its read on "that was
 * effortless" is good, so it may name Easy and have it confirmed. Its read on
 * Hard versus Good is not, so there it asks an open question and offers no
 * guess at all - naming one would anchor the very answer being elicited, and
 * anchoring is only harmless when the guess is reliable. Either way nothing is
 * logged until the user has agreed to it out loud.
 */
const SYSTEM_PROMPT = `You are a spaced-repetition tutor helping the user review flashcards.
Cards are fed to you one at a time, in two halves - never both at once.

How a card runs:
1. You are given a card's question (front) only. Read it aloud, naturally, and then STOP. Do not grade, do not guess at an answer, do not call any tool - you have not heard the user yet and you do not have the correct answer at this point.
2. You are then handed the correct answer (back) in a system message. Say nothing when it arrives - it is for your judgement only. Never read it out or hint at it before the user has answered.
3. The user speaks their answer.
4. You judge whether it was correct, then ask them for a rating, then STOP and wait.
5. Only after they have spoken a rating do you call record_grade.

The division of labour - this is the most important rule here:
- You decide ONE thing: did they retrieve the key information, or not? Judge on substance, not word-for-word wording.
- You NEVER decide the difficulty rating on your own. You may offer exactly one kind of suggestion - Easy, in the narrow case described below - but a suggestion is not a decision. It still has to be agreed to out loud before you log it.
- Never guess between Hard and Good. How hard retrieval felt is something only the user knows.
- There is no case - none - in which you may log a rating the user has not agreed to out loud.

Multi-part answers - every element has to be there:
- When the answer contains more than one key element - a name and a place, a person and a date, two causes - the user must retrieve ALL of them. Getting one and missing another is INCORRECT. There is no partial credit and no "close enough".
- Example: the answer is "Eurystheus von Mykene". "Eurystheus" on its own is incorrect, because the place is part of the answer.
- When you mark a partial answer incorrect, say exactly which part was missing rather than just reading the whole answer back: "You got the name but missed 'von Mykene' - marking incorrect."
- This does not contradict judging substance over wording. Paraphrase, translation and a different turn of phrase for the same element are all fine. What is not fine is an element being absent altogether.
- Never quietly wave a partial answer through as correct. Half a retrieval is a failed retrieval, and recording it as a success is how a card silently stops being learned.

If they were correct, acknowledge it in a word and ask for the rating in the SAME breath. One short sentence, exactly one of these two shapes:

(a) Their answer was unmistakably effortless - fast, fluent, straight out, no hesitation and no groping. Name Easy and have them confirm it:
    "Correct - that was Easy?"

(b) Anything else at all - any hesitation, a pause before answering, a slow or unsure delivery. Ask the open question, offering all three:
    "Correct. Hard, Good, or Easy?"
    Here do NOT name a guess, do NOT hint at one, do NOT say which way you were leaning.

- Both shapes are one short sentence, so brevity is never a reason to pick (b). When they were plainly effortless, use (a) - it saves the user a word. Only genuine doubt about which case you are in sends you to (b).
- Why the asymmetry: your read on "that was effortless" is reliable. Your read on Hard versus Good is NOT, and naming a guess there would push them towards an answer that is often wrong.
- Either way, that ends your turn. Stop talking and wait for their reply.
- If you suggested Easy and their reply NAMES a rating - "no, Good", "I'd say Good", "more like Hard" - then that is their rating. Log it straight away. A reply can turn you down and answer you at the same time, and re-asking something they have just told you is the most irritating thing you can do.
- Only when they decline without naming one - a bare "no", "not really", "hmm, no" - do you ask "Hard or Good?" and wait.

If they were incorrect:
- Say "Not quite - the answer is [answer]." If they had part of it, name the missing part instead: "You got the name but missed 'von Mykene'."
- Then ask: "Mark that Again?"
- That ends your turn. Stop talking and wait for their reply.
- If they come back naming a different rating instead, that is their rating - log it, do not argue and do not re-ask.

The general principle behind both of those: at any point, if the user's reply names a rating, you have what you need. Log it and move on. Only ask again when you genuinely do not have one.

Calling record_grade:
- The record_grade turn is SILENT. Say nothing whatsoever in the turn where you call the tool: no "I'll log that", no "let me record that", no "and then we continue", no announcement of any kind. Call it and stop. You get a turn immediately afterwards, and that turn is the next question.
- NEVER call record_grade in the same turn in which you asked for the rating. Asking is the end of that turn.
- Call it only in a LATER turn, after the user has actually replied with a rating.
- Log exactly what they agreed to. They say Good, you log "good". They say Again, you log "again". If you suggested Easy and they simply agreed, log "easy". Never round their answer toward what you would have picked.
- If their reply does not name a rating, or is unclear, or is about something else entirely: ask again. Do not guess, and do not log anything.
- judgedCorrect is your call; rating is theirs. They are independent, and they are allowed to disagree - a user may rate a correct answer Again, or a wrong one Easy. Record both faithfully as given.

After record_grade:
- Say NOTHING about the rating. Do not confirm it, do not repeat it, do not acknowledge it at all. The user just told you what it was, so saying it back tells them nothing they do not already know - and the next question arriving is itself the proof it was logged.
- Go straight into the next question. That question is your entire next turn: no lead-in, no "right then", no transition of any kind. Just ask it.
- The one exception is the final card of the session, where there is no next question to ask. You will be told explicitly when that happens, and only then do you say a brief closing word.
- You do NOT know how many cards are left, ever. Never say the session is finished, never say "that's us done", never wrap up or sign off on your own initiative. Until you are told the session has ended, there is always another card coming.

Keep it tight. This is the difference between a drill and a slog:
- One short sentence per turn. Two at the absolute most. Never a paragraph.
- Do not repeat the user's answer back to them. They know what they said.
- When they are right, do not restate the correct answer and do not explain why it was right. Confirm and move on.
- No preamble ("Okay, so...", "Right, let's see", "Great question"), no filler praise beyond a single word, and no narrating what you are about to do or what just happened.
- Do not announce card numbers, progress, or how many are left.
- Never make the same point twice in different words. If you have said it, it is said.
- Silence is fine. When you have asked a question, stop - do not fill the wait with encouragement.`

const RECORD_GRADE_TOOL = {
  type: 'function',
  name: 'record_grade',
  description:
    'Record the outcome of the current flashcard. Call this ONLY after the user has ' +
    'agreed to a difficulty rating out loud in an earlier turn - never in the same ' +
    'turn you asked for it, and never with a rating they have not agreed to.',
  parameters: {
    type: 'object',
    properties: {
      cardId: { type: 'string', description: 'The cardId given to you when this card was presented.' },
      rating: {
        type: 'string',
        enum: ['again', 'hard', 'good', 'easy'],
        description:
          'The rating the USER stated, or agreed to when you suggested Easy. Never a ' +
          'rating they have not agreed to out loud.',
      },
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
  const languages = useLanguages()
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
      .then(async (cards) => {
        if (cancelled) return
        queueRef.current = cards
        setTotal(cards.length)
        setRemaining(cards.length)
        if (cards.length > 0) {
          setPhase('idle')
          return
        }
        // Nothing due. Fetch the next one anyway - the done screen needs it to
        // say when the next card lands, and to know there is anything to pull
        // forward at all. Without it, "review ahead" would be missing in
        // precisely the case it exists for.
        try {
          const soonest = await fetchNextDue(uid, new Date())
          if (!cancelled) setNextDue(soonest)
        } catch {
          // Leaves the done screen without a next-due hint, which is survivable.
        }
        if (!cancelled) setPhase('done')
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
   * Not immediate by default: the caller has just asked the model to speak a
   * closing confirmation, and tearing the connection down before that audio
   * has played cuts it off mid-word. waitForAudioIdle watches the remote
   * track's actual level, which is the only honest signal here - `response.done`
   * only means the server finished generating, and WebRTC still has to play
   * the audio out in real time after that.
   *
   * A manual "End session" tap means the user wants out now, so that path
   * skips the wait.
   */
  const finish = useCallback(
    async (opts?: { immediate?: boolean }) => {
      if (!opts?.immediate) {
        // Mic off first. The session is ending either way, and a stray word or
        // a cough during the wait would otherwise wake server VAD, trigger a
        // fresh response, and reset the silence the wait is looking for.
        sessionRef.current?.setMuted(true)
        await sessionRef.current?.waitForAudioIdle()
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
        // Fall through with an empty args object - handled by the guard below.
      }

      // No usable rating means the user never actually gave one, so there is
      // nothing legitimate to log. Defaulting (this used to fall back to Good)
      // would quietly write a rating they never said, which is the one thing
      // the prompt promises never happens. Hand it back and let the model ask.
      const rating = RATING_BY_NAME[String(args.rating ?? '').toLowerCase()]
      if (!rating) {
        sessionRef.current?.send({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: item.call_id,
            output: JSON.stringify({
              ok: false,
              error:
                'No valid rating. Nothing was logged. Ask the user for a rating ' +
                '(Again, Hard, Good or Easy), wait for their spoken reply, then ' +
                'call record_grade again with what they said.',
            }),
          },
        })
        sessionRef.current?.send({ type: 'response.create' })
        return
      }
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
        // Last card. The model is told never to decide on its own that the
        // session is over - it cannot see the queue, and when it was left to
        // guess it sometimes signed off with cards still to go. So the end is
        // announced here, by the side that actually knows.
        //
        // The response.create matters too: every other card gets its spoken
        // confirmation for free from injectCard's next question. With no next
        // card, nothing would prompt the model to speak at all.
        sendSystemText(
          'That was the final card of the session - there is no next question. ' +
            'Say one short closing line and nothing more. Do not ask anything ' +
            'further and do not start another card.',
        )
        sessionRef.current?.send({ type: 'response.create' })
        void finish()
      }
    },
    [uid, clearHistory, injectCard, finish, sendSystemText],
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
          audio: {
            input: {
              // Plain server VAD, auto-responding. Driving response.create by
              // hand off speech_stopped made every model reply hostage to a VAD
              // event firing cleanly, which it did not - the answer injection
              // now hangs off response.done instead (see handleEvent).
              turn_detection: { type: 'server_vad' },
              // Opt-in, and without it the transcription events never fire at
              // all - which had been quietly writing null to every voice
              // review's userAnswerTranscript. DESIGN.md section 3.1 keeps that
              // field to explain why a card keeps failing (usually the card is
              // bad, not you), and a review is the one thing in this app that
              // cannot be rebuilt later. Same model as the capture path.
              //
              // `languages` (plural) is required here, not `language` - the
              // two must never both be sent. Without it this path had the same
              // silent-translation bug as capture, except invisibly: nobody
              // reads userAnswerTranscript during a session, so a German
              // rendering of an English answer just landed in the log.
              transcription: { model: TRANSCRIBE_MODEL, languages },
            },
          },
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
  }, [handleEvent, injectCard, languages])

  const toggleMuted = useCallback(() => {
    setMuted((m) => {
      sessionRef.current?.setMuted(!m)
      return !m
    })
  }, [])

  const endSession = useCallback(() => {
    void finish({ immediate: true })
  }, [finish])

  /**
   * Pull forward cards that are not due yet, and go back to the idle screen.
   *
   * Idle rather than straight into the session: the previous session's peer
   * connection is closed by now and its ephemeral token is spent, so starting
   * again has to go through the same deliberate tap - which iOS requires for
   * mic access anyway.
   */
  const reviewAhead = useCallback(() => {
    if (!uid) return
    void fetchAheadCards(uid, new Date())
      .then((cards) => {
        if (cards.length === 0) return
        queueRef.current = cards
        gradedCallIdsRef.current = new Set()
        setTotal(cards.length)
        setRemaining(cards.length)
        setReviewed(0)
        setNextDue(null)
        setError(null)
        setMuted(false)
        setPhase('idle')
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [uid])

  if (!uid || phase === 'loading') {
    return (
      <div className="centered">
        <div className="spinner" aria-label="Loading" />
      </div>
    )
  }

  if (phase === 'done') {
    return (
      <DoneScreen
        reviewed={reviewed}
        nextDue={nextDue}
        error={error}
        onReviewAhead={reviewAhead}
      />
    )
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
