import { useEffect, useRef } from 'react'
import { monaco } from './monaco.ts'

type Props = {
  model: monaco.editor.ITextModel
  readOnly: boolean
  onSave: () => void
  onChange: () => void
}

const darkScheme = window.matchMedia('(prefers-color-scheme: dark)')

/** One Monaco instance for the page; switching files swaps models, so undo history stays per file. */
export default function CodeEditor({ model, readOnly, onSave, onChange }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const handlers = useRef({ onSave, onChange })

  useEffect(() => {
    handlers.current = { onSave, onChange }
  }, [onSave, onChange])

  useEffect(() => {
    const instance = monaco.editor.create(host.current!, {
      automaticLayout: true,
      fontSize: 14,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      theme: darkScheme.matches ? 'vs-dark' : 'vs',
      tabSize: 2,
    })
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => handlers.current.onSave())
    const changes = instance.onDidChangeModelContent(() => handlers.current.onChange())
    const followTheme = (e: MediaQueryListEvent) => monaco.editor.setTheme(e.matches ? 'vs-dark' : 'vs')
    darkScheme.addEventListener('change', followTheme)
    editor.current = instance
    return () => {
      darkScheme.removeEventListener('change', followTheme)
      changes.dispose()
      instance.dispose()
      editor.current = null
    }
  }, [])

  useEffect(() => {
    editor.current?.setModel(model)
    editor.current?.focus()
  }, [model])

  useEffect(() => {
    editor.current?.updateOptions({ readOnly })
  }, [readOnly])

  return <div className="code-editor" ref={host} />
}
