import { APICallError } from '@ai-sdk/provider'
import { RetryError } from 'ai'
import { describe, expect, it } from 'vitest'
import { MemorySecretStore } from '../ports'
import {
  ANTHROPIC_API_KEY,
  ConfigError,
  GEMINI_API_KEY,
  createModel,
  llmConfigFromEnv
} from './config'
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

  it('accepts claude with a model id and points anthropic users to it', () => {
    expect(llmConfigFromEnv({ LLM_PROVIDER: 'claude', LLM_MODEL_ID: 'm' })).toEqual({
      provider: 'claude',
      modelId: 'm'
    })
    expect(() => llmConfigFromEnv({ LLM_PROVIDER: 'claude' })).toThrow(/needs LLM_MODEL_ID/)
    expect(() => llmConfigFromEnv({ LLM_PROVIDER: 'anthropic' })).toThrow(/LLM_PROVIDER=claude/)
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

  it('asks for a Claude key until one is saved, and uses only that key', async () => {
    const secrets = new MemorySecretStore()
    const config = { provider: 'claude' as const, modelId: 'm' }
    await secrets.set(GEMINI_API_KEY, 'gemini-key')
    await expect(createModel(config, secrets)).rejects.toThrow(/Add your Claude API key/)
    await secrets.set(ANTHROPIC_API_KEY, 'key')
    const model = await createModel(config, secrets)
    expect(typeof model === 'object' && model.provider).toMatch(/anthropic/)
  })

  it('builds the offline demo model by default', async () => {
    expect(await createModel({ provider: 'mock' }, new MemorySecretStore())).toBeInstanceOf(
      MockModel
    )
  })
})

describe('modelErrorFrom', () => {
  const apiError = (
    statusCode: number,
    responseBody = '{"error":{"message":"secret detail"}}'
  ): APICallError =>
    new APICallError({
      message: 'secret detail',
      url: 'u',
      requestBodyValues: {},
      statusCode,
      responseBody
    })

  it.each([
    [401, "didn't accept your API key"],
    [403, "didn't accept your API key"],
    [402, 'credits are used up'],
    [404, "doesn't have a model called 'm'"],
    [429, 'rate limit, quota or spend limit'],
    [503, "'m' model is overloaded"],
    [500, 'having problems right now (error 500)'],
    [400, 'rejected the request (error 400)']
  ])('maps %i to our own words', (status, expected) => {
    const error = modelErrorFrom(apiError(status), 'm')
    expect(error).toBeInstanceOf(ModelError)
    expect(error.message).toContain(expected)
    expect(error.message).not.toContain('secret detail')
  })

  it.each([
    [401, "Claude didn't accept your API key", 'the Claude Console'],
    [402, 'Claude API credits are used up', 'the Claude Console'],
    [403, 'refused this request for your API key', 'the Claude Console'],
    [404, "Claude doesn't have a model called 'm'", 'LLM_MODEL_ID'],
    [413, 'too long for Claude', 'Restart the app'],
    [529, "Claude's 'm' model is overloaded right now (error 529)", 'another model']
  ])('maps Claude %i to our own words', (status, expected, hint) => {
    const error = modelErrorFrom(apiError(status), 'm', 'claude')
    expect(error.message).toContain(expected)
    expect(error.message).toContain(hint)
    expect(error.message).not.toContain('secret detail')
  })

  it('treats a Claude 400 about the credit balance as a billing problem', () => {
    const body = '{"error":{"message":"Your credit balance is too low"}}'
    expect(modelErrorFrom(apiError(400, body), 'm', 'claude').message).toContain('credits')
    // A Gemini 400 about an API key is a bad key, but not for Claude.
    const keyBody = '{"error":{"message":"API key not valid"}}'
    expect(modelErrorFrom(apiError(400, keyBody), 'm', 'claude').message).toContain('error 400')
  })

  it('reports the last failure when the SDK gave up retrying', () => {
    const retry = new RetryError({
      message: 'Failed after 3 attempts. Last error: secret detail',
      reason: 'maxRetriesExceeded',
      errors: [apiError(503), apiError(503)]
    })
    const error = modelErrorFrom(retry, 'm')
    expect(error.message).toContain("'m' model is overloaded")
    expect(error.message).not.toContain('secret detail')
  })

  it('treats a 400 about the API key as a bad key', () => {
    const error = modelErrorFrom(apiError(400, '{"error":{"message":"API key not valid"}}'), 'm')
    expect(error.message).toContain("didn't accept your API key")
  })
})
