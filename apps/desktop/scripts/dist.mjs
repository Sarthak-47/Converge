// Builds installers for this platform with electron-builder, keeping its downloads (Electron, NSIS and the
// other packaging tools) inside the project: <repo>/.cache/electron and <repo>/.cache/electron-builder.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const desktop = path.resolve(here, '..')
const repo = path.resolve(desktop, '../..')
const cli = path.join(repo, 'node_modules', 'electron-builder', 'cli.js')

// electron-builder's own Electron download reads only this option, not the cache variables below.
const cache = `-c.electronDownload.cache=${path.join(repo, '.cache', 'electron')}`
const result = spawnSync(process.execPath, [cli, '--config', 'electron-builder.yml', cache, ...process.argv.slice(2)], {
  cwd: desktop,
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_CACHE: path.join(repo, '.cache', 'electron'),
    electron_config_cache: path.join(repo, '.cache', 'electron'),
    ELECTRON_BUILDER_CACHE: path.join(repo, '.cache', 'electron-builder'),
    // Unsigned builds: do not look for a signing certificate in the keychain.
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  },
})
process.exit(result.status ?? 1)
