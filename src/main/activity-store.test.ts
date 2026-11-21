import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ActivityEntry } from '../core/activity'
import { JsonlActivityStore, MAX_STORED_ENTRIES } from './activity-store'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function file(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ppa-activity-'))
  dirs.push(dir)
  return join(dir, 'nested', 'activity.jsonl')
}

const NOW = new Date('2026-11-21T12:00:00Z')
const clock = { now: () => NOW }
const entry = (id: string, daysAgo: number, label = 'Replied'): ActivityEntry => ({
  id,
  at: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(),
  tone: 'ok',
  label
})

describe('JsonlActivityStore', () => {
  it('appends lines and returns the newest first, across instances', async () => {
    const path = await file()
    const store = new JsonlActivityStore(path, clock)
    await Promise.all([store.append(entry('a', 1)), store.append(entry('b', 0))])
    expect((await store.recent(10)).map((e) => e.id)).toEqual(['b', 'a'])
    expect((await new JsonlActivityStore(path, clock).recent(1)).map((e) => e.id)).toEqual(['b'])
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(2)
  })

  it('drops entries older than 30 days and lines it cannot read', async () => {
    const path = await file()
    const seed = new JsonlActivityStore(path, clock)
    await seed.append(entry('old', 45))
    await seed.append(entry('recent', 3))
    await appendFile(path, 'not json\n{"id":1}\n')
    const store = new JsonlActivityStore(path, clock)
    expect((await store.recent(10)).map((e) => e.id)).toEqual(['recent'])
    // The file was rewritten without the dropped lines.
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(1)
  })

  it('keeps at most the newest entries', async () => {
    const path = await file()
    const store = new JsonlActivityStore(path, clock)
    for (let i = 0; i < MAX_STORED_ENTRIES + 600; i++) await store.append(entry(`e${i}`, 0))
    const reopened = new JsonlActivityStore(path, clock)
    const all = await reopened.recent(10_000)
    expect(all).toHaveLength(MAX_STORED_ENTRIES)
    expect(all[0]?.id).toBe(`e${MAX_STORED_ENTRIES + 599}`)
  })
})
