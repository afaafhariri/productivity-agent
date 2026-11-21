import { Check, KeyRound } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import type {
  ModelList,
  Provider,
  SecretName,
  Settings as SettingsData
} from '../../../shared/ipc-contract'
import type { SettingsState } from '../state/useSettings'

const SECRETS: Array<{
  name: SecretName
  label: string
  help: string
  isSet: (s: SettingsData) => boolean
}> = [
  {
    name: 'gemini_api_key',
    label: 'Gemini API key',
    help: 'From Google AI Studio. Used only when the provider is gemini, and only sent to Google.',
    isSet: (s) => s.geminiApiKeySet
  },
  {
    name: 'anthropic_api_key',
    label: 'Claude API key',
    help: 'From the Claude Console. Used only when the provider is claude, and only sent to Anthropic.',
    isSet: (s) => s.anthropicApiKeySet
  },
  {
    name: 'github_token',
    label: 'GitHub token',
    help: 'A fine-grained token with read-only Pull requests and Issues. Only sent to GitHub.',
    isSet: (s) => s.githubTokenSet
  }
]

export function Settings({
  state,
  version
}: {
  state: SettingsState
  version: string | null
}): React.JSX.Element {
  const { settings, loadError, refresh } = state
  // A run may have changed something since the last load (e.g. an "Always allow").
  useEffect(() => {
    void refresh()
  }, [refresh])
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-8">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        {loadError && <p className="text-sm text-danger">{loadError}</p>}
        {settings && (
          <>
            <Section title="Model">
              <ModelSection state={state} settings={settings} />
              {version && <Row label="App version" value={version} />}
            </Section>
            <Section title="Keys">
              <p className="text-xs text-muted">
                Keys are encrypted on this computer with your OS keychain. The app never shows them
                again.
              </p>
              {SECRETS.map((secret) => (
                <SecretField
                  key={secret.name}
                  name={secret.name}
                  label={secret.label}
                  help={secret.help}
                  isSet={secret.isSet(settings)}
                  state={state}
                />
              ))}
            </Section>
            <Section title="Daily token limit">
              <TokenLimit state={state} />
            </Section>
            <Section title="Tools">
              <ul className="divide-y divide-line rounded-xl border border-line bg-panel">
                {settings.tools.map((tool) => (
                  <li key={tool.name} className="flex items-start gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-sm">{tool.name}</div>
                      <div className="mt-0.5 line-clamp-2 text-xs text-muted">
                        {tool.description}
                      </div>
                      <div className="mt-1 text-xs text-muted">
                        {tool.networkHosts.length > 0 ? (
                          <>
                            Can reach{' '}
                            <span className="font-mono">{tool.networkHosts.join(', ')}</span> over
                            HTTPS
                          </>
                        ) : (
                          'No network access'
                        )}
                      </div>
                    </div>
                    {tool.effect === 'read' ? (
                      <span className="badge border-line text-muted">Read-only</span>
                    ) : tool.alwaysAllowed ? (
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="badge border-accent/40 text-accent">Always allowed</span>
                        <button
                          type="button"
                          className="btn-secondary px-2.5 py-1 text-xs"
                          aria-label={`Revoke always allow for ${tool.name}`}
                          onClick={() => void state.revoke(tool.name)}
                        >
                          Revoke
                        </button>
                      </div>
                    ) : (
                      <span className="badge border-warn/40 text-warn">Asks first</span>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          </>
        )}
      </div>
    </div>
  )
}

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <h2 className="text-sm font-medium text-muted">{title}</h2>
      {children}
    </section>
  )
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between rounded-lg bg-panel px-4 py-2.5 text-sm">
      <span className="text-muted">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  )
}

/** Write-only: the typed value goes to the main process and the field is cleared. */
function SecretField({
  name,
  label,
  help,
  isSet,
  state
}: {
  name: SecretName
  label: string
  help: string
  isSet: boolean
  state: SettingsState
}): React.JSX.Element {
  const inputId = useId()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)

  const run = async (action: () => Promise<string | null>, done: string): Promise<void> => {
    setBusy(true)
    const error = await action()
    setBusy(false)
    if (error) setMessage({ error: true, text: error })
    else {
      setValue('')
      setMessage({ error: false, text: done })
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-panel p-4">
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-muted" aria-hidden />
        <label htmlFor={inputId} className="text-sm font-medium">
          {label}
        </label>
        <span
          className={`ml-auto flex items-center gap-1 text-xs ${isSet ? 'text-ok' : 'text-muted'}`}
        >
          {isSet && <Check className="size-3.5" aria-hidden />}
          {isSet ? 'Saved' : 'Not set'}
        </span>
      </div>
      <p className="text-xs text-muted">{help}</p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (value.trim()) void run(() => state.save(name, value), 'Saved.')
        }}
      >
        <input
          id={inputId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          disabled={busy}
          placeholder={isSet ? 'Paste a new value to replace it' : 'Paste it here'}
          onChange={(e) => {
            setValue(e.target.value)
            setMessage(null)
          }}
          className="min-w-0 flex-1 rounded-lg border border-line bg-card px-3 py-1.5 font-mono text-sm outline-none placeholder:font-sans placeholder:text-muted focus:border-accent/60"
        />
        <button type="submit" className="btn-primary" disabled={busy || !value.trim()}>
          {isSet ? 'Replace' : 'Save'}
        </button>
        {isSet && (
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => void run(() => state.remove(name), 'Removed.')}
          >
            Remove
          </button>
        )}
      </form>
      {message && (
        <p role="status" className={`text-xs ${message.error ? 'text-danger' : 'text-ok'}`}>
          {message.text}
        </p>
      )}
    </div>
  )
}

/** Today's usage and the daily limit. A run won't start, or stops, once the limit is reached. */
function TokenLimit({ state }: { state: SettingsState }): React.JSX.Element {
  const usage = state.settings?.usage
  const inputId = useId()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)
  if (!usage) return <></>

  const apply = async (limit: number | null, done: string): Promise<void> => {
    setBusy(true)
    const error = await state.setTokenLimit(limit)
    setBusy(false)
    setMessage(error ? { error: true, text: error } : { error: false, text: done })
    if (!error) setValue('')
  }
  const format = (n: number): string => n.toLocaleString('en')

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-panel p-4">
      <p className="text-sm">
        Used today: <span className="font-mono">{format(usage.tokensToday)}</span> tokens
        {usage.limit !== null ? (
          <>
            {' '}
            of <span className="font-mono">{format(usage.limit)}</span>
          </>
        ) : (
          ' (no limit)'
        )}
      </p>
      <p className="text-xs text-muted">
        Counts every model step. When today&apos;s total reaches the limit, new tasks won&apos;t
        start and a running task stops after its current step. It resets at midnight.
      </p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          const limit = Number(value.replace(/[,_\s]/g, ''))
          if (value.trim()) void apply(limit, 'Saved.')
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          Daily token limit
        </label>
        <input
          id={inputId}
          inputMode="numeric"
          value={value}
          disabled={busy}
          placeholder={
            usage.limit !== null
              ? `New limit (now ${format(usage.limit)})`
              : 'Set a limit, e.g. 1,000,000'
          }
          onChange={(e) => {
            setValue(e.target.value)
            setMessage(null)
          }}
          className="min-w-0 flex-1 rounded-lg border border-line bg-card px-3 py-1.5 font-mono text-sm outline-none placeholder:font-sans placeholder:text-muted focus:border-accent/60"
        />
        <button type="submit" className="btn-primary" disabled={busy || !value.trim()}>
          Save
        </button>
        {usage.limit !== null && (
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => void apply(null, 'Limit turned off.')}
          >
            No limit
          </button>
        )}
      </form>
      {message && (
        <p role="status" className={`text-xs ${message.error ? 'text-danger' : 'text-ok'}`}>
          {message.text}
        </p>
      )}
    </div>
  )
}

/** The dropdown entry that switches to typing an ID. Can't clash: IDs never contain spaces. */
const TYPE_AN_ID = 'type an id'

const PROVIDER_OPTIONS: Array<{ id: Provider; name: string; keyFrom?: string }> = [
  { id: 'mock', name: 'Offline demo' },
  { id: 'gemini', name: 'Gemini', keyFrom: 'Google AI Studio' },
  { id: 'claude', name: 'Claude', keyFrom: 'the Claude Console' }
]

const keySaved = (settings: SettingsData, provider: Provider): boolean =>
  provider === 'mock' ||
  (provider === 'gemini' ? settings.geminiApiKeySet : settings.anthropicApiKeySet)

const describeChoice = (provider: Provider, modelId: string | null): string => {
  const name = PROVIDER_OPTIONS.find((p) => p.id === provider)?.name ?? provider
  return provider === 'mock' || !modelId ? name : `${name} · ${modelId}`
}

type Message = { error: boolean; text: string } | null

/**
 * The picker restarts from the saved values whenever they change (its `key`); the status
 * message lives here so it survives that reset.
 */
function ModelSection({
  state,
  settings
}: {
  state: SettingsState
  settings: SettingsData
}): React.JSX.Element {
  const [message, setMessage] = useState<Message>(null)
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-4">
      <ModelPicker
        key={`${settings.llmProvider}:${settings.llmModelId}:${settings.modelSource}`}
        state={state}
        settings={settings}
        onMessage={setMessage}
      />
      {message && (
        <p role="status" className={`text-xs ${message.error ? 'text-danger' : 'text-ok'}`}>
          {message.text}
        </p>
      )}
    </div>
  )
}

/** Pick the provider and model; the next message uses them, no restart needed. */
function ModelPicker({
  state,
  settings,
  onMessage
}: {
  state: SettingsState
  settings: SettingsData
  onMessage: (message: Message) => void
}): React.JSX.Element {
  const providerId = useId()
  const modelFieldId = useId()
  const [provider, setProvider] = useState<Provider>(settings.llmProvider)
  const [modelId, setModelId] = useState(settings.llmModelId ?? '')
  const [busy, setBusy] = useState(false)
  /** Lists already loaded, per provider. A provider with a key but no entry is loading. */
  const [lists, setLists] = useState<Partial<Record<Provider, ModelList>>>({})
  /** The user chose to type an ID instead of picking from the list. */
  const [typing, setTyping] = useState(false)
  const setMessage = onMessage

  const option = PROVIDER_OPTIONS.find((p) => p.id === provider)
  const needsModel = provider !== 'mock'
  const hasKey = keySaved(settings, provider)
  const { listModels } = state

  useEffect(() => {
    if (!needsModel || !hasKey || lists[provider]) return
    let live = true
    void listModels(provider).then((list) => {
      if (live) setLists((current) => ({ ...current, [provider]: list }))
    })
    return () => {
      live = false
    }
  }, [provider, needsModel, hasKey, lists, listModels])

  const list = lists[provider]
  const models = list?.status === 'ok' ? list.models : []
  const loading = needsModel && hasKey && !list
  const showList = needsModel && !typing && (loading || models.length > 0)
  // With a list and nothing chosen yet, the first (newest) model is selected.
  const selectedId = (showList && !modelId ? (models[0]?.id ?? '') : modelId).trim()
  const listed = models.some((m) => m.id === selectedId)

  const unchanged =
    provider === settings.llmProvider && (!needsModel || selectedId === settings.llmModelId)
  const canSave =
    !busy && hasKey && !loading && !unchanged && (!needsModel || selectedId.length > 0)

  const run = async (action: () => Promise<string | null>, done: string): Promise<void> => {
    setBusy(true)
    const error = await action()
    setBusy(false)
    setMessage(error ? { error: true, text: error } : { error: false, text: done })
  }

  return (
    <>
      <p className="text-sm">
        Using{' '}
        <span className="font-mono">
          {describeChoice(settings.llmProvider, settings.llmModelId)}
        </span>
        <span className="text-muted">
          {settings.modelSource === 'settings' ? ' (chosen here)' : ' (default from .env)'}
        </span>
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (!canSave) return
          void run(
            () => state.setModel(provider, needsModel ? selectedId : null),
            `Switched. Your next message uses ${describeChoice(provider, needsModel ? selectedId : null)}.`
          )
        }}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={providerId} className="text-xs text-muted">
            Provider
          </label>
          <select
            id={providerId}
            value={provider}
            disabled={busy}
            onChange={(e) => {
              const next = e.target.value as Provider
              setProvider(next)
              setModelId(next === settings.llmProvider ? (settings.llmModelId ?? '') : '')
              setTyping(false)
              setMessage(null)
            }}
            className="rounded-lg border border-line bg-card px-3 py-1.5 text-sm outline-none focus:border-accent/60"
          >
            {PROVIDER_OPTIONS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.id !== 'mock' && !keySaved(settings, p.id) ? ' (no key yet)' : ''}
              </option>
            ))}
          </select>
        </div>
        {needsModel && (
          <div className="flex min-w-48 flex-1 flex-col gap-1">
            <label htmlFor={modelFieldId} className="text-xs text-muted">
              Model
            </label>
            {showList ? (
              <select
                id={modelFieldId}
                value={loading ? '' : selectedId}
                disabled={busy || loading}
                onChange={(e) => {
                  if (e.target.value === TYPE_AN_ID) {
                    setTyping(true)
                    setModelId(selectedId)
                  } else {
                    setModelId(e.target.value)
                  }
                  setMessage(null)
                }}
                className="rounded-lg border border-line bg-card px-3 py-1.5 text-sm outline-none focus:border-accent/60"
              >
                {loading ? (
                  <option value="">Loading models…</option>
                ) : (
                  <>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name === m.id ? m.id : `${m.name} (${m.id})`}
                      </option>
                    ))}
                    {selectedId && !listed && (
                      <option value={selectedId}>{selectedId} (not in the list)</option>
                    )}
                    <option value={TYPE_AN_ID}>Type an ID…</option>
                  </>
                )}
              </select>
            ) : (
              <input
                id={modelFieldId}
                value={modelId}
                disabled={busy}
                spellCheck={false}
                autoComplete="off"
                placeholder={`A current model ID from ${option?.keyFrom ?? 'the provider'}`}
                onChange={(e) => {
                  setModelId(e.target.value)
                  setMessage(null)
                }}
                className="rounded-lg border border-line bg-card px-3 py-1.5 font-mono text-sm outline-none placeholder:font-sans placeholder:text-muted focus:border-accent/60"
              />
            )}
          </div>
        )}
        <button type="submit" className="btn-primary" disabled={!canSave}>
          Switch
        </button>
      </form>
      {needsModel && !hasKey && (
        <p className="text-xs text-warn">
          Save your {option?.name} API key under Keys below first.
        </p>
      )}
      {needsModel && hasKey && list?.status === 'error' && (
        <p className="text-xs text-muted">{list.message} Type a model ID instead.</p>
      )}
      {needsModel && typing && models.length > 0 && (
        <button
          type="button"
          className="self-start text-xs text-accent hover:underline"
          onClick={() => {
            setTyping(false)
            setModelId('')
          }}
        >
          Pick from the list instead
        </button>
      )}
    </>
  )
}
