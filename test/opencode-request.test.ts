import { test, expect, vi } from 'vitest'
import { opencodeRequest } from '../src/backends/opencode/request.ts'
import { readEventStream } from '../src/backends/opencode/sse.ts'
import { authHeader } from '../src/backends/opencode/client.ts'
import { probeServer } from '../src/backends/opencode/server-manager.ts'

const reply = (status: number, text: string) => Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(text) })

// The one request helper both API versions go through (#186).
test('sends the query, credential and extra headers, and parses the JSON reply', async () => {
  const fetchImpl = vi.fn(() => reply(200, '{"a":1}'))
  const out = await opencodeRequest(fetchImpl as any, 'http://h', 'POST', '/p', { body: { x: 1 }, auth: 'Basic z', query: '?directory=%2Fd', headers: { 'x-extra': 'v' } })
  expect(out).toEqual({ a: 1 })
  expect(fetchImpl).toHaveBeenCalledWith('http://h/p?directory=%2Fd', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Basic z', 'x-extra': 'v' },
    body: '{"x":1}',
    signal: expect.any(AbortSignal),
  })
})

test('no body and no credential send neither header; an empty 2xx is null', async () => {
  const fetchImpl = vi.fn(() => reply(204, ''))
  expect(await opencodeRequest(fetchImpl as any, 'http://h', 'GET', '/p')).toBeNull()
  expect(fetchImpl).toHaveBeenCalledWith('http://h/p', expect.objectContaining({ headers: {}, body: undefined }))
})

test('a refusal throws with its status, the path without the query, and a cleaned body', async () => {
  const fetchImpl = vi.fn(() => reply(403, `no${String.fromCharCode(27)}[2J`))
  const err: any = await opencodeRequest(fetchImpl as any, 'http://h', 'GET', '/p', { query: '?directory=secret' }).catch((e: any) => e)
  expect(err.status).toBe(403)
  expect(err.message).toMatch(/^GET \/p → 403: no/)
  expect(err.message).not.toContain('secret')
  expect(err.message).not.toContain(String.fromCharCode(27))
})

// #216: fleetview's server dies, something else takes the port, and fleetview keeps talking to it.
test('after a lost connection the credential waits for a pid-matched probe, on requests and the event stream', async () => {
  vi.stubEnv('OPENCODE_SERVER_PASSWORD', 'hunter2')
  const base = 'http://127.0.0.1:4999'
  let listener: 'ours' | 'squatter' = 'ours'
  const shown: Record<string, Array<string | undefined>> = { ours: [], squatter: [] }
  const json = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) })
  const fetchImpl = vi.fn(async (url: string, init: any = {}) => {
    const auth: string | undefined = init.headers?.authorization
    const path = new URL(url).pathname
    // The squatter passes as a passwordless 1.x: healthy without ever asking for the credential.
    if (path === '/project') return listener === 'squatter' ? json(200, [{ id: 'g', worktree: '/' }]) : { ok: true, status: 200, json: async () => { throw new SyntaxError('html') } }
    // The probe's route: 2.x's own 401 until the credential is shown, then the answering pid.
    if (path === '/api/info') return auth ? json(200, { version: '2.3.2', pid: listener === 'ours' ? 42 : 666 }) : json(401, { _tag: 'UnauthorizedError' })
    shown[listener].push(auth)
    if (path === '/api/event') {
      if (listener !== 'ours') return json(401, {})
      // Fleetview's server dies: the open stream ends.
      return { ok: true, status: 200, headers: { get: () => 'text/event-stream' }, body: (async function* () {})() }
    }
    return json(200, [])
  }) as any
  const stream = () => readEventStream(`${base}/api/event`, { fetchImpl, signal: new AbortController().signal, idleMs: 60_000, onOpen: () => {}, onChunk: () => {} }).catch(() => {})
  const request = () => opencodeRequest(fetchImpl, base, 'GET', '/api/session', { auth: authHeader() }).catch(() => {})
  const server = { host: '127.0.0.1', port: 4999, pid: 42, api: 2 as const }
  try {
    await request()
    await stream()
    expect(shown.ours).toEqual([authHeader(), authHeader()])
    listener = 'squatter'
    await request()
    await stream()
    // A healthy answer that never asked for the credential proves nothing: still withheld.
    expect(await probeServer(server, fetchImpl, () => null)).toBe('healthy')
    await request()
    expect(shown.squatter).toEqual([undefined, undefined, undefined])
    listener = 'ours'
    expect(await probeServer(server, fetchImpl, () => null)).toBe('healthy')
    await request()
    expect(shown.ours.at(-1)).toBe(authHeader())
  } finally {
    vi.unstubAllEnvs()
  }
})
