import { useCallback, useEffect, useState } from 'react'
import type { AgentApi, SecretName, Settings } from '../../../shared/ipc-contract'

export interface SettingsState {
  settings: Settings | null
  /** Why settings couldn't be loaded (for example an invalid configuration). */
  loadError: string | null
  /** Resolves to an error message, or null on success. The value is never kept or read back. */
  save(name: SecretName, value: string): Promise<string | null>
  remove(name: SecretName): Promise<string | null>
  /** Makes an always-allowed tool ask for approval again. */
  revoke(toolName: string): Promise<string | null>
  /** Loads settings again (runs can change them, e.g. an "Always allow"). */
  refresh(): Promise<void>
}

export function useSettings(agent: AgentApi): SettingsState {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const refresh = useCallback(
    () =>
      agent.settings().then((result) => {
        if (result.ok) {
          setSettings(result.value)
          setLoadError(null)
        } else {
          setLoadError(result.error.message)
        }
      }),
    [agent]
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  const save = useCallback(
    async (name: SecretName, value: string): Promise<string | null> => {
      const result = await agent.setSecret(name, value)
      await refresh()
      return result.ok ? null : result.error.message
    },
    [agent, refresh]
  )

  const remove = useCallback(
    async (name: SecretName): Promise<string | null> => {
      const result = await agent.deleteSecret(name)
      await refresh()
      return result.ok ? null : result.error.message
    },
    [agent, refresh]
  )

  const revoke = useCallback(
    async (toolName: string): Promise<string | null> => {
      const result = await agent.revokeAlways(toolName)
      await refresh()
      return result.ok ? null : result.error.message
    },
    [agent, refresh]
  )

  return { settings, loadError, save, remove, revoke, refresh }
}
