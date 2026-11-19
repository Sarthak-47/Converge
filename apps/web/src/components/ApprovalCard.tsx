import { useEffect, useRef, useState } from 'react'
import { api, type Approval, type JobDetail } from '../api.ts'
import { errorMessage } from './agentKit.ts'

type Props = {
  approval: Approval
  canDecide: boolean
  /** Bumped on job output and status events, so the output streams in. */
  jobSignal: number
  onChanged: () => void
}

const JOB_LABEL: Record<string, string> = {
  QUEUED: 'Queued',
  RUNNING: 'Running in the sandbox…',
  SUCCEEDED: 'Succeeded',
  FAILED: 'Failed',
  CANCELED: 'Cancelled',
  OUTCOME_UNKNOWN: 'Outcome unknown',
}

/**
 * An approval card (design §13.7): the exact command, what it may touch, who asks and who pays. Any editor
 * answers; the first answer wins. Once approved, the job's output streams in below, and an interrupted job
 * asks a person to record what actually happened instead of being retried.
 */
export function ApprovalCard({ approval, canDecide, jobSignal, onChanged }: Props) {
  const [detail, setDetail] = useState<JobDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const output = useRef<HTMLPreElement>(null)
  const jobId = approval.job?.id ?? null

  useEffect(() => {
    if (jobId) api.job(jobId).then(setDetail).catch(() => undefined)
  }, [jobId, jobSignal])

  useEffect(() => {
    output.current?.scrollTo({ top: output.current.scrollHeight })
  }, [detail])

  async function act(action: () => Promise<unknown>, fallback: string) {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(errorMessage(e, fallback))
    } finally {
      setBusy(false)
      onChanged()
    }
  }

  const job = detail?.job ?? approval.job
  return (
    <div className="approval-card" data-status={approval.status} role="group" aria-label={`Approval: ${approval.command}`}>
      <p className="small">
        <strong>{approval.turnId ? `${approval.requesterName}'s agent` : approval.requesterName}</strong> asks to run
      </p>
      <code className="approval-command">{approval.command}</code>
      <p className="muted small">{approval.capabilities.join(' · ')}</p>
      {approval.status === 'PENDING' && (
        canDecide ? (
          <div className="approval-actions">
            <button type="button" className="primary" disabled={busy} onClick={() => void act(() => api.decide(approval, true), 'Could not approve')}>
              Approve
            </button>
            <button type="button" className="ghost" disabled={busy} onClick={() => void act(() => api.decide(approval, false), 'Could not deny')}>
              Deny
            </button>
            <span className="muted small">expires {new Date(approval.expiresAt).toLocaleTimeString()}</span>
          </div>
        ) : (
          <p className="muted small">Waiting for an editor to approve.</p>
        )
      )}
      {approval.status === 'DENIED' && <p className="approval-state denied small">Denied by {approval.deciderName}</p>}
      {approval.status === 'EXPIRED' && <p className="approval-state small muted">Expired without an answer; it did not run.</p>}
      {approval.status === 'APPROVED' && (
        <p className="approval-state small">
          Approved by {approval.deciderName}
          {job && <> · <span className={`job-status status-${job.status.toLowerCase()}`}>{JOB_LABEL[job.status] ?? job.status}{job.exitCode !== null ? ` (exit ${job.exitCode})` : ''}</span></>}
        </p>
      )}
      {detail && detail.output.length > 0 && (
        <pre className="job-output" ref={output} aria-label="Job output">
          {detail.output.map((c) => <span key={c.seq} className={`out-${c.stream}`}>{c.chunk}</span>)}
        </pre>
      )}
      {job?.error && <p className="agent-error small">{job.error}</p>}
      {job?.status === 'OUTCOME_UNKNOWN' && !job.outcome && canDecide && (
        <div className="approval-actions">
          <span className="small">What happened?</span>
          <button type="button" className="ghost" disabled={busy} onClick={() => void act(() => api.recordOutcome(job.id, 'SUCCEEDED'), 'Could not record')}>It succeeded</button>
          <button type="button" className="ghost" disabled={busy} onClick={() => void act(() => api.recordOutcome(job.id, 'FAILED'), 'Could not record')}>It failed</button>
        </div>
      )}
      {job?.outcome && <p className="muted small">Recorded outcome: {job.outcome.toLowerCase()}</p>}
      {error && <p className="error small" role="alert">{error}</p>}
    </div>
  )
}
