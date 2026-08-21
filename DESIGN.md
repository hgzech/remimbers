# Remimbers — Design Notes

*v0.5 — 21 Aug 2026. Thinking document, not a spec.*

## Decisions log

| # | Decision | Consequence |
|---|---|---|
| Audience | Hilmar + a few friends | Allowlist, no billing, client-trusted writes are acceptable |
| LLM key | Cloud Functions proxy | Blaze plan; three stateless endpoints |
| Hosting | **GitHub Pages**, not Firebase Hosting | Explicit CORS on Functions; subpath base URL (§2.1) |
| Audio | **Not persisted** | Firebase Storage dropped entirely; IndexedDB holds blobs transiently (§5.1) |
| Platform | **iPhone-first PWA**, Android free | Manual home-screen install; user gesture required for mic (§5.2) |
| Cards | **Auto-accepted**, fixable at review time | No approval inbox |
| Zero-card notes | **Not supported** — every note yields ≥1 card | Simpler model |
| Thin notes | **Never padded from model knowledge**; repaired conversationally at review | Capture stays non-blocking (§4.1a) |
| Grading | LLM judges correct/incorrect; **user picks the difficulty** | Sidesteps LLM leniency (§4.3) |
| Text review | **Included** | It *is* Phase 2 — free by construction (§4.4) |
| Review log | **Schema fixed before the UI**; stores its own FSRS replay state | Rows survive reparameterisation, card deletion, and card edits (§3.1) |
| Fraud | Accepted | No server-side grade validation |

---

## 1. What the app actually is

A reminders app stores a **future action** and interrupts you at a time you chose.
Remimbers stores a **fact you just met** and interrupts you at a time an algorithm chose.

That inversion has one practical consequence that should dominate every design decision:

> Reminders are entered when you have a moment to think. Remimbers are entered mid-conversation, mid-podcast, mid-book — when you have three seconds and no hands.

So the product succeeds or fails on **capture friction**, not on LLM quality. A mediocre card you actually captured beats a perfect card you didn't. Everything below is arranged around protecting that.

The corollary: **capture must never block on the network or on an LLM.** Speak → "captured ✓" → app closed, in under five seconds. Transcription and card generation happen afterwards, invisibly. If OpenAI is down, capture still works and the queue drains later.

---

## 2. Architecture at a glance

```
┌─────────────────────────────────────────────┐
│  Browser (static SPA on GitHub Pages)       │
│  Vite + React + TS + ts-fsrs                │
│                                             │
│  ├─ Capture view    (MediaRecorder)         │
│  ├─ Review view     (WebRTC ↔ Realtime API) │
│  └─ Library view    (browse / edit cards)   │
└───────┬─────────────────────────┬───────────┘
        │ Firebase SDK            │ WebRTC audio + data channel
        │ (auth, Firestore,       │ (direct to OpenAI, using an
        │  offline persistence)   │  ephemeral token)
        ▼                         ▼
┌──────────────────┐      ┌────────────────────┐
│ Firebase         │      │ OpenAI Realtime    │
│ Auth / Firestore │      │ gpt-realtime-2.1-  │
│ Rules            │      │ mini               │
└────────▲─────────┘      └────────────────────┘
         │
┌────────┴──────────────────────────────────────┐
│ Cloud Functions (2nd gen) — the only secret-   │
│ holding component. Three endpoints:            │
│  1. POST /transcribe        audio → text       │
│  2. onCreate(note)          text → cards       │
│  3. POST /realtime-token  → ephemeral key      │
└────────────────────────────────────────────────┘
```

No Firebase Storage — audio is never persisted (§5.1), which removes a whole product from the stack.

### 2.1 "Static site" and React are not in tension

Worth being explicit, since this caused some confusion. **Static** means *no origin server executes code per request* — a CDN hands out files it already had. It does **not** mean "no JavaScript framework."

React is a *build-time* dependency. `vite build` compiles it into a handful of `.html`, `.js` and `.css` files. That's the entire deployed artifact; there is no Node process running anywhere. The React code executes in the visitor's browser, exactly like hand-written JS would, just organised better.

The thing to avoid is Next.js or Remix in SSR mode, which *do* need a live Node server. A Vite SPA does not. What we're building is a static site by any definition GitHub Pages cares about.

Cloud Functions are the one exception, and calling them a "backend" oversells them: three stateless handlers, no database of their own, no session, no routing. They exist solely because a browser cannot be trusted with an OpenAI key. If OpenAI ever shipped safe browser-side auth, they'd vanish.

### 2.2 What GitHub Pages costs us

Two things, both one-time:

- **CORS becomes explicit.** Firebase Hosting could rewrite `/api/**` to a Function, making calls same-origin. Pages can't, so the browser calls the Functions URL cross-origin and the Functions need an origin allowlist. Note that CORS is a browser convention, not access control — `curl` ignores it — so every endpoint that spends money verifies the Firebase ID token itself.
- **A subpath.** Pages serves project sites from `https://<user>.github.io/remimbers/`. Vite's `base`, the PWA manifest's `start_url`/`scope`, and React Router's `basename` must all agree, or the installed app opens on a blank screen. Derive all three from one variable. Also: Pages has no SPA rewrite, so `dist/index.html` is copied to `404.html` at build time to make deep links work.

Also required: add `<user>.github.io` to Firebase Auth's **Authorized domains**, or sign-in fails with an error that doesn't name the domain it wanted.

**Note:** Cloud Functions requires the **Blaze** plan (you have it). Free allowances still cover everything here; the Firebase bill rounds to zero. The OpenAI bill is the one to watch (§7).

---

## 3. Data model

Everything under `users/{uid}/…` so the security rules are one line.

### `users/{uid}/notes/{noteId}` — the raw capture

| field | type | notes |
|---|---|---|
| `rawText` | string | the transcript |
| `source` | `'voice' \| 'text' \| 'share'` | |
| `status` | `'transcribing' \| 'generating' \| 'done' \| 'failed'` | drives the capture-queue UI |
| `createdAt` | Timestamp | |
| `cardIds` | string[] | |

### `users/{uid}/cards/{cardId}` — the derived flashcard

| field | type | notes |
|---|---|---|
| `noteId` | string | provenance — **never drop this** |
| `front`, `back` | string | |
| `type` | `'qa' \| 'cloze'` | |
| `tags` | string[] | LLM-suggested, user-editable |
| `due` | Timestamp | **indexed** |
| `state` | 0–3 | New / Learning / Review / Relearning |
| `stability`, `difficulty`, `elapsed_days`, `scheduled_days`, `reps`, `lapses`, `last_review` | | FSRS state, stored flat rather than nested so it round-trips cleanly |
| `suspended` | bool | |

### `users/{uid}/cards/{cardId}/reviews/{reviewId}` — the log

Three reasons this subcollection matters more than it looks:

1. FSRS parameter optimisation needs a complete review history — you cannot reconstruct it later.
2. `llmJudgedCorrect` against your subsequent rating is your only measurement of **grader calibration** (§6.3). Without it you're flying blind, and it cannot be backfilled.
3. `userAnswerTranscript` tells you *why* a card keeps failing — usually the card is bad, not you.

#### 3.1 The row, as built in Phase 2

*Settled 21 Aug 2026, before the review UI, because this is the one shape in the app that can't be migrated by rerunning something.*

Everything else here is derived: delete every card and a regeneration pass over the notes brings them back. A review is an **event** — it happened at a moment, in a state that no longer exists — so the schema is fixed first and carries fields Phase 2 itself has no use for.

| group | fields | why |
|---|---|---|
| identity | `cardId`, `noteId` | denormalised out of the path. A collection-group export shouldn't have to parse document paths, and a review outlives its card |
| the answer | `rating` (1–4), `mode`, `llmJudgedCorrect`, `userAnswerTranscript`, `llmRationale` | §4.3's split: the model's binary, your difficulty |
| timing | `reviewedAt`, `syncedAt`, `durationMs`, `revealMs` | |
| replay | `before` (ts-fsrs's own `ReviewLog`), `after`, `scheduler` | |
| provenance | `cardEditedAt`, `schemaVersion` | |

Four of those took an argument, and the arguments are the point:

- **`llmJudgedCorrect` is `null` in text mode, never `false`.** `false` is a claim — *the grader said you were wrong*. Text review runs no grader at all. Collapsing "nobody judged" into "judged incorrect" would silently poison the exact number §6.3 exists to produce, and every Phase 2 review would be in the denominator of a calibration statistic it was never part of.
- **`before` is stored, not recomputed.** In principle the pre-review state is replayable from the card's whole history in order. In practice Phase 5 *changes the parameters*, and a replay under new weights doesn't reproduce the state the old weights actually produced. Storing ts-fsrs's `ReviewLog` verbatim, alongside the `scheduler` block that produced `after`, makes every row self-describing: you can refit without reconstructing anything, and a row survives its card being deleted or regenerated.
- **`reviewedAt` is a client timestamp, deliberately.** It is the exact instant handed to FSRS, so the row agrees with the arithmetic that was actually applied; a `serverTimestamp()` would also be unavailable offline, where review is expressly meant to work. `syncedAt` is the server's, and bounds it from outside — the only defence against a wrong device clock quietly corrupting the intervals the optimiser learns from.
- **`cardEditedAt` is the card's `updatedAt` at review time.** Cards get fixed at the moment they annoy you (§4.1a), so card text churns by design. Two reviews of "Why did he forbid it?" and of the repaired question are not measurements of the same thing. Logging the content version lets that history be split into comparable halves later. It's also why answering a card leaves `updatedAt` alone — and why editing one writes a client timestamp, so the value is knowable locally the instant it changes.

`revealMs` (shown → answer revealed) is separated from `durationMs` (shown → rated) because the first is retrieval effort and the second includes deciding which button to press. Cheap now, unbackfillable later.

**Deleting a card does not delete its reviews.** Firestore keeps subcollection documents when the parent goes, which is what we want: a card deleted for being bad is precisely the calibration data worth keeping.

**Why keep the note?** Cards are derived data. Keeping `rawText` means you can regenerate the whole deck when you improve the generation prompt, and it gives the grading model context ("the source said…"). Treat notes as source and cards as build output.

### Due-card query

```ts
query(cards,
  where('suspended', '==', false),
  where('due', '<=', Timestamp.now()),
  orderBy('due'),
  limit(20))
```

One composite index. Fetch the day's queue in a single read, then work offline.

---

## 4. The three LLM boundaries

Keeping these separate is the main structural decision in the app. Different models, different failure modes, different costs.

### 4.1 Note → cards *(Cloud Function, background, cheap text model)*

Fires on note creation. Structured output, always an array — one utterance often contains two or three facts.

`gpt-5.6-luna`-class is plenty ($0.10/$0.60 per 1M). Cost per note: negligible.

The prompt does the real work here. Non-negotiables:

- **One fact per card.** The single strongest finding in the SRS literature. Your Pythagoras note should probably produce *two* cards: "Why did Pythagoras forbid eating beans?" and "What did Pythagoreans believe beans contained?"
- **The question must be answerable without seeing the note.** LLMs love writing "Why did he forbid it?" — pronouns with no antecedent are the #1 generated-card failure.
- **Answers short enough to say out loud.** You will be grading these by voice.
- **Preserve the user's phrasing** where it carries meaning. Don't let the model "improve" a technical term into a vaguer one.
- **Always return at least one card.** No zero-card notes — if the note is thin, make one card from it rather than silently dropping the capture.

**Decided: cards are auto-accepted.** No approval inbox — those get abandoned by week three. Instead, every card shows its source note during review, so a bad card gets fixed or deleted in one tap *at the moment it annoys you*. Fix-on-encounter beats a review queue for a personal tool, and it means the cost of a mediocre generated card is one mildly irritating review rather than a chore you have to do up front.

### 4.1a Thin notes: clarify at review, never at capture

*Added 20 Aug 2026, from the first prompt eval sweep.*

Some notes are too thin to card honestly — dictation cut off by a dropped mic, a term captured with no context, a sentence that trails off. There are only two ways to handle one, and they pull in opposite directions:

- **Pad it from the model's own knowledge.** Produces a good-looking card containing something you never actually heard. This is the worst failure the app can have, and not because the added fact is likely to be wrong — it usually isn't. It's that a fabricated card is *indistinguishable from a real one*. You cannot tell, months later, which parts of your deck came from the world and which came from the model, and the moment that's true the deck stops being a record of what you learned. It also quietly voids §3's promise that the deck can be regenerated from notes, since the notes no longer contain what the cards test.
- **Card only what survived.** Honest, and visibly thin.

**The second, always.** Observed rate: `gpt-5.6-luna` fabricated in exactly one of twenty eval cases — the single case where the note gave it nothing to work with. Everywhere else it stayed inside the note, including a case where supplying a correct missing name would have been trivial. So the failure mode is real but narrow: it appears precisely when the note is starved, which is exactly when a thin card is the right answer anyway.

**The obvious objection, and the answer.** A conversational capture would just say "I didn't catch that." Fire-and-forget voice notes can't — that's a genuine cost of the capture model, not an oversight. But §1 makes non-blocking capture the property everything else is arranged around: speak, "captured ✓", app closed, five seconds. A clarification round trip at capture would destroy it to fix a minority of notes.

The resolution is that the clarification doesn't have to happen *at capture*. It happens at **review**, where Phase 4 already has a conversational agent:

> "You noted 'Rayleigh scattering' but didn't say what about it — want to fill that in?"

Which is better than clarifying at capture, not merely cheaper. At capture you're mid-podcast with three seconds; at review you're already thinking about that fact and have nothing else to do. It also gives the rehearsal agent a second job beyond quizzing — repairing the deck as you go — which is the sort of thing that justifies a conversation over four buttons.

**What this requires of the parts built before Phase 4:** Phase 1 must produce thin cards rather than padded ones, so there is something visible to repair. That constraint is in the generation prompt now (`functions/src/prompt.ts`, "Notes get cut off"), tested by the `truncated-dictation` eval case.

### 4.2 Rehearsal conversation *(browser ↔ Realtime API, WebRTC)*

`gpt-realtime-2.1-mini`. Flow:

1. Browser → `/api/realtime-token`; the Function POSTs to `https://api.openai.com/v1/realtime/client_secrets` with the real key and returns a short-lived client secret.
2. Browser opens an `RTCPeerConnection`, adds the mic track, POSTs the SDP offer to `https://api.openai.com/v1/realtime/calls` with the ephemeral token.
3. A data channel named `oai-events` carries JSON events both ways; audio flows on the media track automatically.

The key is never in the browser and the ephemeral token expires in minutes.

**The answer-leak problem, and a clean fix.** The model needs the correct answer to grade — but if the answer is in context when it asks the question, it will eventually leak it. Prompting alone is unreliable here. Instead use the fact that Realtime sessions accept mid-session context injection:

1. Inject **only the front**; the model asks the question.
2. User answers; server VAD signals speech stopped.
3. Browser injects the back as a system-role `conversation.item.create`.
4. Model grades.

Structural rather than exhortative. Worth the extra plumbing.

**Repair is the second job.** Beyond grading, the rehearsal agent is where thin or bad cards get fixed (§4.1a). A card the generator could not write well becomes a question the agent asks you, once, at the moment you are already thinking about it.

**Context pruning is a cost requirement, not an optimisation.** The Realtime API resubmits full context every turn, so an unmanaged session grows super-linearly in cost — measured sessions have hit $2 for 14 minutes. Clear conversation history between cards. Each card is independent; nothing is lost. This keeps a session near the $0.02–0.05/min floor instead of the $0.15/min ceiling.

### 4.3 Grading — split the judgement from the rating

Your proposed flow turns out to be better than my original design, and worth spelling out why:

> "Correct. Should I rate this Hard, Good, or Easy?" → you say → logged.

The model decides one **binary**: did you retrieve it or not. You decide the **difficulty**. That split is right on two counts.

First, it's more faithful to Anki than an LLM picking all four. In Anki the rating was never purely about correctness — it encodes *how much effort retrieval cost you*, which is information only you have. A model listening to a correct answer genuinely cannot distinguish "instant" from "dragged it up after four seconds of straining."

Second, it neutralises the LLM-leniency problem I flagged in v0.1. Graders reward fluent-sounding wrong answers, and the failure mode of a four-way rating is silent grade inflation across your whole deck. A binary correct/incorrect is a much easier call, and the axis where models drift generous is now yours to set.

So the flow is:

- **Wrong** → `Again`. State it briefly, don't ask — there's nothing to choose.
- **Right** → offer Hard / Good / Easy, accept by voice or tap.

One tool, called after you answer:

```jsonc
{ "name": "record_grade",
  "parameters": { "cardId": "…", "rating": "good", "judgedCorrect": true,
                  "rationale": "Got transmigrating souls; missed the Orphic link." } }
```

**FSRS decides the date, always.** The LLM never emits an interval, an ease factor, or a due date — only one of the four labels. Keeping the model out of the arithmetic is what stops scheduling quality from drifting with prompt changes.

Still worth writing an explicit rubric for the binary, with worked examples. Anki's bar is retrieval, not recognition: "something about souls?" is a miss.

### 4.4 Text review comes free

You asked whether the text fallback is cheap to add. It's cheaper than that — **it's Phase 2**, so it exists before the voice mode does and simply stays.

That ordering is deliberate. Phase 2 gives you a working Anki with four buttons, usable daily, generating the review history that makes Phase 4 worth having. When the realtime layer arrives it sits on top as an alternative presenter, and the button UI remains as the fallback for: no signal, no privacy to talk aloud, a dead mic, a hit daily cost cap, or a 60-card backlog where conversation is just slow.

Which is the real point: voice rehearsal is delightful for ten cards and tedious for sixty. Text mode isn't a degraded path, it's the right tool for a different session.

---

## 5. Voice capture

### 5.1 Audio is not persisted — and that removes a whole component

Agreed, and it simplifies more than it first appears: with no audio archive there is **no Firebase Storage in the stack at all**. Flow becomes:

```
MediaRecorder → Blob → POST to Function → transcription → text → Firestore
```

The audio exists in memory, crosses the wire once, and is gone.

**One thing to keep, though.** Hold the blob in **IndexedDB until transcription succeeds**, then delete it. Not as an archive — as crash insurance. If you record on the Metro with no signal, or the tab dies mid-upload, the capture survives and retries when you're back. Without it, a failed upload silently loses the thought, which is the one failure this app cannot afford: the whole premise is that you trust it enough to speak into it and walk away.

It's roughly thirty lines and costs nothing. The iOS seven-day storage eviction doesn't apply — the queue drains in seconds, not days.

The tradeoff you're accepting: if transcription garbles a word, you can't re-run it later against a better model. Given the vocabulary priming below, that's a fair trade.

### 5.2 Which transcription route

Three real options.

### (a) Web Speech API — free, browser-native

Instant, no upload, no cost. But it degrades exactly where this app lives: **proper nouns and technical vocabulary**. "Pythagoras", "transmigrating", "Orphic" are precisely what it mangles, and iOS support has always been the shakiest. For a general dictation app that's an annoyance; for a knowledge-capture app it corrupts the payload.

### (b) Record → server transcription — **recommended**

`MediaRecorder` → direct upload → `gpt-transcribe` at **$0.0045/min**. A 30-second note costs **under a fifth of a cent**. Ten notes a day is roughly **$0.02/day**. The cost argument for (a) evaporates on contact with the actual numbers, and accuracy is dramatically better.

Codec note: Safari's `MediaRecorder` emits MP4/AAC, Chrome emits WebM/Opus. Both are accepted by the transcription endpoint — just feature-detect the mimeType rather than hardcoding one, which is the standard way this breaks on iOS.

Two accuracy upgrades worth building:

- **Vocabulary priming.** Pass a prompt hint built from terms already in your card corpus. This is the single highest-leverage fix for proper nouns, and it compounds — the more you capture, the better it gets at your particular subject matter.
- **Optimistic UI.** Run Web Speech *locally* purely to show live interim text while recording, so the UI feels alive, while the real audio uploads for accurate transcription. Display is Web Speech; truth is the server. Nice-to-have, not v1.

### (c) Realtime API for capture

Overkill. You're not having a conversation, you're dictating. ~10× the cost for no benefit.

### 5.3 iPhone-first PWA — what that actually constrains

This matters more than the transcription choice, and now that the platform is settled, here are the real constraints. None are blockers; all of them bite if discovered late.

**Correction to v0.1:** I suggested auto-arming the mic on load. **That doesn't work on iOS** — Safari requires a user gesture before granting microphone access. So the capture screen is one deliberate tap on a large button, not a zero-tap listen-on-open. Still fast, but design for the tap rather than trying to engineer around it.

The rest:

- **Install is manual.** iOS has no install prompt — Share → Add to Home Screen. You'll do it once; friends need a screenshot. Android *does* prompt, and gets a share target too, so the same codebase is strictly better there.
- **Mic works in standalone PWAs** on current iOS. This was genuinely broken years ago, which is why stale advice says otherwise.
- **Web push works on iOS 16.4+, but only for installed PWAs.** Worth knowing: Apple briefly removed EU home-screen web apps in Feb 2024 and reversed it that March, so this is available to you in Greece — some guides still repeat the withdrawn version. This is the one genuine *reminder* feature Remimbers needs: a daily nudge that cards are due.
- **No background capture.** A PWA can't record from the lock screen or respond to a hardware button. The fastest realistic path is home-screen icon → tap → speak.
- **iOS evicts PWA storage after 7 days of not opening the app.** Irrelevant here — a daily-use app never gets close, and the IndexedDB queue drains in seconds.

Worth adding on iOS: an **iOS Shortcut** that opens the app URL, bindable to the Action Button or Control Centre — the closest thing to a global hotkey the platform allows.

---

## 6. Scheduling

### 6.1 Use FSRS, not SM-2

`ts-fsrs` (FSRS v6) — TypeScript, no native dependencies, ESM/CJS/UMD, runs fine in the browser. MIT licensed and actively maintained.

```ts
const f = fsrs()
const card = createEmptyCard()
const { card: next, log } = f.next(card, new Date(), Rating.Good)
```

FSRS beats SM-2 meaningfully on review count for the same retention, and it's what modern Anki uses by default. No reason to implement SM-2 in 2026.

### 6.2 Scheduling runs client-side

FSRS is pure arithmetic. Run it in the browser, write the resulting card state to Firestore. No function needed. This also means review works fully offline — enable Firestore persistence and the whole review flow degrades gracefully to text-mode with manual grading when there's no signal.

### 6.3 Instrument the grader from day one

Log `llmJudgedCorrect` on every review alongside the rating you chose. Since the model now only makes a binary call (§4.3), calibration is directly measurable: how often does it say "correct" on an answer you then rate `Hard`, or worse, immediately feel was a miss?

After a few hundred reviews that's a real number. Systematic leniency is a prompt fix; noise is a model change. Without the field you'll have impressions instead of data, and it cannot be backfilled — which is why it's in the schema from Phase 0 even though nothing writes it until Phase 4.

Phase 2 writes `null` there rather than `false`, for the reason in §3.1: text reviews must be *outside* the calibration sample, not counted as the grader getting it wrong.

### 6.4 The session queue, and why `Again` means today

*Added 21 Aug 2026, building Phase 2.*

FSRS's learning steps are in **minutes**, not days: a card you rate `Again` is due in one minute. That collides with the due query in a way worth naming, because the obvious implementations are both wrong.

- A **live listener** on the due query re-adds the card the instant its own grade lands — the query it just left is the query it immediately re-enters. The screen flickers and the card never leaves.
- A **fetch-once queue that drops graded cards** turns `Again` into "see you next week", which is the opposite of what the button says.

So the session fetches once with `getDocs`, owns its queue in memory, and re-queues any card whose new due date falls inside the longest (re)learning step — currently 15 minutes, derived from the parameters rather than hardcoded so Phase 5 can't leave it stale. The server is consulted again only when the local queue runs dry. Offline the initial fetch resolves from cache, which is the whole point of persistence.

The four buttons show the interval each would produce, from `scheduler.repeat()` — the same scheduler that `next()` runs a moment later, so there is no second implementation to drift out of agreement with the first.

### 6.5 Retention tiers, and why they are nearly free

*Added 21 Aug 2026. Phase 6 — nothing here changes Phases 3–5, and it is written down now only so the review log keeps being worth what it costs.*

Not every card deserves the same retention. Greek case endings are load-bearing — forget one and the sentence stops parsing, and the failure blocks everything downstream. That Pythagoras forbade beans because he thought they held transmigrating souls is terminal knowledge: nothing sits on top of it, and the cost of a miss is a moment of mild annoyance.

The structural fact that makes this cheap: **desired retention is not part of the memory model.** FSRS stores stability and difficulty per card. Retention enters only at scheduling time, as a multiplier on stability:

```
interval = (S / FACTOR) · (r^(1/DECAY) − 1)
```

At `r = 0.9` that collapses to `interval = S` by construction — which is what stability *means*. Everything else is a constant rescaling:

| Target retention | Interval vs. stability | Review load vs. 90% |
|---|---|---|
| 95% | 0.46× | ~2× |
| 90% | 1.0× | 1× |
| 85% | 1.64× | ~0.6× |
| 80% | 2.40× | ~0.45× |
| 75% | 3.32× | ~0.35× |

(FSRS-6 fits `DECAY` per user rather than fixing it, so the exact multipliers drift. The shape holds.)

Three consequences worth having in writing:

1. **Retroactive changes are free.** Retention is a per-request parameter, so re-tiering a card reschedules it correctly from its existing stability. No migration, no history invalidation, nothing to replay. Which means there is no cost to shipping everything at 90% and splitting later — and therefore no reason to build this before Phase 6.
2. **Tiers cost nothing in fitted data.** The optimiser never sees a retention setting; it sees `(card, elapsed time, grade)` and fits a forgetting curve. If anything, mixed retention *helps* the fit by sampling the curve at a wider spread of intervals. The ~400–1,000-review threshold is about **parameters**, not tiers — an easy and expensive thing to conflate, since it would otherwise argue for keeping tier count low to keep groups large. It does not.
3. **One global parameter set, probably forever.** Difficulty is already a per-card fitted value and absorbs most of the "this material behaves differently" variance. Separate parameter sets per tier only pay off across genuinely huge, genuinely dissimilar bodies of material — tens of thousands of reviews each — which this deck will not have.

So: three tiers, spaced far enough apart that choosing between them means something.

| Tier | Retention | Cost per card | For |
|---|---|---|---|
| **Core** | 95% | ~2× | Load-bearing — grammar, anything other knowledge depends on |
| **Standard** | 90% | 1× | The middle |
| **Casual** | 80% | ~0.45× | Leaf knowledge, nice-to-have |

That is a ~4.4× spread top to bottom. Something like 80/85/90 spans only 2.2× and puts a tier five points from the default, which nobody will ever be confident choosing. The floor is 80 rather than 75 because below that you fail one card in four, and FSRS's post-lapse stability penalty means low-retention cards can churn — lapsing repeatedly rather than maturing. The theoretical minimum-workload point sits near 70–85%, but minimum workload is not the same as a tolerable five minutes.

**Store the tier, derive the retention.** The card carries `"casual"`, not `0.8`; the mapping lives in `src/lib/fsrs.ts` next to the parameters, for the same reason `SESSION_HORIZON_MS` is derived there rather than hardcoded. Retuning what Core means is then one line, and reschedules the whole tier instantly — which is only true because of consequence 1 above.

#### Voice cues as the tier signal

The tier should come out of the capture utterance, not a separate sorting step — a sort step is exactly the friction §5 exists to remove. *"It's interesting that Pythagoras forbade beans…"* is Casual. *"It's important to know…"* is Core. This is how people already talk; it costs nothing to say.

Three rules:

- **Not keyword matching.** Exact triggers are brittle and impose a memorisation burden — was it "interesting" or "fun" or "neat"? The tier is a field in the §4.1 JSON schema, classified by the same call that writes the cards, with those phrasings as strong priors. The classification is free; the call is already happening.
- **Show the inferred tier, one tap to change it.** Inference without visible feedback is where these systems lose trust. This is the same principle as cards being auto-accepted and fixable at review time, applied to a second field.
- **The cue does double duty.** *"It's interesting that X"* also marks X as the salient fact, which is the cloze target. One utterance, two signals, no extra interaction.

What an *absent* cue means is the open question. The dull answer is a default tier (§6.6 argues that should be Casual). The better one: uncued notes land in a staging queue and cued ones go straight into rotation, which makes a cue a statement of confidence — "I have already decided about this one" — rather than just a label, and puts the triage cost only on the cards you were genuinely unsure about. Decide after Phase 3 shows how often cueing actually happens in real captures.

The predictable side effect is that "it's interesting that" drifts from meaning *interesting* to meaning *cheap*. That is fine. It means a command language got learned without anyone having to teach it.

### 6.6 Load forecasting, and the number that lies to you

*Added 21 Aug 2026. Phase 6, alongside §6.5.*

The target is Duolingo time: **about five minutes a day.** That is the real design constraint and it is tighter than it sounds.

Steady state is roughly **ten reviews per day for every one new card per day** at 90% retention — each card generates ~8 reviews in its first year, ~1.5 in the second, ~0.8 in the third, decaying as intervals stretch, summed across every card ever added. Five minutes at ~8s per card is ~40 reviews. Running that backwards:

| Mix | New cards/day |
|---|---|
| All Core (95%) | ~2 |
| All Standard (90%) | ~4 |
| All Casual (80%) | ~9 |

Two things fall out. First, **at this budget Casual is probably the default and Standard the promotion** — if everything lands at 90%, four cards a day consumes the entire allowance and the app feels stingy exactly when it is being enjoyed. Unless Greek grammar is the point and the trivia is garnish, which is a question about what Remimbers is *for* and deserves an explicit answer rather than an inherited default.

Second, and this is the trap the section is named after: **the 10× multiplier is steady state, reached after two or three years.** In month two the load is a third of it. Adding ten a day will feel entirely fine for the better part of a year and then quietly become fifteen minutes. So the number on screen must be the *projected* steady-state load, not the current one. Current load is reassuring and wrong.

**Budget in measured seconds, not cards.** Grammar production cards run 15–20s; trivia recognition runs 5s. Any static per-card estimate is wrong for this deck in particular — and the measurement already exists, because §3.1 puts `durationMs` and `revealMs` on every review row. Back-solve the sustainable add rate from measured per-tier cost. It self-corrects as card formulation improves, and it is a second payoff from a log that was preserved for a different reason.

The forecast itself is cheap: run `scheduler.repeat()` forward over the existing deck plus an assumed add rate. No model call, no server, no new data — the same arithmetic Phase 2 already does to label the four buttons. The graph is projected reviews/day over ~3 years, stacked by tier, with the five-minute budget drawn as a horizontal rule. The thing worth looking at is where the curve crosses it.

The encouraging half, worth recording so the numbers above don't read as discouraging: 40 reviews/day is *robust*. A week away is a 280-card backlog — two long sessions, not a death spiral — where a 200/day habit would leave 1,400 and end the habit. And 4 cards a day is ~1,500 a year, ~4,400 after three years. Small budgets compound much better than they feel.

---

## 7. Cost model

The Firebase side is free-tier noise. OpenAI is the whole bill.

| Component | Model | Unit cost | Realistic monthly |
|---|---|---|---|
| Transcription | `gpt-transcribe` | $0.0045/min | ~$0.70 |
| Card generation | `gpt-5.6-luna` class | $0.10/$0.60 per 1M | ~$0.20 |
| **Rehearsal** | `gpt-realtime-2.1-mini` | **$0.02–0.08/min** | **$6–25** |

A 10-minute voice session runs **$0.30–0.80**. Daily, that's **$9–24/month per user** — the dominant cost by an order of magnitude, and it scales linearly with friends. The full `gpt-realtime-2.1` model is ~3× that; don't reach for it without evidence you need it.

Three controls, all worth building before you invite anyone:

1. **Aggressive context pruning** between cards (§4.2) — the largest single lever.
2. **A per-user daily cap on minted realtime tokens**, enforced in the token Function against a Firestore counter. The token endpoint is the door to all real spend; it's the right chokepoint.
3. **A text-mode review path** that costs nothing. Also your fallback when the mic is unavailable, and — usefully — the mode you'll want for burning through a 60-card backlog, where conversation is just slow.

That third point is a product observation as much as a cost one: voice rehearsal is delightful for 10 cards and tedious for 60.

---

## 8. Access control

Google sign-in plus an `allowlist/{email}` collection, checked directly in the rules — no Cloud Function needed:

```
function isAllowed() {
  return request.auth != null
    && request.auth.token.email_verified == true
    && exists(/databases/$(database)/documents/allowlist/$(request.auth.token.email.lower()));
}

match /users/{uid}/{document=**} {
  allow read, write: if request.auth.uid == uid && isAllowed();
}
```

Inviting a friend is creating one empty document named after their email. Revoking is deleting it. The client also reads the allowlist, but only to show "you're not invited" instead of a wall of permission errors — faking that check gains nothing, since the rules are what actually hold.

Note that the repo is public (GitHub Pages project sites require it on the free tier) and the Firebase web config ships in the bundle. That's fine and by design: those are public identifiers, not credentials. The rules above are the entire security boundary, which is worth internalising — it means rule changes deserve more care than any other change in the codebase.

**Accept the trust model consciously:** the browser writes grades directly, so a user could forge their own review history. As you said, there's no motivation to cheat at your own flashcards — the only person harmed is the forger. Writing it down now stops it being rediscovered as a "bug" later. It *would* have to move server-side if this ever grew shared decks or anything competitive.

---

## 9. Build order

The ordering principle: **the app should be genuinely useful before any of the fancy parts exist**, and each phase should be independently shippable. If the realtime session turns out to be a disappointment, you still have a working spaced-repetition app rather than a pile of infrastructure.

| Phase | Deliverable | Proves |
|---|---|---|
| **0** | Vite + React + TS skeleton, Google auth + allowlist, text capture, Firestore rules, Pages deploy | Plumbing works end to end ✅ |
| **1** | **Text** capture → LLM → cards → library view with edit/delete ✅ | **Card quality.** The riskiest assumption, tested cheapest. If the LLM writes bad cards, nothing downstream matters |
| **2** | FSRS + classic review UI with manual Again/Hard/Good/Easy buttons | You now have a working Anki. Usable daily. Start accumulating real review data ✅ |
| **3** | Voice capture: MediaRecorder → transcribe → note, PWA install, offline queue | The actual product thesis — is capture fast enough that you use it? |
| **4** | Realtime rehearsal, tool-call grading, confirm step, cost caps | The differentiator |
| **5** | FSRS parameter optimisation on your own review log; grader calibration review | Compounding quality |
| **6** | Retention tiers from voice cues + steady-state load forecast (§6.5, §6.6) | Sustainability — keeping the habit inside five minutes a day |

Phase 1 is deliberately first. Paste in twenty notes of the kind you'd actually speak, look hard at the cards, and iterate the prompt until they're good. That prompt is the product; everything else is scaffolding around it.

Phase 2 gives you something worth opening every day, which matters: you need real cards and real review history before the Phase 4 conversation has anything interesting to work with.

Phase 6 is last for two reasons, both in §6.5: re-tiering is retroactively free, so nothing is lost by shipping everything at 90% first, and the forecast is only honest once Phase 5 has fitted parameters and enough reviews to measure real per-tier seconds from. Building it earlier would mean guessing at both.

---

## 10. Still open

The v0.1 questions are answered in the decisions log. What remains:

1. **Where is the correct/incorrect line?** Anki's bar is retrieval, not recognition — "something about souls?" is a miss. Worth writing the rubric with three or four worked examples *before* writing the prompt, because it's the one judgement you're delegating entirely.
2. **Does the realtime model do the judging, or a text model?** Now a much smaller question than in v0.1, since it's only a binary. Start with the realtime model — one round trip, cheapest — and let §6.3's data decide whether to move it.
3. **Daily cost cap: what number?** §7 needs a concrete ceiling on minted realtime tokens before anyone else is invited. Easier to pick after you've seen a week of your own sessions.
4. **Which tier is the default, and does an uncued note go straight into rotation?** §6.5 and §6.6 disagree with each other's instincts here, and the tiebreaker is data Phase 3 will produce: how often you actually cue, and whether the deck is mostly trivia with grammar on the side or the reverse.
5. **Do you want the daily-due push notification?** iOS supports it for installed PWAs, and it's arguably the one place Remimbers should behave like a reminders app. Not needed before Phase 4.

---

## Sources

- [OpenAI API pricing](https://developers.openai.com/api/docs/pricing)
- [Realtime API with WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc)
- [Realtime and audio guide](https://developers.openai.com/api/docs/guides/realtime)
- [Realtime API pricing, measured across 4,000 sessions](https://hackernoon.com/openai-realtime-api-pricing-in-2026-real-world-data-from-4000-measured-sessions)
- [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs)
- [PWA iOS limitations and Safari support](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide) — note its EU-push claim is out of date
- [Apple reverses decision on EU home-screen web apps](https://techcrunch.com/2024/03/01/apple-reverses-decision-about-blocking-web-apps-on-iphones-in-the-eu/)
