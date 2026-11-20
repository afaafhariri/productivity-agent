/**
 * The only bridge between the renderer and the agent: channel names and payload types shared
 * by main, preload and renderer. The renderer is untrusted; main validates every payload.
 */
import type { Decision, RunEventParams, SecretName, Settings } from '../core/service'

export type {
  ApprovalScope,
  Decision,
  DoneReason,
  RunEvent,
  RunEventParams,
  SecretName,
  Settings,
  ToolInfo,
  UsageToday
} from '../core/service'

export const Channels = {
  info: 'agent:info',
  settings: 'agent:settings',
  setSecret: 'agent:set-secret',
  deleteSecret: 'agent:delete-secret',
  startRun: 'agent:start-run',
  cancelRun: 'agent:cancel-run',
  respond: 'agent:respond',
  revokeAlways: 'agent:revoke-always',
  setTokenLimit: 'agent:set-token-limit',
  /** main → renderer */
  runEvent: 'agent:run-event'
} as const

/** Errors cross IPC as data, so the user-facing message survives. */
export type Result<T> =
  { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

export interface AgentInfo {
  version: string
  /** Set when the configuration is invalid; the UI shows it and runs are refused. */
  configError: string | null
}

/** What `window.agent` offers the renderer. Nothing else from Electron or Node is exposed. */
export interface AgentApi {
  info(): Promise<Result<AgentInfo>>
  settings(): Promise<Result<Settings>>
  /** Write-only: the value is stored in the OS keychain and never sent back. */
  setSecret(name: SecretName, value: string): Promise<Result<null>>
  deleteSecret(name: SecretName): Promise<Result<null>>
  startRun(conversationId: string, text: string): Promise<Result<{ runId: string }>>
  cancelRun(runId: string): Promise<Result<null>>
  /** Answers an approval card. Only an explicit click may call this. */
  respond(runId: string, toolCallId: string, decision: Decision): Promise<Result<null>>
  /** Makes an always-allowed write tool ask again. */
  revokeAlways(toolName: string): Promise<Result<null>>
  /** Sets the daily token limit; `null` turns it off. */
  setTokenLimit(limit: number | null): Promise<Result<null>>
  /** Returns an unsubscribe function. */
  onRunEvent(listener: (params: RunEventParams) => void): () => void
}
