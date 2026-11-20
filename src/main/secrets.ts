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
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
  getSelectedStorageBackend?(): string
}

export class SafeStorageSecretStore implements SecretStore {
  constructor(
    private readonly file: string,
    private readonly encryptor: Encryptor
  ) {}

  async get(key: string): Promise<string | undefined> {
    const blob = (await this.read())[key]
    return blob === undefined
      ? undefined
      : this.encryptor.decryptString(Buffer.from(blob, 'base64'))
  }

  async set(key: string, value: string): Promise<void> {
    this.checkAvailable()
    const all = await this.read()
    all[key] = this.encryptor.encryptString(value).toString('base64')
    await this.write(all)
  }

  async delete(key: string): Promise<void> {
    const all = await this.read()
    if (!(key in all)) return
    delete all[key]
    await this.write(all)
  }

  private checkAvailable(): void {
    // On Linux without a keyring, Electron falls back to a hard-coded key: refuse that.
    const plaintext = this.encryptor.getSelectedStorageBackend?.() === 'basic_text'
    if (!this.encryptor.isEncryptionAvailable() || plaintext) {
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
