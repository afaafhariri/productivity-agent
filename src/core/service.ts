/**
 * The agent service: conversations, runs, approvals, settings and secrets, for one user.
 *
 * The Electron main process calls it and forwards its events to the window. It has no
 * Electron dependency, so another host could put any transport in front of it.
 */
import type { LanguageModel, ModelMessage } from 'ai'
import {
  MemoryActivityStore,
  clipDetail,
  type ActivityEntry,
  type ActivityStore,
  type ActivityTone
} from './activity'
import { RunCancelledError, runAgent, type AgentEvent } from './agent/loop'
import { GITHUB_TOKEN } from './integrations/github'
import type { JsonValue } from './json'
import { ANTHROPIC_API_KEY, GEMINI_API_KEY, createModel, type LlmConfig } from './llm/config'
import { ModelError } from './llm/errors'
import { Redactor } from './safety/redact'
import {
  MAX_DAILY_TOKEN_LIMIT,
  MIN_DAILY_TOKEN_LIMIT,
  UsageMeter,
  type UsageToday
} from './safety/usage'
import {
  MemoryPreferenceStore,
  type ApprovalScope,
  type Clock,
  type Confirmation,
  type ConfirmationRequest,
  type Decision,
  type Logger,
  type PreferenceStore,
  type SecretStore
} from './ports'
import { ApprovalPolicy, TaskSafety, type ToolEffect, type ToolRegistry } from './tools'

export type { ApprovalScope, Decision } from './ports'

export const MAX_TEXT_CHARS = 32_000
export const MAX_ID_CHARS = 128
export const MAX_SECRET_CHARS = 512

export type DoneReason = 'stop' | 'max_steps' | 'token_limit' | 'cancelled'

export type { UsageToday } from './safety/usage'
export type { ActivityEntry, ActivityTone } from './activity'

/** Most entries `activity()` returns. */
export const MAX_ACTIVITY_ENTRIES = 500

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
      /** The scopes the user may grant; only `once` after an untrusted read. */
      scopes: ApprovalScope[]
      untrustedSources: string[]
    }
  /** Today's token count after a model step. */
  | ({ type: 'usage' } & UsageToday)
  /** Secrets were replaced with labels before the model saw your message or a tool result. */
  | { type: 'redacted'; source: 'message' | 'tool'; toolName?: string; hidden: string[] }
  /** A write ran without asking because of an earlier "this task" or "always" grant. */
  | { type: 'auto_approved'; toolCallId: string; toolName: string; scope: 'task' | 'always' }
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
  /** The user chose "Always allow" for this write tool. */
  alwaysAllowed: boolean
  /** Hosts the tool may reach; empty means no network access. */
  networkHosts: string[]
}

/** Non-secret view of the configuration. Secrets are only reported as set or not. */
export interface Settings {
  llmProvider: string
  llmModelId: string | null
  geminiApiKeySet: boolean
  anthropicApiKeySet: boolean
  githubTokenSet: boolean
  tools: ToolInfo[]
  /** Tokens used today and the daily limit. */
  usage: UsageToday
}

export type SecretName = 'gemini_api_key' | 'anthropic_api_key' | 'github_token'

const SECRET_KEYS: Record<SecretName, string> = {
  gemini_api_key: GEMINI_API_KEY,
  anthropic_api_key: ANTHROPIC_API_KEY,
  github_token: GITHUB_TOKEN
}

/** How each saved secret is named when it's hidden from the model. */
const SECRET_LABELS: Record<SecretName, string> = {
  gemini_api_key: 'Gemini API key',
  anthropic_api_key: 'Claude API key',
  github_token: 'GitHub token'
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
  /** Where "Always allow" choices are kept. In memory (forgotten on quit) if not given. */
  preferences?: PreferenceStore
  /** Where the activity log is kept. In memory if not given. */
  activity?: ActivityStore
  /** Told about each new activity entry, e.g. to update the window. */
  onActivity?: (entry: ActivityEntry) => void
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
  private readonly approvals: ApprovalPolicy
  private readonly usage: UsageMeter
  private readonly activityStore: ActivityStore

  constructor(private readonly deps: ServiceDeps) {
    this.model = deps.model
    const preferences = deps.preferences ?? new MemoryPreferenceStore()
    this.approvals = new ApprovalPolicy(preferences)
    this.usage = new UsageMeter(preferences, deps.clock)
    this.activityStore = deps.activity ?? new MemoryActivityStore()
  }

  /** The activity log, newest first. */
  activity(limit = MAX_ACTIVITY_ENTRIES): Promise<ActivityEntry[]> {
    return this.activityStore.recent(Math.min(Math.max(1, limit), MAX_ACTIVITY_ENTRIES))
  }

  /** Adds an entry. Failures are logged; they never break the action being recorded. */
  private record(tone: ActivityTone, label: string, detail?: string): void {
    const entry: ActivityEntry = {
      id: crypto.randomUUID(),
      at: this.deps.clock.now().toISOString(),
      tone,
      label,
      ...(detail ? { detail: clipDetail(detail) } : {})
    }
    this.activityStore.append(entry).then(
      () => this.deps.onActivity?.(entry),
      (error: unknown) =>
        this.deps.logger.warn('activity not saved', {
          error: error instanceof Error ? error.message : String(error)
        })
    )
  }

  /** The log entry for a run event, if it is worth keeping. */
  private recordEvent(event: RunEvent): void {
    switch (event.type) {
      case 'tool_result': {
        const result = event.result
        const rejected =
          typeof result === 'object' &&
          result !== null &&
          !Array.isArray(result) &&
          result['status'] === 'rejected'
        if (rejected) this.record('neutral', 'Rejected', event.toolName)
        else this.record('ok', 'Used a tool', event.toolName)
        break
      }
      case 'auto_approved':
        this.record(
          'accent',
          event.scope === 'always'
            ? 'Ran without asking (always allowed)'
            : 'Ran without asking (allowed for this task)',
          event.toolName
        )
        break
      case 'redacted':
        this.record(
          'neutral',
          'Hid a secret from the model',
          `${event.hidden.join(', ')} in ${event.source === 'message' ? 'your message' : (event.toolName ?? 'a tool result')}`
        )
        break
      case 'done':
        if (event.reason === 'stop') this.record('ok', 'Replied')
        else if (event.reason === 'cancelled') this.record('neutral', 'Stopped')
        else if (event.reason === 'max_steps') this.record('warn', 'Stopped at the step limit')
        else this.record('warn', "Stopped at today's token limit")
        break
      case 'error':
        this.record('danger', 'Failed', event.message)
        break
      default:
        break
    }
  }

  async settings(): Promise<Settings> {
    const { config, registry, secrets } = this.deps
    const always = await this.approvals.alwaysAllowed()
    return {
      llmProvider: config.provider,
      llmModelId: config.modelId ?? null,
      geminiApiKeySet: Boolean(await secrets.get(GEMINI_API_KEY)),
      anthropicApiKeySet: Boolean(await secrets.get(ANTHROPIC_API_KEY)),
      githubTokenSet: Boolean(await secrets.get(GITHUB_TOKEN)),
      tools: registry.specs().map(({ name, description, effect, networkHosts }) => ({
        name,
        description,
        effect,
        alwaysAllowed: effect === 'write' && always.includes(name),
        networkHosts: [...networkHosts]
      })),
      usage: await this.usage.today()
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
    this.record('neutral', `Saved the ${SECRET_LABELS[name]}`)
  }

  async deleteSecret(name: SecretName): Promise<void> {
    await this.deps.secrets.delete(SECRET_KEYS[name])
    this.forgetModel()
    this.deps.logger.info('secret deleted', { secret: name })
    this.record('neutral', `Removed the ${SECRET_LABELS[name]}`)
  }

  /** Sets the daily token limit; `null` turns it off. */
  async setDailyTokenLimit(limit: number | null): Promise<void> {
    if (
      limit !== null &&
      (!Number.isInteger(limit) || limit < MIN_DAILY_TOKEN_LIMIT || limit > MAX_DAILY_TOKEN_LIMIT)
    ) {
      throw new ServiceError(
        'invalid_input',
        `The daily limit must be a whole number from ${MIN_DAILY_TOKEN_LIMIT.toLocaleString('en')} to ${MAX_DAILY_TOKEN_LIMIT.toLocaleString('en')} tokens`
      )
    }
    await this.usage.setLimit(limit)
    this.deps.logger.info('daily token limit changed', { limit })
    this.record(
      'neutral',
      'Changed the daily token limit',
      limit === null ? 'No limit' : `${limit.toLocaleString('en')} tokens`
    )
  }

  /** Undoes an "Always allow": the tool asks for approval again. */
  async revokeAlways(toolName: string): Promise<void> {
    if (this.deps.registry.get(toolName)?.effect !== 'write') {
      throw new ServiceError('invalid_input', 'No write tool with that name')
    }
    await this.approvals.revoke(toolName)
    this.deps.logger.info('always-allow revoked', { tool: toolName })
    this.record('neutral', 'Revoked "Always allow"', toolName)
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
    const toolName = run.confirmation.respond(toolCallId, decision)
    if (!toolName) {
      throw new ServiceError('confirmation_not_found', 'No pending confirmation for that call')
    }
    if (decision.approved) {
      const scope = decision.scope ?? 'once'
      const how = { once: 'once', task: 'for this task', always: 'always' }[scope]
      this.record('accent', `Approved ${how}`, toolName)
    }
  }

  /** Stops every run (e.g. when the app quits). Pending approvals are never executed. */
  cancelAll(): void {
    for (const run of this.runs.values()) run.controller.abort()
  }

  private emit(runId: string, event: RunEvent): void {
    this.deps.onEvent({ runId, event })
    this.recordEvent(event)
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
    const emit = (event: RunEvent): void => this.emit(runId, event)
    try {
      // Built per run, so a key saved a moment ago is hidden too.
      const redactor = await Redactor.fromStore(
        secrets,
        (Object.keys(SECRET_KEYS) as SecretName[]).map((name) => ({
          label: SECRET_LABELS[name],
          key: SECRET_KEYS[name]
        }))
      )
      const message = redactor.text(text)
      this.record('neutral', 'You asked', message.text)
      if (message.hidden.length > 0) {
        emit({ type: 'redacted', source: 'message', hidden: message.hidden })
      }
      // Work on a copy: only a completed run changes the conversation.
      const working: ModelMessage[] = [...history, { role: 'user', content: message.text }]
      const remaining = await this.usage.remaining()
      if (remaining === 0) {
        const { tokensToday, limit } = await this.usage.today()
        return {
          type: 'error',
          message: `You've reached today's token limit (${tokensToday.toLocaleString('en')} of ${(limit ?? 0).toLocaleString('en')}). Raise it in Settings, or try again tomorrow.`
        }
      }
      this.model ??= await createModel(config, secrets)
      if (signal.aborted) return { type: 'done', reason: 'cancelled' }
      const reason = await runAgent({
        model: this.model,
        modelId: config.modelId ?? 'mock',
        provider: config.provider,
        registry,
        // A task is one run: its grants and untrusted reads end with it.
        runtime: {
          confirmation,
          secrets,
          clock,
          logger,
          approvals: this.approvals,
          task: new TaskSafety(),
          redact: (toolName, result) => {
            const redacted = redactor.json(result)
            if (redacted.hidden.length > 0) {
              emit({ type: 'redacted', source: 'tool', toolName, hidden: redacted.hidden })
            }
            return redacted.value
          }
        },
        history: working,
        signal,
        tokenBudget: remaining ?? undefined,
        onUsage: async (tokens) => emit({ type: 'usage', ...(await this.usage.add(tokens)) }),
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
  private readonly pending = new Map<
    string,
    { toolName: string; settle: (decision: Decision) => void }
  >()

  constructor(private readonly emit: (event: RunEvent) => void) {}

  request(request: ConfirmationRequest, signal?: AbortSignal): Promise<Decision> {
    return new Promise((resolve) => {
      const settle = (decision: Decision): void => {
        this.pending.delete(request.toolCallId)
        resolve(decision)
      }
      this.pending.set(request.toolCallId, { toolName: request.toolName, settle })
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

  notifyAutoApproved(toolCallId: string, toolName: string, scope: 'task' | 'always'): void {
    this.emit({ type: 'auto_approved', toolCallId, toolName, scope })
  }

  /** Settles a pending approval; returns its tool name, or undefined if none was pending. */
  respond(toolCallId: string, decision: Decision): string | undefined {
    const pending = this.pending.get(toolCallId)
    if (!pending) return undefined
    pending.settle(decision)
    return pending.toolName
  }
}
