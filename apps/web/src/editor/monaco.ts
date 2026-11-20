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

// Editor themes for Sticker Lid: the editor is the quietest sheet on the lid. Syntax stays restrained (ink weight,
// a muted green and amber) so no token is mistaken for a person's sticker colour.
monaco.editor.defineTheme('converge-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '7a7e86', fontStyle: 'italic' },
    { token: 'keyword', foreground: '16171a', fontStyle: 'bold' },
    { token: 'string', foreground: '2f6b3a' },
    { token: 'number', foreground: '8a5a00' },
    { token: 'type', foreground: '16171a', fontStyle: 'bold' },
  ],
  colors: {
    'editor.background': '#fbfbfa',
    'editor.foreground': '#16171a',
    'editorLineNumber.foreground': '#a9adb4',
    'editorLineNumber.activeForeground': '#16171a',
    'editor.lineHighlightBackground': '#f2f3f4',
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': '#ffe9806e',
    'editor.inactiveSelectionBackground': '#ffe98040',
    'editorCursor.foreground': '#16171a',
    'editorIndentGuide.background1': '#e6e7ea',
    'editorWidget.background': '#fbfbfa',
    'editorWidget.border': '#d1d4d8',
    'scrollbarSlider.background': '#16171a22',
    'scrollbarSlider.hoverBackground': '#16171a38',
  },
})

monaco.editor.defineTheme('converge-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '7d8189', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'f2f2ee', fontStyle: 'bold' },
    { token: 'string', foreground: '9fd3a8' },
    { token: 'number', foreground: 'e6c46a' },
    { token: 'type', foreground: 'f2f2ee', fontStyle: 'bold' },
  ],
  colors: {
    'editor.background': '#17181b',
    'editor.foreground': '#dedfda',
    'editorLineNumber.foreground': '#4c4f57',
    'editorLineNumber.activeForeground': '#f2f2ee',
    'editor.lineHighlightBackground': '#1e2024',
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': '#ffd4003d',
    'editor.inactiveSelectionBackground': '#ffd40024',
    'editorCursor.foreground': '#f2f2ee',
    'editorIndentGuide.background1': '#26282d',
    'editorWidget.background': '#1e2024',
    'editorWidget.border': '#33353b',
    'scrollbarSlider.background': '#f2f2ee22',
    'scrollbarSlider.hoverBackground': '#f2f2ee38',
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
