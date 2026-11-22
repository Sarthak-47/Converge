import { useState, type FormEvent } from 'react'
import type React from 'react'
import { api, type AgentKey, type AgentProvider, type AgentTurn, type AgentTurnStatus } from '../api.ts'
import { dollars, errorMessage, PROVIDERS } from './agentKit.ts'
import { Icon } from './Icon.tsx'
import type { CSSProperties } from 'react'
import { colorFor } from '../editor/collabDocument.ts'
import { initials, stickerStyle } from './sticker.ts'

const STATUS_LABEL: Record<AgentTurnStatus, string> = {
  RUNNING: 'Working…',
  SUCCEEDED: 'Done',
  FAILED: 'Failed',
  CANCELLED: 'Stopped',
  REFUSED: 'Declined',
  BUDGET_EXCEEDED: 'Cost cap reached',
}

type TurnCardProps = {
  turn: AgentTurn
  currentUserId: string
  canEdit: boolean
  busy: boolean
  onStop: (turn: AgentTurn) => void
  onRevert: (turn: AgentTurn) => void
  /** Renders an approval card where the agent asked for it in the transcript. */
  renderApproval?: (approvalId: string) => React.ReactNode
}

/** One agent turn in a lane: its transcript, cost on the sponsor's key, and stop/revert (design §13.2, §13.5). */
export function TurnCard({ turn, currentUserId, canEdit, busy, onStop, onRevert, renderApproval }: TurnCardProps) {
  return (
    <li className="agent-turn" data-status={turn.status} aria-label={`${turn.sponsorName}'s agent turn`} style={{ '--who': colorFor(turn.sponsorId) } as CSSProperties}>
      <div className="agent-turn-head">
        <strong className="turn-who"><span className="avatar avatar-sm agent" style={stickerStyle(turn.sponsorId)} aria-hidden="true">{initials(turn.sponsorName)}</span>{turn.sponsorName}'s agent</strong>
        <span className={`agent-status status-${turn.status.toLowerCase()}`}>{STATUS_LABEL[turn.status]}</span>
      </div>
      {turn.events.map((e) => {
        if (e.kind === 'prompt') return <p key={e.seq} className="agent-prompt"><span className="muted">{turn.sponsorName}:</span> {e.text}</p>
        if (e.kind === 'steer') return <p key={e.seq} className="agent-prompt"><span className="muted">{turn.sponsorName} (steering):</span> {e.text}</p>
        if (e.kind === 'tool') return <p key={e.seq} className={`agent-tool ${e.ok ? 'ok' : 'failed'}`}><Icon name={e.ok ? 'check' : 'cross'} size={13} /><span className="sr-only">{e.ok ? 'Done: ' : 'Failed: '}</span>{e.summary}</p>
        if (e.kind === 'note') return <p key={e.seq} className="agent-note muted">{e.text}</p>
        if (e.kind === 'approval') return <div key={e.seq}>{e.approvalId && renderApproval?.(e.approvalId)}</div>
        return <p key={e.seq} className="agent-text">{e.text}</p>
      })}
      {turn.error && <p className="agent-error" role="status">{turn.error}</p>}
      <div className="agent-turn-foot">
        <span className="muted small" title={`Model ${turn.model}; cap ${dollars(turn.costCapMicros)}`}>
          {dollars(turn.costMicros)} on {turn.sponsorName}'s key
        </span>
        {turn.status === 'RUNNING' && turn.sponsorId === currentUserId && (
          <button type="button" className="ghost" disabled={busy} onClick={() => onStop(turn)}>Stop</button>
        )}
        {turn.revertible && canEdit && (
          <button type="button" className="ghost" disabled={busy} onClick={() => onRevert(turn)}>Revert this turn</button>
        )}
        {turn.revertStatus === 'REVERTED' && <span className="muted small">Reverted</span>}
      </div>
    </li>
  )
}

export function AgentKeyForm({ onSaved, title }: { onSaved: (key: AgentKey) => void; title?: string }) {
  const [provider, setProvider] = useState<AgentProvider>('anthropic')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const chosen = PROVIDERS.find((p) => p.id === provider)!

  function save(event: FormEvent) {
    event.preventDefault()
    const value = draft.trim()
    if (!value) return
    setBusy(true)
    setError(null)
    api.setAgentKey(provider, value)
      .then((key) => {
        setDraft('')
        onSaved(key)
      })
      .catch((e) => setError(errorMessage(e, 'Could not save the key')))
      .finally(() => setBusy(false))
  }

  return (
    <form className="agent-key-form" onSubmit={save}>
      {title && <strong className="small">{title}</strong>}
      <div className="agent-key-provider" role="radiogroup" aria-label="Key provider">
        {PROVIDERS.map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={p.id === provider} className={p.id === provider ? 'chip active' : 'chip'}
            onClick={() => setProvider(p.id)}>{p.label}</button>
        ))}
      </div>
      <label htmlFor="agent-key">Your {chosen.label} API key</label>
      <input id="agent-key" type="password" autoComplete="off" placeholder={chosen.placeholder} value={draft} onChange={(e) => setDraft(e.target.value)} />
      <p className="muted small">Your agent runs on your own key. It is stored encrypted and never shown again.</p>
      {error && <p className="error small" role="alert">{error}</p>}
      <button type="submit" className="primary" disabled={busy || !draft.trim()}>Save key</button>
    </form>
  )
}

/** The member's saved keys, each removable, and a form to add another provider's or replace one. */
export function AgentKeyManager({ keys, onChanged }: { keys: AgentKey[]; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  function remove(key: AgentKey) {
    setBusy(true)
    setError(null)
    api.removeAgentKey(key.provider)
      .then(onChanged)
      .catch((e) => setError(errorMessage(e, 'Could not remove the key')))
      .finally(() => setBusy(false))
  }
  return (
    <details className="agent-keys">
      <summary className="small">API keys</summary>
      <ul className="agent-key-list" aria-label="Your API keys">
        {keys.filter((k) => k.configured).map((k) => (
          <li key={k.provider}>
            <span className="small"><strong>{k.label}</strong> <span className="muted">{k.hint}</span></span>
            <button type="button" className="link small" disabled={busy} aria-label={`Remove your ${k.label} key`} onClick={() => remove(k)}>Remove</button>
          </li>
        ))}
      </ul>
      {error && <p className="error small" role="alert">{error}</p>}
      <AgentKeyForm onSaved={onChanged} title="Add or replace a key" />
    </details>
  )
}
