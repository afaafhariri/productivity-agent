/**
 * Counts model tokens per day and holds the user's daily limit. Both live in the preference
 * store, so the count survives restarts and starts again at local midnight.
 */
import type { Clock, PreferenceStore } from '../ports'

export const DEFAULT_DAILY_TOKEN_LIMIT = 1_000_000
export const MIN_DAILY_TOKEN_LIMIT = 10_000
export const MAX_DAILY_TOKEN_LIMIT = 1_000_000_000

const USAGE_KEY = 'token_usage'
const LIMIT_KEY = 'daily_token_limit'

export interface UsageToday {
  /** Tokens used since local midnight. */
  tokensToday: number
  /** The daily limit, or null when the user turned it off. */
  limit: number | null
}

export class UsageMeter {
  /** Serialises updates so concurrent steps can't lose each other's counts. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly store: PreferenceStore,
    private readonly clock: Clock
  ) {}

  async today(): Promise<UsageToday> {
    return { tokensToday: await this.tokensToday(), limit: await this.limit() }
  }

  /** Tokens left today, or null when there is no limit. */
  async remaining(): Promise<number | null> {
    const { tokensToday, limit } = await this.today()
    return limit === null ? null : Math.max(0, limit - tokensToday)
  }

  add(tokens: number): Promise<UsageToday> {
    const next = this.queue.then(async () => {
      if (Number.isFinite(tokens) && tokens > 0) {
        const total = (await this.tokensToday()) + Math.round(tokens)
        await this.store.set(USAGE_KEY, { day: this.day(), tokens: total })
      }
      return this.today()
    })
    this.queue = next.catch(() => undefined)
    return next
  }

  /** `null` turns the limit off. Callers validate the range. */
  async setLimit(limit: number | null): Promise<void> {
    await this.store.set(LIMIT_KEY, limit === null ? 'off' : limit)
  }

  private async limit(): Promise<number | null> {
    const value = await this.store.get(LIMIT_KEY)
    if (value === 'off') return null
    return typeof value === 'number' ? value : DEFAULT_DAILY_TOKEN_LIMIT
  }

  private async tokensToday(): Promise<number> {
    const value = await this.store.get(USAGE_KEY)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 0
    const { day, tokens } = value as { day?: unknown; tokens?: unknown }
    return day === this.day() && typeof tokens === 'number' ? tokens : 0
  }

  /** The local calendar day, e.g. 2026-11-21. */
  private day(): string {
    const now = this.clock.now()
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  }
}
