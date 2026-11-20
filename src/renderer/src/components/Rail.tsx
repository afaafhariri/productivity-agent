import { Bot, MessageSquare, Settings } from 'lucide-react'

export type View = 'chat' | 'settings'

const ITEMS = [
  { view: 'chat' as const, label: 'Chat', icon: MessageSquare },
  { view: 'settings' as const, label: 'Settings', icon: Settings }
]

export function Rail({
  view,
  onChange
}: {
  view: View
  onChange: (view: View) => void
}): React.JSX.Element {
  return (
    <nav
      className="flex w-14 shrink-0 flex-col items-center gap-2 border-r border-line bg-panel py-3"
      aria-label="Main"
    >
      <div className="mb-2 flex size-9 items-center justify-center rounded-xl bg-accent-soft text-accent">
        <Bot className="size-5" aria-hidden />
      </div>
      {ITEMS.map(({ view: v, label, icon: Icon }) => (
        <button
          key={v}
          type="button"
          aria-label={label}
          aria-current={view === v ? 'page' : undefined}
          title={label}
          onClick={() => onChange(v)}
          className={`flex size-9 items-center justify-center rounded-xl transition-colors ${
            view === v ? 'bg-hover text-ink' : 'text-muted hover:bg-hover hover:text-ink'
          }`}
        >
          <Icon className="size-[18px]" aria-hidden />
        </button>
      ))}
    </nav>
  )
}
