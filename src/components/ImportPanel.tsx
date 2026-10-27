import { useState } from 'react'
import { importCards } from '../lib/cards'
import { parseCardFile, withoutDuplicates, type ParsedRow } from '../lib/csvImport'
import type { Flashcard } from '../lib/types'

type Step =
  | { kind: 'pick'; error?: string }
  | { kind: 'review'; fileName: string; fresh: ParsedRow[]; duplicates: number; incomplete: number }
  | { kind: 'importing'; done: number; total: number }
  | { kind: 'finished'; count: number }
  | { kind: 'failed'; message: string }

const PREVIEW = 5

/**
 * Import cards from a CSV file: pick, check what was found, import.
 *
 * Nothing is written until you confirm. Rows already in the library (same
 * question and answer) are skipped, so importing a file twice does nothing.
 */
export function ImportPanel({
  uid,
  existing,
  onClose,
}: {
  uid: string
  existing: Flashcard[]
  onClose: () => void
}) {
  const [step, setStep] = useState<Step>({ kind: 'pick' })

  async function read(file: File) {
    try {
      const { rows, incomplete } = parseCardFile(await file.text())
      const { fresh, duplicates } = withoutDuplicates(rows, existing)
      if (rows.length === 0) {
        setStep({ kind: 'pick', error: `No cards found in ${file.name}. Expected two columns: question, answer.` })
        return
      }
      setStep({ kind: 'review', fileName: file.name, fresh, duplicates, incomplete })
    } catch {
      setStep({ kind: 'pick', error: `Could not read ${file.name}.` })
    }
  }

  async function run(fileName: string, rows: ParsedRow[]) {
    setStep({ kind: 'importing', done: 0, total: rows.length })
    try {
      const count = await importCards(uid, rows, fileName, (done) =>
        setStep({ kind: 'importing', done, total: rows.length }),
      )
      setStep({ kind: 'finished', count })
    } catch (err) {
      setStep({ kind: 'failed', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <section className="lib-add lib-import">
      <p className="lib-panel-title">Import from a file</p>

      {step.kind === 'pick' && (
        <>
          <p className="lib-import-hint">
            A CSV or tab-separated file with two columns: question, then answer. A header row is
            fine. Anki’s plain-text export works too.
          </p>
          <label className="btn btn-small lib-file">
            Choose file
            <input
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/plain,text/tab-separated-values"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void read(file)
                e.target.value = ''
              }}
            />
          </label>
          {step.error && <p className="lib-import-error">{step.error}</p>}
          <div className="card-form-actions">
            <button className="linkbtn" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}

      {step.kind === 'review' && (
        <>
          <p className="lib-import-summary">
            <strong>
              {step.fresh.length === 1 ? '1 new card' : `${step.fresh.length} new cards`}
            </strong>{' '}
            in {step.fileName}
            {step.duplicates > 0 && (
              <>
                <br />
                {step.duplicates} already in your library, skipped
              </>
            )}
            {step.incomplete > 0 && (
              <>
                <br />
                {step.incomplete} {step.incomplete === 1 ? 'row' : 'rows'} without a question or
                answer, skipped
              </>
            )}
          </p>
          {step.fresh.length > 0 && (
            <ul className="lib-import-preview">
              {step.fresh.slice(0, PREVIEW).map((row, i) => (
                <li key={i}>
                  <span className="lib-import-q">{row.front}</span>
                  <span className="lib-import-a">{row.back}</span>
                </li>
              ))}
              {step.fresh.length > PREVIEW && (
                <li className="lib-import-more">and {step.fresh.length - PREVIEW} more</li>
              )}
            </ul>
          )}
          <div className="card-form-actions">
            <button className="linkbtn" onClick={() => setStep({ kind: 'pick' })}>
              Other file
            </button>
            {step.fresh.length > 0 ? (
              <button
                className="btn btn-primary btn-small"
                onClick={() => void run(step.fileName, step.fresh)}
              >
                Import {step.fresh.length}
              </button>
            ) : (
              <button className="btn btn-small" onClick={onClose}>
                Done
              </button>
            )}
          </div>
        </>
      )}

      {step.kind === 'importing' && (
        <p className="lib-import-summary">
          Importing… {step.done} of {step.total}
        </p>
      )}

      {step.kind === 'finished' && (
        <>
          <p className="lib-import-summary">
            {step.count === 1 ? '1 card imported.' : `${step.count} cards imported.`}
          </p>
          <div className="card-form-actions">
            <button className="btn btn-primary btn-small" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      )}

      {step.kind === 'failed' && (
        <>
          <p className="lib-import-error">
            The import stopped: {step.message}. Cards saved before the error are in your library;
            importing the file again adds only the rest.
          </p>
          <div className="card-form-actions">
            <button className="btn btn-small" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      )}
    </section>
  )
}
