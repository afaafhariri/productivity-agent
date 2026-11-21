/**
 * The activity log as JSON Lines in the app's data folder: one entry per line, appended as it
 * happens. Entries older than the retention period (or beyond the cap) are dropped when the
 * file is first read.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ActivityEntry, ActivityStore } from '../core/activity'
import type { Clock } from '../core/ports'

export const RETENTION_DAYS = 30
export const MAX_STORED_ENTRIES = 2000
const DAY_MS = 24 * 60 * 60 * 1000

export class JsonlActivityStore implements ActivityStore {
  private entries: ActivityEntry[] | undefined
  /** Serialises file writes so lines never interleave. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly clock: Clock
  ) {}

  append(entry: ActivityEntry): Promise<void> {
    const next = this.queue.then(async () => {
      const entries = await this.load()
      entries.push(entry)
      await mkdir(dirname(this.file), { recursive: true })
      await appendFile(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
      if (entries.length > MAX_STORED_ENTRIES * 1.25) await this.compact(entries)
    })
    this.queue = next.catch(() => undefined)
    return next
  }

  async recent(limit: number): Promise<ActivityEntry[]> {
    await this.queue
    return (await this.load()).slice(-limit).reverse()
  }

  private async load(): Promise<ActivityEntry[]> {
    if (this.entries) return this.entries
    let text = ''
    try {
      text = await readFile(this.file, 'utf8')
    } catch {
      // No log yet.
    }
    const lines = text.split('\n').filter(Boolean)
    const parsed = lines.map(parseEntry).filter((e): e is ActivityEntry => e !== undefined)
    this.entries = parsed
    if (
      parsed.length !== lines.length ||
      this.expired(parsed) > 0 ||
      parsed.length > MAX_STORED_ENTRIES
    ) {
      await this.compact(parsed)
    }
    return this.entries
  }

  /** Keeps the newest entries within the retention period and rewrites the file. */
  private async compact(entries: ActivityEntry[]): Promise<void> {
    const kept = entries.slice(this.expired(entries)).slice(-MAX_STORED_ENTRIES)
    this.entries = kept
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    await writeFile(temp, kept.map((e) => `${JSON.stringify(e)}\n`).join(''), { mode: 0o600 })
    await rename(temp, this.file)
  }

  /** How many leading entries are older than the retention period. */
  private expired(entries: ActivityEntry[]): number {
    const cutoff = this.clock.now().getTime() - RETENTION_DAYS * DAY_MS
    const index = entries.findIndex((e) => Date.parse(e.at) >= cutoff)
    return index === -1 ? entries.length : index
  }
}

function parseEntry(line: string): ActivityEntry | undefined {
  try {
    const value: unknown = JSON.parse(line)
    if (!value || typeof value !== 'object') return undefined
    const e = value as Record<string, unknown>
    const tones = ['neutral', 'accent', 'ok', 'warn', 'danger']
    if (
      typeof e['id'] !== 'string' ||
      typeof e['at'] !== 'string' ||
      Number.isNaN(Date.parse(e['at'])) ||
      typeof e['label'] !== 'string' ||
      !tones.includes(String(e['tone'])) ||
      (e['detail'] !== undefined && typeof e['detail'] !== 'string')
    ) {
      return undefined
    }
    return {
      id: e['id'],
      at: e['at'],
      tone: e['tone'] as ActivityEntry['tone'],
      label: e['label'],
      ...(typeof e['detail'] === 'string' ? { detail: e['detail'] } : {})
    }
  } catch {
    return undefined
  }
}
