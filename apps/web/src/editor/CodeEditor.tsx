import { useEffect, useRef } from 'react'
import { MonacoBinding } from 'y-monaco'
import type { CollabDocument } from './collabDocument.ts'
import { monaco } from './monaco.ts'

type Props = {
  model: monaco.editor.ITextModel
  live: CollabDocument
  readOnly: boolean
}

const darkScheme = window.matchMedia('(prefers-color-scheme: dark)')

/**
 * One Monaco instance for the page. The active file's model is bound to its Yjs text with y-monaco: local
 * keystrokes become CRDT operations and remote operations become Monaco edits (design §8.5).
 */
export default function CodeEditor({ model, live, readOnly }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)

  useEffect(() => {
    const instance = monaco.editor.create(host.current!, {
      automaticLayout: true,
      fontSize: 14,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      theme: darkScheme.matches ? 'vs-dark' : 'vs',
      tabSize: 2,
    })
    // Changes are saved continuously; swallow Ctrl+S so the browser does not open "Save page".
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => undefined)
    const followTheme = (e: MediaQueryListEvent) => monaco.editor.setTheme(e.matches ? 'vs-dark' : 'vs')
    darkScheme.addEventListener('change', followTheme)
    editor.current = instance
    return () => {
      darkScheme.removeEventListener('change', followTheme)
      instance.dispose()
      editor.current = null
    }
  }, [])

  useEffect(() => {
    const instance = editor.current
    if (!instance) return
    instance.setModel(model)
    const binding = new MonacoBinding(live.text, model, new Set([instance]), live.provider.awareness)
    instance.focus()
    return () => binding.destroy()
  }, [model, live])

  useEffect(() => {
    editor.current?.updateOptions({ readOnly })
  }, [readOnly])

  return <div className="code-editor" ref={host} />
}
