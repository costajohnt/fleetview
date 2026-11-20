import { beforeEach, test, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { connectEvents, createV2Translator, parseSseChunk } from '../src/backends/opencode/event-mux.ts'
import { resetOpencodeApiMemo } from '../src/backends/opencode/client.ts'

// Tests here reuse base URLs, and the API-version answer is memoised per URL module-wide.
beforeEach(resetOpencodeApiMemo)

test('parseSseChunk yields JSON payloads from data: lines, keeps partial tail', () => {
  const { events, rest } = parseSseChunk('data: {"type":"session.status"}\n\ndata: {"ty')
  expect(events).toEqual([{ type: 'session.status' }])
  expect(rest).toBe('data: {"ty')
})

test('parseSseChunk frames CRLF line endings (proxied/spec-compliant server)', () => {
  const { events, rest } = parseSseChunk('data: {"type":"a"}\r\n\r\ndata: {"type":"b"}\r\n\r\ndata: {"ty')
  expect(events).toEqual([{ type: 'a' }, { type: 'b' }])
  expect(rest).toBe('data: {"ty')
})

test('parseSseChunk skips malformed JSON without throwing', () => {
  const { events } = parseSseChunk('data: {nope}\n\ndata: {"type":"ok"}\n\n')
  expect(events).toEqual([{ type: 'ok' }])
})

test('connectEvents streams events to onEvent with directory', async () => {
  const chunks = ['data: {"type":"server.connected"}\n\n', 'data: {"type":"session.status","properties":{"sessionID":"s1","status":{"type":"busy"}}}\n\n']
  const body = (async function* () { for (const c of chunks) yield new TextEncoder().encode(c) })()
  const fetchImpl = vi.fn(() => Promise.resolve({ ok: true, body })) as any
  const onEvent = vi.fn()
  const conn = connectEvents({ host: '127.0.0.1', port: 4801, directory: '/repos/repoA' }, { fetchImpl, onEvent, onOffline: vi.fn(), onOnline: vi.fn(), reconnect: false })
  await conn.done
  expect(onEvent).toHaveBeenCalledWith('/repos/repoA', { type: 'server.connected' })
  expect(onEvent).toHaveBeenCalledWith('/repos/repoA', expect.objectContaining({ type: 'session.status' }))
})

test('connectEvents reports offline on connect failure', async () => {
  const fetchImpl = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')))
  const onOffline = vi.fn()
  const conn = connectEvents({ host: '127.0.0.1', port: 4801, directory: '/repos/repoA' }, { fetchImpl, onEvent: vi.fn(), onOffline, onOnline: vi.fn(), reconnect: false })
  await conn.done
  expect(onOffline).toHaveBeenCalledWith('/repos/repoA')
})

test('fetchImpl receives the directory-scoped event URL and an abort signal', async () => {
  const fetchImpl = vi.fn(() => Promise.reject(new Error('nope')))
  const conn = connectEvents({ host: 'h', port: 1, directory: '/repos/r' }, { fetchImpl, onEvent: vi.fn(), onOffline: vi.fn(), onOnline: vi.fn(), reconnect: false })
  await conn.done
  expect(fetchImpl).toHaveBeenCalledWith('http://h:1/event?directory=%2Frepos%2Fr', expect.objectContaining({ signal: expect.any(AbortSignal) }))
})

test('multi-byte UTF-8 split across chunks decodes correctly', async () => {
  const bytes = new TextEncoder().encode('data: {"type":"café"}\n\n')
  const splitAt = bytes.length - 5 // splits inside the multi-byte é
  const body = (async function* () { yield bytes.slice(0, splitAt); yield bytes.slice(splitAt) })()
  const fetchImpl = vi.fn(() => Promise.resolve({ ok: true, body })) as any
  const onEvent = vi.fn()
  const conn = connectEvents({ host: 'h', port: 1, directory: '/repos/r' }, { fetchImpl, onEvent, onOffline: vi.fn(), onOnline: vi.fn(), reconnect: false })
  await conn.done
  expect(onEvent).toHaveBeenCalledWith('/repos/r', { type: 'café' })
})

// Deterministic rather than timed: the old form measured performance.now() around stop() and
// asserted "< 500ms", which is a wall-clock guess that a loaded machine can lose. Under frozen fake
// timers, `done` settling at all proves the abort woke the backoff — a stop that waited for the
// 1000ms timer could never resolve here, because that timer is never advanced.
test('stop() during backoff resolves done without waiting out the backoff, and makes no further attempts', async () => {
  vi.useFakeTimers()
  try {
    let calls = 0
    // Counts stream attempts only: each attempt first asks /api/info, which is down too and so never memoised.
    const fetchImpl = vi.fn((url: any) => { if (String(url).includes('/event')) calls++; return Promise.reject(new Error('down')) })
    const conn = connectEvents({ host: 'h', port: 1, directory: '/repos/r' }, { fetchImpl, onEvent: vi.fn(), onOffline: vi.fn(), onOnline: vi.fn(), reconnect: true })
    await vi.advanceTimersByTimeAsync(0) // first attempt fails and enters backoff; no time passes
    conn.stop()
    await conn.done
    expect(calls).toBe(1)
    expect(vi.getTimerCount()).toBe(0) // the backoff timer was cleared, not left pending
  } finally {
    vi.useRealTimers()
  }
})

// A half-open connection (laptop sleep, VPN flap) delivers no bytes and no error, so without a
// deadline the read sits there until undici's implicit ~300s bodyTimeout with the project frozen.
test('a stream that goes silent trips the idle deadline instead of waiting forever', async () => {
  const encode = (s: string) => new TextEncoder().encode(s)
  const body = (async function* () {
    yield encode('data: {"type":"server.connected"}\n\n')
    await new Promise(() => {}) // half-open: never another byte, never an error
  })()
  const fetchImpl = vi.fn(() => Promise.resolve({ ok: true, body })) as any
  const onEvent = vi.fn()
  const onOffline = vi.fn()
  const conn = connectEvents(
    { host: 'h', port: 1, directory: '/repos/r' },
    { fetchImpl, onEvent, onOffline, onOnline: vi.fn(), reconnect: false, idleMs: 5 },
  )
  await conn.done // would hang without the deadline
  expect(onEvent).toHaveBeenCalledWith('/repos/r', { type: 'server.connected' })
  expect(onOffline).toHaveBeenCalledWith('/repos/r') // takes the existing reconnect path, not a new one
})

test('the idle deadline is re-armed by every chunk, so a slow but live stream survives it', async () => {
  vi.useFakeTimers()
  try {
    const encode = (s: string) => new TextEncoder().encode(s)
    let release: any
    const body = (async function* () {
      yield encode('data: {"type":"a"}\n\n')
      await new Promise((r) => { release = r })
      yield encode('data: {"type":"b"}\n\n')
      await new Promise(() => {})
    })()
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: true, body })) as any
    const onEvent = vi.fn()
    const onOffline = vi.fn()
    const conn = connectEvents(
      { host: 'h', port: 1, directory: '/repos/r' },
      { fetchImpl, onEvent, onOffline, onOnline: vi.fn(), reconnect: false, idleMs: 1000 },
    )
    await vi.advanceTimersByTimeAsync(900) // quiet, but inside the deadline
    release()
    await vi.advanceTimersByTimeAsync(900) // 1800ms connected, only 900ms since the last chunk
    expect(onEvent).toHaveBeenCalledTimes(2)
    expect(onOffline).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200) // now 1100ms of silence — the deadline fires
    await conn.done
    expect(onOffline).toHaveBeenCalledWith('/repos/r')
  } finally {
    vi.useRealTimers()
  }
})

test('backoff sleep removes its abort listener when the timer elapses', async () => {
  vi.useFakeTimers()
  const fetchImpl = vi.fn(() => Promise.reject(new Error('down')))
  const conn = connectEvents({ host: 'h', port: 1, directory: '/repos/r' }, { fetchImpl, onEvent: vi.fn(), onOffline: vi.fn(), onOnline: vi.fn(), reconnect: true })
  await vi.advanceTimersByTimeAsync(0) // let the first failure reach its backoff before spies install
  const addSpy = vi.spyOn(AbortSignal.prototype, 'addEventListener')
  const removeSpy = vi.spyOn(AbortSignal.prototype, 'removeEventListener')
  await vi.advanceTimersByTimeAsync(1000) // cycle 1 backoff elapses
  await vi.advanceTimersByTimeAsync(2000) // cycle 2
  await vi.advanceTimersByTimeAsync(4000) // cycle 3
  const added = addSpy.mock.calls.filter(([type]) => type === 'abort').length
  const removed = removeSpy.mock.calls.filter(([type]) => type === 'abort').length
  expect(added).toBe(removed) // every elapsed timer removed its listener
  conn.stop()
  await conn.done
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// #184: 2.x's one server-wide stream, cut to a directory by v2Filter. The transcript is a live
// recording from opencode 2.3.2 (paths rewritten to /fv): sessions created in /fv/repo (mine), /fv
// (foreign) and /fv/repo-link (a symlink to repo), a rename and a `!` shell in mine, a rename of the
// foreign one, then all three deleted. Renames and deletes carry no location.
const transcript = readFileSync(join(import.meta.dirname, 'fixtures', 'opencode-2.3.2-events.sse'), 'utf8')
const MINE = 'ses_e09924833ffeym6fKgnk261ATw'
const FOREIGN = 'ses_e099247e8ffeDhdud5GOTg1DX2'

const v2Server = ({ listed = [] as string[], frames = transcript }: { listed?: string[]; frames?: string } = {}) => {
  const order: string[] = []
  const fetchImpl = vi.fn((url: string) => {
    const path = new URL(url).pathname
    order.push(path)
    const json = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) })
    if (path === '/api/info') return json({ version: '2.3.2', pid: 1 })
    if (path === '/api/session') return json({ data: listed.map((id) => ({ id, location: { directory: '/fv/repo' }, time: {} })) })
    if (path === '/api/event') {
      // Split mid-frame, as a socket would.
      const body = (async function* () { for (let i = 0; i < frames.length; i += 97) yield new TextEncoder().encode(frames.slice(i, i + 97)) })()
      return Promise.resolve({ ok: true, status: 200, body })
    }
    return Promise.reject(new Error(`unexpected ${path}`))
  })
  return { fetchImpl: fetchImpl as any, order }
}
const replay = async (directory: string, server = v2Server()) => {
  const events: any[] = []
  await connectEvents({ host: '127.0.0.1', port: 4802, directory }, { fetchImpl: server.fetchImpl, onEvent: (_d, e) => events.push(e), reconnect: false }).done
  return events
}
const sessionsIn = (events: any[]) => [...new Set(events.map((e) => e.properties?.sessionID ?? e.properties?.info?.id))]

test('2.x: the recorded stream reaches only its own directory, location-less renames and deletes included', async () => {
  const events = await replay('/fv/repo')
  expect(sessionsIn(events)).toEqual([MINE])
  expect(events).toContainEqual({ type: 'session.updated', properties: { info: { id: MINE, title: 'renamed', time: { updated: expect.any(Number) } } } })
  expect(events).toContainEqual({ type: 'message.updated', properties: { sessionID: MINE, info: { role: 'user' } } })
  expect(events.at(-1)).toEqual({ type: 'session.deleted', properties: { info: { id: MINE } } })
  // The foreign directory gets the foreign session and none of mine.
  expect(sessionsIn(await replay('/fv'))).toEqual([FOREIGN])
})

test('2.x: a roster directory spelled with a trailing slash still matches (2.x strips it)', async () => {
  expect(await replay('/fv/repo/')).toEqual(await replay('/fv/repo'))
})

test('2.x: the seed is listed after the stream opens, so a session made in between is not lost', async () => {
  const server = v2Server()
  await replay('/fv/repo', server)
  expect(server.order.indexOf('/api/event')).toBeLessThan(server.order.indexOf('/api/session'))
})

test('2.x: location-less frames pass for a listed session and drop for an unknown one; a nested form routes by its session', async () => {
  const frame = (o: object) => `data: ${JSON.stringify(o)}\n\n`
  const form = { id: 'frm_1', sessionID: 'ses_listed', title: 'Pick', fields: [{ key: 'q0', type: 'string', title: 'Fruit', options: [{ value: 'pear', label: 'pear' }] }] }
  const frames = [
    frame({ type: 'session.renamed', created: 5, data: { sessionID: 'ses_listed', title: 'kept' } }),
    frame({ type: 'session.renamed', created: 6, data: { sessionID: 'ses_unknown', title: 'dropped' } }),
    frame({ type: 'form.created', created: 7, data: { form } }),
    frame({ type: 'form.created', created: 8, data: { form: { ...form, id: 'frm_2', sessionID: 'ses_unknown' } } }),
  ].join('')
  const events = await replay('/fv/repo', v2Server({ listed: ['ses_listed'], frames }))
  expect(events.map((e) => e.type)).toEqual(['session.updated', 'question.asked'])
  expect(events[1].properties).toMatchObject({ id: 'frm_1', sessionID: 'ses_listed' })
})

test('2.x translator: the branches no recording reaches without a model', () => {
  const t = createV2Translator()
  const at = (type: string, data: object) => t({ type, created: 9, data })
  expect(at('permission.asked', { id: 'per_1', sessionID: 's', action: 'bash', resources: ['ls'] })).toEqual([{ type: 'permission.asked', properties: { id: 'per_1', sessionID: 's', permission: 'bash', patterns: ['ls'], metadata: undefined } }])
  t({ type: 'session.text.delta', data: { sessionID: 's', assistantMessageID: 'm', ordinal: 0, delta: 'Hel' } })
  expect(at('session.text.ended', { sessionID: 's', assistantMessageID: 'm', ordinal: 0, text: 'Hello' })).toEqual([{ type: 'message.part.updated', properties: { sessionID: 's', part: { type: 'text', text: 'Hello', messageID: 'm' } } }])
  // ended clears the accumulator: a later delta for the same part starts over
  expect(t({ type: 'session.text.delta', data: { sessionID: 's', assistantMessageID: 'm', ordinal: 0, delta: 'x' } })[0]).toMatchObject({ properties: { part: { text: 'x' } } })
  expect(at('form.cancelled', { sessionID: 's', id: 'frm_1' })).toEqual([{ type: 'question.rejected', properties: { sessionID: 's', requestID: 'frm_1' } }])
  expect(at('session.deleted', { sessionID: 's' })).toEqual([{ type: 'session.deleted', properties: { info: { id: 's' } } }])
  expect(at('session.inbox.enqueued', { sessionID: 's' })).toEqual([{ type: 'message.updated', properties: { sessionID: 's', info: { role: 'user' } } }, { type: 'session.updated', properties: { info: { id: 's', time: { updated: 9 } } } }])
  expect(at('session.step.started', { sessionID: 's', assistantMessageID: 'm2' })[0]).toEqual({ type: 'message.updated', properties: { sessionID: 's', info: { id: 'm2', role: 'assistant' } } })
  for (const type of ['session.step.ended', 'session.step.failed']) expect(at(type, { sessionID: 's' })).toEqual([{ type: 'session.updated', properties: { info: { id: 's', time: { updated: 9 } } } }])
})

test('2.x: a listing that fails after the stream opened releases the body and goes offline', async () => {
  const release = vi.fn(() => Promise.resolve({ done: true, value: undefined }))
  let sent = false
  const body = {
    [Symbol.asyncIterator]: () => ({
      next: () => (sent ? new Promise(() => {}) : ((sent = true), Promise.resolve({ done: false, value: new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n') }))),
      return: release,
    }),
  }
  const fetchImpl = vi.fn((url: string) => {
    const path = new URL(url).pathname
    if (path === '/api/info') return Promise.resolve({ ok: true, json: () => Promise.resolve({ version: '2.3.2', pid: 1 }) })
    if (path === '/api/event') return Promise.resolve({ ok: true, status: 200, body })
    return Promise.reject(new Error('listing failed'))
  }) as any
  const onOffline = vi.fn()
  await connectEvents({ host: '127.0.0.1', port: 4803, directory: '/fv/repo' }, { fetchImpl, onEvent: vi.fn(), onOffline, reconnect: false }).done
  expect(release).toHaveBeenCalled()
  expect(onOffline).toHaveBeenCalledWith('/fv/repo')
})

test('2.x: stop() while the seed is being listed delivers nothing more', async () => {
  let listed!: (v: unknown) => void
  const fetchImpl = vi.fn((url: string) => {
    const path = new URL(url).pathname
    if (path === '/api/info') return Promise.resolve({ ok: true, json: () => Promise.resolve({ version: '2.3.2', pid: 1 }) })
    if (path === '/api/event') return Promise.resolve({ ok: true, status: 200, body: (async function* () { yield new TextEncoder().encode(transcript) })() })
    return new Promise((r) => { listed = r })
  }) as any
  const onEvent = vi.fn()
  const conn = connectEvents({ host: '127.0.0.1', port: 4804, directory: '/fv/repo' }, { fetchImpl, onEvent, reconnect: false })
  await vi.waitFor(() => expect(listed).toBeDefined())
  conn.stop()
  listed({ ok: true, status: 200, text: () => Promise.resolve('{"data":[]}') })
  await conn.done
  expect(onEvent).not.toHaveBeenCalled()
})
