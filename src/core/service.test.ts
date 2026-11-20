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

  constructor(model: LanguageModel | undefined, registry: ToolRegistry, provider: 'mock' | 'gemini' = 'mock') {
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
  registerTools(new ToolRegistry(), new GitHubApi((() => Promise.reject(new Error('no network'))) as typeof fetch))

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
      toolCallId: 'c1',
      toolName: 'email_send',
      description: 'Sends an email.',
      input: { to: 'a@example.com' }
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(sent).toEqual([])
    expect(() => h.service.respondConfirmation(run, 'zzz', { approved: true })).toThrow(/No pending/)
    h.service.respondConfirmation(run, 'c1', { approved: true })
    const done = await h.done(run)
    expect(done).toContainEqual({ type: 'tool_result', toolCallId: 'c1', toolName: 'email_send', result: { sent: true } })
    expect(sent).toEqual(['a@example.com'])
    expect(() => h.service.respondConfirmation(run, 'c1', { approved: true })).toThrow(/No active run/)
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
    expect(events[0]).toMatchObject({ type: 'error', message: expect.stringContaining('Add your Gemini API key') })
    await h.service.setSecret('gemini_api_key', '  key-123  ')
    expect(await h.secrets.get('gemini_api_key')).toBe('key-123')
    expect(await h.service.settings()).toMatchObject({ geminiApiKeySet: true, githubTokenSet: false })
  })

  it('validates secrets and never echoes them', async () => {
    const h = new Harness(MockModel.echo(), new ToolRegistry())
    for (const bad of ['', '   ', 'has space', 'tab\there', 'naïve-key', 'x'.repeat(513)]) {
      await expect(h.service.setSecret('github_token', bad)).rejects.toThrow("That doesn't look like a GitHub token")
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
    expect(settings.tools).toContainEqual(expect.objectContaining({ name: 'gmail_send_draft', effect: 'write' }))
    expect(settings.tools).toContainEqual(expect.objectContaining({ name: 'github_list_pull_requests', effect: 'read' }))
    expect(JSON.stringify(settings)).not.toContain('super-secret')
  })

  it('drives the stub tools end to end with the demo model', async () => {
    const h = new Harness(MockModel.demo({ delayMs: 0 }), stubRegistry())

    const prs = await h.done(h.service.startRun('a', 'What PRs need my review?'))
    expect(prs).toContainEqual(
      expect.objectContaining({ type: 'tool_result', toolName: 'github_list_pull_requests', result: expect.objectContaining({ status: 'not_connected' }) })
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
