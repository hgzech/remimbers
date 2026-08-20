# Prompt evals

The generation prompt is the Phase 1 deliverable (`functions/src/prompt.ts`).
Everything else in Phase 1 — a trigger, one HTTP call, a batched write — is
plumbing. This directory is how the prompt gets judged.

## Why a dry-run endpoint

Iterating through the real trigger would mean a deploy per wording and a
Firestore slowly filling with junk notes and their cards. So `dryRunCards`
generates and **writes nothing**, and accepts a `promptOverride`. One deploy
buys an unlimited number of prompt candidates.

It verifies the caller's ID token like every other endpoint here, because it
spends money and CORS is not access control.

## Running a sweep

Open the app signed in, then paste `run.js` into the devtools console:

```js
evals.cases = /* paste the `cases` array from notes.json */
await evals.run()                                  // deployed prompt
await evals.run({ promptOverride: '...candidate' }) // a candidate
await evals.run({ only: ['pronoun-trap'] })         // one case
```

`evals.last` holds the raw results for copying out.

## Reading the output

`notes.json` gives each case a `watch` field. It is a rubric, not an expected
answer — most notes have several good cards and only one is ever written, so
comparing against a fixed answer would measure agreement with whoever wrote the
fixture rather than card quality.

Judge each card against the five non-negotiables in DESIGN.md §4.1:

1. **One fact per card.** Over-splitting is as bad as under-splitting.
2. **The question stands alone.** No `he`, `it`, `this`, `the study` without a
   referent in the question itself. This is the #1 generated-card failure.
3. **The answer is sayable.** You will be grading these by voice.
4. **The user's phrasing survives** where the term carries the meaning.
5. **At least one card.** Enforced in code, not by the prompt — but a `fellBack`
   result means the model returned nothing and the eval found a real gap.

Two failure modes the rubric will not catch on its own, so look for them:

- **Fabrication.** A card containing a fact the note never stated. `pronoun-trap`
  exists specifically to bait this: naming Kepler is wrong even though it is true.
- **Recognition instead of recall.** Yes/no framings and questions that contain
  their own answer. They look fine and are worthless after a week.

## The corpus

Two cases are real captures (`"real": true`). The other eighteen are written
against the failure modes DESIGN.md names, plus the transcription damage Phase 3
will start producing. That ratio is backwards and should be fixed: synthetic
notes test the prompt against *someone's idea* of how you capture. Add real ones
as you accumulate them and drop the synthetic case they duplicate.
