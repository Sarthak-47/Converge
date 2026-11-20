import { createRoot } from 'react-dom/client'
import { AskTextDialog, type AskTextOptions } from './AskTextDialog.tsx'

/**
 * Asks for a line or a few lines of text in an in-app dialog. Replaces window.prompt, which Electron does not
 * implement (the desktop app would silently get nothing) and which browsers style inconsistently.
 * Resolves with the trimmed text, or null when cancelled.
 */
export function askText(options: AskTextOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    let settled = false
    const done = (value: string | null) => {
      if (settled) return
      settled = true
      resolve(value)
      // Unmount after the current event finishes, so the dialog's own handlers complete first.
      setTimeout(() => {
        root.unmount()
        host.remove()
      })
    }
    root.render(<AskTextDialog {...options} done={done} />)
  })
}
