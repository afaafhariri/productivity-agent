import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { LanguageModel } from 'ai'
import type { SecretStore } from '../ports'
import { ModelError } from './errors'
import { MockModel } from './mock'

/** Secret store key for the user's Gemini API key (from Google AI Studio). */
export const GEMINI_API_KEY = 'gemini_api_key'
/** Secret store key for the user's Claude API key (from the Claude Console). */
export const ANTHROPIC_API_KEY = 'anthropic_api_key'

export type Provider = 'mock' | 'gemini' | 'claude'

const PROVIDERS: readonly Provider[] = ['mock', 'gemini', 'claude']
const isProvider = (value: string): value is Provider => PROVIDERS.includes(value as Provider)

/** Configuration only a restart can change. */
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
  if (provider === 'anthropic') {
    throw new ConfigError('Unknown LLM_PROVIDER=anthropic; use LLM_PROVIDER=claude')
  }
  if (!isProvider(provider)) {
    throw new ConfigError(`Unknown LLM_PROVIDER=${provider}; use mock, gemini or claude`)
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
        apiKey: await requireKey(secrets, GEMINI_API_KEY, 'Gemini')
      })(modelId)
    case 'claude':
      return createAnthropic({ apiKey: await requireKey(secrets, ANTHROPIC_API_KEY, 'Claude') })(
        modelId
      )
  }
}

async function requireKey(secrets: SecretStore, key: string, name: string): Promise<string> {
  const apiKey = await secrets.get(key)
  if (!apiKey) throw new ModelError(`Add your ${name} API key in Settings to start chatting.`)
  return apiKey
}
