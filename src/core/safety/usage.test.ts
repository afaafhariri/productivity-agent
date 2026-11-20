import { describe, expect, it } from 'vitest'
import { MemoryPreferenceStore } from '../ports'
import { DEFAULT_DAILY_TOKEN_LIMIT, UsageMeter } from './usage'

function clockAt(date: Date): { now: () => Date; set: (d: Date) => void } {
  let current = date
  return { now: () => current, set: (d) => (current = d) }
}

describe('UsageMeter', () => {
  it('adds up tokens for the day, defaulting to the standard limit', async () => {
    const meter = new UsageMeter(new MemoryPreferenceStore(), clockAt(new Date(2026, 10, 21, 9)))
    expect(await meter.today()).toEqual({ tokensToday: 0, limit: DEFAULT_DAILY_TOKEN_LIMIT })
    await Promise.all([meter.add(1200), meter.add(800), meter.add(-5), meter.add(Number.NaN)])
    expect(await meter.today()).toEqual({ tokensToday: 2000, limit: DEFAULT_DAILY_TOKEN_LIMIT })
    expect(await meter.remaining()).toBe(DEFAULT_DAILY_TOKEN_LIMIT - 2000)
  })

  it('starts again at local midnight and keeps counts across instances', async () => {
    const store = new MemoryPreferenceStore()
    const clock = clockAt(new Date(2026, 10, 21, 23, 59))
    await new UsageMeter(store, clock).add(5000)
    expect((await new UsageMeter(store, clock).today()).tokensToday).toBe(5000)
    clock.set(new Date(2026, 10, 22, 0, 1))
    expect((await new UsageMeter(store, clock).today()).tokensToday).toBe(0)
  })

  it('can change or turn off the limit', async () => {
    const meter = new UsageMeter(new MemoryPreferenceStore(), clockAt(new Date(2026, 10, 21)))
    await meter.add(30_000)
    await meter.setLimit(20_000)
    expect(await meter.remaining()).toBe(0)
    await meter.setLimit(null)
    expect(await meter.today()).toEqual({ tokensToday: 30_000, limit: null })
    expect(await meter.remaining()).toBeNull()
  })
})
