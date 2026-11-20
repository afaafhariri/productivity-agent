import { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { LanguageModel } from 'ai'
import type { SecretStore } from '../ports'
import { ModelError } from './errors'
import { MockModel } from './mock'

/** Secret store key for the user's Gemini API key (from Google AI Studio). */
export const GEMINI_API_KEY = 'gemini_api_key'

export type Provider = 'mock' | 'gemini'

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
  if (provider !== 'mock' && provider !== 'gemini') {
    throw new ConfigError(`Unknown LLM_PROVIDER=${provider}; use mock or gemini`)
  }
  const modelId = value('LLM_MODEL_ID')
  if (provider === 'gemini' && !modelId) {
    throw new ConfigError('LLM_PROVIDER=gemini needs LLM_MODEL_ID to be set')
  }
  return { provider, modelId }
}

/**
 * Builds the configured model. A missing Gemini key is a ModelError the user can fix in
 * Settings. Never hard-code a model id: they change often.
 */
export async function createModel(config: LlmConfig, secrets: SecretStore): Promise<LanguageModel> {
  if (config.provider === 'mock') return MockModel.demo({ delayMs: 30 })
  const apiKey = await secrets.get(GEMINI_API_KEY)
  if (!apiKey) throw new ModelError('Add your Gemini API key in Settings to start chatting.')
  return createGoogleGenerativeAI({ apiKey })(config.modelId ?? '')
}
