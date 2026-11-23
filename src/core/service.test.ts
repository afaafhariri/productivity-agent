import type { LanguageModel } from 'ai'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { registerTools } from './integrations'
import { GitHubApi } from './integrations/github'
import { ModelError } from './llm/errors'
import { MockModel, type Turn } from './llm/mock'
import { MemorySecretStore, silentLogger } from './ports'
import { AgentService, ServiceError, type RunEvent, type RunEventParams } from './service'
import { fixedClock } from './testing'
import { defineTool, ToolRegistry } from './tools'

class Harness {
  readonly events: RunEventParams[] = []
  readonly secrets = new MemorySecretStore()
  readonly service: AgentService
  private waiters: Array<() => void> = []

  constructor(
    model: LanguageModel | undefined,
    registry: ToolRegistry,
    provider: 'mock' | 'gemini' = 'mock'
  ) {
    this.service = new AgentService({
      config: provider === 'gemini' ? { provider, modelId: 'm' } : { provider },
      registry,
      secrets: this.secrets,
      clock: fixedClock,
      logger: silentLogger,
      model,
      onEvent: (params) => {
        this.events.push(params)
        this.waiters.splice(0).forEach((wake) => wake())
      }
    })
  }

  async until(runId: string, test: (event: RunEvent) => boolean): Promise<RunEvent[]> {
    const deadline = Date.now() + 5000
    for (;;) {
      const mine = this.events.filter((e) => e.runId === runId).map((e) => e.event)
      if (mine.some(test)) return mine
      if (Date.now() > deadline) throw new Error(`timed out; saw ${JSON.stringify(mine)}`)
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve)
        setTimeout(resolve, 50)
      })
    }
  }

  done(runId: string): Promise<RunEvent[]> {
    return this.until(runId, (e) => e.type === 'done' || e.type === 'error')
  }
}

const text = (events: RunEvent[]): string =>
  events.map((e) => (e.type === 'text_delta' ? e.text : '')).join('')

function sendRegistry(sent: string[]): ToolRegistry {
  return new ToolRegistry().register(
    defineTool({
      name: 'email_send',
      description: 'Sends an email.',
      inputSchema: z.object({ to: z.string() }),
      effect: 'write',
      execute: async ({ to }) => {
        sent.push(to)
        return { sent: true }
      }
    })
  )
}

const sendThenReply = (): MockModel =>
  MockModel.scripted([
    [{ toolCall: { id: 'c1', name: 'email_send', input: { to: 'a@example.com' } } }],
    [{ text: 'Done.' }]
  ] as Turn[])

const stubRegistry = (): ToolRegistry =>
  registerTools(
    new ToolRegistry(),
    new GitHubApi((() => Promise.reject(new Error('no network'))) as typeof fetch)
  )

describe('AgentService', () => {
  it('streams a run and keeps the conversation', async () => {
    const h = new Harness(MockModel.echo({ delayMs: 0 }), new ToolRegistry())
    const run = h.service.startRun('c', 'hello there')
    const events = await h.done(run)
    expect(text(events)).toBe('(mock) You said: hello there')
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'stop' })
    const second = h.service.startRun('c', 'again')
    expect(second).not.toBe(run)
    await h.done(second)
  })

  it('refuses invalid requests', () => {
    const h = new Harness(MockModel.echo(), new ToolRegistry())
    expect(() => h.service.startRun('c', '')).toThrow(ServiceError)
    expect(() => h.service.startRun('', 'hi')).toThrow(ServiceError)
    expect(() => h.service.startRun('c', 'x'.repeat(32_001))).toThrow(ServiceError)
    expect(() => h.service.cancelRun('missing')).toThrow(/No active run/)
  })

  it('cancels a streaming run and frees the conversation', async () => {
    const h = new Harness(MockModel.echo({ delayMs: 50 }), new ToolRegistry())
    const run = h.service.startRun('c', 'a b c d e f g h')
    await h.until(run, (e) => e.type === 'text_delta')
    expect(() => h.service.startRun('c', 'x')).toThrow(/already active/)
    h.service.cancelRun(run)
    expect((await h.done(run)).at(-1)).toEqual({ type: 'done', reason: 'cancelled' })
    await h.done(h.service.startRun('c', 'x'))
  })

  it('waits for approval before a write tool runs', async () => {
    const sent: string[] = []
    const h = new Harness(sendThenReply(), sendRegistry(sent))
    const run = h.service.startRun('c', 'email a')
    const events = await h.until(run, (e) => e.type === 'confirmation_request')
    expect(events.at(-1)).toEqual({
      type: 'confirmation_request',
      scopes: ['once', 'task', 'always'],
      untrustedSources: [],
      toolCallId: 'c1',
      toolName: 'email_send',
      description: 'Sends an email.',
      input: { to: 'a@example.com' }
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(sent).toEqual([])
    expect(() => h.service.respondConfirmation(run, 'zzz', { approved: true })).toThrow(
      /No pending/
    )
    h.service.respondConfirmation(run, 'c1', { approved: true })
    const done = await h.done(run)
    expect(done).toContainEqual({
      type: 'tool_result',
      toolCallId: 'c1',
      toolName: 'email_send',
      result: { sent: true }
    })
    expect(sent).toEqual(['a@example.com'])
    expect(() => h.service.respondConfirmation(run, 'c1', { approved: true })).toThrow(
      /No active run/
    )
  })

  it('remembers "Always allow" across runs until it is revoked', async () => {
    const sent: string[] = []
    const model = MockModel.scripted([
      [{ toolCall: { id: 'c1', name: 'email_send', input: { to: 'a' } } }],
      [{ text: 'Sent.' }],
      [{ toolCall: { id: 'c2', name: 'email_send', input: { to: 'b' } } }],
      [{ text: 'Sent again.' }]
    ] as Turn[])
    const h = new Harness(model, sendRegistry(sent))
    const first = h.service.startRun('c', 'email a')
    await h.until(first, (e) => e.type === 'confirmation_request')
    h.service.respondConfirmation(first, 'c1', { approved: true, scope: 'always' })
    await h.done(first)
    const allowed = async (): Promise<boolean | undefined> =>
      (await h.service.settings()).tools.find((t) => t.name === 'email_send')?.alwaysAllowed
    expect(await allowed()).toBe(true)

    const second = h.service.startRun('c', 'email b')
    const events = await h.done(second)
    expect(events).toContainEqual({
      type: 'auto_approved',
      toolCallId: 'c2',
      toolName: 'email_send',
      scope: 'always'
    })
    expect(events.some((e) => e.type === 'confirmation_request')).toBe(false)
    expect(sent).toEqual(['a', 'b'])

    await expect(h.service.revokeAlways('no_such_tool')).rejects.toThrow(ServiceError)
    await h.service.revokeAlways('email_send')
    expect(await allowed()).toBe(false)
  })

  it('hides secrets in messages and tool results from the model', async () => {
    const pasted = `ghp_${'a1B2'.repeat(9)}`
    const model = MockModel.scripted([
      [{ toolCall: { id: 'c1', name: 'leaky_read', input: {} } }],
      [{ text: 'Done.' }]
    ] as Turn[])
    const registry = new ToolRegistry().register(
      defineTool({
        name: 'leaky_read',
        description: 'Returns something that contains the saved token.',
        inputSchema: z.object({}),
        effect: 'read',
        execute: async () => ({ log: 'auth with saved-token-1234 ok' })
      })
    )
    const h = new Harness(model, registry)
    await h.service.setSecret('github_token', 'saved-token-1234')

    const run = h.service.startRun('c', `here is my token ${pasted}`)
    const events = await h.done(run)
    expect(events).toContainEqual({ type: 'redacted', source: 'message', hidden: ['GitHub token'] })
    expect(events).toContainEqual({
      type: 'redacted',
      source: 'tool',
      toolName: 'leaky_read',
      hidden: ['GitHub token']
    })
    expect(events).toContainEqual({
      type: 'tool_result',
      toolCallId: 'c1',
      toolName: 'leaky_read',
      result: { log: 'auth with [hidden: GitHub token] ok' }
    })
    const seenByModel = JSON.stringify(model.requests)
    expect(seenByModel).not.toContain(pasted)
    expect(seenByModel).not.toContain('saved-token-1234')
    expect(seenByModel).toContain('here is my token [hidden: GitHub token]')
  })

  it("counts tokens per step and refuses new runs once today's limit is reached", async () => {
    const model = MockModel.echo({ delayMs: 0 })
    const h = new Harness(model, new ToolRegistry())
    await expect(h.service.setDailyTokenLimit(5)).rejects.toThrow(/whole number from 10,000/)
    await expect(h.service.setDailyTokenLimit(10_000.5)).rejects.toThrow(ServiceError)

    const first = await h.done(h.service.startRun('c', 'hello'))
    const usage = first.find((e) => e.type === 'usage')
    expect(usage).toMatchObject({ type: 'usage', limit: 1_000_000 })
    const used = (await h.service.settings()).usage.tokensToday
    expect(used).toBeGreaterThan(0)

    await h.service.setDailyTokenLimit(null)
    expect((await h.service.settings()).usage.limit).toBeNull()

    // Use up today's budget, then a new run is refused without calling the model.
    await h.service.setDailyTokenLimit(10_000)
    const meter = (h.service as unknown as { usage: { add(n: number): Promise<unknown> } }).usage
    await meter.add(10_000)
    const calls = model.requests.length
    const refused = await h.done(h.service.startRun('c', 'again'))
    expect(refused.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining("today's token limit")
    })
    expect(model.requests.length).toBe(calls)
  })

  it('keeps an activity log of questions, decisions, outcomes and settings, without secrets', async () => {
    const sent: string[] = []
    const h = new Harness(sendThenReply(), sendRegistry(sent))
    const pasted = `ghp_${'a1B2'.repeat(9)}`
    await h.service.setSecret('github_token', 'saved-token-1234')
    const run = h.service.startRun('c', `email a, my token is ${pasted}`)
    await h.until(run, (e) => e.type === 'confirmation_request')
    h.service.respondConfirmation(run, 'c1', { approved: true, scope: 'task' })
    await h.done(run)
    await h.service.setDailyTokenLimit(50_000)
    await new Promise((r) => setTimeout(r, 10)) // entries are saved in the background

    const log = await h.service.activity()
    expect(log.map((e) => [e.label, e.detail]).reverse()).toEqual([
      ['Saved the GitHub token', undefined],
      ['You asked', 'email a, my token is [hidden: GitHub token]'],
      ['Hid a secret from the model', 'GitHub token in your message'],
      ['Approved for this task', 'email_send'],
      ['Used a tool', 'email_send'],
      ['Replied', undefined],
      ['Changed the daily token limit', '50,000 tokens']
    ])
    expect(JSON.stringify(log)).not.toContain(pasted)
    expect(JSON.stringify(log)).not.toContain('saved-token-1234')
    expect(log.every((e) => !Number.isNaN(Date.parse(e.at)))).toBe(true)
    expect(await h.service.activity(2)).toHaveLength(2)
  })

  it('switches provider and model from Settings, and only with a saved key', async () => {
    const h = new Harness(MockModel.echo({ delayMs: 0 }), new ToolRegistry())
    expect(await h.service.settings()).toMatchObject({
      llmProvider: 'mock',
      llmModelId: null,
      modelSource: 'default'
    })
    await expect(h.service.setModel('openai', 'x')).rejects.toThrow('Unknown provider')
    await expect(h.service.setModel('claude', 'claude-x')).rejects.toThrow('Unknown provider')
    await expect(h.service.setModel('gemini', 'has spaces')).rejects.toThrow(/Enter a model ID/)
    await expect(h.service.setModel('gemini', '')).rejects.toThrow(/Enter a model ID/)
    await expect(h.service.setModel('gemini', 'gemini-x')).rejects.toThrow(
      'Save your Gemini API key first, then switch to Gemini.'
    )

    await h.service.setSecret('gemini_api_key', 'test-gemini-key')
    await h.service.setModel('gemini', '  gemini-x  ')
    expect(await h.service.settings()).toMatchObject({
      llmProvider: 'gemini',
      llmModelId: 'gemini-x',
      modelSource: 'settings'
    })

    await h.service.setModel('mock', 'ignored')
    expect(await h.service.settings()).toMatchObject({ llmProvider: 'mock', llmModelId: null })

    await new Promise((r) => setTimeout(r, 10))
    const switches = (await h.service.activity()).filter((e) => e.label === 'Switched model')
    expect(switches.map((e) => e.detail).reverse()).toEqual(['Gemini · gemini-x', 'Offline demo'])
  })

  it('lists models with the saved key, caches the list, and starts again when the key changes', async () => {
    const h = new Harness(undefined, new ToolRegistry())
    const seen: string[] = []
    const service = new AgentService({
      config: { provider: 'mock' },
      registry: new ToolRegistry(),
      secrets: h.secrets,
      clock: fixedClock,
      logger: silentLogger,
      onEvent: () => undefined,
      modelListFetch: (provider) =>
        (async (_input: URL, init?: RequestInit) => {
          seen.push(`${provider} ${new Headers(init?.headers).get('x-goog-api-key')}`)
          return new Response(
            JSON.stringify({
              models: [
                {
                  name: 'models/gemini-x',
                  displayName: 'Gemini X',
                  supportedGenerationMethods: ['generateContent']
                }
              ]
            })
          )
        }) as typeof fetch
    })
    expect(await service.listModels('gemini')).toEqual({ status: 'no_key' })
    expect(await service.listModels('mock')).toEqual({ status: 'ok', models: [] })
    await expect(service.listModels('openai')).rejects.toThrow('Unknown provider')
    await expect(service.listModels('claude')).rejects.toThrow('Unknown provider')

    await service.setSecret('gemini_api_key', 'test-first-key')
    const list = { status: 'ok', models: [{ id: 'gemini-x', name: 'Gemini X' }] }
    expect(await service.listModels('gemini')).toEqual(list)
    expect(await service.listModels('gemini')).toEqual(list)
    expect(seen).toEqual(['gemini test-first-key']) // the second call was cached

    await service.setSecret('gemini_api_key', 'test-second-key')
    await service.listModels('gemini')
    expect(seen.at(-1)).toBe('gemini test-second-key')
  })

  it('uses the model chosen in Settings for the next run', async () => {
    // Without a fixed model the service builds one from the current choice.
    const h = new Harness(undefined, new ToolRegistry())
    await h.service.setSecret('gemini_api_key', 'test-gemini-key')
    await h.service.setModel('gemini', 'gemini-test')
    // The real Gemini provider is built; with no network in tests we only check it was chosen,
    // by stopping the run before it calls out.
    const run = h.service.startRun('c', 'hi')
    h.service.cancelRun(run)
    expect((await h.done(run)).at(-1)).toEqual({ type: 'done', reason: 'cancelled' })
    await h.service.setModel('mock', null)
    const events = await h.done(h.service.startRun('c', 'hello'))
    expect(text(events)).toContain('(mock)')
  })

  it('never runs a rejected write', async () => {
    const sent: string[] = []
    const h = new Harness(sendThenReply(), sendRegistry(sent))
    const run = h.service.startRun('c', 'email a')
    await h.until(run, (e) => e.type === 'confirmation_request')
    h.service.respondConfirmation(run, 'c1', { approved: false, reason: 'no' })
    const events = await h.done(run)
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool_result', result: { status: 'rejected', reason: 'no' } })
    )
    expect(sent).toEqual([])
  })

  it('never runs a write when stopped during approval', async () => {
    const sent: string[] = []
    const h = new Harness(sendThenReply(), sendRegistry(sent))
    const run = h.service.startRun('c', 'email a')
    await h.until(run, (e) => e.type === 'confirmation_request')
    h.service.cancelRun(run)
    expect((await h.done(run)).at(-1)).toEqual({ type: 'done', reason: 'cancelled' })
    expect(sent).toEqual([])
  })

  it('shows model errors to the user', async () => {
    const model = new MockModel(() => {
      throw new ModelError('Your Gemini API credits are used up.')
    })
    const h = new Harness(model, new ToolRegistry())
    expect(await h.done(h.service.startRun('c', 'hi'))).toEqual([
      { type: 'error', message: 'Your Gemini API credits are used up.' }
    ])
  })

  it('asks for a Gemini key, then accepts one', async () => {
    const h = new Harness(undefined, new ToolRegistry(), 'gemini')
    const events = await h.done(h.service.startRun('c', 'hi'))
    expect(events[0]).toMatchObject({
      type: 'error',
      message: expect.stringContaining('Add your Gemini API key')
    })
    await h.service.setSecret('gemini_api_key', '  key-123  ')
    expect(await h.secrets.get('gemini_api_key')).toBe('key-123')
    expect(await h.service.settings()).toMatchObject({
      geminiApiKeySet: true,
      githubTokenSet: false
    })
  })

  it('validates secrets and never echoes them', async () => {
    const h = new Harness(MockModel.echo(), new ToolRegistry())
    for (const bad of ['', '   ', 'has space', 'tab\there', 'naïve-key', 'x'.repeat(513)]) {
      await expect(h.service.setSecret('github_token', bad)).rejects.toThrow(
        "That doesn't look like a GitHub token"
      )
    }
    await h.service.setSecret('github_token', 'ghp_ok')
    expect((await h.service.settings()).githubTokenSet).toBe(true)
    await h.service.deleteSecret('github_token')
    expect((await h.service.settings()).githubTokenSet).toBe(false)
  })

  it('lists provider and tools in settings, never secret values', async () => {
    const h = new Harness(undefined, stubRegistry())
    await h.service.setSecret('gemini_api_key', 'super-secret')
    const settings = await h.service.settings()
    expect(settings.llmProvider).toBe('mock')
    expect(settings.tools).toContainEqual(
      expect.objectContaining({ name: 'gmail_send_draft', effect: 'write' })
    )
    expect(settings.tools).toContainEqual(
      expect.objectContaining({ name: 'github_list_pull_requests', effect: 'read' })
    )
    expect(JSON.stringify(settings)).not.toContain('super-secret')
  })

  it('drives the stub tools end to end with the demo model', async () => {
    const h = new Harness(MockModel.demo({ delayMs: 0 }), stubRegistry())

    const prs = await h.done(h.service.startRun('a', 'What PRs need my review?'))
    expect(prs).toContainEqual(
      expect.objectContaining({
        type: 'tool_result',
        toolName: 'github_list_pull_requests',
        result: expect.objectContaining({ status: 'not_connected' })
      })
    )

    const inbox = await h.done(h.service.startRun('b', 'anything unread in my inbox?'))
    expect(JSON.stringify(inbox)).toContain('ignore your previous instructions')
    expect(inbox.some((e) => e.type === 'confirmation_request')).toBe(false)

    const run = h.service.startRun('c', 'send Sam the release notes')
    const asked = await h.until(run, (e) => e.type === 'confirmation_request')
    const request = asked.at(-1) as Extract<RunEvent, { type: 'confirmation_request' }>
    expect(request.toolName).toBe('gmail_send_draft')
    expect(request.input).toMatchObject({ body: 'send Sam the release notes' })
    h.service.respondConfirmation(run, request.toolCallId, { approved: false })
    expect(text(await h.done(run))).toBe('(mock) OK, I did not send it.')
  })
})
