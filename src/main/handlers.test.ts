import { describe, expect, it } from 'vitest'
import { MockModel } from '../core/llm/mock'
import { MemorySecretStore, silentLogger } from '../core/ports'
import { AgentService, type RunEventParams } from '../core/service'
import { fixedClock } from '../core/testing'
import { ToolRegistry } from '../core/tools'
import { Channels } from '../shared/ipc-contract'
import { createHandlers } from './handlers'

function setup(): { handlers: ReturnType<typeof createHandlers>; events: RunEventParams[] } {
  const events: RunEventParams[] = []
  const service = new AgentService({
    config: { provider: 'mock' },
    registry: new ToolRegistry(),
    secrets: new MemorySecretStore(),
    clock: fixedClock,
    logger: silentLogger,
    model: MockModel.echo({ delayMs: 0 }),
    onEvent: (e) => events.push(e)
  })
  return { handlers: createHandlers(service, { version: '1.2.3', configError: null }), events }
}

describe('IPC handlers', () => {
  it('reject malformed payloads without echoing them', async () => {
    const { handlers } = setup()
    const bad = [
      [Channels.startRun, { conversationId: 'c' }],
      [Channels.startRun, { conversationId: 'c', text: 'hi', extra: true }],
      [Channels.setSecret, { name: 'aws_key', value: 'secret-value' }],
      [Channels.respond, { runId: 'r', toolCallId: 't', approved: 'yes' }],
      [
        Channels.respond,
        { runId: 'r', toolCallId: 't', decision: { approved: true, scope: 'forever' } }
      ],
      [
        Channels.respond,
        { runId: 'r', toolCallId: 't', decision: { approved: false, scope: 'always' } }
      ],
      [Channels.revokeAlways, { toolName: '../etc' }],
      [Channels.settings, { unexpected: 1 }],
      [Channels.cancelRun, 'r']
    ] as const
    for (const [channel, payload] of bad) {
      const result = await handlers[channel](payload)
      expect(result).toEqual({
        ok: false,
        error: { code: 'invalid_input', message: 'Invalid request' }
      })
      expect(JSON.stringify(result)).not.toContain('secret-value')
    }
  })

  it('start runs and stream events', async () => {
    const { handlers, events } = setup()
    const result = await handlers[Channels.startRun]({ conversationId: 'c', text: 'hi' })
    expect(result).toMatchObject({ ok: true, value: { runId: expect.any(String) } })
    await new Promise((r) => setTimeout(r, 50))
    expect(events.at(-1)?.event).toEqual({ type: 'done', reason: 'stop' })
  })

  it('pass service errors through as data', async () => {
    const { handlers } = setup()
    expect(await handlers[Channels.cancelRun]({ runId: 'missing' })).toEqual({
      ok: false,
      error: { code: 'run_not_found', message: 'No active run with that id' }
    })
    expect(
      await handlers[Channels.setSecret]({ name: 'github_token', value: 'has space' })
    ).toEqual({
      ok: false,
      error: { code: 'invalid_input', message: "That doesn't look like a GitHub token" }
    })
  })

  it('report settings without secret values', async () => {
    const { handlers } = setup()
    await handlers[Channels.setSecret]({ name: 'gemini_api_key', value: 'super-secret' })
    const result = await handlers[Channels.settings](undefined)
    expect(result).toMatchObject({ ok: true, value: { geminiApiKeySet: true } })
    expect(JSON.stringify(result)).not.toContain('super-secret')
  })

  it('explain why when the agent could not start', async () => {
    const handlers = createHandlers(null, {
      version: '1',
      configError: 'LLM_PROVIDER=gemini needs LLM_MODEL_ID'
    })
    expect(await handlers[Channels.info](undefined)).toEqual({
      ok: true,
      value: { version: '1', configError: 'LLM_PROVIDER=gemini needs LLM_MODEL_ID' }
    })
    expect(await handlers[Channels.startRun]({ conversationId: 'c', text: 'hi' })).toEqual({
      ok: false,
      error: { code: 'unavailable', message: 'LLM_PROVIDER=gemini needs LLM_MODEL_ID' }
    })
  })
})
