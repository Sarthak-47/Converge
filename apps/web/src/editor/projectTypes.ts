import type { FileNode } from '../api.ts'
import { api } from '../api.ts'
import { monaco } from './monaco.ts'

/**
 * Project-wide code intelligence for TypeScript and JavaScript. Monaco's TypeScript service only knows the
 * models it is given, and only open files have models, so an import of another workspace file showed as an
 * error and "go to definition" could not follow it. Every other TS/JS file of the workspace is handed to the
 * service as a background source at its workspace path, and kept current as files change. Open files are
 * not given twice: their live model is the source.
 *
 * Installed packages are not part of a workspace, so "cannot find module" for a package is not shown.
 */
const SCRIPT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i
const MAX_FILES = 400
const MAX_BYTES = 256 * 1024
/** Cannot find module, its declaration, or its types: packages live outside the workspace. */
const PACKAGE_DIAGNOSTICS = [2307, 2792, 7016]

let configured = false

function configure() {
  if (configured) return
  configured = true
  const ts = monaco.typescript
  const options = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    allowNonTsExtensions: true,
    esModuleInterop: true,
    skipLibCheck: true,
    strict: true,
  }
  for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
    defaults.setCompilerOptions(options)
    defaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false, diagnosticCodesToIgnore: PACKAGE_DIAGNOSTICS })
    defaults.setEagerModelSync(true)
  }
}

/** The URI a workspace file has in the editor and in the TypeScript service: its path, so imports resolve. */
export function pathUri(path: string) {
  return monaco.Uri.file(`/${path}`)
}

export class ProjectSources {
  private readonly libs = new Map<string, { version: number; dispose: () => void }>()
  private readonly open = new Set<string>()
  private disposed = false

  constructor() {
    configure()
  }

  /** Brings the background sources in line with the tree: adds new files, drops deleted or moved ones. */
  async sync(files: FileNode[], changedIds: Set<string> = new Set()) {
    const scripts = files.filter((f) => f.kind === 'FILE' && SCRIPT.test(f.name)).slice(0, MAX_FILES)
    const wanted = new Map(scripts.map((f) => [f.id, f]))
    for (const [key, lib] of this.libs) {
      const id = key.split('|')[0]!
      const file = wanted.get(id)
      if (!file || key !== this.key(file) || changedIds.has(id) || this.open.has(id)) {
        lib.dispose()
        this.libs.delete(key)
      }
    }
    await Promise.all(scripts.filter((f) => !this.open.has(f.id) && !this.libs.has(this.key(f))).map((f) => this.add(f)))
  }

  /** An opened file is served by its live model from now on. */
  opened(file: FileNode) {
    this.open.add(file.id)
    for (const [key, lib] of this.libs) {
      if (key.startsWith(`${file.id}|`)) {
        lib.dispose()
        this.libs.delete(key)
      }
    }
  }

  /** A closed file goes back to being a background source. */
  closed(file: FileNode) {
    this.open.delete(file.id)
    if (SCRIPT.test(file.name)) void this.add(file)
  }

  dispose() {
    this.disposed = true
    for (const lib of this.libs.values()) lib.dispose()
    this.libs.clear()
  }

  private key(file: FileNode) {
    return `${file.id}|${file.path}`
  }

  private async add(file: FileNode) {
    const key = this.key(file)
    const version = (this.libs.get(key)?.version ?? 0) + 1
    let text: string
    try {
      text = (await api.content(file.id)).text
    } catch {
      return
    }
    if (this.disposed || this.open.has(file.id) || text.length > MAX_BYTES) return
    this.libs.get(key)?.dispose()
    const ts = monaco.typescript
    const uri = pathUri(file.path).toString()
    const handles = [ts.typescriptDefaults.addExtraLib(text, uri), ts.javascriptDefaults.addExtraLib(text, uri)]
    this.libs.set(key, { version, dispose: () => handles.forEach((h) => h.dispose()) })
  }
}
