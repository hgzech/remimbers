import { useId, useState } from 'react'

/**
 * Question and answer fields, used for both editing and adding a card.
 *
 * Holds its own draft. To clear it after a save, the parent remounts it with
 * a new `key` rather than resetting state from outside.
 */
export function CardForm({
  initialFront = '',
  initialBack = '',
  submitLabel,
  onSubmit,
  onCancel,
  cancelLabel = 'Cancel',
}: {
  initialFront?: string
  initialBack?: string
  submitLabel: string
  onSubmit: (fields: { front: string; back: string }) => void
  onCancel: () => void
  cancelLabel?: string
}) {
  const id = useId()
  const [front, setFront] = useState(initialFront)
  const [back, setBack] = useState(initialBack)
  const ready = front.trim() !== '' && back.trim() !== ''

  return (
    <form
      className="card-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) onSubmit({ front, back })
      }}
    >
      <label className="card-label" htmlFor={`${id}-front`}>
        Question
      </label>
      <textarea
        id={`${id}-front`}
        className="card-input"
        value={front}
        rows={2}
        onChange={(e) => setFront(e.target.value)}
        autoFocus
      />
      <label className="card-label" htmlFor={`${id}-back`}>
        Answer
      </label>
      <textarea
        id={`${id}-back`}
        className="card-input"
        value={back}
        rows={2}
        onChange={(e) => setBack(e.target.value)}
      />
      <div className="card-form-actions">
        <button type="button" className="linkbtn" onClick={onCancel}>
          {cancelLabel}
        </button>
        <button type="submit" className="btn btn-primary btn-small" disabled={!ready}>
          {submitLabel}
        </button>
      </div>
    </form>
  )
}
