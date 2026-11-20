import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SafeStorageSecretStore, type Encryptor } from './secrets'

/** Reversible "encryption" so tests can check nothing is stored in plain text. */
const fakeEncryptor = (backend = 'keychain', available = true): Encryptor => ({
  isEncryptionAvailable: () => available,
  getSelectedStorageBackend: () => backend,
  encryptString: (plain) => Buffer.from([...plain].reverse().join(''), 'utf8'),
  decryptString: (encrypted) => [...encrypted.toString('utf8')].reverse().join('')
})

const dirs: string[] = []
async function file(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ppa-secrets-'))
  dirs.push(dir)
  return join(dir, 'nested', 'secrets.json')
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('SafeStorageSecretStore', () => {
  it('stores encrypted values that survive a new instance', async () => {
    const path = await file()
    const store = new SafeStorageSecretStore(path, fakeEncryptor())
    expect(await store.get('k')).toBeUndefined()
    await store.set('k', 'ghp_secret')
    expect(await readFile(path, 'utf8')).not.toContain('ghp_secret')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await new SafeStorageSecretStore(path, fakeEncryptor()).get('k')).toBe('ghp_secret')
    await store.delete('k')
    await store.delete('k')
    expect(await store.get('k')).toBeUndefined()
  })

  it('refuses to store secrets without a real OS keychain', async () => {
    for (const encryptor of [fakeEncryptor('keychain', false), fakeEncryptor('basic_text')]) {
      const store = new SafeStorageSecretStore(await file(), encryptor)
      await expect(store.set('k', 'v')).rejects.toThrow(/No OS keychain/)
    }
  })
})
