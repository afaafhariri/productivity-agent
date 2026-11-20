/**
 * Non-secret preferences (such as always-allowed tools) in a JSON file in the app's data
 * folder. Secrets never go here; they use SafeStorageSecretStore.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { JsonValue } from '../core/json'
import type { PreferenceStore } from '../core/ports'

export class JsonFilePreferenceStore implements PreferenceStore {
  /** Serialises writes so two quick changes can't overwrite each other. */
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  async get(key: string): Promise<JsonValue | undefined> {
    return (await this.read())[key]
  }

  set(key: string, value: JsonValue): Promise<void> {
    const next = this.queue.then(async () => {
      const all = await this.read()
      all[key] = value
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.tmp`
      await writeFile(temp, JSON.stringify(all, null, 2), { mode: 0o600 })
      await rename(temp, this.file)
    })
    this.queue = next.catch(() => undefined)
    return next
  }

  private async read(): Promise<Record<string, JsonValue>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, JsonValue>)
        : {}
    } catch {
      return {}
    }
  }
}
