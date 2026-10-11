import { lstat } from 'node:fs/promises'
import path from 'node:path'

export class UnsafePathError extends Error {}

/** Folder inside the checkout where the bridge keeps its own data (trash, state). Never synced. */
export const BRIDGE_DIR = '.converge'

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * Turns a workspace path from the server into an absolute path inside `root`, or refuses it (design §12.12).
 * Workspace paths are untrusted input: a teammate (or a compromised server) must not be able to write
 * outside the checkout, into .git (hooks would run code), or into the bridge's own folder.
 */
export function resolveInside(root: string, workspacePath: string): string {
  if (!workspacePath || workspacePath.includes('\0')) throw new UnsafePathError('Empty or invalid path')
  const normalized = workspacePath.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new UnsafePathError(`Absolute paths are not allowed: ${workspacePath}`)
  }
  const segments = normalized.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new UnsafePathError(`Path segments must be plain names: ${workspacePath}`)
    }
    if (WINDOWS_RESERVED.test(segment) || /[. ]$/.test(segment)) {
      throw new UnsafePathError(`Not a valid file name on Windows: ${segment}`)
    }
  }
  const first = segments[0].toLowerCase()
  if (first === '.git' || first === BRIDGE_DIR) {
    throw new UnsafePathError(`Refusing to sync into ${segments[0]}/`)
  }
  const absolute = path.resolve(root, ...segments)
  const relative = path.relative(path.resolve(root), absolute)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new UnsafePathError(`Path escapes the checkout: ${workspacePath}`)
  }
  return absolute
}

/**
 * Refuses paths that would pass through a symbolic link (or junction) inside the checkout, since a link could
 * point anywhere on the machine. Missing components are fine: they will be created as real folders.
 */
export async function assertNoLinks(root: string, absolute: string): Promise<void> {
  const base = path.resolve(root)
  const parts = path.relative(base, absolute).split(path.sep)
  let current = base
  for (const part of parts) {
    current = path.join(current, part)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new UnsafePathError(`Refusing to follow a link: ${current}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

/** The workspace path for an absolute path inside the checkout, always with forward slashes. */
export function toWorkspacePath(root: string, absolute: string): string {
  return path.relative(path.resolve(root), absolute).split(path.sep).join('/')
}
