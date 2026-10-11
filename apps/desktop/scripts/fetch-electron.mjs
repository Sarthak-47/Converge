// Downloads the Electron binary into the project (never the user profile): the download cache goes to
// <repo>/.cache/electron and the unpacked app to node_modules/electron/dist. Run once before `npm run desktop`.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../../..')
const installer = createRequire(import.meta.url).resolve('electron/install.js')

const result = spawnSync(process.execPath, [installer], {
  stdio: 'inherit',
  env: { ...process.env, electron_config_cache: path.join(repo, '.cache', 'electron') },
})
process.exit(result.status ?? 1)
