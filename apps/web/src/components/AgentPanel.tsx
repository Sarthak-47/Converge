import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api, ApiError, type AgentKey, type AgentTurn, type AgentTurnStatus } from '../api.ts'

type Props = {
  workspaceId: string
  currentUser: { id: string; displayName: string }
  canEdit: boolean
  /** Bumped whenever an agent event arrives on the workspace channel. */
  refreshSignal: number
}

const STATUS_LABEL: Record<AgentTurnStatus, string> = {
  RUNNING: 'Working…',
  SUCCEEDED: 'Done',
  FAILED: 'Failed',
  CANCELLED: 'Stopped',
  REFUSED: 'Declined',
  BUDGET_EXCEEDED: 'Cost cap reached',
}

function dollars(micros: number) {
  return `$${(micros / 1_000_000).toFixed(micros < 10_000 ? 4 : 2)}`
}

function message(error: unknown, fallback: string) {
  return error instanceof ApiError || error instanceof Error ? error.message : fallback
}

/**
 * Agent lanes (design §13.3, §13.5): every member's turns are visible to the whole workspace, each turn is
 * paid by one named sponsor with their own key, and any editor can revert a finished turn's edits.
 */
export function AgentPanel({ workspaceId, currentUser, canEdit, refreshSignal }: Props) {
  const [turns, setTurns] = useState<AgentTurn[]>([])
  const [key, setKey] = useState<AgentKey | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const list = useRef<HTMLOListElement>(null)

  const reload = useCallback(() => {
    api.agentTurns(workspaceId).then(setTurns).catch(() => undefined)
  }, [workspaceId])

  useEffect(() => {
    reload()
  }, [reload, refreshSignal])

  useEffect(() => {
    if (canEdit) api.agentKey().then(setKey).catch(() => setKey(null))
  }, [canEdit])

  useEffect(() => {
    list.current?.lastElementChild?.scrollIntoView({ block: 'end' })
  }, [turns])

  const mineRunning = turns.some((t) => t.sponsorId === currentUser.id && t.status === 'RUNNING')

  async function run(action: () => Promise<unknown>, fallback: string) {
    setError(null)
    setBusy(true)
    try {
      await action()
      reload()
    } catch (e) {
      setError(message(e, fallback))
    } finally {
      setBusy(false)
    }
  }

  function saveKey(event: FormEvent) {
    event.preventDefault()
    const value = keyDraft.trim()
    if (!value) return
    void run(async () => {
      setKey(await api.setAgentKey(value))
      setKeyDraft('')
    }, 'Could not save the key')
  }

  function send(event: FormEvent) {
    event.preventDefault()
    const prompt = draft.trim()
    if (!prompt) return
    void run(async () => {
      await api.promptAgent(workspaceId, prompt)
      setDraft('')
    }, 'Could not start the agent')
  }

  return (
    <section className="agents" aria-label="Agents">
      <ol className="agent-turns" ref={list}>
        {turns.length === 0 && <li className="muted small">No agent turns yet. Each member prompts their own agent; everyone sees its work here.</li>}
        {turns.map((turn) => (
          <li key={turn.id} className="agent-turn" data-status={turn.status} aria-label={`${turn.sponsorName}'s agent turn`}>
            <div className="agent-turn-head">
              <strong>{turn.sponsorName}'s agent</strong>
              <span className={`agent-status status-${turn.status.toLowerCase()}`}>{STATUS_LABEL[turn.status]}</span>
            </div>
            {turn.events.map((e) => {
              if (e.kind === 'prompt') return <p key={e.seq} className="agent-prompt"><span className="muted">{turn.sponsorName}:</span> {e.text}</p>
              if (e.kind === 'tool') return <p key={e.seq} className={`agent-tool ${e.ok ? 'ok' : 'failed'}`}>{e.ok ? '✓' : '✗'} {e.summary}</p>
              if (e.kind === 'note') return <p key={e.seq} className="agent-note muted">{e.text}</p>
              return <p key={e.seq} className="agent-text">{e.text}</p>
            })}
            {turn.error && <p className="agent-error" role="status">{turn.error}</p>}
            <div className="agent-turn-foot">
              <span className="muted small" title={`Model ${turn.model}; cap ${dollars(turn.costCapMicros)}`}>
                {dollars(turn.costMicros)} on {turn.sponsorName}'s key
              </span>
              {turn.status === 'RUNNING' && turn.sponsorId === currentUser.id && (
                <button type="button" className="ghost" disabled={busy} onClick={() => void run(() => api.cancelTurn(workspaceId, turn.id), 'Could not stop the turn')}>
                  Stop
                </button>
              )}
              {turn.revertible && canEdit && (
                <button type="button" className="ghost" disabled={busy} onClick={() => void run(() => api.revertTurn(workspaceId, turn.id), 'Could not revert the turn')}>
                  Revert this turn
                </button>
              )}
              {turn.revertStatus === 'REVERTED' && <span className="muted small">Reverted</span>}
            </div>
          </li>
        ))}
      </ol>
      {error && <p className="error small agent-panel-error" role="alert">{error}</p>}
      {canEdit && key && !key.configured && (
        <form className="agent-key-form" onSubmit={saveKey}>
          <label htmlFor="agent-key">Your Anthropic API key</label>
          <input id="agent-key" type="password" autoComplete="off" placeholder="sk-ant-…" value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} />
          <p className="muted small">Your agent runs on your own key. It is stored encrypted and never shown again.</p>
          <button type="submit" className="primary" disabled={busy || !keyDraft.trim()}>Save key</button>
        </form>
      )}
      {canEdit && key?.configured && (
        <form className="agent-composer" onSubmit={send}>
          <label htmlFor="agent-prompt" className="small">
            Prompt your agent. Uses {currentUser.displayName}'s API key ({key.hint}).{' '}
            <button type="button" className="link" onClick={() => void run(async () => {
              await api.removeAgentKey()
              setKey({ configured: false, hint: null })
            }, 'Could not remove the key')}>Remove key</button>
          </label>
          <textarea
            id="agent-prompt"
            rows={3}
            maxLength={20000}
            value={draft}
            placeholder={mineRunning ? 'Your agent is working…' : 'Describe the change you want'}
            disabled={mineRunning}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(e)
            }}
          />
          <button type="submit" className="primary" disabled={busy || mineRunning || !draft.trim()}>Send to agent</button>
        </form>
      )}
    </section>
  )
}
