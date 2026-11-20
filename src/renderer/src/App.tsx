import { TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AgentApi, AgentInfo } from '../../shared/ipc-contract'
import { AgentPanel } from './components/AgentPanel'
import { Chat } from './components/Chat'
import { Rail, type View } from './components/Rail'
import { Settings } from './components/Settings'
import { useChat } from './state/useChat'
import { useSettings } from './state/useSettings'

/** The mock ignores LLM_MODEL_ID, so it isn't shown for it. */
function modelLabel(provider: string, modelId: string | null): string {
  if (provider === 'mock') return 'mock (offline demo)'
  return modelId ? `${provider} \u00b7 ${modelId}` : provider
}

export default function App({ agent = window.agent }: { agent?: AgentApi }): React.JSX.Element {
  const [view, setView] = useState<View>('chat')
  const [info, setInfo] = useState<AgentInfo | null>(null)
  const chat = useChat(agent)
  const settings = useSettings(agent)

  useEffect(() => {
    void agent.info().then((result) => result.ok && setInfo(result.value))
  }, [agent])

  // Keep today's token count current: it changes after every model step.
  const { refresh } = settings
  useEffect(
    () =>
      agent.onRunEvent(({ event }) => {
        if (event.type === 'usage' || event.type === 'done' || event.type === 'error') {
          void refresh()
        }
      }),
    [agent, refresh]
  )

  const configError = info?.configError ?? null
  const s = settings.settings
  const model = s ? modelLabel(s.llmProvider, s.llmModelId) : null
  return (
    <div className="flex h-full">
      <Rail view={view} onChange={setView} />
      <main className="flex min-w-0 flex-1 flex-col">
        {configError && (
          <div
            role="alert"
            className="flex items-center gap-2 border-b border-danger/30 bg-danger/10 px-4 py-2 text-sm text-danger"
          >
            <TriangleAlert className="size-4 shrink-0" aria-hidden />
            Agent unavailable: {configError}
          </div>
        )}
        {view === 'chat' ? (
          <Chat chat={chat} disabled={configError !== null} />
        ) : (
          <Settings state={settings} version={info?.version ?? null} />
        )}
      </main>
      <AgentPanel transcript={chat.transcript} model={model} usage={s?.usage ?? null} />
    </div>
  )
}
