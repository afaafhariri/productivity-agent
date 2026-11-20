import { APICallError } from '@ai-sdk/provider'
import { describe, expect, it } from 'vitest'
import { MemorySecretStore } from '../ports'
import { ConfigError, GEMINI_API_KEY, createModel, llmConfigFromEnv } from './config'
import { ModelError, modelErrorFrom } from './errors'
import { MockModel } from './mock'

describe('llmConfigFromEnv', () => {
  it('defaults to the mock and validates gemini settings', () => {
    expect(llmConfigFromEnv({})).toEqual({ provider: 'mock', modelId: undefined })
    expect(llmConfigFromEnv({ LLM_PROVIDER: ' ' }).provider).toBe('mock')
    expect(llmConfigFromEnv({ LLM_PROVIDER: 'gemini', LLM_MODEL_ID: 'm' })).toEqual({
      provider: 'gemini',
      modelId: 'm'
    })
    expect(() => llmConfigFromEnv({ LLM_PROVIDER: 'gemini' })).toThrow(ConfigError)
    expect(() => llmConfigFromEnv({ LLM_PROVIDER: 'vertex' })).toThrow(/no longer supported/)
    expect(() => llmConfigFromEnv({ LLM_PROVIDER: 'gateway' })).toThrow(/Unknown/)
  })
})

describe('createModel', () => {
  it('asks for a Gemini key until one is saved', async () => {
    const secrets = new MemorySecretStore()
    const config = { provider: 'gemini' as const, modelId: 'm' }
    await expect(createModel(config, secrets)).rejects.toThrow(/Add your Gemini API key/)
    await secrets.set(GEMINI_API_KEY, 'key')
    await expect(createModel(config, secrets)).resolves.toBeDefined()
  })

  it('builds the offline demo model by default', async () => {
    expect(await createModel({ provider: 'mock' }, new MemorySecretStore())).toBeInstanceOf(MockModel)
  })
})

describe('modelErrorFrom', () => {
  const apiError = (statusCode: number, responseBody = '{"error":{"message":"secret detail"}}'): APICallError =>
    new APICallError({ message: 'secret detail', url: 'u', requestBodyValues: {}, statusCode, responseBody })

  it.each([
    [401, "didn't accept your API key"],
    [403, "didn't accept your API key"],
    [402, 'credits are used up'],
    [404, "doesn't have a model called 'm'"],
    [429, 'rate limit or quota'],
    [503, "'m' model is overloaded"],
    [500, 'having problems right now (error 500)'],
    [400, 'rejected the request (error 400)']
  ])('maps %i to our own words', (status, expected) => {
    const error = modelErrorFrom(apiError(status), 'm')
    expect(error).toBeInstanceOf(ModelError)
    expect(error.message).toContain(expected)
    expect(error.message).not.toContain('secret detail')
  })

  it('treats a 400 about the API key as a bad key', () => {
    const error = modelErrorFrom(apiError(400, '{"error":{"message":"API key not valid"}}'), 'm')
    expect(error.message).toContain("didn't accept your API key")
  })
})
