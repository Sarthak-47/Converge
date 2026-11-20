import { useEffect, useRef, useState, type FormEvent } from 'react'

export type AskTextOptions = {
  title: string
  label: string
  initial?: string
  /** Long text (a commit message, a comment) gets a text area. */
  multiline?: boolean
  submitLabel?: string
  /** Allows submitting an empty value (e.g. an optional checkpoint name). */
  optional?: boolean
}

/** The dialog behind askText(); rendered on its own root. */
export function AskTextDialog({ title, label, initial = '', multiline, submitLabel = 'OK', optional, done }: AskTextOptions & { done: (value: string | null) => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [value, setValue] = useState(initial)

  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  function submit(event: FormEvent) {
    event.preventDefault()
    const text = value.trim()
    if (!text && !optional) return
    done(text)
  }

  return (
    <dialog ref={dialog} className="dialog card ask-text" aria-labelledby="ask-text-title" onClose={() => done(null)}>
      <form onSubmit={submit}>
        <header className="dialog-header">
          <h2 id="ask-text-title">{title}</h2>
        </header>
        <label htmlFor="ask-text-input">{label}</label>
        {multiline ? (
          <textarea id="ask-text-input" rows={4} value={value} autoFocus onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(e)
            }} />
        ) : (
          <input id="ask-text-input" value={value} autoFocus onChange={(e) => setValue(e.target.value)} />
        )}
        <footer className="dialog-footer">
          <button type="button" className="ghost" onClick={() => done(null)}>Cancel</button>
          <button type="submit" className="primary" disabled={!optional && !value.trim()}>{submitLabel}</button>
        </footer>
      </form>
    </dialog>
  )
}
