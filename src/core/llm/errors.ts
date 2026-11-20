import { APICallError } from '@ai-sdk/provider'
import { RetryError } from 'ai'
import type { Provider } from './config'

/**
 * A model call failed for a reason the user can act on (bad key, no credit, rate limit, ...).
 * The message is shown to the user, so it must never contain secrets.
 */
export class ModelError extends Error {
  override readonly name = 'ModelError'
}

/** How each provider is named in messages, and where its key and limits are managed. */
const PROVIDERS: Record<Provider, { name: string; console: string }> = {
  mock: { name: 'The demo model', console: 'Settings' },
  gemini: { name: 'Gemini', console: 'Google AI Studio' },
  claude: { name: 'Claude', console: 'the Claude Console' }
}

/** Our own wording for provider failures; the provider's text is only logged. */
export function modelErrorFrom(
  error: unknown,
  modelId: string,
  provider: Provider = 'gemini'
): ModelError {
  if (error instanceof ModelError) return error
  // The AI SDK retries 429/5xx itself and then wraps the last failure; report that one.
  if (RetryError.isInstance(error)) return modelErrorFrom(error.lastError, modelId, provider)
  const { name, console } = PROVIDERS[provider]
  if (isTimeout(error)) {
    return new ModelError(`${name} didn't respond in time. It may be busy; try again in a moment.`)
  }
  if (!APICallError.isInstance(error)) return new ModelError('The run failed. See logs.')

  const status = normalisedStatus(error, provider)
  if (status === 401 || (status === 403 && provider !== 'claude')) {
    return new ModelError(
      `${name} didn't accept your API key. Check it in Settings, or create a new one in ${console}.`
    )
  }
  if (status === 403) {
    return new ModelError(
      `${name} refused this request for your API key's organization (error 403). Check its access settings in ${console}.`
    )
  }
  if (status === 402) {
    return new ModelError(
      `Your ${name} API credits are used up or billing needs attention. Add credits in ${console}, then try again.`
    )
  }
  if (status === 404) {
    return new ModelError(
      `${name} doesn't have a model called '${modelId}' that your key can use. Set LLM_MODEL_ID to a current model and restart the app.`
    )
  }
  if (status === 413) {
    return new ModelError(
      `This conversation is too long for ${name} (error 413). Restart the app to start a new one.`
    )
  }
  if (status === 429) {
    return new ModelError(
      `${name}'s rate limit, quota or spend limit was reached. Wait a moment and try again, or check your limits in ${console}.`
    )
  }
  if (status === 503 || status === 529) {
    return new ModelError(
      `${name}'s '${modelId}' model is overloaded right now (error ${status}). Try again in a moment, or set LLM_MODEL_ID to another model and restart the app.`
    )
  }
  if (status >= 500) {
    return new ModelError(
      `${name} is having problems right now (error ${status}). Try again in a moment.`
    )
  }
  if (status > 0) return new ModelError(`${name} rejected the request (error ${status}).`)
  return new ModelError(`Couldn’t reach ${name}. Check your internet connection and try again.`)
}

/** Some failures arrive as a 400 whose body says what really happened. */
function normalisedStatus(error: APICallError, provider: Provider): number {
  const status = error.statusCode ?? 0
  if (status !== 400) return status
  const body = (error.responseBody ?? '').toLowerCase()
  if (provider === 'gemini' && body.includes('api key')) return 401 // Gemini reports bad keys as 400.
  if (provider === 'claude' && body.includes('credit balance')) return 402
  return status
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === 'TimeoutError' || /timed? ?out/i.test(error.message))
  )
}
