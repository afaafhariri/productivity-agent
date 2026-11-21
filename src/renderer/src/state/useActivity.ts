import { useEffect, useState } from 'react'
import type { ActivityEntry, AgentApi } from '../../../shared/ipc-contract'

const MAX_SHOWN = 500

/** The saved activity log (newest first), kept current as new entries arrive. */
export function useActivity(agent: AgentApi): ActivityEntry[] {
  const [entries, setEntries] = useState<ActivityEntry[]>([])

  useEffect(() => {
    let live = true
    // A pure update (React may run it twice): merge by id, newest first.
    const add = (incoming: ActivityEntry[]): void =>
      setEntries((current) => {
        const known = new Set(current.map((e) => e.id))
        const fresh = incoming.filter((e) => !known.has(e.id))
        if (fresh.length === 0) return current
        return [...fresh, ...current].sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_SHOWN)
      })
    // Subscribe first, so nothing recorded during the initial load is missed.
    const unsubscribe = agent.onActivity((entry) => add([entry]))
    void agent.activity().then((result) => {
      if (live && result.ok) add(result.value)
    })
    return () => {
      live = false
      unsubscribe()
    }
  }, [agent])

  return entries
}

/** Groups entries (newest first) by local day: "Today", "Yesterday", or a date. */
export function groupByDay(
  entries: ActivityEntry[],
  now: Date = new Date()
): Array<{ day: string; entries: ActivityEntry[] }> {
  const key = (d: Date): string => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
  const today = key(now)
  const yesterday = key(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
  const groups: Array<{ day: string; entries: ActivityEntry[] }> = []
  for (const entry of entries) {
    const at = new Date(entry.at)
    const k = key(at)
    const day =
      k === today
        ? 'Today'
        : k === yesterday
          ? 'Yesterday'
          : at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
    const last = groups.at(-1)
    if (last?.day === day) last.entries.push(entry)
    else groups.push({ day, entries: [entry] })
  }
  return groups
}
