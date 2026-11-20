import { Bot } from 'lucide-react'

function App(): React.JSX.Element {
  return (
    <main className="flex h-full flex-col items-center justify-center gap-3 select-none">
      <Bot className="size-10 text-accent" aria-hidden />
      <h1 className="text-xl font-semibold tracking-tight">Personal Productivity Agent</h1>
      <p className="text-sm text-muted">Electron + TypeScript scaffold</p>
    </main>
  )
}

export default App
