// Bundles the main process and the sync bridge into one file, so the installed app needs no node_modules
// (electron-builder struggles to collect packages from an npm workspace). Electron itself stays external, and
// so do ws's optional native speed-ups, which ws loads only if they are present.
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

await build({
  entryPoints: [path.join(root, 'src', 'main.ts')],
  outfile: path.join(root, 'dist', 'main.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  // CommonJS packages in the bundle (ws, for one) call require() for Node built-ins.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'warning',
})
console.log('bundled dist/main.js')
