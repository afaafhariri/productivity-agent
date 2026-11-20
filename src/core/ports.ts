/**
 * What the core needs from its host. The Electron main process provides the implementations;
 * tests use the fakes in `testing.ts`.
 */
import type { JsonValue } from './json'

/** Encrypted key/value storage for credentials. Values never reach logs or the model. */
export interface SecretStore {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

/** Keeps secrets in memory only. For tests and PRODUCTIVITY_AGENT_SECRETS=memory. */
export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>()

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key)
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key)
  }
}

export interface Clock {
  now(): Date
}

export const systemClock: Clock = { now: () => new Date() }

/**
 * How far an approval reaches: this call only, the rest of this task (run), or every future
 * call of the tool (until revoked in Settings).
 */
export type ApprovalScope = 'once' | 'task' | 'always'

export const APPROVAL_SCOPES: readonly ApprovalScope[] = ['once', 'task', 'always']

/** What the user is asked to approve before a `write` tool runs. */
export interface ConfirmationRequest {
  toolCallId: string
  toolName: string
  /** The tool's description, so the user knows what the action does. */
  description: string
  /** The exact, validated arguments the tool will be called with. */
  input: JsonValue
  /** The scopes the user may grant. Only `once` after the task has read untrusted content. */
  scopes: ApprovalScope[]
  /** Tools whose untrusted output this task has read (why only `once` is offered). */
  untrustedSources: string[]
}

export type Decision =
  { approved: true; scope?: ApprovalScope } | { approved: false; reason?: string }

/**
 * Asks the user to approve or reject a state-changing action. When `signal` aborts (the run
 * was stopped), implementations must settle with a rejection so the tool never runs.
 */
export interface Confirmation {
  request(request: ConfirmationRequest, signal?: AbortSignal): Promise<Decision>
  /** Tells the user a write ran without asking because of an earlier grant. */
  notifyAutoApproved?(toolCallId: string, toolName: string, scope: 'task' | 'always'): void
}

/** Small, non-secret JSON values kept between app restarts (e.g. always-allowed tools). */
export interface PreferenceStore {
  get(key: string): Promise<JsonValue | undefined>
  set(key: string, value: JsonValue): Promise<void>
}

export class MemoryPreferenceStore implements PreferenceStore {
  private readonly values = new Map<string, JsonValue>()

  async get(key: string): Promise<JsonValue | undefined> {
    return this.values.get(key)
  }

  async set(key: string, value: JsonValue): Promise<void> {
    this.values.set(key, value)
  }
}

/** Minimal structured logger. Callers must never pass secrets or raw tokens. */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}
