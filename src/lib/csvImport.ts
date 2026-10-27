import { normalize } from './cardStats'

/**
 * Reading a CSV (or tab-separated) file into question/answer pairs.
 *
 * Accepted: two columns, question then answer; further columns are ignored.
 * Comma, semicolon or tab separated, detected from the first line. Quoted
 * fields may contain separators, doubled quotes and line breaks (RFC 4180).
 * An optional header row is recognised by its words and skipped.
 *
 * Anki's "Notes in Plain Text" export works as is: its `#separator:` and
 * `#html:` lines are read, and with `#html:true` the HTML is turned back into
 * plain text, and columns it marks as metadata (guid, note type, deck, tags)
 * are skipped.
 */

export interface ParsedRow {
  front: string
  back: string
}

export interface ParseResult {
  rows: ParsedRow[]
  /** Rows with an empty question or answer. */
  incomplete: number
}

const HEADER_FRONT = /^(question|front|frage|q|vorderseite)$/i
const HEADER_BACK = /^(answer|back|antwort|a|rückseite)$/i

const ANKI_SEPARATORS: Record<string, string> = {
  tab: '\t',
  comma: ',',
  semicolon: ';',
  pipe: '|',
  space: ' ',
}

function detectSeparator(firstLine: string): string {
  const counts = ['\t', ';', ','].map((s) => [s, firstLine.split(s).length - 1] as const)
  const best = counts.reduce((a, b) => (b[1] > a[1] ? b : a))
  return best[1] > 0 ? best[0] : ','
}

/** RFC 4180 records. Separators and newlines inside quotes are content. */
function records(text: string, sep: string): string[][] {
  const out: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += c
    } else if (c === '"' && field === '') {
      quoted = true
    } else if (c === sep) {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      out.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    out.push(row)
  }
  return out
}

/** HTML from an Anki export, back to plain text: <br> and blocks become line breaks. */
function htmlToText(html: string): string {
  const withBreaks = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p|li)>/gi, '\n')
  const doc = new DOMParser().parseFromString(withBreaks, 'text/html')
  return (doc.body.textContent ?? '').replace(/ /g, ' ')
}

export function parseCardFile(raw: string): ParseResult {
  let text = raw.replace(/^﻿/, '')

  // Anki's header lines: "#separator:tab", "#html:true", "#tags column:3" ...
  let sep: string | null = null
  let html = false
  // "#guid column:1", "#deck column:2", "#tags column:5" ...: columns that are
  // not card text. 1-based in the file, 0-based here.
  const metaColumns = new Set<number>()
  while (text.startsWith('#')) {
    const end = text.indexOf('\n')
    const line = (end === -1 ? text : text.slice(0, end)).trim()
    const m = /^#(\w[\w ]*):(.*)$/.exec(line)
    if (m) {
      const key = m[1].toLowerCase()
      const value = m[2].trim().toLowerCase()
      if (key === 'separator') sep = ANKI_SEPARATORS[value] ?? (value.length === 1 ? value : null)
      if (key === 'html') html = value === 'true'
      if (key.endsWith(' column')) {
        const n = parseInt(value, 10)
        if (n > 0) metaColumns.add(n - 1)
      }
    }
    text = end === -1 ? '' : text.slice(end + 1)
  }

  sep ??= detectSeparator(text.split(/\r?\n/, 1)[0] ?? '')
  const all = records(text, sep).filter((r) => r.some((f) => f.trim() !== ''))

  const first = all[0]?.filter((_, i) => !metaColumns.has(i))
  if (first && HEADER_FRONT.test(first[0]?.trim() ?? '') && HEADER_BACK.test(first[1]?.trim() ?? '')) {
    all.shift()
  }

  const rows: ParsedRow[] = []
  let incomplete = 0
  for (const record of all) {
    const r = record.filter((_, i) => !metaColumns.has(i))
    const clean = (s: string | undefined) => (html ? htmlToText(s ?? '') : (s ?? '')).trim()
    const front = clean(r[0])
    const back = clean(r[1])
    if (front && back) rows.push({ front, back })
    else incomplete++
  }
  return { rows, incomplete }
}

/** Same question and same answer, ignoring case, accents and spacing. */
export function duplicateKey(front: string, back: string): string {
  const squash = (s: string) => normalize(s).replace(/\s+/g, ' ').trim()
  return `${squash(front)}\u0000${squash(back)}`
}

/**
 * Split parsed rows into what to import and what is already there - in the
 * deck, or earlier in the same file. Importing the same file twice adds nothing.
 */
export function withoutDuplicates(
  rows: ParsedRow[],
  existing: { front: string; back: string }[],
): { fresh: ParsedRow[]; duplicates: number } {
  const seen = new Set(existing.map((c) => duplicateKey(c.front, c.back)))
  const fresh: ParsedRow[] = []
  for (const row of rows) {
    const key = duplicateKey(row.front, row.back)
    if (seen.has(key)) continue
    seen.add(key)
    fresh.push(row)
  }
  return { fresh, duplicates: rows.length - fresh.length }
}
