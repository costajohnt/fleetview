import { test, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { spawnServer, isServerHealthy, isAuthEnforced, probeServer } from '../src/backends/opencode/server-manager.ts'
import { homedir } from 'node:os'

// What a real `opencode serve` answers GET /project with — verified against opencode 1.18.5, which
// reports its global project even with a completely fresh config dir. `[]` is deliberately NOT this:
// an empty array is what any listener can produce without implementing opencode at all.
const PROJECTS = [{ id: 'global', worktree: '/', time: { created: 1, updated: 1 }, sandboxes: [] }]

const withPassword = async (value: any, fn: any) => {
  const previous = process.env.OPENCODE_SERVER_PASSWORD
  if (value === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
  else process.env.OPENCODE_SERVER_PASSWORD = value
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
    else process.env.OPENCODE_SERVER_PASSWORD = previous
  }
}

test('isAuthEnforced is true with no password (nothing to enforce), without probing', async () => {
  const fetchImpl = vi.fn()
  await withPassword(undefined, async () => {
    expect(await isAuthEnforced({ host: '127.0.0.1', port: 4900 }, fetchImpl)).toBe(true)
  })
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('isAuthEnforced is true when an unauthenticated probe is rejected (401)', async () => {
  const fetchImpl = vi.fn(() => Promise.resolve({ status: 401 }))
  await withPassword('hunter2', async () => {
    expect(await isAuthEnforced({ host: '127.0.0.1', port: 4900 }, fetchImpl as any)).toBe(true)
  })
  // Probes WITHOUT a credential — the whole point is to see whether the server rejects it.
  expect((fetchImpl.mock.calls[0] as any)[1].headers).toBeUndefined()
})

test('isAuthEnforced is false when a password is set but the server answers anyway', async () => {
  const fetchImpl = vi.fn(() => Promise.resolve({ status: 200 }))
  await withPassword('hunter2', async () => {
    expect(await isAuthEnforced({ host: '127.0.0.1', port: 4900 }, fetchImpl as any)).toBe(false)
  })
})

test('isAuthEnforced does not nag on a transient network failure', async () => {
  const fetchImpl = vi.fn(() => Promise.reject(new Error('ECONNRESET')))
  await withPassword('hunter2', async () => {
    expect(await isAuthEnforced({ host: '127.0.0.1', port: 4900 }, fetchImpl)).toBe(true)
  })
})

test('spawnServer runs opencode serve detached from the home directory', () => {
  const child = { pid: 999, unref: vi.fn(), on: vi.fn() }
  const spawnImpl = vi.fn(() => child)
  const server = { host: '127.0.0.1', port: 4900 }
  const pid = spawnServer(server, { spawnImpl, logFd: 'ignore' } as any)
  expect(pid).toBe(999)
  expect(spawnImpl).toHaveBeenCalledWith(
    'opencode',
    ['serve', '--port', '4900', '--hostname', '127.0.0.1'],
    expect.objectContaining({ cwd: homedir(), detached: true, stdio: ['ignore', 'ignore', 'ignore'] }),
  )
  expect(child.unref).toHaveBeenCalled()
})

test('isServerHealthy true when /project responds ok with an opencode project list', async () => {
  const server = { host: '127.0.0.1', port: 4900 }
  const okFetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(PROJECTS) }))
  expect(await isServerHealthy(server, okFetch as any)).toBe(true)
  expect(okFetch).toHaveBeenCalledWith(
    'http://127.0.0.1:4900/project',
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  )
})

// The health probe gates every startup path in makeEnsureServer. It used to send no credential, so
// with OPENCODE_SERVER_PASSWORD set the live server answered 401, fleetview read that as a dead server,
// and ensureServer walked eleven ports spawning replacements that all 401'd the same way — turning
// the documented mitigation on stopped fleetview booting at all.
// Still true, but the credential now rides on a RETRY, not the first request: the probe asks
// unauthenticated, and only a 401 — the listener saying it wants a credential — earns one.
test('isServerHealthy sends the same basic auth the client does, once a 401 asks for it', async () => {
  const server = { host: '127.0.0.1', port: 4900 }
  const okFetch = vi.fn(() =>
    okFetch.mock.calls.length === 1
      ? Promise.resolve({ status: 401 })
      : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(PROJECTS) }),
  )
  await withPassword('hunter2', async () => {
    expect(await isServerHealthy(server, okFetch as any)).toBe(true)
  })
  expect((okFetch.mock.calls[0] as any)[1].headers).toBeUndefined()
  expect(okFetch).toHaveBeenLastCalledWith(
    'http://127.0.0.1:4900/project',
    expect.objectContaining({
      headers: { authorization: `Basic ${Buffer.from('opencode:hunter2').toString('base64')}` },
    }),
  )
})

// SEC1: the saved password is presented only to something that already proved it wants one. A
// listener that answers 200 never sees it, however healthy it looks.
test('probeServer never sends the password to a listener that did not ask for it', async () => {
  const server = { host: '127.0.0.1', port: 4900 }
  const okFetch = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(PROJECTS) }))
  await withPassword('hunter2', async () => {
    expect(await probeServer(server, okFetch as any)).toBe('healthy')
  })
  expect(okFetch).toHaveBeenCalledTimes(1)
  expect((okFetch.mock.calls[0] as any)[1].headers).toBeUndefined()
})

test('probeServer reports unauthorized without a second request when there is no password to offer', async () => {
  const server = { host: '127.0.0.1', port: 4900 }
  const fetchImpl = vi.fn(() => Promise.resolve({ ok: false, status: 401 }))
  await withPassword(undefined, async () => {
    expect(await probeServer(server, fetchImpl as any)).toBe('unauthorized')
  })
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})

test('probeServer reports unauthorized when the retried password is rejected too', async () => {
  const server = { host: '127.0.0.1', port: 4900 }
  const fetchImpl = vi.fn(() => Promise.resolve({ ok: false, status: 401 }))
  await withPassword('hunter2', async () => {
    expect(await probeServer(server, fetchImpl as any)).toBe('unauthorized')
  })
  expect(fetchImpl).toHaveBeenCalledTimes(2)
})

// SEC2: "answered with a JSON array" was the whole identity test, so a listener returning `[]` was
// adopted and then fed prompts, shell commands, and the directories fleetview hands to git/spawnSync.
test.each([
  ['an empty array', []],
  ['array of empty objects', [{}]],
  ['entries missing worktree', [{ id: 'p1' }]],
  ['entries missing id', [{ worktree: '/tmp/x' }]],
  ['entries with a non-string worktree', [{ id: 'p1', worktree: 42 }]],
  ['nulls', [null]],
  ['a bare string list', ['/tmp/x']],
])('a listener answering %s is not adopted as healthy', async (_label, body) => {
  const server = { host: '127.0.0.1', port: 4900 }
  const fetchImpl = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) }))
  expect(await probeServer(server, fetchImpl as any)).toBe('unreachable')
})

test('a realistic opencode project list is adopted as healthy', async () => {
  const server = { host: '127.0.0.1', port: 4900 }
  const fetchImpl = vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve([...PROJECTS, { id: 'abc123', worktree: '/Users/j/dev/fleetview', vcs: 'git' }]),
    }),
  )
  expect(await probeServer(server, fetchImpl as any)).toBe('healthy')
})

test('isServerHealthy sends no authorization header when no password is set', async () => {
  const server = { host: '127.0.0.1', port: 4900 }
  const okFetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(PROJECTS) }))
  const previous = process.env.OPENCODE_SERVER_PASSWORD
  delete process.env.OPENCODE_SERVER_PASSWORD
  try {
    expect(await isServerHealthy(server, okFetch as any)).toBe(true)
  } finally {
    if (previous !== undefined) process.env.OPENCODE_SERVER_PASSWORD = previous
  }
  expect((okFetch.mock.calls[0] as any)[1].headers).toBeUndefined()
})

test('isServerHealthy false when body is ok but not an array', async () => {
  const server = { host: '127.0.0.1', port: 4900 }
  const objFetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ foo: 'bar' }) }))
  expect(await isServerHealthy(server, objFetch as any)).toBe(false)
})

// A 401 says something IS listening and enforcing a password fleetview doesn't hold — the opposite
// of nothing being there, though both read as unhealthy. ensureServer needs the difference to avoid
// spawning onto an occupied port.
test('probeServer separates an occupied port (401) from an unreachable one', async () => {
  const server = { host: '127.0.0.1', port: 4900 }
  expect(await probeServer(server, vi.fn(() => Promise.resolve({ ok: false, status: 401 })) as any)).toBe('unauthorized')
  expect(await probeServer(server, vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))) as any)).toBe('unreachable')
  expect(await probeServer(server, vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(PROJECTS) })) as any)).toBe('healthy')
})

test('isServerHealthy false on network error', async () => {
  const server = { host: '127.0.0.1', port: 4900 }
  const badFetch = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')))
  expect(await isServerHealthy(server, badFetch)).toBe(false)
})

test('isServerHealthy false on non-ok response', async () => {
  const server = { host: '127.0.0.1', port: 4900 }
  const notOkFetch = vi.fn(() => Promise.resolve({ ok: false }))
  expect(await isServerHealthy(server, notOkFetch as any)).toBe(false)
})

test('isServerHealthy false when response is ok but body is not valid JSON', async () => {
  const server = { host: '127.0.0.1', port: 4900 }
  const badJsonFetch = vi.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.reject(new SyntaxError('Unexpected token')) }),
  )
  expect(await isServerHealthy(server, badJsonFetch as any)).toBe(false)
})

test('spawnServer does not crash when the child emits an async error event (e.g. missing binary) (F2)', () => {
  const child: any = new EventEmitter()
  child.pid = undefined
  child.unref = vi.fn()
  const spawnImpl = vi.fn(() => child)
  const server = { host: '127.0.0.1', port: 4900 }
  const pid = spawnServer(server, { spawnImpl, logFd: 'ignore' } as any)
  expect(pid).toBeUndefined()
  expect(() => child.emit('error', new Error('ENOENT'))).not.toThrow()
})

// A server that never comes healthy is spawned up to 11 times per ensureServer run, and
// ensureServer re-runs on every failed poll — so an unclosed parent fd accumulates without bound.
test('spawnServer closes the log descriptor it opened, and leaves a caller-supplied one alone', () => {
  const closed: any[] = []
  const child = { on: () => {}, unref: () => {}, pid: 42 }
  spawnServer(
    { host: '127.0.0.1', port: 4900 },
    { spawnImpl: () => child, logFd: 7, closeSyncImpl: (fd: any) => closed.push(fd) } as any,
  )
  expect(closed).toEqual([]) // fd 7 belongs to the caller
})
