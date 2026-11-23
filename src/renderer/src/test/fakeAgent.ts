import { act } from '@testing-library/react'
import type {
  ActivityEntry,
  AgentApi,
  AgentInfo,
  Result,
  RunEvent,
  RunEventParams,
  SecretName,
  Decision,
  ModelList,
  Provider,
  Settings
} from '../../../shared/ipc-contract'

const ok = <T>(value: T): Promise<Result<T>> => Promise.resolve({ ok: true, value })

/** A stand-in for the preload bridge: records calls, keeps settings, lets a test push run events. */
export class FakeAgent implements AgentApi {
  calls: Array<[string, ...unknown[]]> = []
  /** Next setSecret fails with this message, if set. */
  rejectSecret: string | null = null
  private secrets = new Set<SecretName>()
  /** Tools the user chose "Always allow" for. */
  always = new Set<string>()
  /** The model choice as the settings report it. */
  model: { provider: Provider; modelId: string | null; source: 'settings' | 'default' } = {
    provider: 'mock',
    modelId: null,
    source: 'default'
  }
  /** Today's usage as the settings report it. */
  usage: { tokensToday: number; limit: number | null } = { tokensToday: 1234, limit: 1_000_000 }
  private listeners = new Set<(params: RunEventParams) => void>()
  private activityListeners = new Set<(entry: ActivityEntry) => void>()
  /** The saved log, oldest first, as main would return it. */
  activityLog: ActivityEntry[] = []
  constructor(private configError: string | null = null) {}

  info(): Promise<Result<AgentInfo>> {
    return ok({ version: '0.0.0-test', configError: this.configError })
  }
  settings(): Promise<Result<Settings>> {
    if (this.configError)
      return Promise.resolve({
        ok: false,
        error: { code: 'unavailable', message: this.configError }
      })
    return ok({
      llmProvider: this.model.provider,
      llmModelId: this.model.modelId,
      modelSource: this.model.source,
      geminiApiKeySet: this.secrets.has('gemini_api_key'),
      githubTokenSet: this.secrets.has('github_token'),
      usage: { ...this.usage },
      tools: [
        {
          name: 'github_list_pull_requests',
          description: 'List PRs.',
          effect: 'read',
          alwaysAllowed: false,
          networkHosts: ['api.github.com']
        },
        {
          name: 'gmail_send_draft',
          description: 'Send an email.',
          effect: 'write',
          alwaysAllowed: this.always.has('gmail_send_draft'),
          networkHosts: []
        }
      ]
    })
  }
  setSecret(name: SecretName, value: string): Promise<Result<null>> {
    this.calls.push(['setSecret', name, value])
    if (this.rejectSecret) {
      const message = this.rejectSecret
      this.rejectSecret = null
      return Promise.resolve({ ok: false, error: { code: 'invalid_input', message } })
    }
    this.secrets.add(name)
    return ok(null)
  }
  deleteSecret(name: SecretName): Promise<Result<null>> {
    this.calls.push(['deleteSecret', name])
    this.secrets.delete(name)
    return ok(null)
  }
  startRun(conversationId: string, text: string): Promise<Result<{ runId: string }>> {
    this.calls.push(['startRun', conversationId, text])
    return ok({ runId: 'run-1' })
  }
  cancelRun(runId: string): Promise<Result<null>> {
    this.calls.push(['cancelRun', runId])
    return ok(null)
  }
  respond(runId: string, toolCallId: string, decision: Decision): Promise<Result<null>> {
    this.calls.push(['respond', runId, toolCallId, decision])
    return ok(null)
  }
  setModel(provider: Provider, modelId: string | null): Promise<Result<null>> {
    this.calls.push(['setModel', provider, modelId])
    const key: SecretName | null = provider === 'gemini' ? 'gemini_api_key' : null
    if (key && !this.secrets.has(key)) {
      return Promise.resolve({
        ok: false,
        error: { code: 'invalid_input', message: 'Save the key first.' }
      })
    }
    this.model = { provider, modelId: key ? modelId : null, source: 'settings' }
    return ok(null)
  }
  /** What listModels returns, per provider. */
  modelLists: Partial<Record<Provider, ModelList>> = {}
  listModels(provider: Provider): Promise<Result<ModelList>> {
    this.calls.push(['listModels', provider])
    return ok(this.modelLists[provider] ?? { status: 'ok', models: [] })
  }
  setTokenLimit(limit: number | null): Promise<Result<null>> {
    this.calls.push(['setTokenLimit', limit])
    if (limit !== null && limit < 10_000) {
      return Promise.resolve({
        ok: false,
        error: { code: 'invalid_input', message: 'The daily limit must be at least 10,000 tokens' }
      })
    }
    this.usage = { ...this.usage, limit }
    return ok(null)
  }
  revokeAlways(toolName: string): Promise<Result<null>> {
    this.calls.push(['revokeAlways', toolName])
    this.always.delete(toolName)
    return ok(null)
  }
  onRunEvent(listener: (params: RunEventParams) => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }
  activity(): Promise<Result<ActivityEntry[]>> {
    return ok([...this.activityLog].reverse())
  }
  onActivity(listener: (entry: ActivityEntry) => void): () => void {
    this.activityListeners.add(listener)
    return () => void this.activityListeners.delete(listener)
  }
  /** Records an entry and pushes it to the window, like main does. */
  record(entry: ActivityEntry): void {
    this.activityLog.push(entry)
    act(() => this.activityListeners.forEach((l) => l(entry)))
  }
  emit(event: RunEvent, runId = 'run-1'): void {
    act(() => this.listeners.forEach((l) => l({ runId, event })))
  }
}
