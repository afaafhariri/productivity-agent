/**
 * Secrets encrypted with Electron's safeStorage (the key lives in the macOS Keychain, Windows
 * DPAPI or the Linux Secret Service) and kept in a file in the app's data folder. Values are
 * never logged.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SecretStore } from '../core/ports'

/** The parts of Electron's safeStorage this store uses (a fake in tests). */
export interface Encryptor {
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(plain: string): Promise<Buffer>
  /** `shouldReEncrypt` is set when the OS key was rotated or upgraded. */
  decryptStringAsync(encrypted: Buffer): Promise<{ shouldReEncrypt: boolean; result: string }>
  getSelectedStorageBackend?(): string
}

export class SafeStorageSecretStore implements SecretStore {
  constructor(
    private readonly file: string,
    private readonly encryptor: Encryptor
  ) {}

  async get(key: string): Promise<string | undefined> {
    const blob = (await this.read())[key]
    if (blob === undefined) return undefined
    const { result, shouldReEncrypt } = await this.encryptor.decryptStringAsync(
      Buffer.from(blob, 'base64')
    )
    // Best effort: the value is still usable if re-encrypting fails.
    if (shouldReEncrypt) await this.set(key, result).catch(() => undefined)
    return result
  }

  async set(key: string, value: string): Promise<void> {
    await this.checkAvailable()
    const encrypted = await this.encryptor.encryptStringAsync(value)
    const all = await this.read()
    all[key] = encrypted.toString('base64')
    await this.write(all)
  }

  async delete(key: string): Promise<void> {
    const all = await this.read()
    if (!(key in all)) return
    delete all[key]
    await this.write(all)
  }

  private async checkAvailable(): Promise<void> {
    const available = await this.encryptor.isAsyncEncryptionAvailable()
    // On Linux without a keyring, Electron falls back to a hard-coded key: refuse that.
    const plaintext = this.encryptor.getSelectedStorageBackend?.() === 'basic_text'
    if (!available || plaintext) {
      throw new Error('No OS keychain is available to encrypt secrets.')
    }
  }

  private async read(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as Record<string, string>
    } catch {
      return {}
    }
  }

  private async write(all: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    await writeFile(temp, JSON.stringify(all), { mode: 0o600 })
    await rename(temp, this.file)
  }
}
