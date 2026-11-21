import { describe, expect, it } from 'vitest'
import { ModelListError, MAX_MODELS, listClaudeModels, listGeminiModels } from './models'

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

describe('listClaudeModels', () => {
  it('reads every page with the key in the header, keeping the API order', async () => {
    const { fetch, calls } = fake([
      {
        body: {
          data: [
            { id: 'claude-new', display_name: 'Claude New', created_at: '2026-11-01' },
            { id: 'claude-mid', display_name: '  Claude   Mid  ' }
          ],
          has_more: true,
          last_id: 'claude-mid'
        }
      },
      { body: { data: [{ id: 'claude-old' }], has_more: false, last_id: 'claude-old' } }
    ])
    expect(await listClaudeModels('sk-ant-key', fetch)).toEqual([
      { id: 'claude-new', name: 'Claude New' },
      { id: 'claude-mid', name: 'Claude Mid' },
      { id: 'claude-old', name: 'claude-old' }
    ])
    expect(calls[0]?.url.href).toBe('https://api.anthropic.com/v1/models?limit=100')
    expect(calls[0]?.headers.get('x-api-key')).toBe('sk-ant-key')
    expect(calls[0]?.headers.get('anthropic-version')).toBe('2023-06-01')
    expect(calls[1]?.url.searchParams.get('after_id')).toBe('claude-mid')
    // The key never goes in the URL.
    expect(calls.every((c) => !c.url.href.includes('sk-ant-key'))).toBe(true)
  })

  it('drops IDs that do not look like model IDs, duplicates, and anything over the cap', async () => {
    const many = Array.from({ length: MAX_MODELS + 20 }, (_, i) => ({ id: `m-${i}` }))
    const { fetch } = fake([
      {
        body: {
          data: [{ id: 'bad id with spaces' }, { id: '<script>' }, { id: 'ok' }, { id: 'ok' }]
        }
      }
    ])
    expect(await listClaudeModels('k', fetch)).toEqual([{ id: 'ok', name: 'ok' }])
    const capped = fake([{ body: { data: many } }])
    expect(await listClaudeModels('k', capped.fetch)).toHaveLength(MAX_MODELS)
  })

  it.each([
    [401, /didn't accept your API key/],
    [500, /couldn't list its models right now \(error 500\)/]
  ])('reports status %i plainly', async (status, message) => {
    const { fetch } = fake([{ status, body: { error: { message: 'secret detail' } } }])
    await expect(listClaudeModels('k', fetch)).rejects.toThrow(message)
    await expect(listClaudeModels('k', fake([{ status, body: {} }]).fetch)).rejects.toBeInstanceOf(
      ModelListError
    )
  })

  it('refuses a response it cannot read', async () => {
    const { fetch } = fake([{ body: { unexpected: true } }])
    await expect(listClaudeModels('k', fetch)).rejects.toThrow(/could not read/)
  })
})

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
})
