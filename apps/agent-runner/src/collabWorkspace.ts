import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import WebSocket from 'ws'
import * as Y from 'yjs'
import type { TurnApi } from './apiClient.js'
import {
  TEXT_FIELD, type Anchor, type ApprovalState, type FileEntry, type HeldRange, type JobState, type MemoryKind, type MemoryNote,
  type PlanStep, type SearchHit, type StepStatus, type TurnWorkspace,
} from './workspace.js'

/** A colour that is valid for the editor's awareness check and distinct from people's palette. */
const AGENT_COLOR = 'hsl(280 70% 50%)'

/**
 * The live workspace for one turn: the API for the tree and search, and the collaboration service for
 * documents, which the agent joins as its own Yjs client and awareness identity ("Asha's agent"). Tickets
 * are issued per connection for the turn's sponsor, through the API, so a sponsor who loses access
 * stops the agent too.
 */
export class CollabWorkspace implements TurnWorkspace {
  private readonly socket: HocuspocusProviderWebsocket
  private readonly providers = new Map<string, { provider: HocuspocusProvider; doc: Y.Doc }>()
  private entries: FileEntry[] | null = null

  constructor(
    private readonly api: TurnApi,
    private readonly label: string,
    options: { collabUrl: string; origin: string },
  ) {
    const origin = options.origin
    class OriginWebSocket extends WebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols, { headers: { Origin: origin } })
      }
    }
    this.socket = new HocuspocusProviderWebsocket({ url: options.collabUrl, WebSocketPolyfill: OriginWebSocket })
  }

  async list(): Promise<FileEntry[]> {
    this.entries = await this.api.tree()
    return this.entries
  }

  async open(fileId: string, initialState?: Uint8Array): Promise<Y.Doc> {
    const existing = this.providers.get(fileId)
    if (existing) return existing.doc
    // Garbage collection off: the content this turn deletes must survive for a later revert.
    const doc = new Y.Doc({ gc: false })
    if (initialState) Y.applyUpdate(doc, initialState)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out opening ${fileId}`)), 15_000)
      const provider = new HocuspocusProvider({
        websocketProvider: this.socket,
        name: fileId,
        document: doc,
        token: () => this.api.ticket(fileId),
        onSynced: () => {
          clearTimeout(timer)
          resolve()
        },
        onAuthenticationFailed: ({ reason }) => {
          clearTimeout(timer)
          reject(new Error(`Not allowed to open the file: ${reason}`))
        },
      })
      provider.setAwarenessField('user', { name: this.label, color: AGENT_COLOR, agent: true })
      provider.attach()
      this.providers.set(fileId, { provider, doc })
    })
    return doc
  }

  async createFile(path: string): Promise<FileEntry> {
    const entry = await this.api.createFile(path)
    this.entries = null
    return entry
  }

  search(query: string): Promise<SearchHit[]> {
    return this.api.search(query)
  }

  plan(): Promise<PlanStep[]> {
    return this.api.plan()
  }

  proposePlan(titles: string[]): Promise<PlanStep[]> {
    return this.api.proposePlan(titles)
  }

  setStepStatus(position: number, status: StepStatus): Promise<PlanStep[]> {
    return this.api.setStepStatus(position, status)
  }

  requestCommand(command: string): Promise<{ approvalId: string }> {
    return this.api.requestCommand(command)
  }

  approval(approvalId: string): Promise<ApprovalState> {
    return this.api.approval(approvalId)
  }

  job(jobId: string): Promise<JobState> {
    return this.api.job(jobId)
  }

  memories(fileId?: string): Promise<MemoryNote[]> {
    return this.api.memories(fileId)
  }

  writeMemory(note: { fileId: string; kind: MemoryKind; body: string; anchor: Anchor; anchoredText: string }): Promise<MemoryNote> {
    return this.api.writeMemory(note)
  }

  updateMemory(id: string, change: { body?: string; anchor?: Anchor; anchoredText?: string; retire?: boolean }): Promise<MemoryNote> {
    return this.api.updateMemory(id, change)
  }

  heldRanges(fileId: string): Promise<HeldRange[]> {
    return this.api.heldRanges(fileId)
  }

  setCursor(fileId: string, index: number | null) {
    const open = this.providers.get(fileId)
    if (!open) return
    if (index === null) {
      open.provider.setAwarenessField('selection', null)
      return
    }
    const position = Y.createRelativePositionFromTypeIndex(open.doc.getText(TEXT_FIELD), index)
    open.provider.setAwarenessField('selection', { anchor: position, head: position })
  }

  async flush(): Promise<void> {
    const deadline = Date.now() + 10_000
    while ([...this.providers.values()].some(({ provider }) => provider.hasUnsyncedChanges)) {
      if (Date.now() > deadline) throw new Error('Edits did not reach the collaboration service in time')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  async close(): Promise<void> {
    for (const { provider, doc } of this.providers.values()) {
      provider.destroy()
      doc.destroy()
    }
    this.providers.clear()
    this.socket.destroy()
  }
}
