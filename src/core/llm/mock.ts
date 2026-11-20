/**
 * Deterministic models with no network: the default provider in dev and the one tests use.
 * Implements the AI SDK's provider interface directly, so production code never imports
 * test helpers.
 */
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart
} from '@ai-sdk/provider'
import type { JsonValue } from '../json'

/** One model turn: text and/or tool calls. */
export type Turn = Array<{ text: string } | { toolCall: { id: string; name: string; input: JsonValue } }>

export interface MockRequest {
  prompt: LanguageModelV4Prompt
  toolNames: string[]
}

type Respond = (request: MockRequest) => Turn

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 }
}

export class MockModel implements LanguageModelV4 {
  readonly specificationVersion = 'v4' as const
  readonly provider = 'mock'
  readonly modelId = 'demo'
  readonly supportedUrls = {}
  /** Every request this model received, in order. For tests. */
  readonly requests: MockRequest[] = []

  constructor(
    private readonly respond: Respond,
    private readonly delayMs = 0
  ) {}

  /** Plays `turns` in order, one per model call. */
  static scripted(turns: Turn[]): MockModel {
    const remaining = [...turns]
    return new MockModel(() => {
      const turn = remaining.shift()
      if (!turn) throw new Error('MockModel script exhausted')
      return turn
    })
  }

  /** Replies with the last user message, word by word, so streaming is visible. */
  static echo({ delayMs = 30 } = {}): MockModel {
    return new MockModel((request) => words(`(mock) You said: ${lastUserText(request.prompt)}`), delayMs)
  }

  /**
   * Echo, plus keyword-triggered tool calls so the tool and approval flows work offline:
   * mention pull requests, unread email, or sending.
   */
  static demo({ delayMs = 30 } = {}): MockModel {
    let calls = 0
    return new MockModel((request) => {
      const last = request.prompt.at(-1)
      if (last?.role === 'tool') {
        const part = last.content.find((p) => p.type === 'tool-result')
        return words(summarize(part?.toolName ?? 'tool', part?.output))
      }
      const text = lastUserText(request.prompt)
      const pick = pickTool(text, request.toolNames)
      if (!pick) return words(`(mock) You said: ${text}`)
      calls += 1
      return [{ toolCall: { id: `mock-call-${calls}`, name: pick.name, input: pick.input } }]
    }, delayMs)
  }

  async doGenerate(): Promise<never> {
    throw new Error('MockModel only supports streaming')
  }

  async doStream(options: LanguageModelV4CallOptions): Promise<{ stream: ReadableStream<LanguageModelV4StreamPart> }> {
    const request: MockRequest = {
      prompt: options.prompt,
      toolNames: (options.tools ?? []).map((t) => t.name)
    }
    this.requests.push(request)
    const parts = toParts(this.respond(request))
    const delayMs = this.delayMs
    const signal = options.abortSignal
    return {
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        async start(controller) {
          for (const part of parts) {
            if (delayMs > 0) await sleep(delayMs, signal)
            if (signal?.aborted) break
            controller.enqueue(part)
          }
          controller.close()
        }
      })
    }
  }
}

function toParts(turn: Turn): LanguageModelV4StreamPart[] {
  const parts: LanguageModelV4StreamPart[] = [{ type: 'stream-start', warnings: [] }]
  let sawCall = false
  turn.forEach((item, i) => {
    if ('text' in item) {
      const id = `t${i}`
      parts.push({ type: 'text-start', id }, { type: 'text-delta', id, delta: item.text }, { type: 'text-end', id })
    } else {
      sawCall = true
      parts.push({
        type: 'tool-call',
        toolCallId: item.toolCall.id,
        toolName: item.toolCall.name,
        input: JSON.stringify(item.toolCall.input)
      })
    }
  })
  parts.push({
    type: 'finish',
    usage,
    finishReason: { unified: sawCall ? 'tool-calls' : 'stop', raw: undefined }
  })
  return parts
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function lastUserText(prompt: LanguageModelV4Prompt): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const message = prompt[i]
    if (message.role === 'user') {
      return message.content.map((p) => (p.type === 'text' ? p.text : '')).join('')
    }
  }
  return ''
}

function words(text: string): Turn {
  return text.split(' ').map((w, i) => ({ text: i === 0 ? w : ` ${w}` }))
}

function pickTool(text: string, available: string[]): { name: string; input: JsonValue } | undefined {
  const tokens = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const has = (...options: string[]): boolean => tokens.some((t) => options.includes(t))
  const follows = (first: string, ...next: string[]): boolean =>
    tokens.some((t, i) => t === first && next.includes(tokens[i + 1] ?? ''))

  if (available.includes('gmail_send_draft') && (has('send') || follows('email', 'him', 'her', 'them'))) {
    return {
      name: 'gmail_send_draft',
      input: { to: 'teammate@example.com', subject: 'Quick update', body: text }
    }
  }
  if (available.includes('github_list_pull_requests') && (has('pr', 'prs') || follows('pull', 'request', 'requests'))) {
    return { name: 'github_list_pull_requests', input: { filter: 'review_requested' } }
  }
  if (available.includes('gmail_list_unread') && has('unread', 'inbox', 'email', 'emails', 'mail')) {
    return { name: 'gmail_list_unread', input: { limit: 5 } }
  }
  return undefined
}

function summarize(toolName: string, output: unknown): string {
  const value = unwrap(output)
  const status = typeof value === 'object' && value && 'status' in value ? (value as { status: unknown }).status : undefined
  if (status === 'rejected') return '(mock) OK, I did not send it.'
  if (status === 'cancelled') return '(mock) Stopped.'
  let preview = JSON.stringify(value) ?? 'null'
  if (preview.length > 300) preview = `${preview.slice(0, 300)}…`
  return `(mock) ${toolName} returned: ${preview}`
}

/** Tool output reaches the model as `{type: 'json', value: {tool, untrusted_content}}`. */
function unwrap(output: unknown): unknown {
  const value = (output as { value?: unknown } | undefined)?.value ?? output
  if (value && typeof value === 'object' && 'untrusted_content' in value) {
    return (value as { untrusted_content: unknown }).untrusted_content
  }
  return value
}
