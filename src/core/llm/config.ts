import { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { LanguageModel } from 'ai'
import type { SecretStore } from '../ports'
import { guardedFetch } from '../safety/network'
import { ModelError } from './errors'
import { MockModel } from './mock'

/** Secret store key for the user's Gemini API key (from Google AI Studio). */
export const GEMINI_API_KEY = 'gemini_api_key'

export type Provider = 'mock' | 'gemini'

/**
 * Longest wait for a model API to start answering. Overloaded models sometimes accept a
 * request and then send nothing; without this the run would wait forever.
 */
export const MODEL_RESPONSE_TIMEOUT_MS = 60_000

/** The only hosts each model provider may reach. */
export const PROVIDER_HOSTS: Record<Exclude<Provider, 'mock'>, readonly string[]> = {
  gemini: ['generativelanguage.googleapis.com']
}

export const PROVIDERS: readonly Provider[] = ['mock', 'gemini']
export const isProvider = (value: string): value is Provider =>
  PROVIDERS.includes(value as Provider)

/** How each provider is named to the user. */
export const PROVIDER_NAMES: Record<Provider, string> = {
  mock: 'Offline demo',
  gemini: 'Gemini'
}

/** Model IDs: letters, digits and . _ : / - (no spaces), as providers name them. */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/

/** Which model to use: from .env at startup, or the user's choice in Settings. */
export interface LlmConfig {
  provider: Provider
  modelId?: string
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

/** Reads LLM_PROVIDER (default mock) and LLM_MODEL_ID. The API key never comes from the environment. */
export function llmConfigFromEnv(env: Record<string, string | undefined>): LlmConfig {
  const value = (name: string): string | undefined => env[name]?.trim() || undefined
  const provider = value('LLM_PROVIDER') ?? 'mock'
  if (provider === 'vertex' || provider === 'agent_platform') {
    throw new ConfigError(
      `LLM_PROVIDER=${provider} is no longer supported (Gemini Enterprise Agent Platform was removed); use LLM_PROVIDER=gemini and add your API key in Settings`
    )
  }
  if (provider === 'claude' || provider === 'anthropic') {
    throw new ConfigError(
      `LLM_PROVIDER=${provider} is no longer supported (the app uses Gemini only); use LLM_PROVIDER=gemini and add your API key in Settings`
    )
  }
  if (!isProvider(provider)) {
    throw new ConfigError(`Unknown LLM_PROVIDER=${provider}; use mock or gemini`)
  }
  const modelId = value('LLM_MODEL_ID')
  if (provider !== 'mock' && !modelId) {
    throw new ConfigError(`LLM_PROVIDER=${provider} needs LLM_MODEL_ID to be set`)
  }
  return { provider, modelId }
}

/**
 * Builds the configured model. A missing key is a ModelError the user can fix in Settings.
 * Never hard-code a model id: they change often.
 */
export async function createModel(config: LlmConfig, secrets: SecretStore): Promise<LanguageModel> {
  const modelId = config.modelId ?? ''
  switch (config.provider) {
    case 'mock':
      return MockModel.demo({ delayMs: 30 })
    case 'gemini':
      return createGoogleGenerativeAI({
        apiKey: await requireKey(secrets, GEMINI_API_KEY, 'Gemini'),
        fetch: guardedFetch({
          allowedHosts: PROVIDER_HOSTS.gemini,
          responseTimeoutMs: MODEL_RESPONSE_TIMEOUT_MS
        })
      })(modelId)
  }
}

async function requireKey(secrets: SecretStore, key: string, name: string): Promise<string> {
  const apiKey = await secrets.get(key)
  if (!apiKey) throw new ModelError(`Add your ${name} API key in Settings to start chatting.`)
  return apiKey
}
