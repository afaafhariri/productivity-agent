/**
 * The activity log: a short, local record of what the agent did and what the user decided.
 * Entries hold tool names, outcomes and clipped (already redacted) questions; never secrets
 * or tool results.
 */
export type ActivityTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger'

export interface ActivityEntry {
  id: string
  /** ISO 8601 time. */
  at: string
  tone: ActivityTone
  label: string
  detail?: string
}

export interface ActivityStore {
  append(entry: ActivityEntry): Promise<void>
  /** Newest first, at most `limit`. */
  recent(limit: number): Promise<ActivityEntry[]>
}

export class MemoryActivityStore implements ActivityStore {
  readonly entries: ActivityEntry[] = []

  async append(entry: ActivityEntry): Promise<void> {
    this.entries.push(entry)
  }

  async recent(limit: number): Promise<ActivityEntry[]> {
    return this.entries.slice(-limit).reverse()
  }
}

const DETAIL_CHARS = 120

export function clipDetail(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > DETAIL_CHARS ? `${oneLine.slice(0, DETAIL_CHARS)}…` : oneLine
}
