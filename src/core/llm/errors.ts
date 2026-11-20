import { APICallError } from '@ai-sdk/provider'
import { RetryError } from 'ai'

/**
 * A model call failed for a reason the user can act on (bad key, no credit, rate limit, ...).
 * The message is shown to the user, so it must never contain secrets.
 */
export class ModelError extends Error {
  override readonly name = 'ModelError'
}

/** Our own wording for provider failures; the provider's text is only logged. */
export function modelErrorFrom(error: unknown, modelId: string): ModelError {
  if (error instanceof ModelError) return error
  // The AI SDK retries 429/5xx itself and then wraps the last failure; report that one.
  if (RetryError.isInstance(error)) return modelErrorFrom(error.lastError, modelId)
  if (isTimeout(error)) {
    return new ModelError("Gemini didn't respond in time. It may be busy; try again in a moment.")
  }
  if (APICallError.isInstance(error)) {
    let status = error.statusCode ?? 0
    const body = (error.responseBody ?? '').toLowerCase()
    if (status === 400 && body.includes('api key')) status = 401 // Gemini reports bad keys as 400.
    if (status === 401 || status === 403) {
      return new ModelError(
        "Gemini didn't accept your API key. Check it in Settings, or create a new one in Google AI Studio."
      )
    }
    if (status === 402) {
      return new ModelError(
        "Your Gemini API credits are used up. Top up your project's prepaid balance in Google AI Studio, then try again."
      )
    }
    if (status === 404) {
      return new ModelError(
        `Gemini doesn't have a model called '${modelId}'. Set LLM_MODEL_ID to a current model and restart the app.`
      )
    }
    if (status === 429) {
      return new ModelError(
        "Gemini's rate limit or quota was reached. Wait a moment and try again, or check your project's limits in Google AI Studio."
      )
    }
    if (status === 503) {
      return new ModelError(
        `Gemini's '${modelId}' model is overloaded right now (error 503). Try again in a moment, or set LLM_MODEL_ID to another model and restart the app.`
      )
    }
    if (status >= 500) {
      return new ModelError(
        `Gemini is having problems right now (error ${status}). Try again in a moment.`
      )
    }
    if (status > 0) return new ModelError(`Gemini rejected the request (error ${status}).`)
    return new ModelError('Couldn’t reach Gemini. Check your internet connection and try again.')
  }
  return new ModelError('The run failed. See logs.')
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === 'TimeoutError' || /timed? ?out/i.test(error.message))
  )
}
