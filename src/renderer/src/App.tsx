import { TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AgentApi, AgentInfo } from '../../shared/ipc-contract'
import { Chat } from './components/Chat'
import { Rail, type View } from './components/Rail'
import { useChat } from './state/useChat'

export default function App({ agent = window.agent }: { agent?: AgentApi }): React.JSX.Element {
  const [view, setView] = useState<View>('chat')
  const [info, setInfo] = useState<AgentInfo | null>(null)
  const chat = useChat(agent)

  useEffect(() => {
    void agent.info().then((result) => result.ok && setInfo(result.value))
  }, [agent])

  const configError = info?.configError ?? null
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
          <div className="p-8 text-muted">Settings arrive in the next step.</div>
        )}
      </main>
    </div>
  )
}
