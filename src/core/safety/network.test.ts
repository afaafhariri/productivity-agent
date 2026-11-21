import { describe, expect, it } from 'vitest'
import { NetworkPolicyError, guardedFetch, isPublicAddress, type Resolve } from './network'

describe('isPublicAddress', () => {
  it.each([
    ['140.82.112.6', true],
    ['8.8.8.8', true],
    ['2606:4700:4700::1111', true],
    ['::ffff:140.82.112.6', true],
    ['127.0.0.1', false],
    ['10.1.2.3', false],
    ['172.16.0.1', false],
    ['172.31.255.255', false],
    ['172.32.0.1', true],
    ['192.168.1.1', false],
    ['169.254.169.254', false],
    ['100.64.0.1', false],
    ['0.0.0.0', false],
    ['224.0.0.1', false],
    ['255.255.255.255', false],
    ['::', false],
    ['::1', false],
    ['::ffff:127.0.0.1', false],
    ['::ffff:7f00:1', false],
    ['64:ff9b::a9fe:a9fe', false],
    ['2002:c0a8:0101::1', false],
    ['fd00::1', false],
    ['fe80::1%en0', false],
    ['ff02::1', false],
    ['2001:db8::1', false],
    ['not-an-ip', false]
  ])('%s → %s', (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected)
  })
})

interface Call {
  url: string
  headers: Headers
  method: string
}

function setup(
  responses: Array<{ status: number; location?: string }> = [{ status: 200 }],
  addresses: Record<string, string[]> = {
    'api.example.com': ['140.82.112.6'],
    'cdn.example.com': ['140.82.112.7']
  }
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const queue = [...responses]
  const fetchFn = (async (input: URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      method: init?.method ?? 'GET'
    })
    expect(init?.redirect).toBe('manual')
    const next = queue.shift() ?? { status: 200 }
    return new Response(null, {
      status: next.status,
      headers: next.location ? { location: next.location } : {}
    })
  }) as typeof fetch
  const resolve: Resolve = async (host) => addresses[host] ?? []
  return {
    fetch: guardedFetch({
      allowedHosts: ['api.example.com', 'cdn.example.com'],
      fetchFn,
      resolve
    }),
    calls
  }
}

describe('guardedFetch', () => {
  it('lets HTTPS requests to allowed public hosts through', async () => {
    const { fetch, calls } = setup()
    const response = await fetch('https://api.example.com/x', {
      headers: { authorization: 'Bearer t' }
    })
    expect(response.status).toBe(200)
    expect(calls.map((c) => c.url)).toEqual(['https://api.example.com/x'])
  })

  it.each([
    ['http://api.example.com/x', /only HTTPS/],
    ['https://evil.example.org/x', /not an allowed host/],
    ['https://API.example.com.evil.org/x', /not an allowed host/],
    ['https://user:pw@api.example.com/x', /credentials in the URL/],
    ['https://api.example.com:8443/x', /default port/],
    ['https://127.0.0.1/x', /not an allowed host/]
  ])('blocks %s', async (url, message) => {
    const { fetch, calls } = setup()
    await expect(fetch(url)).rejects.toThrow(message)
    await expect(fetch(url)).rejects.toBeInstanceOf(NetworkPolicyError)
    expect(calls).toEqual([])
  })

  it('blocks an allowed host that resolves to a private address', async () => {
    const { fetch, calls } = setup([{ status: 200 }], {
      'api.example.com': ['140.82.112.6', '10.0.0.5']
    })
    await expect(fetch('https://api.example.com/x')).rejects.toThrow(
      /non-public address \(10\.0\.0\.5\)/
    )
    expect(calls).toEqual([])
  })

  it('checks every redirect and drops credentials when the host changes', async () => {
    const { fetch, calls } = setup([
      { status: 301, location: '/moved' },
      { status: 302, location: 'https://cdn.example.com/file' },
      { status: 200 }
    ])
    await fetch('https://api.example.com/x', {
      headers: { authorization: 'Bearer t', 'x-other': '1' }
    })
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.example.com/x',
      'https://api.example.com/moved',
      'https://cdn.example.com/file'
    ])
    expect(calls[1]?.headers.get('authorization')).toBe('Bearer t')
    expect(calls[2]?.headers.get('authorization')).toBeNull()
    expect(calls[2]?.headers.get('x-other')).toBe('1')
  })

  it('refuses a redirect to a host that is not allowed', async () => {
    const { fetch, calls } = setup([
      { status: 302, location: 'http://169.254.169.254/latest/meta-data' }
    ])
    await expect(fetch('https://api.example.com/x')).rejects.toThrow(/only HTTPS/)
    expect(calls).toHaveLength(1)
  })

  it('stops after too many redirects', async () => {
    const loop = Array.from({ length: 5 }, () => ({ status: 302, location: '/again' }))
    const { fetch } = setup(loop)
    await expect(fetch('https://api.example.com/x')).rejects.toThrow(/too many redirects/)
  })

  it('turns a redirected POST into a GET without a body', async () => {
    const { fetch, calls } = setup([{ status: 303, location: '/done' }, { status: 200 }])
    await fetch('https://api.example.com/x', { method: 'POST', body: 'data' })
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET'])
  })
})
