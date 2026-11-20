// Monaco is bundled with the app (no CDN), and its language workers are built by Vite.
import * as monaco from 'monaco-editor'
import { currentTheme, onThemeChange, type Theme } from '../theme.ts'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker'

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case 'json':
        return new JsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker()
      case 'typescript':
      case 'javascript':
        return new TsWorker()
      default:
        return new EditorWorker()
    }
  },
}

export { monaco }

// Editor themes drawn from the app's cyanotype palette, so the editor reads as part of the page rather than a
// stock VS Code panel inside it.
monaco.editor.defineTheme('converge-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6b7a99', fontStyle: 'italic' },
    { token: 'keyword', foreground: '0b6fa4', fontStyle: 'bold' },
    { token: 'string', foreground: '0f7a5c' },
    { token: 'number', foreground: 'a3460c' },
    { token: 'type', foreground: '7a3fc2' },
  ],
  colors: {
    'editor.background': '#ffffff',
    'editor.foreground': '#0d1a36',
    'editorLineNumber.foreground': '#a3b0c9',
    'editorLineNumber.activeForeground': '#0d1a36',
    'editor.lineHighlightBackground': '#f2f5fb',
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': '#c6e6f6',
    'editor.inactiveSelectionBackground': '#e1e8f8',
    'editorCursor.foreground': '#0b6fa4',
    'editorIndentGuide.background1': '#e6ebf4',
    'editorWidget.background': '#ffffff',
    'editorWidget.border': '#d3dcec',
    'scrollbarSlider.background': '#0d1a3622',
    'scrollbarSlider.hoverBackground': '#0d1a3638',
  },
})

monaco.editor.defineTheme('converge-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6f7fa6', fontStyle: 'italic' },
    { token: 'keyword', foreground: '6cc6ec', fontStyle: 'bold' },
    { token: 'string', foreground: '6fe0b4' },
    { token: 'number', foreground: 'ffb36b' },
    { token: 'type', foreground: 'c9a2ff' },
  ],
  colors: {
    'editor.background': '#0a1a29',
    'editor.foreground': '#e6ecfa',
    'editorLineNumber.foreground': '#3f5f7c',
    'editorLineNumber.activeForeground': '#c3cfeb',
    'editor.lineHighlightBackground': '#0e2233',
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': '#1b4766',
    'editor.inactiveSelectionBackground': '#143650',
    'editorCursor.foreground': '#6cc6ec',
    'editorIndentGuide.background1': '#13293c',
    'editorWidget.background': '#0e2233',
    'editorWidget.border': '#24476a',
    'scrollbarSlider.background': '#8fb2ff22',
    'scrollbarSlider.hoverBackground': '#8fb2ff3a',
  },
})

/** The Monaco theme for the app's current light or dark theme; Monaco themes are global, so one call updates every editor. */
export function monacoTheme(theme: Theme = currentTheme()) {
  return theme === 'dark' ? 'converge-dark' : 'converge-light'
}

onThemeChange((theme) => monaco.editor.setTheme(monacoTheme(theme)))

/** Shared editor options: the app's code face, sized for long sessions. */
export const editorFont = {
  fontFamily: "'JetBrains Mono Variable', ui-monospace, SFMono-Regular, Consolas, monospace",
  fontSize: 13.5,
  lineHeight: 22,
  fontLigatures: true,
}
