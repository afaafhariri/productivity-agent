import { Check, KeyRound } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import type { SecretName, Settings as SettingsData } from '../../../shared/ipc-contract'
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
              <Row label="Provider" value={settings.llmProvider} />
              <Row
                label="Model"
                value={
                  settings.llmProvider === 'mock' ? 'offline demo' : (settings.llmModelId ?? '—')
                }
              />
              {version && <Row label="App version" value={version} />}
              <p className="text-xs text-muted">
                Set LLM_PROVIDER and LLM_MODEL_ID in .env, then restart.
              </p>
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
            <Section title="Tools">
              <ul className="divide-y divide-line rounded-xl border border-line bg-panel">
                {settings.tools.map((tool) => (
                  <li key={tool.name} className="flex items-start gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-sm">{tool.name}</div>
                      <div className="mt-0.5 line-clamp-2 text-xs text-muted">
                        {tool.description}
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
