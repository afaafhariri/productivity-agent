import { Activity } from 'lucide-react'
import type { ActivityEntry, ActivityTone, UsageToday } from '../../../shared/ipc-contract'
import { agentStatus, type AgentStatus } from '../state/activity'
import type { Transcript } from '../state/transcript'
import { groupByDay } from '../state/useActivity'

type Tone = ActivityTone

const TONE_DOT: Record<Tone, string> = {
  neutral: 'bg-muted',
  accent: 'bg-accent',
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger'
}

function describe(status: AgentStatus): { tone: Tone; text: string; tool?: string } {
  switch (status.kind) {
    case 'idle':
      return { tone: 'neutral', text: 'Ready' }
    case 'thinking':
      return { tone: 'accent', text: 'Thinking' }
    case 'replying':
      return { tone: 'accent', text: 'Replying' }
    case 'tool':
      return { tone: 'accent', text: 'Running', tool: status.name }
    case 'awaiting':
      return { tone: 'warn', text: 'Waiting for your approval', tool: status.name }
  }
}

/** Right-hand panel: what the agent is doing now, today's tokens, and the saved activity log. */
export function AgentPanel({
  transcript,
  model,
  usage,
  activity
}: {
  transcript: Transcript
  model: string | null
  usage: UsageToday | null
  activity: ActivityEntry[]
}): React.JSX.Element {
  const status = describe(agentStatus(transcript))
  const days = groupByDay(activity)
  return (
    <aside
      className="hidden w-72 shrink-0 flex-col border-l border-line bg-panel lg:flex"
      aria-label="Agent"
    >
      <div className="border-b border-line px-4 py-4">
        <div className="text-xs font-medium tracking-wide text-muted uppercase">Agent</div>
        <div className="mt-2" role="status" aria-label="Agent status">
          <div className="flex items-center gap-2 text-sm">
            <span
              className={`size-2 shrink-0 rounded-full ${TONE_DOT[status.tone]} ${status.tone === 'neutral' ? '' : 'animate-pulse'}`}
            />
            {status.text}
          </div>
          {status.tool && (
            <div className="mt-0.5 truncate pl-4 font-mono text-xs text-muted">{status.tool}</div>
          )}
        </div>
        {model && <div className="mt-1 truncate font-mono text-xs text-muted">{model}</div>}
        {usage && <UsageMeter usage={usage} />}
      </div>
      <div className="flex items-center gap-2 px-4 pt-4 pb-1 text-xs font-medium tracking-wide text-muted uppercase">
        <Activity className="size-3.5" aria-hidden />
        Activity
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4" aria-label="Activity">
        {days.length === 0 && <p className="pt-1 text-xs text-muted">Nothing yet.</p>}
        {days.map(({ day, entries }) => (
          <section key={day} aria-label={day}>
            <h3 className="sticky top-0 bg-panel pt-3 pb-1 text-xs font-medium text-muted">
              {day}
            </h3>
            <ol>
              {entries.map((entry) => (
                <li key={entry.id} className="flex gap-2.5 py-1.5 text-sm">
                  <span
                    className={`mt-[7px] size-1.5 shrink-0 rounded-full ${TONE_DOT[entry.tone]}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span>{entry.label}</span>
                      <time dateTime={entry.at} className="shrink-0 text-xs text-muted">
                        {new Date(entry.at).toLocaleTimeString(undefined, {
                          hour: '2-digit',
                          minute: '2-digit'
                        })}
                      </time>
                    </div>
                    {entry.detail && (
                      <div className="truncate text-xs text-muted" title={entry.detail}>
                        {entry.detail}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </aside>
  )
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })

/** Today's tokens against the daily limit, as text and a thin bar. */
function UsageMeter({ usage }: { usage: UsageToday }): React.JSX.Element {
  const { tokensToday, limit } = usage
  const share = limit ? Math.min(1, tokensToday / limit) : 0
  const tone = share >= 1 ? 'bg-danger' : share >= 0.8 ? 'bg-warn' : 'bg-accent'
  return (
    <div className="mt-3" aria-label="Tokens used today">
      <div className="flex justify-between text-xs text-muted">
        <span>Tokens today</span>
        <span className="font-mono">
          {compact.format(tokensToday)}
          {limit ? ` / ${compact.format(limit)}` : ' (no limit)'}
        </span>
      </div>
      {limit !== null && (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-card">
          <div className={`h-full ${tone}`} style={{ width: `${share * 100}%` }} />
        </div>
      )}
    </div>
  )
}
