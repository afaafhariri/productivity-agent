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

/** What the user is asked to approve before a `write` tool runs. */
export interface ConfirmationRequest {
  toolCallId: string
  toolName: string
  /** The tool's description, so the user knows what the action does. */
  description: string
  /** The exact, validated arguments the tool will be called with. */
  input: JsonValue
}

export type Decision = { approved: true } | { approved: false; reason?: string }

/**
 * Asks the user to approve or reject a state-changing action. When `signal` aborts (the run
 * was stopped), implementations must settle with a rejection so the tool never runs.
 */
export interface Confirmation {
  request(request: ConfirmationRequest, signal?: AbortSignal): Promise<Decision>
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
