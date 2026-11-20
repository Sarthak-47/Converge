import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api, type AgentTurn, type Approval, type Comment, type GitOperation, type Overlap, type PlanStep, type Role, type SessionCard, type SessionDetail } from '../api.ts'
import { ApprovalCard } from './ApprovalCard.tsx'
import { askText } from './askText.tsx'
import { AgentKeyForm, TurnCard } from './TurnCard.tsx'
import { errorMessage, useAgentKey } from './agentKit.ts'
import type { CSSProperties } from 'react'
import { colorFor } from '../editor/collabDocument.ts'

type Props = {
  workspaceId: string
  currentUser: { id: string; displayName: string }
  role: Role
  /** Bumped whenever an agent, session, comment or approval event arrives on the workspace channel. */
  refreshSignal: number
  /** Bumped on job output and status events. */
  jobSignal: number
  /** The open session, shared with the editor so new code comments attach to it. */
  sessionId: string | null
  onOpenSession: (sessionId: string | null) => void
  onShowComment: (comment: Comment) => void
}

const SESSION_STATUS: Record<SessionCard['status'], string> = {
  ACTIVE: 'Active',
  AWAITING_TAKEOVER: 'Awaiting takeover',
  DONE: 'Finished',
}

const STEP_LABEL: Record<PlanStep['status'], string> = { TODO: 'To do', IN_PROGRESS: 'In progress', DONE: 'Done' }

/**
 * Sessions (design §13.3, §13.9): a board of every session with its progress and an alerts strip for the
 * ones awaiting a takeover; inside a session, the plan with owners, one lane per participant, and the
 * sponsor-only composer that prompts or steers the member's own agent.
 */
export function SessionsPanel(props: Props) {
  const { workspaceId, role, refreshSignal, sessionId, onOpenSession } = props
  const [board, setBoard] = useState<SessionCard[]>([])
  const [waiting, setWaiting] = useState<Approval[]>([])
  const [task, setTask] = useState('')
  const [error, setError] = useState<string | null>(null)
  const canEdit = role === 'OWNER' || role === 'EDITOR'

  useEffect(() => {
    if (sessionId) return
    api.sessions(workspaceId).then(setBoard).catch(() => undefined)
    api.approvals(workspaceId).then((all) => setWaiting(all.filter((a) => a.status === 'PENDING'))).catch(() => undefined)
  }, [workspaceId, sessionId, refreshSignal])

  function create(event: FormEvent) {
    event.preventDefault()
    if (!task.trim()) return
    setError(null)
    api.createSession(workspaceId, task.trim())
      .then((card) => {
        setTask('')
        onOpenSession(card.id)
      })
      .catch((e) => setError(errorMessage(e, 'Could not start the session')))
  }

  if (sessionId) return <SessionView {...props} sessionId={sessionId} />

  const alerts = board.filter((s) => s.status === 'AWAITING_TAKEOVER')
  return (
    <section className="agents sessions-board" aria-label="Sessions">
      {(alerts.length > 0 || waiting.length > 0) && (
        <div className="alerts-strip" role="status">
          {waiting.map((a) => (
            <button key={a.id} type="button" className="alert" onClick={() => a.sessionId && onOpenSession(a.sessionId)}>
              Approval waiting: {a.requesterName}'s agent wants to run "{a.command}"
            </button>
          ))}
          {alerts.map((s) => (
            <button key={s.id} type="button" className="alert" onClick={() => onOpenSession(s.id)}>
              "{s.task}" is waiting for someone to take over from {s.driverName}
            </button>
          ))}
        </div>
      )}
      <ol className="session-cards">
        {board.length === 0 && <li className="muted small">No sessions yet. A session is one task, one plan, and a lane for everyone working on it.</li>}
        {board.map((s) => (
          <li key={s.id}>
            <button type="button" className="session-card" data-status={s.status} onClick={() => onOpenSession(s.id)}>
              <span className="session-card-task">{s.task}</span>
              <span className="muted small">
                {SESSION_STATUS[s.status]} · driven by {s.driverName} · {s.stepsDone}/{s.stepsTotal} steps
                {s.runningTurns > 0 ? ` · ${s.runningTurns} agent${s.runningTurns === 1 ? '' : 's'} working` : ''}
              </span>
              <span className="muted small">{s.participants.map((p) => `${p.displayName}${p.mode === 'WATCH' ? ' (watching)' : ''}`).join(', ')}</span>
              {s.files.length > 0 && <span className="muted small session-files">{s.files.join(', ')}</span>}
            </button>
          </li>
        ))}
      </ol>
      {error && <p className="error small agent-panel-error" role="alert">{error}</p>}
      {canEdit && (
        <form className="agent-composer" onSubmit={create}>
          <label htmlFor="session-task" className="small">New session: what should get done?</label>
          <textarea id="session-task" rows={2} maxLength={2000} value={task} onChange={(e) => setTask(e.target.value)} />
          <button type="submit" className="primary" disabled={!task.trim()}>Start session</button>
        </form>
      )}
    </section>
  )
}

function SessionView({ workspaceId, currentUser, role, refreshSignal, jobSignal, sessionId, onOpenSession, onShowComment }: Props & { sessionId: string }) {
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [overlaps, setOverlaps] = useState<Overlap[]>([])
  const [gitOps, setGitOps] = useState<GitOperation[]>([])
  const [hasRepository, setHasRepository] = useState(false)
  const [comments, setComments] = useState<Comment[]>([])
  const [draft, setDraft] = useState('')
  const [newStep, setNewStep] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const canEdit = role === 'OWNER' || role === 'EDITOR'
  const canComment = canEdit || role === 'COMMENTER'
  const [key, setKey] = useAgentKey(canEdit)
  const [spend, setSpend] = useState<{ spentMicros: number; dailyCapMicros: number } | null>(null)
  const lanes = useRef<HTMLDivElement>(null)

  const reload = useCallback(() => {
    api.session(sessionId).then(setDetail).catch((e) => setError(errorMessage(e, 'Could not load the session')))
    api.comments(workspaceId, { sessionId }).then(setComments).catch(() => undefined)
    api.approvals(workspaceId, sessionId).then(setApprovals).catch(() => undefined)
    api.overlaps(sessionId).then(setOverlaps).catch(() => setOverlaps([]))
    api.agentSpend().then(setSpend).catch(() => setSpend(null))
    api.gitOperations(workspaceId, sessionId).then(setGitOps).catch(() => setGitOps([]))
    api.gitRepository(workspaceId).then((r) => setHasRepository(r !== null)).catch(() => setHasRepository(false))
  }, [workspaceId, sessionId])

  useEffect(() => {
    reload()
  }, [reload, refreshSignal])

  async function run(action: () => Promise<unknown>, fallback: string) {
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      await action()
      reload()
    } catch (e) {
      setError(errorMessage(e, fallback))
      reload()
    } finally {
      setBusy(false)
    }
  }

  if (!detail) {
    return <section className="agents"><p className="muted small session-loading">{error ?? 'Loading session…'}</p></section>
  }
  const { session, plan, turns } = detail
  const me = session.participants.find((p) => p.userId === currentUser.id)
  const isDriver = session.driverId === currentUser.id
  const done = session.status === 'DONE'
  const myRunning = turns.find((t) => t.sponsorId === currentUser.id && t.status === 'RUNNING')
  const laneOwners = [...new Set(turns.map((t) => t.laneUserId))]

  function send(event: FormEvent) {
    event.preventDefault()
    const text = draft.trim()
    if (!text) return
    if (myRunning) {
      // Steering spends the sponsor's key, so it goes only to the member's own running turn (design §13.8).
      void run(async () => {
        try {
          await api.steerTurn(workspaceId, myRunning.id, text)
          setDraft('')
        } catch (e) {
          setNotice('Your agent had already finished, so your guidance is back in the box; send it as a new prompt.')
          throw e
        }
      }, 'Could not steer the agent')
      return
    }
    void run(async () => {
      await api.promptAgent(workspaceId, text, sessionId)
      setDraft('')
    }, 'Could not start the agent')
  }

  function takeOver() {
    void run(async () => {
      try {
        await api.takeOver(sessionId, session.rowVersion)
      } catch (e) {
        setNotice('Someone else took over first. You can still join with your own lane.')
        throw e
      }
    }, 'Could not take over')
  }

  async function handOff() {
    const candidates = session.participants.filter((p) => p.userId !== currentUser.id && p.mode === 'LANE')
    if (candidates.length === 0) {
      setError('Ask a teammate to join with a lane first; sessions are handed to lane participants.')
      return
    }
    const name = await askText({
      title: 'Hand off the session',
      label: `Hand it to: ${candidates.map((c) => c.displayName).join(', ')}`,
      initial: candidates[0]!.displayName,
      submitLabel: 'Hand off',
    })
    const target = candidates.find((c) => c.displayName === name)
    if (target) void run(() => api.handOff(sessionId, target.userId, session.rowVersion), 'Could not hand the session over')
  }

  async function commentOn(target: { turnId?: string; stepId?: string }) {
    const body = await askText({ title: 'Comment', label: 'Comment', multiline: true })
    if (!body) return
    void run(() => api.addComment(workspaceId, {
      targetKind: target.turnId ? 'TURN' : 'PLAN_STEP', sessionId, ...target, body,
    }), 'Could not add the comment')
  }

  return (
    <section className="agents session-view" aria-label={`Session: ${session.task}`}>
      <div className="session-head">
        <button type="button" className="ghost" onClick={() => onOpenSession(null)} aria-label="Back to all sessions">←</button>
        <div>
          <strong className="session-task">{session.task}</strong>
          <p className="muted small">
            <span className={`session-status status-${session.status.toLowerCase()}`}>{SESSION_STATUS[session.status]}</span>
            {' '}· driven by {session.driverName} · {session.stepsDone}/{session.stepsTotal} steps
          </p>
        </div>
      </div>
      <div className="session-people">
        {session.participants.map((p) => (
          <span key={p.userId} className="peer">{p.displayName}{p.mode === 'WATCH' ? ' 👁' : ''}{p.userId === session.driverId ? ' (driver)' : ''}</span>
        ))}
      </div>
      <div className="session-actions">
        {!done && !me && <button type="button" className="ghost" disabled={busy} onClick={() => void run(() => api.joinSession(sessionId, 'WATCH'), 'Could not join')}>Watch</button>}
        {!done && canEdit && me?.mode !== 'LANE' && <button type="button" className="ghost" disabled={busy} onClick={() => void run(() => api.joinSession(sessionId, 'LANE'), 'Could not join')}>Join with my agent</button>}
        {!done && canEdit && !isDriver && key?.configured && <button type="button" className={session.status === 'AWAITING_TAKEOVER' ? 'primary' : 'ghost'} disabled={busy} onClick={takeOver}>Take over</button>}
        {!done && isDriver && <button type="button" className="ghost" disabled={busy} onClick={() => void handOff()}>Hand off</button>}
        {!done && (isDriver || role === 'OWNER') && hasRepository && (
          <button type="button" className="primary" disabled={busy} onClick={() => void run(async () => {
            // A finished session is closed by a pull request (design §10, Phase 12). The key makes a retry safe.
            await api.openPullRequest(sessionId, crypto.randomUUID())
            await api.finishSession(sessionId, session.rowVersion)
          }, 'Could not open the pull request')}>Finish and open pull request</button>
        )}
        {(isDriver || role === 'OWNER') && hasRepository && done && (
          <button type="button" className="ghost" disabled={busy} onClick={() => void run(() => api.openPullRequest(sessionId, crypto.randomUUID()), 'Could not open the pull request')}>Open pull request</button>
        )}
        {!done && (isDriver || role === 'OWNER') && <button type="button" className="ghost" disabled={busy} onClick={() => void run(() => api.finishSession(sessionId, session.rowVersion), 'Could not finish')}>Finish</button>}
        {me && !isDriver && <button type="button" className="ghost" disabled={busy} onClick={() => void run(() => api.leaveSession(sessionId), 'Could not leave')}>Leave</button>}
      </div>

      {gitOps.length > 0 && (
        <ul className="git-operations" aria-label="Pull requests">
          {gitOps.map((op) => (
            <li key={op.id} data-status={op.status}>
              {op.status === 'SUCCEEDED' && op.result?.prUrl ? (
                <a href={op.result.prUrl} target="_blank" rel="noreferrer noopener">Pull request #{op.result.prNumber}</a>
              ) : (
                <span>{op.type === 'PULL_REQUEST' ? 'Pull request' : 'Push'}: {op.status === 'QUEUED' ? 'queued' : op.status === 'RUNNING' ? 'pushing…' : op.status.toLowerCase()}</span>
              )}
              <span className="muted small"> · {op.params.branch}{op.result ? ` · ${op.result.changedFiles} file${op.result.changedFiles === 1 ? '' : 's'}` : ''}</span>
              {op.error && <p className="agent-error small">{op.error}</p>}
            </li>
          ))}
        </ul>
      )}
      {overlaps.length > 0 && (
        <div className="overlap-warning" role="status">
          {overlaps.map((o) => (
            <p key={o.sessionId} className="small">
              Overlapping: "{o.task}" (driven by {o.driverName}) is also working on {o.files.join(', ')}.{' '}
              <button type="button" className="link small" onClick={() => onOpenSession(o.sessionId)}>Open it</button>
            </p>
          ))}
        </div>
      )}
      <div className="session-scroll" ref={lanes}>
        <h3 className="session-section">Plan</h3>
        <ol className="plan-steps">
          {plan.length === 0 && <li className="muted small">No steps yet. Agents propose steps for their member; anyone can add or take one.</li>}
          {plan.map((step) => (
            <li key={step.id} className="plan-step" data-status={step.status} aria-label={`Step ${step.position}: ${step.title}`}>
              <span className={`step-status status-${step.status.toLowerCase()}`}>{STEP_LABEL[step.status]}</span>
              <span className="step-title">{step.position}. {step.title}</span>
              <span className="muted small">{step.ownerName ?? 'unowned'}</span>
              <span className="step-actions">
                {canComment && !step.ownerId && step.status === 'TODO' && !done && (
                  <button type="button" className="ghost" disabled={busy} onClick={() => void run(() => api.takeStep(step), 'Could not take the step')}>Take</button>
                )}
                {step.ownerId === currentUser.id && step.status === 'TODO' && (
                  <button type="button" className="ghost" disabled={busy} onClick={() => void run(() => api.updateStep(step, 'IN_PROGRESS'), 'Could not update the step')}>Start</button>
                )}
                {step.ownerId === currentUser.id && step.status !== 'DONE' && (
                  <>
                    <button type="button" className="ghost" disabled={busy} onClick={() => void run(() => api.updateStep(step, 'DONE'), 'Could not update the step')}>Done</button>
                    <button type="button" className="ghost" disabled={busy} onClick={() => void run(() => api.updateStep(step, step.status, true), 'Could not hand back the step')}>Hand back</button>
                  </>
                )}
                {canComment && <button type="button" className="ghost" onClick={() => void commentOn({ stepId: step.id })} aria-label={`Comment on step ${step.position}`}>💬</button>}
              </span>
            </li>
          ))}
        </ol>
        {canEdit && !done && (
          <form className="plan-add" onSubmit={(e) => {
            e.preventDefault()
            if (newStep.trim()) void run(async () => {
              await api.addSteps(sessionId, [newStep.trim()])
              setNewStep('')
            }, 'Could not add the step')
          }}>
            <input aria-label="New plan step" placeholder="Add a step" maxLength={300} value={newStep} onChange={(e) => setNewStep(e.target.value)} />
          </form>
        )}

        {laneOwners.map((owner) => {
          const laneTurns = turns.filter((t) => t.laneUserId === owner)
          const name = laneTurns[0]?.sponsorName ?? 'Someone'
          return (
            <div key={owner} className="lane" aria-label={`${name}'s lane`} style={{ '--who': colorFor(owner) } as CSSProperties}>
              <h3 className="session-section">{name}'s lane</h3>
              <ol className="agent-turns">
                {laneTurns.map((turn) => (
                  <TurnCard key={turn.id} turn={turn} currentUserId={currentUser.id} canEdit={canEdit} busy={busy}
                    onStop={(t: AgentTurn) => void run(() => api.cancelTurn(workspaceId, t.id), 'Could not stop the turn')}
                    onRevert={(t: AgentTurn) => void run(() => api.revertTurn(workspaceId, t.id), 'Could not revert the turn')}
                    renderApproval={(approvalId) => {
                      const approval = approvals.find((a) => a.id === approvalId)
                      return approval && <ApprovalCard approval={approval} canDecide={canEdit} jobSignal={jobSignal} onChanged={reload} />
                    }} />
                ))}
              </ol>
              {canComment && laneTurns.length > 0 && (
                <button type="button" className="link small" onClick={() => void commentOn({ turnId: laneTurns.at(-1)!.id })}>Comment on the latest turn</button>
              )}
            </div>
          )
        })}

        {comments.length > 0 && <h3 className="session-section">Comments</h3>}
        <ol className="session-comments">
          {comments.map((c) => (
            <li key={c.id} className={`comment ${c.status === 'RESOLVED' ? 'resolved' : ''}`}>
              <p><strong>{c.authorName}</strong> <span className="muted small">on {c.targetKind === 'FILE_RANGE' ? 'code' : c.targetKind === 'TURN' ? 'a turn' : 'a plan step'}</span></p>
              {c.quote && <pre className="comment-quote">{c.quote}</pre>}
              <p>{c.body}</p>
              <div className="comment-actions">
                {c.targetKind === 'FILE_RANGE' && <button type="button" className="link small" onClick={() => onShowComment(c)}>Show in file</button>}
                {canComment && (
                  <button type="button" className="link small" onClick={() => void run(() => api.resolveComment(workspaceId, c.id, c.status !== 'RESOLVED'), 'Could not update the comment')}>
                    {c.status === 'RESOLVED' ? 'Reopen' : 'Resolve'}
                  </button>
                )}
                {canEdit && !c.causedStepId && !done && <button type="button" className="link small" onClick={() => void run(() => api.commentToStep(workspaceId, c.id), 'Could not add the step')}>Make plan step</button>}
                {c.causedStepId && <span className="muted small">became a plan step</span>}
                {canEdit && c.createdBy === currentUser.id && !c.causedTurnId && key?.configured && !done && (
                  <button type="button" className="link small" onClick={() => void run(() => api.commentToPrompt(workspaceId, c.id), 'Could not send to your agent')}>Send to my agent</button>
                )}
                {c.causedTurnId && <span className="muted small">sent to an agent</span>}
              </div>
            </li>
          ))}
        </ol>
      </div>

      {notice && <p className="notice small agent-panel-error" role="status">{notice}</p>}
      {error && <p className="error small agent-panel-error" role="alert">{error}</p>}
      {canEdit && !done && key && !key.configured && <AgentKeyForm onSaved={setKey} />}
      {canEdit && !done && key?.configured && (
        <form className="agent-composer" onSubmit={send}>
          <label htmlFor="agent-prompt" className="small">
            {myRunning
              ? `Steer your running agent. Uses ${currentUser.displayName}'s API key.`
              : `Prompt your agent. Uses ${currentUser.displayName}'s API key (${key.hint}).`}
            {spend && <span className="muted"> Last 24 h: ${(spend.spentMicros / 1e6).toFixed(2)} of ${(spend.dailyCapMicros / 1e6).toFixed(2)}.</span>}
          </label>
          <textarea
            id="agent-prompt"
            rows={3}
            maxLength={myRunning ? 4000 : 20000}
            value={draft}
            placeholder={myRunning ? 'Guidance for the agent while it works' : 'Describe the change you want'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(e)
            }}
          />
          <button type="submit" className="primary" disabled={busy || !draft.trim()}>{myRunning ? 'Steer' : 'Send to agent'}</button>
        </form>
      )}
    </section>
  )
}
