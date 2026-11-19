import type Anthropic from '@anthropic-ai/sdk'
import * as Y from 'yjs'
import { z } from 'zod'
import { replaceRange, TurnRecorder, type Typing, type UndoRecord } from './edits.js'
import { TEXT_FIELD, type FileEntry, type PlanStep, type TurnWorkspace } from './workspace.js'

/**
 * The agent's tools (design §13.4). Reads and edits work on the live Yjs documents; nothing touches a disk or
 * runs a command. Every input is validated against its schema before it runs, because inputs stream eagerly
 * and the API no longer validates them.
 */
const schemas = {
  list_files: z.object({}).strict(),
  read_file: z.object({
    path: z.string().min(1),
    start_line: z.number().int().positive().optional(),
    end_line: z.number().int().positive().optional(),
  }).strict(),
  search: z.object({ query: z.string().min(1).max(200) }).strict(),
  edit_file: z.object({
    path: z.string().min(1),
    old_string: z.string().min(1),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
  }).strict(),
  create_file: z.object({ path: z.string().min(1), content: z.string() }).strict(),
  get_plan: z.object({}).strict(),
  propose_plan: z.object({ steps: z.array(z.string().min(1).max(300)).min(1).max(20) }).strict(),
  update_step: z.object({ position: z.number().int().positive(), status: z.enum(['TODO', 'IN_PROGRESS', 'DONE']) }).strict(),
}

export type ToolName = keyof typeof schemas

export const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'list_files',
    description: 'List every file and folder in the workspace, one path per line. Folders end with "/".',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_file',
    description:
      'Read a file as it is right now, including teammates\' unsaved typing. Each line is prefixed with its ' +
      'number and a tab; the prefix is not part of the file. Use start_line/end_line for long files.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace path, e.g. src/app.ts' },
        start_line: { type: 'integer', minimum: 1 },
        end_line: { type: 'integer', minimum: 1 },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'search',
    description: 'Find lines containing an exact, case-sensitive string across all files. Results can trail live typing by a few seconds; read_file is always current.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', maxLength: 200 } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_file',
    description:
      'Replace an exact string in a file. old_string must match the current text exactly (no line-number ' +
      'prefixes) and be unique unless replace_all is true; include enough surrounding lines to make it ' +
      'unique. Teammates may be typing in the same file: read it again if a match fails.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_file',
    description: 'Create a new file (and any missing folders) with the given content. Fails if the file exists.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
]

/** Plan tools (design §13.4), offered only to turns that belong to a session. */
export const PLAN_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'get_plan',
    description: "Show the session's plan: numbered steps with status and owner.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'propose_plan',
    description: 'Append steps to the session plan. New steps belong to the member you work for. Propose a plan before larger changes; keep steps short and concrete.',
    input_schema: {
      type: 'object',
      properties: { steps: { type: 'array', items: { type: 'string', maxLength: 300 }, minItems: 1, maxItems: 20 } },
      required: ['steps'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_step',
    description: "Set the status of one of your member's steps by its number. Mark a step IN_PROGRESS when you start it and DONE when it is finished. Steps owned by other people are theirs to update.",
    input_schema: {
      type: 'object',
      properties: { position: { type: 'integer', minimum: 1 }, status: { type: 'string', enum: ['TODO', 'IN_PROGRESS', 'DONE'] } },
      required: ['position', 'status'],
      additionalProperties: false,
    },
  },
]

function formatPlan(steps: PlanStep[]): string {
  if (steps.length === 0) return 'The plan is empty.'
  return steps.map((s) => `${s.position}. [${s.status}] ${s.title}${s.ownerName ? ` (${s.ownerName})` : ' (unowned)'}`).join('\n')
}

export type ToolOutcome = { content: string; isError: boolean; summary: string }

/** Limits per turn (design §13.2): total characters changed. */
export const MAX_CHANGED_CHARACTERS = 200_000
const MAX_RESULT_CHARACTERS = 60_000
const MAX_READ_LINES = 2000

class ToolError extends Error {}

function normalize(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')
}

function clip(text: string): string {
  return text.length <= MAX_RESULT_CHARACTERS ? text : `${text.slice(0, MAX_RESULT_CHARACTERS)}\n… (truncated)`
}

function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = []
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) found.push(at)
  return found
}

/** Runs tool calls for one turn and remembers which documents it changed, for revert. */
export class Toolbox {
  private readonly docs = new Map<string, { doc: Y.Doc; recorder: TurnRecorder }>()
  private changed = 0

  constructor(
    private readonly workspace: TurnWorkspace,
    private readonly origin: string,
    private readonly typing: Typing,
  ) {}

  async run(name: string, input: unknown): Promise<ToolOutcome> {
    if (!(name in schemas)) return { content: `Unknown tool ${name}`, isError: true, summary: `unknown tool ${name}` }
    const parsed = schemas[name as ToolName].safeParse(input)
    if (!parsed.success) {
      // Treated like unparseable JSON: the model sees what it sent and can retry (design §13.4).
      return {
        content: JSON.stringify({ INVALID_JSON: JSON.stringify(input) ?? String(input) }),
        isError: true,
        summary: `${name}: invalid input`,
      }
    }
    try {
      return await this.execute(name as ToolName, parsed.data as never)
    } catch (error) {
      if (error instanceof ToolError) return { content: error.message, isError: true, summary: `${name}: ${error.message}` }
      // The API refused (for example a step owned by someone else): the model can read why and adapt.
      if (error instanceof Error && 'status' in error && typeof error.status === 'number' && error.status < 500) {
        return { content: error.message, isError: true, summary: `${name}: ${error.message}` }
      }
      throw error
    }
  }

  /** The changes made to each document, for "Revert this turn". */
  records(): Array<{ fileId: string; state: Uint8Array; undo: UndoRecord }> {
    const out: Array<{ fileId: string; state: Uint8Array; undo: UndoRecord }> = []
    for (const [fileId, { doc, recorder }] of this.docs) {
      const undo = recorder.record()
      if (undo) out.push({ fileId, state: Y.encodeStateAsUpdate(doc), undo })
    }
    return out
  }

  dispose() {
    for (const { recorder } of this.docs.values()) recorder.destroy()
    this.docs.clear()
  }

  private async execute(name: ToolName, input: Record<string, unknown>): Promise<ToolOutcome> {
    switch (name) {
      case 'list_files': {
        const entries = await this.workspace.list()
        const lines = entries.map((e) => (e.kind === 'FOLDER' ? `${e.path}/` : e.path)).sort()
        return { content: lines.join('\n') || '(the workspace is empty)', isError: false, summary: `listed ${entries.length} entries` }
      }
      case 'read_file': {
        const { path, start_line, end_line } = input as z.infer<typeof schemas.read_file>
        const file = await this.file(path)
        const lines = (await this.text(file.id)).toString().split('\n')
        const from = (start_line ?? 1) - 1
        const to = Math.min(lines.length, end_line ?? from + MAX_READ_LINES, from + MAX_READ_LINES)
        const body = lines.slice(from, to).map((line, i) => `${String(from + i + 1).padStart(6)}\t${line}`).join('\n')
        const more = to < lines.length ? `\n… ${lines.length - to} more lines; use start_line=${to + 1}` : ''
        return { content: clip(body + more), isError: false, summary: `read ${file.path}` }
      }
      case 'search': {
        const { query } = input as z.infer<typeof schemas.search>
        const hits = await this.workspace.search(query)
        const body = hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n')
        return { content: clip(body || 'No matches.'), isError: false, summary: `searched for "${query.slice(0, 40)}"` }
      }
      case 'edit_file': {
        const { path, old_string, new_string, replace_all } = input as z.infer<typeof schemas.edit_file>
        const file = await this.file(path)
        const text = await this.text(file.id)
        // Find and apply in the same tick for each occurrence, so concurrent typing cannot slip in between.
        const current = text.toString()
        const found = occurrences(current, old_string)
        if (found.length === 0) throw new ToolError(`old_string was not found in ${file.path}. Read the file again; a teammate may have changed it.`)
        if (found.length > 1 && !replace_all) throw new ToolError(`old_string occurs ${found.length} times in ${file.path}; add surrounding lines or set replace_all.`)
        this.spend((old_string.length + new_string.length) * found.length)
        // Each match is anchored by a relative position now, so typing that lands between replacements
        // shifts them correctly; a match a teammate has meanwhile changed is skipped, not clobbered.
        const anchors = found.map((at) => Y.createRelativePositionFromTypeIndex(text, at, 0))
        let replaced = 0
        for (const anchor of anchors.reverse()) {
          const at = Y.createAbsolutePositionFromRelativePosition(anchor, text.doc!)?.index
          if (at === undefined || text.toString().slice(at, at + old_string.length) !== old_string) continue
          await replaceRange(text, at, old_string, new_string, this.origin, this.cursor(file.id))
          replaced++
        }
        this.workspace.setCursor(file.id, null)
        return { content: `Edited ${file.path} (${replaced} replacement${replaced === 1 ? '' : 's'}).`, isError: false, summary: `edited ${file.path}` }
      }
      case 'get_plan':
        return { content: formatPlan(await this.workspace.plan()), isError: false, summary: 'read the plan' }
      case 'propose_plan': {
        const { steps } = input as z.infer<typeof schemas.propose_plan>
        const plan = await this.workspace.proposePlan(steps)
        return { content: formatPlan(plan), isError: false, summary: `proposed ${steps.length} plan step${steps.length === 1 ? '' : 's'}` }
      }
      case 'update_step': {
        const { position, status } = input as z.infer<typeof schemas.update_step>
        const plan = await this.workspace.setStepStatus(position, status)
        return { content: formatPlan(plan), isError: false, summary: `marked step ${position} ${status.toLowerCase().replace('_', ' ')}` }
      }
      case 'create_file': {
        const { path, content } = input as z.infer<typeof schemas.create_file>
        const target = normalize(path)
        if ((await this.workspace.list()).some((e) => e.path === target)) throw new ToolError(`${target} already exists; use edit_file.`)
        this.spend(content.length)
        const file = await this.workspace.createFile(target)
        const text = await this.text(file.id)
        await replaceRange(text, 0, '', content, this.origin, this.cursor(file.id))
        this.workspace.setCursor(file.id, null)
        return { content: `Created ${file.path}.`, isError: false, summary: `created ${file.path}` }
      }
    }
  }

  private cursor(fileId: string): Typing {
    return { ...this.typing, onCursor: (index) => this.workspace.setCursor(fileId, index) }
  }

  private spend(characters: number) {
    if (this.changed + characters > MAX_CHANGED_CHARACTERS) {
      throw new ToolError(`This turn may change at most ${MAX_CHANGED_CHARACTERS} characters; stop and summarize what remains.`)
    }
    this.changed += characters
  }

  private async file(path: string): Promise<FileEntry> {
    const target = normalize(path)
    const entry = (await this.workspace.list()).find((e) => e.path === target)
    if (!entry) throw new ToolError(`No file at ${target}. Use list_files to see what exists.`)
    if (entry.kind !== 'FILE') throw new ToolError(`${target} is a folder.`)
    return entry
  }

  private async text(fileId: string): Promise<Y.Text> {
    let open = this.docs.get(fileId)
    if (!open) {
      const doc = await this.workspace.open(fileId)
      open = { doc, recorder: new TurnRecorder(doc.getText(TEXT_FIELD), this.origin) }
      this.docs.set(fileId, open)
    }
    return open.doc.getText(TEXT_FIELD)
  }
}
