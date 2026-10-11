import { Client, type IMessage, type StompSubscription } from '@stomp/stompjs'
import { useEffect, useRef, useState } from 'react'
import type { FileNode } from '../api.ts'

/** Envelope for workspace events (design §7.3). */
export type WorkspaceEvent =
  | Envelope<'FILE_CREATED', { file: FileNode }>
  | Envelope<'FILE_MOVED', { file: FileNode; oldPath: string }>
  | Envelope<'FILE_DELETED', { fileId: string; path: string; kind: FileNode['kind'] }>
  | Envelope<'FILE_SAVED', { fileId: string; version: number; contentHash: string }>

type Envelope<T extends string, P> = {
  type: T
  workspaceId: string
  eventId: string
  actorId: string
  sentAt: string
  payload: P
  protocolVersion: number
}

export type ChatMessage = {
  id: string
  workspaceId: string
  userId: string
  displayName: string
  body: string
  createdAt: string
}

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting'

type Handlers = {
  onEvent: (event: WorkspaceEvent) => void
  onChat: (message: ChatMessage) => void
  onError: (message: string) => void
}

function socketUrl() {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${window.location.host}/ws`
}

/**
 * One STOMP connection per open workspace. The browser sends the session cookie with the handshake, which is
 * same-origin, so no token is needed in the URL. Reconnects automatically and resubscribes.
 */
export function useWorkspaceChannel(workspaceId: string, handlers: Handlers) {
  const [state, setState] = useState<ConnectionState>('connecting')
  const latest = useRef(handlers)
  const client = useRef<Client | null>(null)

  useEffect(() => {
    latest.current = handlers
  })

  useEffect(() => {
    let everConnected = false
    let subscriptions: StompSubscription[] = []
    const parse = <T,>(message: IMessage) => JSON.parse(message.body) as T
    const stomp = new Client({
      brokerURL: socketUrl(),
      reconnectDelay: 2000,
      heartbeatIncoming: 10000,
      heartbeatOutgoing: 10000,
      onConnect: () => {
        everConnected = true
        setState('connected')
        subscriptions = [
          stomp.subscribe(`/topic/workspace/${workspaceId}/events`, (m) => latest.current.onEvent(parse<WorkspaceEvent>(m))),
          stomp.subscribe(`/topic/workspace/${workspaceId}/chat`, (m) => latest.current.onChat(parse<ChatMessage>(m))),
          stomp.subscribe('/user/queue/errors', (m) => latest.current.onError(parse<{ message: string }>(m).message)),
        ]
      },
      onWebSocketClose: () => setState(everConnected ? 'reconnecting' : 'connecting'),
      onStompError: (frame) => latest.current.onError(frame.headers.message ?? 'Realtime error'),
    })
    client.current = stomp
    stomp.activate()
    return () => {
      subscriptions.forEach((s) => s.unsubscribe())
      void stomp.deactivate()
      client.current = null
    }
  }, [workspaceId])

  function sendChat(body: string) {
    client.current?.publish({ destination: `/app/workspace/${workspaceId}/chat`, body: JSON.stringify({ body }) })
  }

  return { state, sendChat }
}
