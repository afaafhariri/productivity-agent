import { Bot } from 'lucide-react'

function App(): React.JSX.Element {
  return (
    <main className="flex h-screen flex-col items-center justify-center gap-3 bg-zinc-950 text-zinc-100 select-none">
      <Bot className="size-12 text-sky-400" aria-hidden />
      <h1 className="text-xl font-semibold">Personal Productivity Agent</h1>
      <p className="text-sm text-zinc-400">Phase 0 scaffold</p>
    </main>
  )
}

export default App
