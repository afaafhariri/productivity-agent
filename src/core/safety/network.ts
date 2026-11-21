/**
 * The only way the agent reaches the network: a `fetch` that allows HTTPS to a fixed list of
 * hosts, and refuses any host that resolves to a private, loopback, link-local or otherwise
 * non-public address. Redirects are followed by hand so every hop is checked the same way.
 *
 * Known limit: the address check and the connection each resolve DNS, so a host that changes
 * its answer in between (DNS rebinding) isn't caught. The allow-list of well-known API hosts
 * keeps that risk small.
 */
import { lookup } from 'node:dns/promises'
import { isIPv4, isIPv6 } from 'node:net'

export class NetworkPolicyError extends Error {
  override readonly name = 'NetworkPolicyError'
}

/** Resolves a hostname to every address it points at. */
export type Resolve = (hostname: string) => Promise<string[]>

export const resolveWithDns: Resolve = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address)

export interface NetworkPolicy {
  /** Exact hostnames, e.g. `api.github.com`. Subdomains are not included. */
  allowedHosts: readonly string[]
  fetchFn?: typeof fetch
  resolve?: Resolve
  maxRedirects?: number
  /**
   * Longest wait for a response to start (status and headers). Only that wait is bounded: once
   * the response starts, the body may stream for as long as it needs.
   */
  responseTimeoutMs?: number
}

/** Headers that carry credentials; never forwarded to a different host on redirect. */
const CREDENTIAL_HEADERS = ['authorization', 'x-api-key', 'x-goog-api-key', 'cookie']

export function guardedFetch(policy: NetworkPolicy): typeof fetch {
  const allowed = new Set(policy.allowedHosts.map((host) => host.toLowerCase()))
  const base = policy.fetchFn ?? fetch
  const resolve = policy.resolve ?? resolveWithDns
  const maxRedirects = policy.maxRedirects ?? 3
  const { responseTimeoutMs } = policy

  /** One request, failing with a TimeoutError if no response starts in time. */
  const send = async (target: URL | Request, init: RequestInit): Promise<Response> => {
    if (!responseTimeoutMs) return base(target, init)
    const timer = new AbortController()
    const handle = setTimeout(
      () =>
        timer.abort(
          new DOMException(`No response within ${responseTimeoutMs / 1000} seconds`, 'TimeoutError')
        ),
      responseTimeoutMs
    )
    const signal = init.signal ? AbortSignal.any([init.signal, timer.signal]) : timer.signal
    try {
      return await base(target, { ...init, signal })
    } finally {
      clearTimeout(handle)
    }
  }

  const check = async (url: URL): Promise<void> => {
    const host = url.hostname.toLowerCase()
    if (url.protocol !== 'https:')
      throw new NetworkPolicyError(
        `Blocked ${url.protocol} request to ${host}: only HTTPS is allowed`
      )
    if (url.username || url.password)
      throw new NetworkPolicyError(`Blocked request to ${host}: credentials in the URL`)
    if (url.port && url.port !== '443')
      throw new NetworkPolicyError(
        `Blocked request to ${host}:${url.port}: only the default port is allowed`
      )
    if (!allowed.has(host))
      throw new NetworkPolicyError(`Blocked request to ${host}: not an allowed host`)
    const addresses = await resolve(host)
    if (addresses.length === 0)
      throw new NetworkPolicyError(`Blocked request to ${host}: it has no address`)
    const blocked = addresses.find((address) => !isPublicAddress(address))
    if (blocked)
      throw new NetworkPolicyError(
        `Blocked request to ${host}: it points at a non-public address (${blocked})`
      )
  }

  const guarded = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (input instanceof Request) {
      // Rare in our code; checked once, and redirects are returned rather than followed.
      await check(new URL(input.url))
      return send(input, { ...init, redirect: 'manual' })
    }
    let url = new URL(input)
    let requestInit: RequestInit = { ...init }
    for (let hop = 0; ; hop++) {
      await check(url)
      const response = await send(url, { ...requestInit, redirect: 'manual' })
      const location = response.headers.get('location')
      if (response.status < 300 || response.status > 399 || response.status === 304 || !location) {
        return response
      }
      if (hop >= maxRedirects)
        throw new NetworkPolicyError(`Blocked request to ${url.hostname}: too many redirects`)
      const next = new URL(location, url)
      const method = (requestInit.method ?? 'GET').toUpperCase()
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method === 'POST')
      ) {
        requestInit = { ...requestInit, method: 'GET', body: undefined }
      }
      if (next.hostname.toLowerCase() !== url.hostname.toLowerCase()) {
        const headers = new Headers(requestInit.headers)
        CREDENTIAL_HEADERS.forEach((name) => headers.delete(name))
        requestInit = { ...requestInit, headers }
      }
      url = next
    }
  }
  return guarded as typeof fetch
}

/** True only for globally routable unicast addresses. */
export function isPublicAddress(address: string): boolean {
  const ip = address.split('%')[0] ?? '' // drop an IPv6 zone id
  if (isIPv4(ip)) return isPublicV4(ip)
  if (isIPv6(ip)) return isPublicV6(ip)
  return false
}

const V4_BLOCKED: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4] // reserved and broadcast
]

const v4ToInt = (ip: string): number =>
  ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0)

function isPublicV4(ip: string): boolean {
  const value = v4ToInt(ip)
  return !V4_BLOCKED.some(([network, bits]) => {
    const size = 2 ** (32 - bits)
    const start = v4ToInt(network)
    return value >= start && value < start + size
  })
}

/** Expands an IPv6 address to eight 16-bit groups (with an embedded IPv4 tail converted). */
function v6Groups(ip: string): number[] {
  let text = ip.toLowerCase()
  const v4Tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  if (v4Tail) {
    const n = v4ToInt(v4Tail)
    text = `${text.slice(0, -v4Tail.length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const [head = '', tail] = text.split('::')
  const parse = (part: string): number[] =>
    part ? part.split(':').map((g) => parseInt(g, 16)) : []
  const left = parse(head)
  const right = tail === undefined ? [] : parse(tail)
  const zeros = new Array<number>(8 - left.length - right.length).fill(0)
  return [...left, ...zeros, ...right]
}

const groupsToV4 = (high: number, low: number): string =>
  [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')

function isPublicV6(ip: string): boolean {
  const g = v6Groups(ip)
  const [a = 0, b = 0, , , , f = 0, x = 0, y = 0] = g
  if (g.slice(0, 6).every((n) => n === 0)) return false // ::, ::1 and IPv4-compatible
  if (g.slice(0, 5).every((n) => n === 0) && f === 0xffff) return isPublicV4(groupsToV4(x, y)) // ::ffff:a.b.c.d
  if (a === 0x64 && b === 0xff9b && g.slice(2, 6).every((n) => n === 0))
    return isPublicV4(groupsToV4(x, y)) // NAT64
  if (a === 0x2002) return isPublicV4(groupsToV4(b, g[2] ?? 0)) // 6to4
  if ((a & 0xfe00) === 0xfc00) return false // unique local
  if ((a & 0xffc0) === 0xfe80) return false // link-local
  if ((a & 0xff00) === 0xff00) return false // multicast
  if (a === 0x2001 && b === 0x0db8) return false // documentation
  return true
}
