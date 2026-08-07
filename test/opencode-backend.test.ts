import { test, expect, vi } from 'vitest'
import { createOpencodeBackend } from '../src/backends/opencode/index.ts'

const server = { host: '127.0.0.1', port: 4900 }
// Only the methods the adapter is allowed to reach for: a fake that grew every OpencodeClient method
// would stop these tests from noticing the adapter calling something it shouldn't.
const fakeClient = () => ({
  listSessions: vi.fn(() => Promise.resolve([{ id: 's1' }])),
  createSession: vi.fn(() => Promise.resolve({ id: 's2' })),
  promptAsync: vi.fn(() => Promise.resolve(null)),
  abortSession: vi.fn(() => Promise.resolve(null)),
  renameSession: vi.fn(() => Promise.resolve(null)),
  deleteSession: vi.fn(() => Promise.resolve(null)),
})

const backend = (client: any = fakeClient(), fetchImpl?: any) => createOpencodeBackend({ server, client, fetchImpl })

test('every call carries the directory through to the client', async () => {
  const client = fakeClient()
  const b = backend(client)
  await b.listSessions('/x/alpha')
  await b.prompt('s1', 'run the tests', '/x/alpha')
  await b.abort('s1', '/x/alpha')
  await b.rename('s1', 'alpha', '/x/alpha')
  await b.delete('s1', '/x/alpha')
  expect(client.listSessions).toHaveBeenCalledWith('/x/alpha')
  expect(client.promptAsync).toHaveBeenCalledWith('s1', 'run the tests', '/x/alpha')
  expect(client.abortSession).toHaveBeenCalledWith('s1', '/x/alpha')
  expect(client.renameSession).toHaveBeenCalledWith('s1', 'alpha', '/x/alpha')
  expect(client.deleteSession).toHaveBeenCalledWith('s1', '/x/alpha')
})

// The two-step is the contract: opencode names a session from its first prompt, so a dispatch that
// created and never prompted would leave an unnamed session sitting in the roster.
test('dispatch creates then prompts, and returns the session ref', async () => {
  const client = fakeClient()
  const ref = await backend(client).dispatch({ prompt: 'fix the flake', directory: '/x/alpha', agent: 'build', model: 'anthropic/haiku' as any })
  expect(client.createSession).toHaveBeenCalledWith({ agent: 'build', model: 'anthropic/haiku' }, '/x/alpha')
  expect(client.promptAsync).toHaveBeenCalledWith('s2', 'fix the flake', '/x/alpha')
  expect(ref).toEqual({ id: 's2', directory: '/x/alpha' })
})

test('a failed prompt fails the dispatch rather than returning a ref', async () => {
  const client = fakeClient()
  client.promptAsync = vi.fn(() => Promise.reject(new Error('prompt_async → 500')))
  await expect(backend(client).dispatch({ prompt: 'fix the flake', directory: '/x/alpha' })).rejects.toThrow('prompt_async → 500')
})

test('attach argv is the opencode attach command, pointed at the session and its worktree', () => {
  expect(backend().attach({ id: 's1', directory: '/x/alpha' })).toEqual([
    'opencode',
    'attach',
    'http://127.0.0.1:4900',
    '-s',
    's1',
    '--dir',
    '/x/alpha',
  ])
})

// opencode is the parity baseline, so all five are true — the flags exist to describe the backends
// that can't do these things, and this pins the baseline they're compared against.
test('opencode declares the full capability set', () => {
  expect(backend().capabilities).toEqual({ fork: true, rename: true, delete: true, questions: true })
  expect(backend().name).toBe('opencode')
})

// stop() rather than connectEvents' reconnect:false, because reconnect isn't part of the backend
// contract — unmounting calling stop() is, and it has to end the reader either way.
test('events opens the directory-scoped stream on the backend server, and stop() ends it', async () => {
  const fetchImpl = vi.fn(() => Promise.reject(new Error('down')))
  const sub = backend(fakeClient(), fetchImpl).events({ directory: '/x/alpha' }, { onEvent: vi.fn() })
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled())
  sub.stop()
  await sub.done
  expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:4900/event?directory=%2Fx%2Falpha', expect.objectContaining({ signal: expect.any(AbortSignal) }))
})

// The id is server-supplied and the server may be an adopted foreign one; it becomes argv on
// attach, so a malformed one is refused with a throw rather than handed to a spawn.
test('attach refuses a session id with flag syntax or control bytes', () => {
  expect(() => backend().attach({ id: '--banner', directory: '/x/alpha' })).toThrow(/malformed session id/)
  expect(() => backend().attach({ id: `ok${String.fromCharCode(27)}[2Jbad`, directory: '/x/alpha' })).toThrow(/malformed session id/)
})
