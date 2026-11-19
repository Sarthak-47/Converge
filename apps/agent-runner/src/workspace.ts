import type * as Y from 'yjs'

/** Name of the shared type holding a file's text; the editor and collaboration service use the same name. */
export const TEXT_FIELD = 'content'

export type FileEntry = { id: string; path: string; kind: 'FILE' | 'FOLDER' }
export type SearchHit = { path: string; line: number; text: string }
export type StepStatus = 'TODO' | 'IN_PROGRESS' | 'DONE'
export type PlanStep = { position: number; title: string; ownerName: string | null; status: StepStatus }
export type ApprovalState = { status: 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED'; deciderName: string | null; jobId: string | null }
export type JobState = {
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED' | 'OUTCOME_UNKNOWN'
  exitCode: number | null
  error: string | null
  output: string
}

/**
 * The workspace as one agent turn sees it. Documents are opened as the turn's own Yjs client, with garbage
 * collection off so the content the agent deletes stays available for "Revert this turn" (design §13.2).
 */
export interface TurnWorkspace {
  list(): Promise<FileEntry[]>
  /**
   * Opens a file's live document. `initialState`, when given, is applied before the first sync: a revert
   * needs the deleted content recorded at the end of the turn, which the server itself no longer keeps.
   */
  open(fileId: string, initialState?: Uint8Array): Promise<Y.Doc>
  createFile(path: string): Promise<FileEntry>
  /** Literal search over the workspace's stored text; may trail live typing by a few seconds. */
  search(query: string): Promise<SearchHit[]>
  /** The session's plan (design §13.9); only turns that belong to a session have one. */
  plan(): Promise<PlanStep[]>
  /** Adds steps owned by the turn's sponsor. */
  proposePlan(titles: string[]): Promise<PlanStep[]>
  /** Moves one of the sponsor's own steps. */
  setStepStatus(position: number, status: StepStatus): Promise<PlanStep[]>
  /**
   * Asks to run an allowlisted command (design §13.7): creates an approval card bound to this exact command.
   * Throws if the command is not allowed or the API cannot be reached; the command then never runs.
   */
  requestCommand(command: string): Promise<{ approvalId: string }>
  approval(approvalId: string): Promise<ApprovalState>
  job(jobId: string): Promise<JobState>
  /** Shows the agent's cursor in a file (`null` hides it). */
  setCursor(fileId: string, index: number | null): void
  /** Waits until every local change has reached the server. */
  flush(): Promise<void>
  close(): Promise<void>
}
