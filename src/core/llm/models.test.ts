import { describe, expect, it } from 'vitest'
import { ModelListError, MAX_MODELS, listGeminiModels } from './models'

interface Call {
  url: URL
  headers: Headers
}

function fake(pages: Array<{ status?: number; body: unknown }>): {
  fetch: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const queue = [...pages]
  const fetchFn = (async (input: URL, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), headers: new Headers(init?.headers) })
    const next = queue.shift() ?? { body: {} }
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 })
  }) as typeof fetch
  return { fetch: fetchFn, calls }
}

describe('listGeminiModels', () => {
  it('keeps chat models only, strips the models/ prefix, and puts higher versions first', async () => {
    const { fetch, calls } = fake([
      {
        body: {
          models: [
            {
              name: 'models/gemini-2.5-flash',
              displayName: 'Gemini 2.5 Flash',
              supportedGenerationMethods: ['generateContent']
            },
            { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
            {
              name: 'models/gemini-10.0-pro',
              displayName: 'Gemini 10 Pro',
              supportedGenerationMethods: ['generateContent', 'countTokens']
            }
          ],
          nextPageToken: 'p2'
        }
      },
      {
        body: {
          models: [
            {
              name: 'models/gemini-3.8-flash',
              displayName: 'Gemini 3.8 Flash',
              supportedGenerationMethods: ['generateContent']
            }
          ]
        }
      }
    ])
    expect(await listGeminiModels('AIza-key', fetch)).toEqual([
      { id: 'gemini-10.0-pro', name: 'Gemini 10 Pro' },
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' }
    ])
    expect(calls[0]?.headers.get('x-goog-api-key')).toBe('AIza-key')
    expect(calls[1]?.url.searchParams.get('pageToken')).toBe('p2')
    expect(calls.every((c) => !c.url.href.includes('AIza-key'))).toBe(true)
  })

  it('treats a 400 as a rejected key, as Gemini reports it', async () => {
    const { fetch } = fake([{ status: 400, body: {} }])
    await expect(listGeminiModels('k', fetch)).rejects.toThrow(/didn't accept your API key/)
  })

  it('drops IDs that do not look like model IDs, duplicates, and anything over the cap', async () => {
    const model = (name: string): object => ({
      name,
      supportedGenerationMethods: ['generateContent']
    })
    const { fetch } = fake([
      { body: { models: [model('models/bad id'), model('<script>'), model('ok'), model('ok')] } }
    ])
    expect(await listGeminiModels('k', fetch)).toEqual([{ id: 'ok', name: 'ok' }])
    const many = Array.from({ length: MAX_MODELS + 20 }, (_, i) => model(`m-${i}`))
    const capped = fake([{ body: { models: many } }])
    expect(await listGeminiModels('k', capped.fetch)).toHaveLength(MAX_MODELS)
  })

  it.each([
    [401, /didn't accept your API key/],
    [500, /couldn't list its models right now \(error 500\)/]
  ])('reports status %i plainly', async (status, message) => {
    const { fetch } = fake([{ status, body: { error: { message: 'secret detail' } } }])
    await expect(listGeminiModels('k', fetch)).rejects.toThrow(message)
    await expect(listGeminiModels('k', fake([{ status, body: {} }]).fetch)).rejects.toBeInstanceOf(
      ModelListError
    )
  })

  it('refuses a response it cannot read', async () => {
    const { fetch } = fake([{ body: { models: 'not a list' } }])
    await expect(listGeminiModels('k', fetch)).rejects.toThrow(/could not read/)
  })
})
