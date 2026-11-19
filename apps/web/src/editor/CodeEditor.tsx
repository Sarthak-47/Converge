import { useEffect, useRef } from 'react'
import { MonacoBinding } from 'y-monaco'
import type { CollabDocument, Peer } from './collabDocument.ts'
import { monaco } from './monaco.ts'

/** A highlighted range, as offsets into the current text. */
export type Highlight = { start: number; end: number; title: string; className?: string }

type Props = {
  model: monaco.editor.ITextModel
  live: CollabDocument
  readOnly: boolean
  /** Ranges that comments are anchored to (design §13.9). */
  highlights?: Highlight[]
  /** A range to scroll to and select once, e.g. "Show in file" on a comment. */
  reveal?: { start: number; end: number; key: string } | null
  /** Exposes the editor so the page can read the selection for a new comment. */
  onEditor?: (editor: monaco.editor.IStandaloneCodeEditor | null) => void
}

const darkScheme = window.matchMedia('(prefers-color-scheme: dark)')

/** Escapes every Markdown control character, so text renders literally in a Markdown hover. */
function plainMarkdown(text: string) {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~&]/g, (c) => `\\${c}`)
}

/** Escapes a value for use inside a double-quoted CSS string. */
function cssString(value: string) {
  return `"${value.replace(/[\\"]/g, '\\$&').replace(/[\n\r]/g, ' ')}"`
}

/**
 * y-monaco tags remote selections with per-client classes; this gives each person their own colour and a
 * name label on their cursor. Peer data is validated in CollabDocument before it gets here.
 */
function cursorStyles(peers: Peer[]) {
  return peers
    .map(
      ({ clientId, name, color }) => `
.yRemoteSelection-${clientId} { background-color: color-mix(in srgb, ${color} 30%, transparent); }
.yRemoteSelectionHead-${clientId} { border-left-color: ${color}; }
.yRemoteSelectionHead-${clientId}::after { content: ${cssString(name)}; background: ${color}; }`,
    )
    .join('\n')
}

/**
 * One Monaco instance for the page. The active file's model is bound to its Yjs text with y-monaco: local
 * keystrokes become CRDT operations and remote operations become Monaco edits (design §8.5). Undo and redo
 * go through the file's per-user UndoManager instead of Monaco's own stack, which cannot tell whose edit
 * is whose (design §8.8).
 */
export default function CodeEditor({ model, live, readOnly, highlights = [], reveal = null, onEditor }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const current = useRef(live)
  const styles = useRef<HTMLStyleElement | null>(null)
  const notifyEditor = useRef(onEditor)
  useEffect(() => {
    notifyEditor.current = onEditor
  })

  useEffect(() => {
    current.current = live
  }, [live])

  useEffect(() => {
    const instance = monaco.editor.create(host.current!, {
      automaticLayout: true,
      fontSize: 14,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      theme: darkScheme.matches ? 'vs-dark' : 'vs',
      tabSize: 2,
    })
    const { KeyMod, KeyCode } = monaco
    // Changes are saved continuously; swallow Ctrl+S so the browser does not open "Save page".
    instance.addCommand(KeyMod.CtrlCmd | KeyCode.KeyS, () => undefined)
    instance.addCommand(KeyMod.CtrlCmd | KeyCode.KeyZ, () => current.current.undoManager.undo())
    instance.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyZ, () => current.current.undoManager.redo())
    instance.addCommand(KeyMod.CtrlCmd | KeyCode.KeyY, () => current.current.undoManager.redo())
    const followTheme = (e: MediaQueryListEvent) => monaco.editor.setTheme(e.matches ? 'vs-dark' : 'vs')
    darkScheme.addEventListener('change', followTheme)
    styles.current = document.head.appendChild(document.createElement('style'))
    editor.current = instance
    notifyEditor.current?.(instance)
    return () => {
      notifyEditor.current?.(null)
      darkScheme.removeEventListener('change', followTheme)
      styles.current?.remove()
      instance.dispose()
      editor.current = null
    }
  }, [])

  useEffect(() => {
    const instance = editor.current
    if (!instance) return
    instance.setModel(model)
    const binding = new MonacoBinding(live.text, model, new Set([instance]), live.provider.awareness)
    live.undoManager.addTrackedOrigin(binding)
    const paint = () => {
      if (styles.current) styles.current.textContent = cursorStyles(live.peers())
    }
    paint()
    const stopWatching = live.subscribePeers(paint)
    instance.focus()
    return () => {
      stopWatching()
      live.undoManager.removeTrackedOrigin(binding)
      binding.destroy()
    }
  }, [model, live])

  useEffect(() => {
    editor.current?.updateOptions({ readOnly })
  }, [readOnly])

  const decorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  useEffect(() => {
    const instance = editor.current
    if (!instance) return
    const ranges = highlights.map(({ start, end, title, className }) => {
      const from = model.getPositionAt(start)
      const to = model.getPositionAt(end)
      return {
        range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column),
        // Comment text is user content: escaped so Monaco shows it as plain text, never markup or links.
        options: { inlineClassName: className ?? 'comment-range', hoverMessage: { value: plainMarkdown(title), isTrusted: false, supportHtml: false } },
      }
    })
    decorations.current?.clear()
    decorations.current = instance.createDecorationsCollection(ranges)
  }, [highlights, model])

  useEffect(() => {
    const instance = editor.current
    if (!instance || !reveal) return
    const from = model.getPositionAt(reveal.start)
    const to = model.getPositionAt(reveal.end)
    const range = new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column)
    instance.setSelection(range)
    instance.revealRangeInCenter(range)
  }, [reveal, model])

  return <div className="code-editor" ref={host} />
}
