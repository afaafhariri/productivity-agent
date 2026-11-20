import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonFilePreferenceStore } from './preferences'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('JsonFilePreferenceStore', () => {
  it('keeps values across instances and serialises concurrent writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ppa-prefs-'))
    dirs.push(dir)
    const file = join(dir, 'nested', 'preferences.json')
    const store = new JsonFilePreferenceStore(file)
    expect(await store.get('a')).toBeUndefined()
    await Promise.all([store.set('a', ['x']), store.set('b', 2), store.set('c', { ok: true })])
    const reopened = new JsonFilePreferenceStore(file)
    expect(await reopened.get('a')).toEqual(['x'])
    expect(await reopened.get('b')).toBe(2)
    expect(await reopened.get('c')).toEqual({ ok: true })
  })
})
