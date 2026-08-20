import { CARD_SCHEMA, MAX_OUTPUT_TOKENS, MODEL, SYSTEM_PROMPT } from './prompt.js'

/** One card as the model returns it, before any scheduling state is attached. */
export interface GeneratedCard {
  front: string
  back: string
  type: 'qa' | 'cloze'
  tags: string[]
}

export interface GenerationResult {
  cards: GeneratedCard[]
  model: string
  /** Present when the model returned nothing usable and the fallback fired. */
  fellBack: boolean
  usage?: { input_tokens?: number; output_tokens?: number }
}

/**
 * No `openai` package on purpose.
 *
 * One POST to one endpoint does not justify a dependency in a function that
 * cold-starts on every note. `fetch` is native on Node 22.
 */
const RESPONSES_URL = 'https://api.openai.com/v1/responses'

/**
 * Pull the JSON payload out of a Responses API result.
 *
 * The convenience `output_text` accessor is an SDK construct, so with raw
 * fetch we walk `output` ourselves. Refusals surface as their own content
 * type and must not be parsed as JSON.
 */
function extractJsonText(body: any): string {
  const output = Array.isArray(body?.output) ? body.output : []

  for (const item of output) {
    if (item?.type !== 'message') continue
    for (const part of item.content ?? []) {
      if (part?.type === 'refusal') {
        throw new Error(`model refused: ${part.refusal}`)
      }
      if (part?.type === 'output_text' && typeof part.text === 'string') {
        return part.text
      }
    }
  }

  if (body?.status === 'incomplete') {
    throw new Error(
      `generation incomplete: ${body?.incomplete_details?.reason ?? 'unknown'}`,
    )
  }
  throw new Error('no output_text in response')
}

/**
 * A cloze card is only a cloze if it actually has a blank.
 *
 * The model labelled a plain "What is Bayes' theorem?" card as `cloze` in the
 * first eval sweep. A strict schema cannot catch this - `cloze` is a valid
 * enum value whatever the front looks like - and the review UI will render a
 * blankless cloze as a broken card. Cheaper to demote it here than to keep
 * asking the prompt nicely.
 */
function classify(type: unknown, front: string): 'qa' | 'cloze' {
  return type === 'cloze' && front.includes('___') ? 'cloze' : 'qa'
}

/** Trim, drop empties, clamp tag counts, and enforce the five-card ceiling. */
function sanitise(cards: unknown): GeneratedCard[] {
  if (!Array.isArray(cards)) return []

  return cards
    .map((c: any) => ({
      front: String(c?.front ?? '').trim(),
      back: String(c?.back ?? '').trim(),
      type: classify(c?.type, String(c?.front ?? '')),
      tags: Array.isArray(c?.tags)
        ? c.tags
            .map((t: any) => String(t).trim().toLowerCase())
            .filter(Boolean)
            .slice(0, 3)
        : [],
    }))
    .filter((c) => c.front.length > 0 && c.back.length > 0)
    .slice(0, 5)
}

/**
 * The zero-card guarantee, in code rather than in the prompt.
 *
 * DESIGN.md makes "every note yields at least one card" a hard rule, and a
 * strict JSON schema cannot express a minimum array length. A capture that
 * silently produced nothing is the one outcome this app cannot afford, so if
 * the model returns an empty array we make a card from the note itself. It is
 * a poor card, but it is visible and fixable at review time - which a dropped
 * capture never is.
 */
export function ensureAtLeastOneCard(
  cards: GeneratedCard[],
  rawText: string,
): { cards: GeneratedCard[]; fellBack: boolean } {
  if (cards.length > 0) return { cards, fellBack: false }

  const trimmed = rawText.trim()
  const preview = trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed

  return {
    fellBack: true,
    cards: [
      {
        front: 'What did I capture in this note?',
        back: preview,
        type: 'qa',
        tags: ['unsorted'],
      },
    ],
  }
}

/**
 * Call the model and return sanitised cards.
 *
 * `promptOverride` exists so the prompt can be iterated from the browser
 * without a redeploy (see dryRunCards). It is never set by the note trigger.
 */
export async function generateCards(
  rawText: string,
  apiKey: string,
  promptOverride?: string,
): Promise<GenerationResult> {
  const res = await fetch(RESPONSES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      input: [
        { role: 'system', content: promptOverride?.trim() || SYSTEM_PROMPT },
        { role: 'user', content: rawText },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'flashcards',
          strict: true,
          schema: CARD_SCHEMA,
        },
      },
      max_output_tokens: MAX_OUTPUT_TOKENS,
    }),
  })

  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`openai ${res.status}: ${detail.slice(0, 500)}`)
  }

  // `as any`, not an interface: the Responses API envelope is large, versioned
  // and mostly irrelevant here. extractJsonText does the narrowing that matters
  // and everything below it is validated by sanitise(). Note that `res.json()`
  // infers `{}` rather than `any` under the @types/node that `npm ci` resolves,
  // so leaving this off compiles locally and fails in a clean install.
  const body = (await res.json()) as any
  const parsed = JSON.parse(extractJsonText(body))
  const { cards, fellBack } = ensureAtLeastOneCard(
    sanitise(parsed?.cards),
    rawText,
  )

  return { cards, fellBack, model: body?.model ?? MODEL, usage: body?.usage }
}
