/**
 * Prompt eval runner. Paste into the devtools console of the signed-in app.
 *
 * Phase 1 lives or dies on card quality, and the only honest way to judge a
 * prompt change is to read a corpus of notes through it. This calls the
 * dryRunCards endpoint, which generates and writes nothing - so a sweep leaves
 * no notes, no cards and no trace in Firestore.
 *
 *   await evals.run()                      // current deployed prompt
 *   await evals.run({ promptOverride })    // a candidate, without redeploying
 *   await evals.run({ only: ['pronoun-trap', 'garbled-transcript'] })
 *
 * Results land in `evals.last` as JSON for copying out.
 */
;(() => {
  const CORPUS_URL = new URL('evals/notes.json', location.origin + '/remimbers/')

  async function loadCases() {
    // Served from the repo only in dev; in production, paste `evals.cases = [...]`
    // yourself, or run this against the local dev server.
    const res = await fetch(CORPUS_URL)
    if (!res.ok) throw new Error(`corpus not reachable at ${CORPUS_URL}`)
    return (await res.json()).cases
  }

  async function run({ promptOverride, only, cases } = {}) {
    if (!window.remimbers) throw new Error('dev handle missing - is this the deployed build?')

    let all = cases ?? window.evals.cases ?? (await loadCases())
    if (only) all = all.filter((c) => only.includes(c.id))

    const results = []
    for (const c of all) {
      const started = performance.now()
      try {
        const out = await window.remimbers.callFunction('dryRunCards', {
          rawText: c.rawText,
          promptOverride,
        })
        results.push({
          id: c.id,
          rawText: c.rawText,
          watch: c.watch,
          ms: Math.round(performance.now() - started),
          fellBack: out.fellBack,
          usage: out.usage,
          cards: out.cards,
        })
      } catch (err) {
        results.push({ id: c.id, rawText: c.rawText, error: String(err) })
      }
    }

    window.evals.last = results
    print(results)
    return results
  }

  function print(results) {
    for (const r of results) {
      console.group(`%c${r.id}`, 'font-weight:600')
      console.log('%c' + r.rawText, 'color:#9a97a8')
      if (r.watch) console.log('%cwatch: ' + r.watch, 'color:#8b7cf6')
      if (r.error) {
        console.error(r.error)
      } else {
        if (r.fellBack) console.warn('FELL BACK - model returned no cards')
        for (const card of r.cards) {
          console.log(`  Q: ${card.front}\n  A: ${card.back}   [${card.type}] ${card.tags.join(', ')}`)
        }
      }
      console.groupEnd()
    }
    const total = results.reduce((n, r) => n + (r.cards?.length ?? 0), 0)
    console.log(`%c${results.length} notes -> ${total} cards`, 'font-weight:600')
  }

  window.evals = { run, print, cases: null, last: null }
  console.log('evals ready. await evals.run()')
})()
