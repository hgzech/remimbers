# Remimbers

Capture a fact the moment you meet it. Rehearse it later, out loud.

A reminders app stores a future action and interrupts you when you asked.
Remimbers stores something you just learned and interrupts you when a spaced
repetition algorithm says you're about to forget it.

See [`DESIGN.md`](./DESIGN.md) for the architecture and the reasoning behind it.

**Status: Phase 1** — notes are turned into flashcards by a Cloud Function; the
library shows them and lets you fix or delete them.

---

## Stack

| | |
|---|---|
| Frontend | Vite + React 19 + TypeScript, no server rendering |
| Hosting | GitHub Pages (static), deployed by GitHub Actions |
| Data | Firestore, with offline persistence |
| Auth | Firebase Auth (Google) + an invite allowlist |
| Scheduling | [`ts-fsrs`](https://github.com/open-spaced-repetition/ts-fsrs), client-side |
| Secrets | Cloud Functions, `europe-west1`, key in Secret Manager |

The site is genuinely static: `npm run build` emits plain HTML/CSS/JS that a
CDN serves. Cloud Functions exist for exactly one reason — a browser cannot
hold an OpenAI key — and they hold no application state.

---

## Setup

Firebase project `remimbers` (Blaze) and the GitHub repo already exist, and
`.env.production` is committed, so a fresh clone builds with no configuration.

### 1. Install and run

```bash
npm install
npm run dev
```

### 2. Firestore database

If you haven't already: **Firebase console → Build → Firestore Database →
Create database**, production mode, region `europe-west3` (Frankfurt).

### 3. Deploy rules and indexes

```bash
npm i -g firebase-tools
firebase login
firebase use --add          # pick "remimbers", alias it "default"
firebase deploy --only firestore
```

Nothing works before this — the default rules deny every read and write.

### 4. Add yourself to the allowlist

In the Firestore console create a collection `allowlist` with a document whose
**ID is your lowercased email address**. The document can be empty; only its
existence is checked.

```
allowlist/hilmarzech@googlemail.com
```

Same procedure to invite a friend. To revoke, delete the document.

### 5. GitHub Pages

1. Push to `main` at [github.com/hgzech/remimbers](https://github.com/hgzech/remimbers).
   The repo name matters — it's the URL path prefix, and `VITE_BASE` in the
   workflow must match it.
2. **Settings → Pages → Source: GitHub Actions.**
3. The workflow builds and publishes to
   [hgzech.github.io/remimbers/](https://hgzech.github.io/remimbers/).

`hgzech.github.io` must be in **Firebase → Authentication → Settings →
Authorized domains**, or sign-in fails with `auth/unauthorized-domain` — an
error that doesn't name the domain it wanted.

### 6. The OpenAI key (needed from Phase 1, not before)

Run this yourself; don't paste the key into a chat, a file, or the repo:

```bash
firebase functions:secrets:set OPENAI_API_KEY --project remimbers
```

### 7. Deploy the functions

Not done by CI — the Pages workflow only builds the static site, and giving
Actions deploy rights to Functions would mean a service-account key in repo
secrets for something you deploy a handful of times.

```bash
cd functions && npm ci && cd ..
firebase deploy --only functions --project remimbers
```

`npm ci` installs but does not compile, and the CLI reads `functions/lib/index.js`
— the compiled output, which is gitignored. The `predeploy` hook in
`firebase.json` runs `tsc` for you; without it the deploy fails with
`functions/lib/index.js does not exist`, which reads like a missing file rather
than a missing build step.

The hook invokes `node_modules/.bin/tsc` directly rather than `npm run build`.
The Firebase CLI spawns predeploy commands through a non-interactive shell,
which does not source `nvm` — so `npm` there can be a much older version than
the one in your terminal, and old npm crashes with
`Cannot read properties of undefined (reading 'stdin')` when spawned without a
TTY. Calling the compiler directly removes npm from the path entirely.

Always pass `--project`: `firebase use`'s per-directory setting lives in a
global configstore and silently overrides `.firebaserc`.

---

## Notes on choices you might otherwise wonder about

**Why GitHub Pages needs `404.html`.** Pages has no SPA rewrite, so a deep
link like `/remimbers/library` would 404. The build copies `index.html` to
`404.html`; Pages serves it, React Router reads the path, and the right view
renders. The response carries a 404 status, which is irrelevant for a private
app.

**Why `VITE_BASE` shows up in three places.** Vite's `base`, the PWA
manifest's `start_url`/`scope`, and the router's `basename` all have to agree
or the installed app opens to a blank screen. They're all derived from the one
variable.

**Why no `hosting` block in `firebase.json`.** Hosting is GitHub Pages. The
cost is that Functions are called cross-origin, so CORS is explicit in
`functions/src/index.ts` — keep `ALLOWED_ORIGINS` tight.

**Why `.env.production` is committed.** Firebase web config is public by
construction — it ships in the bundle and anyone can read it from devtools. It
is not a credential, so hiding it in CI variables buys nothing while adding a
setup step and a failure mode. Security is `firestore.rules` plus the
allowlist, full stop.

**Why the allowlist is checked twice.** `firestore.rules` enforces it;
`AuthProvider` reads it only to decide whether to show "you're not invited"
instead of a wall of permission errors. Faking the client check gains nothing.

**Why the generation function is in `europe-west3` when everything else is in
`europe-west1`.** Firestore triggers are Eventarc triggers, and Eventarc
requires the trigger to sit where the database sits. Deploying it alongside the
HTTP functions fails with `unsupported Cloud Firestore region`, an error that
never mentions the database as the cause.

**Why there is a `dryRunCards` endpoint.** Card quality is the riskiest
assumption in the app, and judging a prompt means running a corpus of notes
through it and reading the output. Doing that through the real trigger would
cost a deploy per wording and fill Firestore with junk. `dryRunCards` writes
nothing and takes a `promptOverride`, so a whole sweep costs one deploy. See
`evals/`.

**Why a failed note offers "Try again" instead of retrying in place.**
Generation fires on document *creation*, so updating a failed note re-runs
nothing. The retry re-captures the same `rawText` as a new note and deletes the
old one — safe precisely because a failed note never produced cards.

**Bundle size.** The Firebase SDK dominates (~250 kB gzipped). Acceptable for
an installed PWA that caches; worth code-splitting if first load starts to
feel slow.

---

## Layout

```
src/
  lib/        firebase init, env, data model, note + card helpers
  auth/       AuthProvider (session + allowlist) and AuthGate
  routes/     Capture, Review, Library
  components/ Layout with bottom nav
functions/
  src/
    prompt.ts    the note → cards prompt. The Phase 1 deliverable
    generate.ts  one POST to the Responses API, plus sanitising
    index.ts     the trigger, the dry-run endpoint, CORS and auth
evals/        prompt eval corpus and console runner — see evals/README.md
```

## Roadmap

| Phase | What | Status |
|---|---|---|
| 0 | Skeleton, auth, text capture, deploy | ✅ |
| 1 | Note → cards via LLM, auto-accepted | ✅ |
| 2 | FSRS + text review (Again/Hard/Good/Easy) | |
| 3 | Voice capture, PWA install, offline queue | |
| 4 | Realtime voice rehearsal + conversational grading | |
| 5 | FSRS parameter optimisation, grader calibration | |

Phase 2 is the point where this becomes usable daily. Phase 4 is the
differentiator, and Phase 2's UI stays on as its text fallback.
