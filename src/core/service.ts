/**
 * The agent service: conversations, runs, approvals, settings and secrets, for one user.
 *
 * The Electron main process calls it and forwards its events to the window. It has no
 * Electron dependency, so another host could put any transport in front of it.
 */
import type { LanguageModel, ModelMessage } from 'ai'
import { RunCancelledError, runAgent, type AgentEvent } from './agent/loop'
import { GITHUB_TOKEN } from './integrations/github'
import type { JsonValue } from './json'
import { ANTHROPIC_API_KEY, GEMINI_API_KEY, createModel, type LlmConfig } from './llm/config'
import { ModelError } from './llm/errors'
import type {
  Clock,
  Confirmation,
  ConfirmationRequest,
  Decision,
  Logger,
  SecretStore
} from './ports'
import type { ToolEffect, ToolRegistry } from './tools'

export const MAX_TEXT_CHARS = 32_000
export const MAX_ID_CHARS = 128
export const MAX_SECRET_CHARS = 512

export type DoneReason = 'stop' | 'max_steps' | 'cancelled'

/** Everything a run reports, in order. `done` or `error` is always last. */
export type RunEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; toolCallId: string; toolName: string; input: JsonValue }
  | { type: 'tool_result'; toolCallId: string; toolName: string; result: JsonValue }
  | {
      type: 'confirmation_request'
      toolCallId: string
      toolName: string
      description: string
      input: JsonValue
    }
  | { type: 'done'; reason: DoneReason }
  | { type: 'error'; message: string }

export interface RunEventParams {
  runId: string
  event: RunEvent
}

export interface ToolInfo {
  name: string
  description: string
  effect: ToolEffect
}

/** Non-secret view of the configuration. Secrets are only reported as set or not. */
export interface Settings {
  llmProvider: string
  llmModelId: string | null
  geminiApiKeySet: boolean
  anthropicApiKeySet: boolean
  githubTokenSet: boolean
  tools: ToolInfo[]
}

export type SecretName = 'gemini_api_key' | 'anthropic_api_key' | 'github_token'

const SECRET_KEYS: Record<SecretName, string> = {
  gemini_api_key: GEMINI_API_KEY,
  anthropic_api_key: ANTHROPIC_API_KEY,
  github_token: GITHUB_TOKEN
}

const INVALID_SECRET: Record<SecretName, string> = {
  gemini_api_key: "That doesn't look like an API key",
  anthropic_api_key: "That doesn't look like an API key",
  github_token: "That doesn't look like a GitHub token"
}

/** Why a request was refused. Messages are fit to show the user and never contain secrets. */
export class ServiceError extends Error {
  constructor(
    readonly code:
      'invalid_input' | 'conversation_busy' | 'run_not_found' | 'confirmation_not_found',
    message: string
  ) {
    super(message)
  }
}

export interface ServiceDeps {
  config: LlmConfig
  registry: ToolRegistry
  secrets: SecretStore
  clock: Clock
  logger: Logger
  onEvent: (params: RunEventParams) => void
  /** Tests can fix the model; normally it's built from `config` on first use. */
  model?: LanguageModel
  newId?: () => string
}

interface ActiveRun {
  conversationId: string
  controller: AbortController
  confirmation: ChannelConfirmation
}

export class AgentService {
  private readonly conversations = new Map<string, ModelMessage[]>()
  private readonly runs = new Map<string, ActiveRun>()
  private model: LanguageModel | undefined

  constructor(private readonly deps: ServiceDeps) {
    this.model = deps.model
  }

  async settings(): Promise<Settings> {
    const { config, registry, secrets } = this.deps
    return {
      llmProvider: config.provider,
      llmModelId: config.modelId ?? null,
      geminiApiKeySet: Boolean(await secrets.get(GEMINI_API_KEY)),
      anthropicApiKeySet: Boolean(await secrets.get(ANTHROPIC_API_KEY)),
      githubTokenSet: Boolean(await secrets.get(GITHUB_TOKEN)),
      tools: registry
        .specs()
        .map(({ name, description, effect }) => ({ name, description, effect }))
    }
  }

  /** Write-only: the value goes to the secret store and is never returned. */
  async setSecret(name: SecretName, value: string): Promise<void> {
    const trimmed = value.trim()
    const valid =
      trimmed.length > 0 && trimmed.length <= MAX_SECRET_CHARS && /^[\x21-\x7e]+$/.test(trimmed)
    // Never echo the value back: it is (or contains) a secret.
    if (!valid) throw new ServiceError('invalid_input', INVALID_SECRET[name])
    await this.deps.secrets.set(SECRET_KEYS[name], trimmed)
    this.forgetModel()
    this.deps.logger.info('secret stored', { secret: name })
  }

  async deleteSecret(name: SecretName): Promise<void> {
    await this.deps.secrets.delete(SECRET_KEYS[name])
    this.forgetModel()
    this.deps.logger.info('secret deleted', { secret: name })
  }

  /** The next run builds the model again, e.g. with a new API key. */
  private forgetModel(): void {
    if (!this.deps.model) this.model = undefined
  }

  /** Starts a run and returns its id. Events follow through `onEvent`. */
  startRun(conversationId: string, text: string): string {
    if (conversationId.length === 0 || conversationId.length > MAX_ID_CHARS) {
      throw new ServiceError('invalid_input', 'Invalid conversation id')
    }
    if (text.length === 0 || text.length > MAX_TEXT_CHARS) {
      throw new ServiceError('invalid_input', `Messages must be 1 to ${MAX_TEXT_CHARS} characters`)
    }
    for (const run of this.runs.values()) {
      if (run.conversationId === conversationId) {
        throw new ServiceError('conversation_busy', 'A run is already active in this conversation')
      }
    }

    const runId = (this.deps.newId ?? (() => crypto.randomUUID()))()
    const controller = new AbortController()
    const confirmation = new ChannelConfirmation((event) => this.emit(runId, event))
    this.runs.set(runId, { conversationId, controller, confirmation })
    void this.run(runId, conversationId, text, controller.signal, confirmation).then((terminal) => {
      this.runs.delete(runId)
      this.emit(runId, terminal)
    })
    return runId
  }

  cancelRun(runId: string): void {
    const run = this.runs.get(runId)
    if (!run) throw new ServiceError('run_not_found', 'No active run with that id')
    run.controller.abort()
  }

  /** Answers a pending approval. Only an explicit user action should call this. */
  respondConfirmation(runId: string, toolCallId: string, decision: Decision): void {
    const run = this.runs.get(runId)
    if (!run) throw new ServiceError('run_not_found', 'No active run with that id')
    if (!run.confirmation.respond(toolCallId, decision)) {
      throw new ServiceError('confirmation_not_found', 'No pending confirmation for that call')
    }
  }

  /** Stops every run (e.g. when the app quits). Pending approvals are never executed. */
  cancelAll(): void {
    for (const run of this.runs.values()) run.controller.abort()
  }

  private emit(runId: string, event: RunEvent): void {
    this.deps.onEvent({ runId, event })
  }

  private async run(
    runId: string,
    conversationId: string,
    text: string,
    signal: AbortSignal,
    confirmation: Confirmation
  ): Promise<RunEvent> {
    const { config, registry, secrets, clock, logger } = this.deps
    const history = this.conversations.get(conversationId) ?? []
    this.conversations.set(conversationId, history)
    // Work on a copy: only a completed run changes the conversation.
    const working: ModelMessage[] = [...history, { role: 'user', content: text }]
    try {
      this.model ??= await createModel(config, secrets)
      if (signal.aborted) return { type: 'done', reason: 'cancelled' }
      const reason = await runAgent({
        model: this.model,
        modelId: config.modelId ?? 'mock',
        provider: config.provider,
        registry,
        runtime: { confirmation, secrets, clock, logger },
        history: working,
        signal,
        onEvent: (event: AgentEvent) => this.emit(runId, event)
      })
      history.splice(0, history.length, ...working)
      return { type: 'done', reason }
    } catch (error) {
      if (error instanceof RunCancelledError || signal.aborted)
        return { type: 'done', reason: 'cancelled' }
      if (error instanceof ModelError) return { type: 'error', message: error.message }
      logger.error('run failed', {
        runId,
        error: error instanceof Error ? error.message : String(error)
      })
      return { type: 'error', message: 'The run failed. See logs.' }
    }
  }
}

/**
 * The approval port for one run: emits `confirmation_request` and waits for
 * `respondConfirmation`. If the run is stopped, the wait settles as a rejection and the
 * registry never runs the tool.
 */
class ChannelConfirmation implements Confirmation {
  private readonly pending = new Map<string, (decision: Decision) => void>()

  constructor(private readonly emit: (event: RunEvent) => void) {}

  request(request: ConfirmationRequest, signal?: AbortSignal): Promise<Decision> {
    return new Promise((resolve) => {
      const settle = (decision: Decision): void => {
        this.pending.delete(request.toolCallId)
        resolve(decision)
      }
      this.pending.set(request.toolCallId, settle)
      signal?.addEventListener(
        'abort',
        () => settle({ approved: false, reason: 'The run was stopped.' }),
        {
          once: true
        }
      )
      this.emit({ type: 'confirmation_request', ...request })
    })
  }

  respond(toolCallId: string, decision: Decision): boolean {
    const settle = this.pending.get(toolCallId)
    if (!settle) return false
    settle(decision)
    return true
  }
}
