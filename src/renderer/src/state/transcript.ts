/** Chat state as a pure reducer, so it can be tested without React or Electron. */
import type { JsonValue as Json } from '../../../core/json'
import type { ApprovalScope, DoneReason, RunEventParams } from '../../../shared/ipc-contract'

export type ToolStatus =
  | { kind: 'running' }
  | {
      kind: 'awaiting'
      description: string
      /** What the user may grant; only `once` after the task read untrusted content. */
      scopes: ApprovalScope[]
      untrustedSources: string[]
    }
  /** The user answered; the agent is now running (or skipping) the tool. */
  | { kind: 'answered'; approved: boolean; scope?: ApprovalScope }
  /** `approved` is set when the user answered an approval card for this call. */
  | { kind: 'finished'; result: Json; approved?: boolean }

export interface ToolView {
  id: string
  name: string
  input: Json
  status: ToolStatus
  /** Ran without asking because of an earlier "this task" or "always" grant. */
  autoApproved?: 'task' | 'always'
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  tools: ToolView[]
  error?: string
  ended?: DoneReason
}

export type RunSlot =
  | { kind: 'idle' }
  /** run.start was sent; its response and first events may arrive in either order. */
  | { kind: 'starting' }
  | { kind: 'running'; runId: string }

export interface Transcript {
  messages: ChatMessage[]
  run: RunSlot
}

export type Action =
  | { type: 'begin'; text: string; id: string }
  | { type: 'started'; runId: string }
  | { type: 'failed_to_start'; message: string }
  | { type: 'event'; params: RunEventParams }
  | { type: 'answered'; toolCallId: string; approved: boolean; scope?: ApprovalScope }
  | { type: 'answer_failed'; message: string }

export const initialTranscript: Transcript = { messages: [], run: { kind: 'idle' } }

export const isBusy = (t: Transcript): boolean => t.run.kind !== 'idle'

export const activeRunId = (t: Transcript): string | undefined =>
  t.run.kind === 'running' ? t.run.runId : undefined

/** Whether `text` may be sent now (non-empty and nothing running). */
export const canSend = (t: Transcript, text: string): boolean =>
  text.trim().length > 0 && !isBusy(t)

export function transcriptReducer(state: Transcript, action: Action): Transcript {
  switch (action.type) {
    case 'begin': {
      if (!canSend(state, action.text)) return state
      return {
        run: { kind: 'starting' },
        messages: [
          ...state.messages,
          { id: `${action.id}-u`, role: 'user', text: action.text.trim(), tools: [] },
          { id: `${action.id}-a`, role: 'assistant', text: '', tools: [] }
        ]
      }
    }
    case 'started':
      return state.run.kind === 'starting'
        ? { ...state, run: { kind: 'running', runId: action.runId } }
        : state
    case 'failed_to_start':
      return state.run.kind === 'starting' ? fail(state, action.message) : state
    case 'answer_failed':
      return updateReply(state, (reply) => ({ ...reply, error: action.message }))
    case 'answered':
      return updateReply(state, (reply) => ({
        ...reply,
        tools: reply.tools.map((tool) =>
          tool.id === action.toolCallId && tool.status.kind === 'awaiting'
            ? {
                ...tool,
                status: { kind: 'answered', approved: action.approved, scope: action.scope }
              }
            : tool
        )
      }))
    case 'event':
      return applyEvent(state, action.params)
  }
}

/** True if `toolCallId` is waiting for an answer (so a second click is ignored). */
export function isAwaiting(state: Transcript, toolCallId: string): boolean {
  const reply = state.messages.at(-1)
  return reply?.tools.some((t) => t.id === toolCallId && t.status.kind === 'awaiting') ?? false
}

function applyEvent(state: Transcript, { runId, event }: RunEventParams): Transcript {
  let run = state.run
  if (run.kind === 'starting') run = { kind: 'running', runId }
  else if (run.kind !== 'running' || run.runId !== runId) return state // Another run's event.

  const next = updateReply({ ...state, run }, (reply) => {
    switch (event.type) {
      case 'text_delta':
        return { ...reply, text: reply.text + event.text }
      case 'tool_call':
        return {
          ...reply,
          tools: [
            ...reply.tools,
            {
              id: event.toolCallId,
              name: event.toolName,
              input: event.input,
              status: { kind: 'running' }
            }
          ]
        }
      case 'confirmation_request':
        return {
          ...reply,
          tools: withTool(reply.tools, event.toolCallId, event.toolName, event.input, {
            kind: 'awaiting',
            description: event.description,
            scopes: event.scopes,
            untrustedSources: event.untrustedSources
          })
        }
      case 'tool_result':
        return {
          ...reply,
          tools: withTool(reply.tools, event.toolCallId, event.toolName, null, {
            kind: 'finished',
            result: event.result,
            approved: answeredWith(reply.tools, event.toolCallId)
          })
        }
      case 'auto_approved':
        return {
          ...reply,
          tools: reply.tools.map((tool) =>
            tool.id === event.toolCallId ? { ...tool, autoApproved: event.scope } : tool
          )
        }
      case 'done':
        return { ...reply, ended: event.reason }
      case 'error':
        return { ...reply, error: event.message }
    }
  })
  return event.type === 'done' || event.type === 'error' ? { ...next, run: { kind: 'idle' } } : next
}

function answeredWith(tools: ToolView[], id: string): boolean | undefined {
  const status = tools.find((t) => t.id === id)?.status
  return status?.kind === 'answered' ? status.approved : undefined
}

/** Updates the tool with `id`, adding it if the call event hasn't been seen. */
function withTool(
  tools: ToolView[],
  id: string,
  name: string,
  input: Json,
  status: ToolStatus
): ToolView[] {
  if (!tools.some((t) => t.id === id)) return [...tools, { id, name, input, status }]
  return tools.map((t) => (t.id === id ? { ...t, status } : t))
}

function updateReply(state: Transcript, update: (reply: ChatMessage) => ChatMessage): Transcript {
  const last = state.messages.at(-1)
  if (!last || last.role !== 'assistant') return state
  return { ...state, messages: [...state.messages.slice(0, -1), update(last)] }
}

function fail(state: Transcript, message: string): Transcript {
  return { ...updateReply(state, (reply) => ({ ...reply, error: message })), run: { kind: 'idle' } }
}
