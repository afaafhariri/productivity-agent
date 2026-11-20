/** What the agent panel shows, derived from the transcript (pure, so it is easy to test). */
import { isBusy, type ToolView, type Transcript } from './transcript'

export type AgentStatus =
  | { kind: 'idle' }
  | { kind: 'thinking' }
  | { kind: 'replying' }
  | { kind: 'tool'; name: string }
  | { kind: 'awaiting'; name: string }

export function agentStatus(t: Transcript): AgentStatus {
  if (!isBusy(t)) return { kind: 'idle' }
  const reply = t.messages.at(-1)
  const awaiting = reply?.tools.find((tool) => tool.status.kind === 'awaiting')
  if (awaiting) return { kind: 'awaiting', name: awaiting.name }
  const running = reply?.tools.find(
    (tool) =>
      tool.status.kind === 'running' || (tool.status.kind === 'answered' && tool.status.approved)
  )
  if (running) return { kind: 'tool', name: running.name }
  return reply?.text ? { kind: 'replying' } : { kind: 'thinking' }
}

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger'

export interface ActivityEntry {
  id: string
  tone: Tone
  label: string
  detail?: string
}

const DETAIL_CHARS = 80
const clip = (text: string): string =>
  text.length > DETAIL_CHARS ? `${text.slice(0, DETAIL_CHARS)}…` : text

const isRejection = (result: unknown): boolean =>
  typeof result === 'object' &&
  result !== null &&
  (result as { status?: unknown }).status === 'rejected'

function toolEntry(tool: ToolView): ActivityEntry {
  const { status } = tool
  const entry = (tone: Tone, label: string): ActivityEntry => ({
    id: tool.id,
    tone,
    label,
    detail: tool.name
  })
  if (tool.autoApproved && status.kind !== 'finished') {
    return entry('accent', 'Running without asking')
  }
  if (tool.autoApproved && status.kind === 'finished') {
    return entry(
      'ok',
      tool.autoApproved === 'always' ? 'Ran (always allowed)' : 'Ran (allowed for this task)'
    )
  }
  switch (status.kind) {
    case 'running':
      return entry('accent', 'Running')
    case 'awaiting':
      return entry('warn', 'Waiting for your approval')
    case 'answered':
      return status.approved ? entry('accent', 'Approved') : entry('neutral', 'Rejected')
    case 'finished':
      if (status.approved === false || isRejection(status.result))
        return entry('neutral', 'Rejected')
      return status.approved ? entry('ok', 'Approved and ran') : entry('ok', 'Used')
  }
}

/** This session's activity, oldest first. */
export function activityLog(t: Transcript): ActivityEntry[] {
  const log: ActivityEntry[] = []
  for (const message of t.messages) {
    if (message.role === 'user') {
      log.push({ id: message.id, tone: 'neutral', label: 'You asked', detail: clip(message.text) })
      continue
    }
    log.push(...message.tools.map(toolEntry))
    message.hidden?.forEach((hidden, i) =>
      log.push({
        id: `${message.id}-hidden-${i}`,
        tone: 'neutral',
        label: 'Hid a secret from the model',
        detail: `${hidden.labels.join(', ')} in ${hidden.source === 'message' ? 'your message' : hidden.toolName}`
      })
    )
    const id = `${message.id}-end`
    if (message.error)
      log.push({ id, tone: 'danger', label: 'Failed', detail: clip(message.error) })
    else if (message.ended === 'stop') log.push({ id, tone: 'ok', label: 'Replied' })
    else if (message.ended === 'cancelled') log.push({ id, tone: 'neutral', label: 'Stopped' })
    else if (message.ended === 'max_steps')
      log.push({ id, tone: 'warn', label: 'Stopped at the step limit' })
  }
  return log
}
