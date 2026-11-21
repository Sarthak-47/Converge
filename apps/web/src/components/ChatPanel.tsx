import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { ChatMessage } from '../realtime/workspaceChannel.ts'
import type { CSSProperties } from 'react'
import { colorFor, inkFor } from '../editor/collabDocument.ts'
import { initials, stickerStyle } from './sticker.ts'

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
      <ol className="chat-messages" ref={list}>
        {messages.length === 0 && <li className="chat-empty small">No messages yet. Say hello.</li>}
        {messages.map((m) => (
          <li key={m.id} className={m.userId === currentUserId ? 'mine' : ''} style={{ '--who': colorFor(m.userId) } as CSSProperties}>
            <div className="chat-meta">
              <strong><span className="avatar avatar-sm" style={{ ...stickerStyle(m.userId), background: colorFor(m.userId), color: inkFor(colorFor(m.userId)) }} aria-hidden="true">{initials(m.displayName)}</span>{m.displayName}</strong>
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
