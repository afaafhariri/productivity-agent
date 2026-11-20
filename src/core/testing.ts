/** Test doubles for the ports. Used by core and main-process tests only. */
import type { Confirmation, ConfirmationRequest, Decision } from './ports'
import { MemorySecretStore, silentLogger } from './ports'
import { DEFAULT_MAX_RESULT_CHARS, type ToolRuntime } from './tools'

/** Answers every request with a fixed decision and records what was asked. */
export class FakeConfirmation implements Confirmation {
  readonly requests: ConfirmationRequest[] = []

  constructor(private readonly decision?: Decision) {}

  async request(request: ConfirmationRequest): Promise<Decision> {
    this.requests.push(request)
    if (!this.decision) throw new Error('confirmation was not expected')
    return this.decision
  }
}

/** Never answers until the signal aborts, like a user who hasn't clicked yet. */
export class BlockingConfirmation implements Confirmation {
  private notifyWaiting!: () => void
  /** Resolves once a request is pending. */
  readonly waiting = new Promise<void>((resolve) => (this.notifyWaiting = resolve))

  request(_request: ConfirmationRequest, signal?: AbortSignal): Promise<Decision> {
    this.notifyWaiting()
    return new Promise((resolve) => {
      signal?.addEventListener('abort', () => resolve({ approved: false, reason: 'stopped' }), {
        once: true
      })
    })
  }
}

/** 2026-01-01T00:00:00Z. */
export const fixedClock = { now: () => new Date('2026-01-01T00:00:00Z') }

export function runtime(
  confirmation: Confirmation,
  maxResultChars = DEFAULT_MAX_RESULT_CHARS
): ToolRuntime {
  return {
    confirmation,
    secrets: new MemorySecretStore(),
    clock: fixedClock,
    logger: silentLogger,
    maxResultChars
  }
}
