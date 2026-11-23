import { ArrowUp, CircleDot, EyeOff, GitPullRequest, Mail, RotateCcw, Square } from 'lucide-react'
import { useEffect, useRef, useLayoutEffect, useState } from 'react'
import type { Decision } from '../../../shared/ipc-contract'
import type { Chat as ChatState } from '../state/useChat'
import { isBusy, type ChatMessage } from '../state/transcript'
import { Markdown } from './Markdown'
import { ApprovalCard, ToolCard } from './ToolCards'

const SUGGESTIONS = [
  { text: 'What PRs need my review?', icon: GitPullRequest },
  { text: 'Which issues are assigned to me?', icon: CircleDot },
  { text: 'Anything unread in my inbox?', icon: Mail }
]

export function Chat({
  chat,
  disabled
}: {
  chat: ChatState
  disabled: boolean
}): React.JSX.Element {
  const { transcript } = chat
  const busy = isBusy(transcript)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const onScroll = (): void => {
    const el = scrollRef.current
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }
  const send = (text: string): boolean => {
    atBottomRef.current = true
    return chat.send(text)
  }

  const last = transcript.messages.at(-1)
  const prev = transcript.messages.at(-2)
  const retryText =
    !busy &&
    !disabled &&
    last?.role === 'assistant' &&
    prev?.role === 'user' &&
    (Boolean(last.error) || last.ended === 'cancelled' || last.ended === 'token_limit')
      ? prev.text
      : null

  useEffect(() => {
    if (atBottomRef.current) bottomRef.current?.scrollIntoView?.({ block: 'end' })
  }, [transcript])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        {transcript.messages.length === 0 ? (
          <EmptyState onPick={(text) => send(text)} disabled={disabled} />
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8">
            {transcript.messages.map((message, i) => (
              <Message
                key={message.id}
                message={message}
                live={busy && i === transcript.messages.length - 1}
                onAnswer={chat.answer}
                onRetry={
                  retryText !== null && i === transcript.messages.length - 1
                    ? () => send(retryText)
                    : undefined
                }
              />
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>
      <Composer busy={busy} disabled={disabled} onSend={send} onStop={chat.stop} />
    </div>
  )
}

function EmptyState({
  onPick,
  disabled
}: {
  onPick: (text: string) => void
  disabled: boolean
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 px-6 text-center">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">How can I help?</h1>
        <p className="mt-2 text-sm text-muted">
          Ask about your pull requests, issues or mail. Anything that sends or changes something
          waits for your approval.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {SUGGESTIONS.map(({ text, icon: Icon }) => (
          <button
            key={text}
            type="button"
            className="chip"
            disabled={disabled}
            onClick={() => onPick(text)}
          >
            <Icon className="size-4 text-muted" aria-hidden />
            {text}
          </button>
        ))}
      </div>
    </div>
  )
}

function Message({
  message,
  live,
  onAnswer,
  onRetry
}: {
  message: ChatMessage
  live: boolean
  onAnswer: (toolCallId: string, decision: Decision) => void
  onRetry?: () => void
}): React.JSX.Element {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 whitespace-pre-wrap text-white">
          {message.text}
        </div>
      </div>
    )
  }
  const thinking = live && !message.text && message.tools.every((t) => t.status.kind === 'finished')
  return (
    <div className="flex flex-col gap-3" data-testid="assistant-message">
      {message.hidden?.map((hidden) => (
        <p key={hidden.id} className="flex items-center gap-1.5 text-xs text-muted">
          <EyeOff className="size-3.5 shrink-0" aria-hidden />
          Hidden from the model: {hidden.labels.join(', ')}{' '}
          {hidden.source === 'message' ? (
            'in your message'
          ) : (
            <>
              in <span className="font-mono">{hidden.toolName}</span>&apos;s result
            </>
          )}
        </p>
      ))}
      {message.tools.map((tool) =>
        tool.status.kind === 'awaiting' ? (
          <ApprovalCard
            key={tool.id}
            tool={tool}
            description={tool.status.description}
            scopes={tool.status.scopes}
            untrustedSources={tool.status.untrustedSources}
            onAnswer={(decision) => onAnswer(tool.id, decision)}
          />
        ) : (
          <ToolCard key={tool.id} tool={tool} />
        )
      )}
      {message.text && <Markdown text={message.text} />}
      {thinking && (
        <div className="flex items-center gap-1 text-muted" aria-label="Thinking">
          <span className="dot" />
          <span className="dot [animation-delay:150ms]" />
          <span className="dot [animation-delay:300ms]" />
        </div>
      )}
      {message.ended === 'cancelled' && <p className="text-xs text-muted">Stopped.</p>}
      {message.ended === 'token_limit' && (
        <p className="text-xs text-warn">
          Stopped at today&apos;s token limit. Raise it in Settings to continue.
        </p>
      )}
      {message.ended === 'max_steps' && (
        <p className="text-xs text-muted">Stopped after the step limit.</p>
      )}
      {message.error && <p className="text-sm text-danger">{message.error}</p>}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="flex w-fit items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-muted transition-colors hover:bg-hover hover:text-ink"
        >
          <RotateCcw className="size-3.5" aria-hidden />
          Try again
        </button>
      )}
    </div>
  )
}

function Composer({
  busy,
  disabled,
  onSend,
  onStop
}: {
  busy: boolean
  disabled: boolean
  onSend: (text: string) => boolean
  onStop: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft])
  const submit = (): void => {
    if (onSend(draft)) setDraft('')
  }
  return (
    <div className="px-6 pb-5">
      <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-line bg-card px-3 py-2 focus-within:border-accent/60">
        <textarea
          aria-label="Message"
          ref={inputRef}
          rows={1}
          value={draft}
          disabled={disabled}
          placeholder={busy ? 'Working…' : 'Ask about your PRs, issues, mail…'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          className="max-h-48 min-h-9 flex-1 resize-none overflow-y-auto bg-transparent px-1 py-1.5 text-[15px] outline-none placeholder:text-muted"
        />
        {busy ? (
          <button
            type="button"
            aria-label="Stop"
            className="icon-btn bg-ink text-page"
            onClick={onStop}
          >
            <Square className="size-3.5 fill-current" aria-hidden />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Send"
            className="icon-btn bg-accent text-white disabled:opacity-40"
            disabled={disabled || !draft.trim()}
            onClick={submit}
          >
            <ArrowUp className="size-4" aria-hidden />
          </button>
        )}
      </div>
      <p className="mt-2 text-center text-xs text-muted">
        Enter to send · Shift+Enter for a new line
      </p>
    </div>
  )
}
