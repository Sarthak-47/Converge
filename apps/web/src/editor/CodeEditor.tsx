import { useEffect, useRef } from 'react'
import { MonacoBinding } from 'y-monaco'
import type { CollabDocument, Peer } from './collabDocument.ts'
import { monaco } from './monaco.ts'

type Props = {
  model: monaco.editor.ITextModel
  live: CollabDocument
  readOnly: boolean
}

const darkScheme = window.matchMedia('(prefers-color-scheme: dark)')

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
export default function CodeEditor({ model, live, readOnly }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const current = useRef(live)
  const styles = useRef<HTMLStyleElement | null>(null)

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
    return () => {
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

  return <div className="code-editor" ref={host} />
}
