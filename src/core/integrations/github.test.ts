import { describe, expect, it } from 'vitest'
import { MemorySecretStore } from '../ports'
import { FakeConfirmation, runtime } from '../testing'
import { ToolInputError, ToolRegistry, type ToolRuntime } from '../tools'
import { GITHUB_TOKEN, GitHubApi, searchQuery } from './github'
import { registerTools } from '.'

interface Seen {
  url: URL
  headers: Record<string, string>
}

function fakeFetch(respond: () => Response, seen: Seen[] = []): typeof fetch {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    seen.push({ url: new URL(String(input)), headers: init?.headers as Record<string, string> })
    return respond()
  }) as typeof fetch
}

async function setup(
  respond: () => Response,
  token?: string
): Promise<{ registry: ToolRegistry; rt: ToolRuntime; seen: Seen[] }> {
  const seen: Seen[] = []
  const registry = registerTools(
    new ToolRegistry(),
    new GitHubApi(fakeFetch(respond, seen), 'https://gh.test')
  )
  const rt = runtime(new FakeConfirmation())
  rt.secrets = new MemorySecretStore()
  if (token) await rt.secrets.set(GITHUB_TOKEN, token)
  return { registry, rt, seen }
}

const item = (number: number, title: string): object => ({
  number,
  title,
  html_url: `https://github.com/acme/web/pull/${number}`,
  repository_url: 'https://api.github.com/repos/acme/web',
  state: 'open',
  updated_at: '2026-11-15T16:02:00Z',
  user: { login: 'mchen' },
  labels: [{ name: 'bug' }, { name: 'ui' }],
  comments: 3,
  draft: false,
  extra_field: { ignored: true }
})

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  })

describe('GitHub tools', () => {
  it('lists review requests with a safe query and trimmed fields', async () => {
    const { registry, rt, seen } = await setup(
      () =>
        json({
          total_count: 7,
          incomplete_results: true,
          items: [item(482, 'x'.repeat(300)), item(483, 'b'), item(484, 'c')]
        }),
      'ghp_test'
    )
    const result = (await registry.call(
      'github_list_pull_requests',
      { repo: 'acme/web', limit: 2 },
      'c1',
      rt
    )) as {
      pull_requests: Array<Record<string, unknown>>
      total: number
      note: string
    }
    expect(seen[0].url.searchParams.get('q')).toBe(
      'is:pr is:open archived:false review-requested:@me repo:acme/web'
    )
    expect(seen[0].url.searchParams.get('per_page')).toBe('2')
    expect(seen[0].headers.Authorization).toBe('Bearer ghp_test')
    expect(result.total).toBe(7)
    expect(result.note).toContain('partial')
    expect(result.pull_requests).toHaveLength(2)
    expect(result.pull_requests[0]).toMatchObject({
      repo: 'acme/web',
      author: 'mchen',
      labels: ['bug', 'ui']
    })
    expect([...(result.pull_requests[0].title as string)]).toHaveLength(200)
    expect(result.pull_requests[0]).not.toHaveProperty('extra_field')
  })

  it('uses issue qualifiers for issues', () => {
    expect(searchQuery('issue', 'mentions:@me')).toBe(
      'is:issue is:open archived:false mentions:@me'
    )
  })

  it('says not connected without a token and makes no request', async () => {
    const { registry, rt, seen } = await setup(() => json({}))
    expect(await registry.call('github_list_pull_requests', {}, 'c1', rt)).toMatchObject({
      status: 'not_connected'
    })
    expect(seen).toEqual([])
  })

  it('rejects smuggled search qualifiers and bad limits', async () => {
    const { registry, rt, seen } = await setup(() => json({}), 't')
    for (const input of [
      { repo: 'acme/web is:closed' },
      { repo: 'acme' },
      { repo: '-acme/web' },
      { limit: 31 }
    ]) {
      await expect(
        registry.call('github_list_pull_requests', input, 'c1', rt)
      ).rejects.toBeInstanceOf(ToolInputError)
    }
    expect(seen).toEqual([])
  })

  it.each([
    [401, {}, 'unauthorized'],
    [403, { 'x-ratelimit-remaining': '0' }, 'rate_limited'],
    [403, { 'x-ratelimit-remaining': '10' }, 'forbidden'],
    [422, {}, 'invalid_query'],
    [429, {}, 'rate_limited'],
    [502, {}, 'unavailable']
  ])('turns HTTP %i into a plain error result', async (status, headers, code) => {
    const { registry, rt } = await setup(
      () => json({ message: "GitHub's own words" }, status, headers),
      'ghp_secret'
    )
    const result = await registry.call('github_list_pull_requests', {}, 'c1', rt)
    expect(result).toMatchObject({ status: 'error', error: code })
    expect(JSON.stringify(result)).not.toMatch(/ghp_secret|GitHub's own words/)
  })

  it('only reaches api.github.com by default, and reports a blocked request plainly', async () => {
    const registry = registerTools(
      new ToolRegistry(),
      new GitHubApi(undefined, 'http://127.0.0.1:9')
    )
    const rt = runtime(new FakeConfirmation())
    await rt.secrets.set(GITHUB_TOKEN, 'ghp_test')
    const result = await registry.call('github_list_issues', {}, 'c1', rt)
    expect(result).toMatchObject({ status: 'error', error: 'blocked' })
    expect(JSON.stringify(result)).toContain('only HTTPS')
    expect(registry.specs().find((s) => s.name === 'github_list_issues')?.networkHosts).toEqual([
      'api.github.com'
    ])
  })

  it('reports a garbage response instead of passing it on', async () => {
    const { registry, rt } = await setup(() => new Response('<html>not json</html>'), 't')
    expect(await registry.call('github_list_pull_requests', {}, 'c1', rt)).toMatchObject({
      error: 'unexpected_response'
    })
  })
})
