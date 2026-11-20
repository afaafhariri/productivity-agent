import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { BlockingConfirmation, FakeConfirmation, runtime } from '../testing'
import {
  defineTool,
  ToolCancelledError,
  ToolFailedError,
  ToolInputError,
  ToolRegistry,
  UnknownToolError
} from '.'

const echo = defineTool({
  name: 'echo_read',
  description: 'Echoes the input.',
  inputSchema: z.object({ text: z.string() }),
  effect: 'read',
  execute: async ({ text }) => ({ echoed: text })
})

function sendTool(): { tool: ReturnType<typeof defineTool>; sent: string[] } {
  const sent: string[] = []
  const tool = defineTool({
    name: 'send_thing',
    description: 'Sends a thing.',
    inputSchema: z.object({ to: z.email(), cc: z.array(z.email()).default([]) }),
    effect: 'write',
    execute: async ({ to }) => {
      sent.push(to)
      return { sent: true }
    }
  })
  return { tool, sent }
}

describe('ToolRegistry', () => {
  it('rejects bad and duplicate names', () => {
    const registry = new ToolRegistry().register(echo)
    expect(() => registry.register(echo)).toThrow(/already registered/)
    for (const name of ['EchoRead', 'echo__read', 'echo_', '_echo', '9echo', 'echo-read']) {
      expect(() => registry.register({ ...echo, name })).toThrow(/snake_case/)
    }
  })

  it('exposes JSON Schema for the model', () => {
    const [spec] = new ToolRegistry().register(echo).specs()
    expect(spec.name).toBe('echo_read')
    expect(spec.effect).toBe('read')
    expect(spec.jsonSchema).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string' } }
    })
  })

  it('runs read tools without asking', async () => {
    const confirmation = new FakeConfirmation()
    const result = await new ToolRegistry()
      .register(echo)
      .call('echo_read', { text: 'hi' }, 'c1', runtime(confirmation))
    expect(result).toEqual({ echoed: 'hi' })
    expect(confirmation.requests).toEqual([])
  })

  it('asks with the exact normalised input before a write tool runs', async () => {
    const { tool, sent } = sendTool()
    const confirmation = new FakeConfirmation({ approved: true })
    const result = await new ToolRegistry()
      .register(tool)
      .call('send_thing', { to: 'a@b.co', extra: 1 }, 'c1', runtime(confirmation))
    expect(result).toEqual({ sent: true })
    expect(confirmation.requests).toEqual([
      {
        toolCallId: 'c1',
        toolName: 'send_thing',
        description: 'Sends a thing.',
        input: { to: 'a@b.co', cc: [] },
        scopes: ['once', 'task', 'always'],
        untrustedSources: []
      }
    ])
    expect(sent).toEqual(['a@b.co'])
  })

  it('never runs a rejected write tool', async () => {
    const { tool, sent } = sendTool()
    const result = await new ToolRegistry()
      .register(tool)
      .call(
        'send_thing',
        { to: 'a@b.co' },
        'c1',
        runtime(new FakeConfirmation({ approved: false, reason: 'no' }))
      )
    expect(result).toEqual({ status: 'rejected', reason: 'no' })
    expect(sent).toEqual([])
  })

  it('never runs a write tool when the run is stopped during approval', async () => {
    const { tool, sent } = sendTool()
    const confirmation = new BlockingConfirmation()
    const controller = new AbortController()
    const call = new ToolRegistry()
      .register(tool)
      .call('send_thing', { to: 'a@b.co' }, 'c1', runtime(confirmation), controller.signal)
    await confirmation.waiting
    controller.abort()
    await expect(call).rejects.toBeInstanceOf(ToolCancelledError)
    expect(sent).toEqual([])
  })

  it('rejects invalid input before asking', async () => {
    const { tool, sent } = sendTool()
    const confirmation = new FakeConfirmation({ approved: true })
    const registry = new ToolRegistry().register(tool)
    for (const bad of [{ to: 42 }, {}, { to: 'not-an-address' }]) {
      const error = await registry
        .call('send_thing', bad, 'c1', runtime(confirmation))
        .catch((e) => e)
      expect(error).toBeInstanceOf(ToolInputError)
      expect((error as ToolInputError).errors[0]?.loc).toBe('to')
    }
    expect(confirmation.requests).toEqual([])
    expect(sent).toEqual([])
  })

  it('reports unknown tools and tool failures as errors', async () => {
    await expect(
      new ToolRegistry().call('nope', {}, 'c1', runtime(new FakeConfirmation()))
    ).rejects.toBeInstanceOf(UnknownToolError)
    const broken = defineTool({
      ...echo,
      name: 'broken_read',
      execute: async () => {
        throw new Error('disk on fire')
      }
    })
    await expect(
      new ToolRegistry()
        .register(broken)
        .call('broken_read', { text: '' }, 'c1', runtime(new FakeConfirmation()))
    ).rejects.toBeInstanceOf(ToolFailedError)
  })

  it('truncates oversized results', async () => {
    const big = defineTool({
      ...echo,
      name: 'big_read',
      execute: async () => ({ data: 'x'.repeat(500) })
    })
    const result = await new ToolRegistry()
      .register(big)
      .call('big_read', { text: '' }, 'c1', runtime(new FakeConfirmation(), 100))
    expect(result).toMatchObject({ truncated: true })
    expect((result as { preview: string }).preview).toHaveLength(100)
  })
})
