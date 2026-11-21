/**
 * A model API that stops answering must end the run with a clear timeout, never hang it.
 * Uses the real Gemini provider with fake transports; no network.
 */
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { ModelMessage } from 'ai'
import { describe, expect, it } from 'vitest'
import { guardedFetch } from '../safety/network'
import { FakeConfirmation, runtime } from '../testing'
import { ToolRegistry } from '../tools'
import { runAgent } from './loop'

/** Accepts the request and never answers; settles only when aborted. */
const noResponse = (async (_input: unknown, init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
  })) as typeof fetch

/** Starts a response, then sends nothing. */
const silentBody = (async (_input: unknown, init?: RequestInit) =>
  new Response(
    new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason))
      }
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  )) as typeof fetch

/** The app's guard around a fake transport: public address, short response timeout. */
const guarded = (fetchFn: typeof fetch): typeof fetch =>
  guardedFetch({
    allowedHosts: ['generativelanguage.googleapis.com'],
    fetchFn,
    resolve: async () => ['142.250.0.1'],
    responseTimeoutMs: 300
  })

async function run(fetchFn: typeof fetch): Promise<{ outcome: unknown; ms: number }> {
  const model = createGoogleGenerativeAI({ apiKey: 'k', fetch: fetchFn })('m')
  const history: ModelMessage[] = [{ role: 'user', content: 'hi' }]
  const started = Date.now()
  let outcome: unknown
  try {
    outcome = await runAgent({
      model,
      modelId: 'm',
      provider: 'gemini',
      registry: new ToolRegistry(),
      runtime: runtime(new FakeConfirmation()),
      history,
      signal: new AbortController().signal,
      onEvent: () => undefined,
      idleTimeoutMs: 300
    })
  } catch (error) {
    outcome = error
  }
  return { outcome, ms: Date.now() - started }
}

describe('a model API that stops answering', () => {
  it.each([
    ['never starts a response', guarded(noResponse)],
    ['starts a response, then goes silent', guarded(silentBody)]
  ])('%s: the run ends with a timeout message', async (_case, fetchFn) => {
    const { outcome, ms } = await run(fetchFn)
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).name).toBe('ModelError')
    expect((outcome as Error).message).toMatch(/Gemini didn't respond in time/)
    expect(ms).toBeLessThan(3000)
  })

  it('the response timeout only covers the wait for a response to start', async () => {
    let bodyDone = false
    const slowBody = (async () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            await new Promise((r) => setTimeout(r, 600)) // longer than the 300 ms timeout
            controller.enqueue(new TextEncoder().encode('ok'))
            controller.close()
            bodyDone = true
          }
        })
      )) as typeof fetch
    const response = await guarded(slowBody)('https://generativelanguage.googleapis.com/x')
    expect(await response.text()).toBe('ok')
    expect(bodyDone).toBe(true)
  })
})
