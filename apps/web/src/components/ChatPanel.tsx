import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { ChatMessage } from '../realtime/workspaceChannel.ts'

type Props = {
  messages: ChatMessage[]
  currentUserId: string | undefined
  canPost: boolean
  connected: boolean
  onSend: (body: string) => void
}

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

export function ChatPanel({ messages, currentUserId, canPost, connected, onSend }: Props) {
  const [draft, setDraft] = useState('')
  const list = useRef<HTMLOListElement>(null)

  useEffect(() => {
    list.current?.lastElementChild?.scrollIntoView({ block: 'end' })
  }, [messages])

  function submit(event: FormEvent) {
    event.preventDefault()
    const body = draft.trim()
    if (!body) return
    onSend(body)
    setDraft('')
  }

  return (
    <aside className="chat" aria-label="Chat">
      <div className="tree-header">
        <span>Chat</span>
      </div>
      <ol className="chat-messages" ref={list}>
        {messages.length === 0 && <li className="muted small">No messages yet.</li>}
        {messages.map((m) => (
          <li key={m.id} className={m.userId === currentUserId ? 'mine' : ''}>
            <div className="chat-meta">
              <strong>{m.displayName}</strong>
              <time className="muted small" dateTime={m.createdAt}>{time.format(new Date(m.createdAt))}</time>
            </div>
            <p>{m.body}</p>
          </li>
        ))}
      </ol>
      {canPost && (
        <form className="chat-form" onSubmit={submit}>
          <input
            placeholder={connected ? 'Message the workspace' : 'Reconnecting…'}
            maxLength={4000}
            value={draft}
            disabled={!connected}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="Message"
          />
        </form>
      )}
    </aside>
  )
}
