import * as Y from 'yjs'
import type { UndoRecord } from '../src/edits.js'
import type { TurnEvent, TurnLedger, TurnStatus } from '../src/turn.js'
import { ApiCallError } from '../src/apiClient.js'
import type { FileEntry, PlanStep, SearchHit, StepStatus, TurnWorkspace } from '../src/workspace.js'
import { Hub } from './hub.js'

/** An in-memory workspace: each file is a Hub, so a test can also join as a person and type. */
export class MemoryWorkspace implements TurnWorkspace {
  readonly files = new Map<string, { entry: FileEntry; hub: Hub }>()
  readonly cursors: Array<[string, number | null]> = []
  /** The session plan; the sponsor is "Asha". */
  readonly steps: PlanStep[] = []
  private disconnects: Array<() => void> = []
  closed = false
  private ids = 0

  add(path: string, text: string): string {
    const id = `00000000-0000-4000-8000-${String(++this.ids).padStart(12, '0')}`
    const hub = new Hub()
    hub.server.getText('content').insert(0, text)
    this.files.set(id, { entry: { id, path, kind: 'FILE' }, hub })
    return id
  }

  hub(path: string): Hub {
    return [...this.files.values()].find((f) => f.entry.path === path)!.hub
  }

  async list(): Promise<FileEntry[]> {
    return [...this.files.values()].map((f) => f.entry)
  }

  async open(fileId: string, initialState?: Uint8Array): Promise<Y.Doc> {
    const file = this.files.get(fileId)
    if (!file) throw new Error('no such file')
    const doc = new Y.Doc({ gc: false })
    if (initialState) Y.applyUpdate(doc, initialState)
    this.disconnects.push(file.hub.connect(doc))
    return doc
  }

  async createFile(path: string): Promise<FileEntry> {
    const id = this.add(path, '')
    return this.files.get(id)!.entry
  }

  async search(query: string): Promise<SearchHit[]> {
    const hits: SearchHit[] = []
    for (const { entry, hub } of this.files.values()) {
      hub.text().split('\n').forEach((text, i) => {
        if (text.includes(query)) hits.push({ path: entry.path, line: i + 1, text })
      })
    }
    return hits
  }

  async plan() {
    return this.steps
  }

  async proposePlan(titles: string[]) {
    for (const title of titles) this.steps.push({ position: this.steps.length + 1, title, ownerName: 'Asha', status: 'TODO' })
    return this.steps
  }

  async setStepStatus(position: number, status: StepStatus) {
    const step = this.steps.find((s) => s.position === position)
    if (!step) throw new ApiCallError(404, `Step ${position} not found`)
    if (step.ownerName !== 'Asha') throw new ApiCallError(403, `Step ${position} belongs to ${step.ownerName}`)
    step.status = status
    return this.steps
  }

  setCursor(fileId: string, index: number | null) {
    this.cursors.push([fileId, index])
  }

  async flush() {
    for (const { hub } of this.files.values()) await hub.settle()
  }

  async close() {
    this.disconnects.forEach((disconnect) => disconnect())
    this.disconnects = []
    this.closed = true
  }
}

export class MemoryLedger implements TurnLedger {
  readonly events: TurnEvent[] = []
  readonly revertStates = new Map<string, { state: Uint8Array; undo: UndoRecord }>()
  costMicros = 0
  finished: { status: TurnStatus; error?: string; code?: string } | null = null

  async event(event: TurnEvent) {
    this.events.push(event)
  }

  async usage(usage: { costMicros: number }) {
    this.costMicros += usage.costMicros
    return { costMicros: this.costMicros }
  }

  async saveRevertState(fileId: string, state: Uint8Array, undo: UndoRecord) {
    this.revertStates.set(fileId, { state, undo })
  }

  async finish(status: TurnStatus, error?: string, code?: string) {
    this.finished = code ? { status, error, code } : { status, error }
  }
}
