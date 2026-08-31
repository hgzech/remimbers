import { useCallback, useEffect, useRef, useState } from 'react'
import { Rating, type Grade } from 'ts-fsrs'
import { useAuth } from '../auth/AuthProvider'
import {
  AHEAD_LIMIT,
  BATCH_SIZE,
  fetchAheadCards,
  fetchDueCards,
  fetchNextDue,
  gradeCard,
} from '../lib/review'
import { createRealtimeSession, mintToken, type RealtimeSession } from '../lib/realtime'
import type { Flashcard } from '../lib/types'
import { DoneScreen } from './Review'

/**
 * Batch voice review (DESIGN.md sections 4.2/4.3, with one deliberate departure).
 *
 * A batch of cards - questions and answers together - is loaded into the model's
 * context in one go, and it works through them conversationally. That is what
 * buys continuity: it can notice three fast answers in a row, or two cards
 * circling the same topic, which a card-at-a-time session structurally cannot.
 *
 * The departure is that DESIGN.md section 4.2 withholds each answer until the
 * user has spoken, precisely because it judged prompting unreliable at stopping
 * a leak. Holding a whole batch of answers is a bigger version of the thing that
 * section warns about, and it is being taken on knowingly, in exchange for the
 * continuity above. Two things follow from that: the leak rules below are the
 * load-bearing part of this prompt rather than boilerplate, and a leak is silent
 * when it happens - a spoiled card looks exactly like a normal one - so it is
 * worth listening for rather than waiting for it to announce itself.
 */
const SYSTEM_PROMPT = `You are a spaced-repetition tutor drilling the user through a set of flashcards.

You have been handed the whole set at once: an ordered list, each card with its cardId, its question and its answer. Work through them strictly in order, one at a time.

THE CARDINAL RULE - you are holding answers the user has not earned yet.

You can see every question and every answer in the set. The user can see none of them. So everything you say must be something that could be said by someone who knows only the cards already answered. Treat every card you have not yet asked as though you had never read it.

- Never state, quote, paraphrase, spell, translate or partly reveal an answer before the user has attempted that card.
- Read each question as written. Do not embellish it, do not rephrase it using words taken from its own answer, and do not add context you only have because you can see the answer.
- Give NO structural hints before they attempt a card. Do not say how many parts the answer has, do not add "and where?", do not say "there's a place too", do not narrow the field with things like "it's a Greek name". If an answer has two elements they must find both unprompted - that is exactly what the multi-part rule below is testing.
- Never trail a later card: no "this connects to something coming up", no "remember that for later", no "you'll see this one again".
- Do not summarise the set, do not describe its themes, do not say what is coming, do not say how many cards remain.
- If the user asks what is next, decline in a few words and put the current question to them.

Before you speak, run one check over what you are about to say: does any part of it come from a card they have not yet answered? If so, cut that part.

Why this rule outranks everything else here: a leak is invisible after the fact. A card whose answer you gave away still gets answered, still gets graded, still gets logged and scheduled - and the schedule then asserts a piece of knowledge that was never actually tested. Nothing downstream can tell that apart from a real review, so there is no catching it later. The only place it can be prevented is here.

For each card, in this order:
1. Read the question aloud, naturally. Then stop and wait.
2. The user answers.
3. Judge it, ask for a rating, and wait for their reply.
4. Call record_grade, then go on to the next card.

Judging - did they retrieve it?
- Judge on substance, not word-for-word wording. Paraphrase and translation are fine.
- Multi-part answers: when the answer holds more than one key element - a name and a place, a person and a date, two causes - they must retrieve ALL of them. One out of two is INCORRECT. There is no partial credit and no "close enough".
  Example: the answer is "Eurystheus von Mykene". "Eurystheus" on its own is incorrect, because the place is part of the answer.
  When you mark a partial answer incorrect, name the part that was missing rather than reading the whole answer back: "You got the name but missed 'von Mykene' - marking incorrect."
- Never quietly wave a partial answer through as correct. Half a retrieval is a failed retrieval, and recording it as a success is how a card stops being learned without anyone noticing.

Rating - they decide it, and you never log one they have not agreed to:
- Correct and unmistakably effortless - fast, fluent, straight out, no hesitation, no groping, no self-correction: name it and have them confirm. "Correct - that was Easy?"
- Correct but anything else - any hesitation, a pause, a slow or unsure delivery, a self-correction: ask the open question and offer all three. "Correct. Hard, Good, or Easy?" Here do NOT name a guess and do NOT hint at one.
- Why the asymmetry: your read on "that was effortless" is reliable. Your read on Hard versus Good is not, and naming a guess there would push them towards an answer that is often wrong. If you are at all unsure which case you are in, ask the open question.
- Incorrect: "Not quite - the answer is X" (or the missing-part version above). Then ask: "Mark that Again?"
- If their reply NAMES a rating - "no, Good", "I'd say Good", "more like Hard" - that is their rating. Log it at once. A reply can turn you down and answer you in the same breath, and re-asking what they have just told you is the most irritating thing you can do.
- Only a bare decline that names nothing - "no", "not really" - gets a follow-up: "Hard or Good?"
- If a reply names no rating and is simply unclear, ask again. Never guess, and never log.

Calling record_grade:
- Say NOTHING in the turn where you call it. No "I'll log that", no "let me record that", no announcement of any kind. Call it and stop - you get a turn immediately after, and that turn is the next question. Anything said here is the same thing said twice.
- Never call it in the same turn in which you asked for the rating. Asking ends that turn.
- rating is what the user agreed to; judgedCorrect is your own binary call. They are independent and they are allowed to disagree.
- Afterwards go straight into the next question. No confirmation, no "logged", no transition of any kind - the next question IS the transition.

Noticing things is welcome, within one hard limit:
- You may briefly remark on a pattern among cards ALREADY ANSWERED - three answered instantly in a row, a lapse on something they had nailed earlier, two answered cards that turned out to share a topic.
- Never about a card still to come, and never phrased so that it tells them anything about what is coming. "You're on a roll" is fine. "These next few are all Greek myth" is a leak wearing a compliment.
- Occasionally, and in one short sentence. This is still a drill.

Keep it tight:
- One short sentence per turn. Never a paragraph.
- Do not repeat the user's answer back to them.
- When they are right, do not restate the answer and do not explain why it was right.
- No preamble, no filler praise beyond a single word, no narrating what you are about to do.
- Silence is fine. When you have asked something, stop.
- You will be told when to fetch more cards and when the session has ended. Never announce either on your own initiative.`

const RECORD_GRADE_TOOL = {
  type: 'function',
  name: 'record_grade',
  description:
    'Record the outcome of the card just answered. Call this ONLY after the user has ' +
    'agreed to a difficulty rating out loud in an earlier turn - never in the same ' +
    'turn you asked for it, and never with a rating they have not agreed to.',
  parameters: {
    type: 'object',
    properties: {
      cardId: {
        type: 'string',
        description: 'The cardId of the card being graded, exactly as given in the set.',
      },
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

/** Render one batch as the ordered list the model works through. */
function batchPrompt(cards: Flashcard[]): string {
  const list = cards
    .map(
      (c, i) =>
        `${i + 1}. cardId: "${c.id}"\n   Q: ${c.front}\n   A: ${c.back}`,
    )
    .join('\n')

  return (
    `Here is your set of ${cards.length} card${cards.length === 1 ? '' : 's'}, in order.\n\n` +
    `${list}\n\n` +
    `Ask them one at a time, in this order, starting with the first. Say nothing ` +
    `about any card until you reach it. Begin now.`
  )
}

type Phase = 'loading' | 'idle' | 'connecting' | 'active' | 'done'
type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking'
/** Where a batch came from, which decides whether another one follows it. */
type Source = 'due' | 'ahead'

export function VoiceReview() {
  const { user } = useAuth()
  const uid = user?.uid

  const [phase, setPhase] = useState<Phase>('loading')
  const [voiceState, setVoiceState] = useState<VoiceState>('idle')
  const [muted, setMuted] = useState(false)
  const [fetchingBatch, setFetchingBatch] = useState(false)
  const [reviewed, setReviewed] = useState(0)
  const [batchTotal, setBatchTotal] = useState(0)
  const [batchDone, setBatchDone] = useState(0)
  const [nextDue, setNextDue] = useState<Flashcard | null>(null)
  const [error, setError] = useState<string | null>(null)

  const sessionRef = useRef<RealtimeSession | null>(null)

  /** The batch as handed to the model, for lookup by cardId. */
  const batchRef = useRef<Map<string, Flashcard>>(new Map())
  /** Cards in this batch still to be answered. An `again` card returns here. */
  const remainingRef = useRef<string[]>([])
  /** Graded to completion this session - never re-fetched into a later batch. */
  const completedRef = useRef<Set<string>>(new Set())

  /** Message items only, deleted when a batch ends - see flushContext. */
  const itemIdsRef = useRef<string[]>([])
  const pendingTranscriptRef = useRef<string | null>(null)
  const gradedCallIdsRef = useRef<Set<string>>(new Set())

  /** Start of the current card, approximated - see handleRecordGrade. */
  const cardStartedAtRef = useRef(0)
  const sourceRef = useRef<Source>('due')
  /**
   * Ahead cards fetched but not yet handed over. Review ahead reads its whole
   * allowance in one query and then serves it BATCH_SIZE at a time, so a test
   * session crosses a real batch boundary instead of sitting in one oversized
   * batch - the handover being the part most worth exercising.
   */
  const aheadReserveRef = useRef<Flashcard[]>([])

  /**
   * Handing the next batch over has to wait for two things: the fetch, and the
   * model finishing whatever it is currently saying. They finish in either
   * order, so both paths call maybeStartNextBatch and it starts when both are
   * ready. Injecting mid-utterance would talk over the model.
   */
  const awaitingBatchRef = useRef(false)
  const nextBatchRef = useRef<Flashcard[] | null>(null)
  const responseInFlightRef = useRef(false)

  useEffect(() => {
    return () => {
      sessionRef.current?.close()
    }
  }, [])

  const send = useCallback((event: unknown) => {
    sessionRef.current?.send(event)
  }, [])

  const sendSystemText = useCallback(
    (text: string) => {
      send({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'system',
          content: [{ type: 'input_text', text }],
        },
      })
    },
    [send],
  )

  /**
   * Drop the finished batch's messages before the next one arrives.
   *
   * Only `message` items. Deleting the model's `function_call` items after
   * their `function_call_output` had been submitted left a dangling reference,
   * and the model would stall and mumble rather than move on.
   */
  const flushContext = useCallback(() => {
    for (const id of itemIdsRef.current) {
      send({ type: 'conversation.item.delete', item_id: id })
    }
    itemIdsRef.current = []
  }, [send])

  /** Hand a batch to the model and start it working through the list. */
  const startBatch = useCallback(
    (cards: Flashcard[]) => {
      batchRef.current = new Map(cards.map((c) => [c.id, c]))
      remainingRef.current = cards.map((c) => c.id)
      setBatchTotal(cards.length)
      setBatchDone(0)
      cardStartedAtRef.current = Date.now()
      sendSystemText(batchPrompt(cards))
      send({ type: 'response.create' })
    },
    [send, sendSystemText],
  )

  const finish = useCallback(
    async (opts?: { immediate?: boolean }) => {
      if (!opts?.immediate) {
        // Mic off first: a stray word during the wait would wake server VAD,
        // trigger a fresh response, and reset the silence being waited on.
        sessionRef.current?.setMuted(true)
        await sessionRef.current?.waitForAudioIdle()
      }
      sessionRef.current?.close()
      sessionRef.current = null
      if (uid) {
        try {
          setNextDue(await fetchNextDue(uid, new Date()))
        } catch {
          // Only costs the done screen its next-due hint.
        }
      }
      setFetchingBatch(false)
      setPhase('done')
    },
    [uid],
  )

  /** Both the fetch and the model going quiet must land before we inject. */
  const maybeStartNextBatch = useCallback(() => {
    if (!awaitingBatchRef.current) return
    if (responseInFlightRef.current) return
    const next = nextBatchRef.current
    if (next === null) return

    awaitingBatchRef.current = false
    nextBatchRef.current = null
    setFetchingBatch(false)

    if (next.length === 0) {
      sendSystemText(
        'There are no more cards due. Say one short closing line and nothing more. ' +
          'Do not start another card.',
      )
      send({ type: 'response.create' })
      void finish()
      return
    }

    flushContext()
    startBatch(next)
  }, [flushContext, startBatch, finish, send, sendSystemText])

  /** Batch exhausted: cover the fetch with a line, then swap in the next one. */
  const requestNextBatch = useCallback(() => {
    if (!uid) return

    awaitingBatchRef.current = true
    nextBatchRef.current = null
    setFetchingBatch(true)

    // Review ahead never issues a second query - it serves what it already
    // reserved and then stops. Re-querying would quietly turn a spot check into
    // an open-ended cram, every card of which moves a real schedule.
    if (sourceRef.current === 'ahead') {
      nextBatchRef.current = aheadReserveRef.current
      aheadReserveRef.current = []
      maybeStartNextBatch()
      return
    }

    sendSystemText(
      'That is this set finished. Say one short line to let the user know you are ' +
        'fetching their next cards, then stop.',
    )
    send({ type: 'response.create' })

    void fetchDueCards(uid, new Date(), BATCH_SIZE)
      .then((cards) => {
        // A card graded earlier this session can still be inside its learning
        // step and come back from the query. Re-asking it in the very next
        // batch would loop the session on the same handful of cards.
        nextBatchRef.current = cards.filter((c) => !completedRef.current.has(c.id))
        maybeStartNextBatch()
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e))
        nextBatchRef.current = []
        maybeStartNextBatch()
      })
  }, [uid, send, sendSystemText, maybeStartNextBatch])

  const handleRecordGrade = useCallback(
    (item: any) => {
      if (!uid) return
      if (gradedCallIdsRef.current.has(item.call_id)) return
      gradedCallIdsRef.current.add(item.call_id)

      let args: any = {}
      try {
        args = JSON.parse(item.arguments ?? '{}')
      } catch {
        // Empty args - caught by the guards below.
      }

      const ack = (payload: unknown) => {
        send({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: item.call_id,
            output: JSON.stringify(payload),
          },
        })
      }

      const cardId = String(args.cardId ?? '')
      const card = batchRef.current.get(cardId)
      if (!card) {
        ack({
          ok: false,
          error:
            'Unknown cardId. Nothing was logged. Use a cardId exactly as given in ' +
            'the set, for the card the user has just answered.',
        })
        send({ type: 'response.create' })
        return
      }

      // Graded already, and not waiting for another attempt. The call_id dedup
      // above does not catch this - a second call carries its own call_id - and
      // letting it through would write two review rows for one answer.
      if (!remainingRef.current.includes(cardId)) {
        ack({
          ok: false,
          error:
            'That card has already been graded. Nothing was logged. Move on to the ' +
            'next card in the set.',
        })
        send({ type: 'response.create' })
        return
      }

      // No usable rating means the user never gave one, so there is nothing
      // legitimate to log. Defaulting would quietly record a rating they never
      // said, which is the one thing the prompt promises cannot happen.
      const rating = RATING_BY_NAME[String(args.rating ?? '').toLowerCase()]
      if (!rating) {
        ack({
          ok: false,
          error:
            'No valid rating. Nothing was logged. Ask the user for a rating (Again, ' +
            'Hard, Good or Easy), wait for their spoken reply, then call record_grade ' +
            'again with what they said.',
        })
        send({ type: 'response.create' })
        return
      }

      const now = new Date()

      // Approximate, and honestly so. DESIGN.md section 3.1 wants shown -> rated,
      // but nothing here observes the moment the model reads a question out. This
      // measures from the previous grade instead, so it includes the model asking
      // as well as the user thinking. Consistent between cards, and never null.
      const durationMs = now.getTime() - cardStartedAtRef.current

      const { next, committed } = gradeCard(
        uid,
        card,
        rating,
        {
          mode: 'voice',
          durationMs,
          // No discrete reveal in voice review - the model paces that itself.
          revealMs: null,
          llmJudgedCorrect: typeof args.judgedCorrect === 'boolean' ? args.judgedCorrect : null,
          userAnswerTranscript: pendingTranscriptRef.current,
          llmRationale: typeof args.rationale === 'string' ? args.rationale : null,
        },
        now,
      )
      committed.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      pendingTranscriptRef.current = null
      cardStartedAtRef.current = now.getTime()

      ack({ ok: true })
      setReviewed((n) => n + 1)

      remainingRef.current = remainingRef.current.filter((id) => id !== card.id)

      if (rating === Rating.Again) {
        // FSRS learning steps are in minutes, so `Again` means later today, not
        // next week. Back onto the end of the batch, carrying the state the
        // grade just produced so a second answer is scored from the right place.
        batchRef.current.set(card.id, next)
        remainingRef.current.push(card.id)
        sendSystemText(
          `Card "${card.id}" was rated Again, so it returns to the end of this set - ` +
            `ask it once more after the others. Do not comment on this; carry on with ` +
            `the next card.`,
        )
      } else {
        completedRef.current.add(card.id)
        setBatchDone(batchRef.current.size - remainingRef.current.length)
      }

      if (remainingRef.current.length === 0) {
        requestNextBatch()
        return
      }

      send({ type: 'response.create' })
    },
    [uid, send, sendSystemText, requestNextBatch],
  )

  const handleEvent = useCallback(
    (event: any) => {
      switch (event.type) {
        case 'conversation.item.created':
          // Only messages are ever deleted between batches - see flushContext.
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
          setVoiceState('thinking')
          break
        case 'response.created':
          responseInFlightRef.current = true
          setVoiceState('thinking')
          break
        case 'response.done': {
          responseInFlightRef.current = false
          setVoiceState('listening')
          for (const item of event.response?.output ?? []) {
            if (item?.type === 'function_call' && item?.name === 'record_grade') {
              handleRecordGrade(item)
            }
          }
          // The model has stopped talking, so a batch waiting on it can go in.
          maybeStartNextBatch()
          break
        }
        case 'error':
          // Logged whole: the surfaced message is often generic, and a broken
          // session is very hard to diagnose from the UI alone.
          console.error('realtime error', event)
          setError(event.error?.message ?? 'Realtime error')
          break
        default:
          if (
            typeof event.type === 'string' &&
            event.type.includes('audio') &&
            event.type.includes('delta')
          ) {
            setVoiceState('speaking')
          }
      }
    },
    [handleRecordGrade, maybeStartNextBatch],
  )

  /** Load the opening batch. Cheap, and needs no microphone. */
  const load = useCallback(
    (source: Source) => {
      if (!uid) return
      sourceRef.current = source
      // Review ahead keeps its own smaller limit: it is a spot check that
      // really does move the schedule of every card it touches.
      const ahead = source === 'ahead'
      const fetcher = ahead ? fetchAheadCards : fetchDueCards

      void fetcher(uid, new Date(), ahead ? AHEAD_LIMIT : BATCH_SIZE)
        .then(async (all) => {
          // Never hand the model more than one batch at a time, however many
          // came back - the batch size is what bounds how long an unasked
          // answer sits in context.
          const cards = all.slice(0, BATCH_SIZE)
          aheadReserveRef.current = all.slice(BATCH_SIZE)
          batchRef.current = new Map(cards.map((c) => [c.id, c]))
          remainingRef.current = cards.map((c) => c.id)
          setBatchTotal(cards.length)
          setBatchDone(0)
          if (cards.length > 0) {
            setPhase('idle')
            return
          }
          // Nothing to do. The done screen still needs to know whether anything
          // exists to pull forward, or "Review ahead" goes missing in exactly
          // the case it is for.
          try {
            setNextDue(await fetchNextDue(uid, new Date()))
          } catch {
            // Survivable: the done screen loses its next-due hint.
          }
          setPhase('done')
        })
        .catch((e: unknown) => {
          setError(e instanceof Error ? e.message : String(e))
          setPhase('done')
        })
    },
    [uid],
  )

  useEffect(() => {
    if (!uid) return
    load('due')
  }, [uid, load])

  // Starting needs a direct tap: iOS grants microphone access only inside a
  // user-gesture call chain, the same constraint Capture.tsx works around.
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
              turn_detection: { type: 'server_vad' },
              // Opt-in, and without it the transcription events never fire,
              // which had been writing null to every review's
              // userAnswerTranscript. DESIGN.md section 3.1 keeps that field to
              // explain why a card keeps failing, and a review cannot be
              // rebuilt later. Same model as the capture path.
              transcription: { model: 'gpt-4o-transcribe' },
            },
          },
        },
      })

      setPhase('active')
      setVoiceState('thinking')
      startBatch([...batchRef.current.values()])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start voice review')
      sessionRef.current?.close()
      sessionRef.current = null
      setPhase('idle')
    }
  }, [handleEvent, startBatch])

  const toggleMuted = useCallback(() => {
    setMuted((m) => {
      sessionRef.current?.setMuted(!m)
      return !m
    })
  }, [])

  const endSession = useCallback(() => {
    void finish({ immediate: true })
  }, [finish])

  /** Pull cards forward when nothing is due - one batch, then stop. */
  const reviewAhead = useCallback(() => {
    setError(null)
    setReviewed(0)
    setNextDue(null)
    setMuted(false)
    completedRef.current = new Set()
    gradedCallIdsRef.current = new Set()
    aheadReserveRef.current = []
    itemIdsRef.current = []
    awaitingBatchRef.current = false
    nextBatchRef.current = null
    responseInFlightRef.current = false
    setFetchingBatch(false)
    setPhase('loading')
    load('ahead')
  }, [load])

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
        <p className="review-done">
          {batchTotal} card{batchTotal === 1 ? '' : 's'} ready
        </p>
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
        <span>
          {batchDone} / {batchTotal}
        </span>
        {reviewed > 0 && <span className="review-count">{reviewed} answered</span>}
      </div>

      {error && <p className="review-error">{error}</p>}

      <div className="voice-stage">
        <div className={`voice-indicator voice-${voiceState}`} aria-label={voiceState} />
        <p className="voice-state-label">
          {fetchingBatch ? (
            'Fetching more cards…'
          ) : (
            <>
              {voiceState === 'listening' && 'Listening…'}
              {voiceState === 'thinking' && 'Thinking…'}
              {voiceState === 'speaking' && 'Speaking…'}
              {voiceState === 'idle' && ' '}
            </>
          )}
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
