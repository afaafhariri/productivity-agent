/** The agent's live status, derived from the transcript (pure, so it is easy to test). */
import { isBusy, type Transcript } from './transcript'

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
