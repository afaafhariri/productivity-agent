import { act } from '@testing-library/react'
import type {
  AgentApi,
  AgentInfo,
  Result,
  RunEvent,
  RunEventParams,
  SecretName,
  Settings
} from '../../../shared/ipc-contract'

const ok = <T>(value: T): Promise<Result<T>> => Promise.resolve({ ok: true, value })

/** A stand-in for the preload bridge: records calls, keeps settings, lets a test push run events. */
export class FakeAgent implements AgentApi {
  calls: Array<[string, ...unknown[]]> = []
  /** Next setSecret fails with this message, if set. */
  rejectSecret: string | null = null
  private secrets = new Set<SecretName>()
  private listeners = new Set<(params: RunEventParams) => void>()
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
      llmProvider: 'mock',
      llmModelId: null,
      geminiApiKeySet: this.secrets.has('gemini_api_key'),
      githubTokenSet: this.secrets.has('github_token'),
      tools: [
        { name: 'github_list_pull_requests', description: 'List PRs.', effect: 'read' },
        { name: 'gmail_send_draft', description: 'Send an email.', effect: 'write' }
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
  respond(
    runId: string,
    toolCallId: string,
    approved: boolean,
    reason?: string
  ): Promise<Result<null>> {
    this.calls.push(['respond', runId, toolCallId, approved, reason])
    return ok(null)
  }
  onRunEvent(listener: (params: RunEventParams) => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }
  emit(event: RunEvent, runId = 'run-1'): void {
    act(() => this.listeners.forEach((l) => l({ runId, event })))
  }
}
