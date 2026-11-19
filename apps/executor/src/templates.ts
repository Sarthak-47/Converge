import { createHash } from 'node:crypto'

/**
 * The executor's own copy of the command allowlist (design §11.5). It must match the API's
 * CommandTemplates: the API decides what can be requested, and the executor independently refuses anything
 * else, even if a job row were altered (design §13.7, Gate E).
 */
const TEMPLATES: RegExp[] = [
  /^npm test$/,
  /^npm run [a-z0-9][a-z0-9:_-]{0,39}$/,
  /^node --test(?: [A-Za-z0-9_./-]{1,200}){0,10}$/,
]

export function allowed(command: string): boolean {
  return command.length <= 500 && TEMPLATES.some((pattern) => pattern.test(command))
}

/** The command as argv: allowlisted commands have no quoting, so splitting on spaces is exact. No shell runs. */
export function argv(command: string): string[] {
  return command.split(' ')
}

/** The canonical action and its hash, built exactly as the API builds them. */
export function actionHash(workspaceId: string, command: string): string {
  const canonical = JSON.stringify({ command, kind: 'run_command', workspaceId })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}
