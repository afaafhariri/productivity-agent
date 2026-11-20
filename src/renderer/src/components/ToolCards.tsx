import { Check, ChevronRight, LoaderCircle, ShieldAlert, X } from 'lucide-react'
import type { ToolView } from '../state/transcript'

/** Longest tool result shown in a card; the full result goes to the model, not the UI. */
const PREVIEW_CHARS = 600

const pretty = (value: unknown): string => JSON.stringify(value, null, 2) ?? 'null'

function preview(value: unknown): string {
  const text = pretty(value)
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text
}

/** The registry's result for a write the user rejected. */
const isRejection = (result: unknown): boolean =>
  typeof result === 'object' &&
  result !== null &&
  (result as { status?: unknown }).status === 'rejected'

function Code({ children }: { children: string }): React.JSX.Element {
  return (
    <pre className="max-h-64 overflow-auto rounded-lg bg-page px-3 py-2 font-mono text-xs leading-relaxed text-ink/90">
      {children}
    </pre>
  )
}

export function ToolCard({ tool }: { tool: ToolView }): React.JSX.Element {
  const { status } = tool
  const rejected =
    (status.kind === 'answered' && !status.approved) ||
    (status.kind === 'finished' && isRejection(status.result))
  const pending = status.kind === 'running' || (status.kind === 'answered' && status.approved)
  const label = rejected
    ? 'Rejected'
    : status.kind === 'running'
      ? 'Running'
      : status.kind === 'answered'
        ? 'Approved, running'
        : 'Done'
  const icon = pending ? (
    <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
  ) : rejected ? (
    <X className="size-3.5" aria-hidden />
  ) : (
    <Check className="size-3.5 text-ok" aria-hidden />
  )
  return (
    <details
      className="group rounded-xl border border-line bg-panel text-sm"
      data-testid={`tool-${tool.id}`}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-muted">
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
        <span className="font-mono text-xs text-ink">{tool.name}</span>
        <span className="ml-auto flex items-center gap-1.5 text-xs">
          {icon}
          {label}
        </span>
      </summary>
      <div className="space-y-2 border-t border-line px-3 py-2">
        <div className="text-xs text-muted">Input</div>
        <Code>{pretty(tool.input)}</Code>
        {status.kind === 'finished' && (
          <>
            <div className="text-xs text-muted">Result</div>
            <Code>{preview(status.result)}</Code>
          </>
        )}
      </div>
    </details>
  )
}

/** A write tool waiting for the user. Approve is never focused by default. */
export function ApprovalCard({
  tool,
  description,
  onAnswer
}: {
  tool: ToolView
  description: string
  onAnswer: (approved: boolean) => void
}): React.JSX.Element {
  return (
    <div
      className="space-y-3 rounded-xl border border-warn/50 bg-panel p-4"
      role="group"
      aria-label={`Approve ${tool.name}?`}
    >
      <div className="flex items-center gap-2 font-medium">
        <ShieldAlert className="size-4 text-warn" aria-hidden />
        <span>
          Approve <span className="font-mono text-sm">{tool.name}</span>?
        </span>
      </div>
      <p className="text-sm text-muted">{description}</p>
      <p className="text-sm">It will run with exactly these arguments:</p>
      <Code>{pretty(tool.input)}</Code>
      <div className="flex gap-2">
        <button type="button" className="btn-secondary" onClick={() => onAnswer(false)}>
          Reject
        </button>
        <button type="button" className="btn-primary" onClick={() => onAnswer(true)}>
          Approve
        </button>
      </div>
    </div>
  )
}
