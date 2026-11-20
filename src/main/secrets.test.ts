import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SafeStorageSecretStore, type Encryptor } from './secrets'

/** Reversible "encryption" so tests can check nothing is stored in plain text. */
const reverse = (text: string): string => [...text].reverse().join('')
const fakeEncryptor = (
  backend = 'keychain',
  available = true,
  shouldReEncrypt = false
): Encryptor & { encrypted: number } => {
  const fake = {
    encrypted: 0,
    isAsyncEncryptionAvailable: async () => available,
    getSelectedStorageBackend: () => backend,
    encryptStringAsync: async (plain: string) => {
      fake.encrypted += 1
      return Buffer.from(reverse(plain), 'utf8')
    },
    decryptStringAsync: async (encrypted: Buffer) => ({
      shouldReEncrypt,
      result: reverse(encrypted.toString('utf8'))
    })
  }
  return fake
}

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
    // Windows has no POSIX modes (Node reports 0o666); the file lives in the user's own AppData.
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await new SafeStorageSecretStore(path, fakeEncryptor()).get('k')).toBe('ghp_secret')
    await store.delete('k')
    await store.delete('k')
    expect(await store.get('k')).toBeUndefined()
  })

  it('re-encrypts a value when the OS key was rotated', async () => {
    const path = await file()
    await new SafeStorageSecretStore(path, fakeEncryptor()).set('k', 'v')
    const rotated = fakeEncryptor('keychain', true, true)
    expect(await new SafeStorageSecretStore(path, rotated).get('k')).toBe('v')
    expect(rotated.encrypted).toBe(1)
  })

  it('refuses to store secrets without a real OS keychain', async () => {
    for (const encryptor of [fakeEncryptor('keychain', false), fakeEncryptor('basic_text')]) {
      const store = new SafeStorageSecretStore(await file(), encryptor)
      await expect(store.set('k', 'v')).rejects.toThrow(/No OS keychain/)
    }
  })
})
