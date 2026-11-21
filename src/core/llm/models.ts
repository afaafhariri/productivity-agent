/**
 * The models a provider offers right now, read from its own API with the user's key, so the
 * Settings dropdown never relies on a built-in list that goes stale.
 *
 * Anything the API returns is untrusted: only a few fields are read, IDs must look like model
 * IDs, names are clipped, and the list is capped.
 */
import { z } from 'zod'
import { MODEL_ID_PATTERN } from './config'

export interface ModelOption {
  id: string
  /** Readable name, e.g. "Claude Opus 5.5". */
  name: string
}

export type ModelList =
  | { status: 'ok'; models: ModelOption[] }
  | { status: 'no_key' }
  | { status: 'error'; message: string }

export const MAX_MODELS = 200
const MAX_NAME_CHARS = 80
const MAX_PAGES = 5
export const LIST_TIMEOUT_MS = 15_000

const ANTHROPIC_VERSION = '2023-06-01'

const ClaudePage = z.object({
  data: z.array(z.object({ id: z.string(), display_name: z.string().optional() })),
  has_more: z.boolean().optional(),
  last_id: z.string().nullish()
})

const GeminiPage = z.object({
  models: z
    .array(
      z.object({
        name: z.string(),
        displayName: z.string().optional(),
        supportedGenerationMethods: z.array(z.string()).optional()
      })
    )
    .default([]),
  nextPageToken: z.string().optional()
})

/** Why a list couldn't be loaded, in words the user can act on. */
export class ModelListError extends Error {
  override readonly name = 'ModelListError'
}

/** Lists Claude models, newest first (the API's own order). */
export async function listClaudeModels(
  apiKey: string,
  fetchFn: typeof fetch
): Promise<ModelOption[]> {
  const models: ModelOption[] = []
  let after: string | undefined
  for (let page = 0; page < MAX_PAGES && models.length < MAX_MODELS; page++) {
    const url = new URL('https://api.anthropic.com/v1/models')
    url.searchParams.set('limit', '100')
    if (after) url.searchParams.set('after_id', after)
    const body = ClaudePage.safeParse(
      await getJson(
        url,
        { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
        'Claude',
        fetchFn
      )
    )
    if (!body.success) throw new ModelListError('Claude sent a model list the app could not read.')
    for (const m of body.data.data) add(models, m.id, m.display_name)
    if (!body.data.has_more || !body.data.last_id) break
    after = body.data.last_id
  }
  return models
}

/** Lists Gemini models that can chat (generateContent), newest-looking versions first. */
export async function listGeminiModels(
  apiKey: string,
  fetchFn: typeof fetch
): Promise<ModelOption[]> {
  const models: ModelOption[] = []
  let token: string | undefined
  for (let page = 0; page < MAX_PAGES && models.length < MAX_MODELS; page++) {
    const url = new URL('https://generativelanguage.googleapis.com/v1beta/models')
    url.searchParams.set('pageSize', '1000')
    if (token) url.searchParams.set('pageToken', token)
    const body = GeminiPage.safeParse(
      await getJson(url, { 'x-goog-api-key': apiKey }, 'Gemini', fetchFn)
    )
    if (!body.success) throw new ModelListError('Gemini sent a model list the app could not read.')
    for (const m of body.data.models) {
      if (!m.supportedGenerationMethods?.includes('generateContent')) continue
      add(models, m.name.replace(/^models\//, ''), m.displayName)
    }
    if (!body.data.nextPageToken) break
    token = body.data.nextPageToken
  }
  // Google's order isn't by release; higher version numbers first is a good stand-in.
  return models.sort((a, b) => b.id.localeCompare(a.id, 'en', { numeric: true }))
}

function add(models: ModelOption[], id: string, displayName: string | undefined): void {
  if (models.length >= MAX_MODELS || !MODEL_ID_PATTERN.test(id)) return
  if (models.some((m) => m.id === id)) return
  const name = (displayName ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_CHARS) || id
  models.push({ id, name })
}

async function getJson(
  url: URL,
  headers: Record<string, string>,
  provider: string,
  fetchFn: typeof fetch
): Promise<unknown> {
  let response: Response
  try {
    response = await fetchFn(url, { headers, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) })
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new ModelListError(`${provider} took too long to list its models. Try again.`)
    }
    throw new ModelListError(`Couldn't reach ${provider} to list its models.`)
  }
  if (response.status === 401 || response.status === 403 || response.status === 400) {
    // Gemini reports a bad key as 400.
    throw new ModelListError(
      `${provider} didn't accept your API key, so its models can't be listed.`
    )
  }
  if (!response.ok) {
    throw new ModelListError(
      `${provider} couldn't list its models right now (error ${response.status}).`
    )
  }
  return response.json().catch(() => undefined)
}
