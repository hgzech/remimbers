# Remimbers

Capture a fact the moment you meet it. Rehearse it later, out loud.

A reminders app stores a future action and interrupts you when you asked.
Remimbers stores something you just learned and interrupts you when a spaced
repetition algorithm says you're about to forget it.

See [`DESIGN.md`](./DESIGN.md) for the architecture and the reasoning behind it.

**Status: Phase 0** — skeleton, auth, text capture, deploy pipeline.

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
firebase functions:secrets:set OPENAI_API_KEY
```

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

**Bundle size.** The Firebase SDK dominates (~250 kB gzipped). Acceptable for
an installed PWA that caches; worth code-splitting if first load starts to
feel slow.

---

## Layout

```
src/
  lib/        firebase init, env, data model, note helpers
  auth/       AuthProvider (session + allowlist) and AuthGate
  routes/     Capture, Review, Library
  components/ Layout with bottom nav
functions/
  src/        Cloud Functions; the only secret-holding component
```

## Roadmap

| Phase | What | Status |
|---|---|---|
| 0 | Skeleton, auth, text capture, deploy | ✅ |
| 1 | Note → cards via LLM, auto-accepted | |
| 2 | FSRS + text review (Again/Hard/Good/Easy) | |
| 3 | Voice capture, PWA install, offline queue | |
| 4 | Realtime voice rehearsal + conversational grading | |
| 5 | FSRS parameter optimisation, grader calibration | |

Phase 2 is the point where this becomes usable daily. Phase 4 is the
differentiator, and Phase 2's UI stays on as its text fallback.
