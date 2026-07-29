import { test, expect, vi } from 'vitest'
import { connectEvents, parseSseChunk } from '../src/backends/opencode/event-mux.ts'

test('parseSseChunk yields JSON payloads from data: lines, keeps partial tail', () => {
  const { events, rest } = parseSseChunk('data: {"type":"session.status"}\n\ndata: {"ty')
  expect(events).toEqual([{ type: 'session.status' }])
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
    const fetchImpl = vi.fn(() => { calls++; return Promise.reject(new Error('down')) })
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
  await Promise.resolve() // let first failure start before spies install
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
