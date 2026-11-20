import { beforeEach, test, expect, vi } from 'vitest'
import { createOpencodeBackend } from '../src/backends/opencode/index.ts'
import { noteOpencodeApi, resetOpencodeApiMemo } from '../src/backends/opencode/client.ts'
import { ownershipLost, ownershipVerified } from '../src/backends/opencode/request.ts'

const server = { host: '127.0.0.1', port: 4900 }
// Only the methods the adapter is allowed to reach for: a fake that grew every OpencodeClient method
// would stop these tests from noticing the adapter calling something it shouldn't.
const fakeClient = () => ({
  promptAsync: vi.fn(() => Promise.resolve(null)),
  abortSession: vi.fn(() => Promise.resolve(null)),
  renameSession: vi.fn(() => Promise.resolve(null)),
  deleteSession: vi.fn(() => Promise.resolve(null)),
  forkSession: vi.fn(() => Promise.resolve({ id: 's2' })),
  listMessages: vi.fn(() => Promise.resolve([])),
  runShell: vi.fn(() => Promise.resolve(null)),
})

// As probeServer leaves it for a 1.x server; attach reads the probed API.
beforeEach(() => {
  resetOpencodeApiMemo()
  noteOpencodeApi('http://127.0.0.1:4900', 1)
})

const backend = (client: any = fakeClient()) => createOpencodeBackend({ server, client })

test('every call carries the directory through to the client', async () => {
  const client = fakeClient()
  const b = backend(client)
  await b.prompt('s1', 'run the tests', '/x/alpha')
  await b.abort('s1', '/x/alpha')
  await b.rename('s1', 'alpha', '/x/alpha')
  await b.delete('s1', '/x/alpha')
  await b.fork!('s1', '/x/alpha')
  await b.listMessages!('s1', '/x/alpha')
  await b.shell!('s1', 'git status', '/x/alpha')
  expect(client.promptAsync).toHaveBeenCalledWith('s1', 'run the tests', '/x/alpha')
  expect(client.abortSession).toHaveBeenCalledWith('s1', '/x/alpha')
  expect(client.renameSession).toHaveBeenCalledWith('s1', 'alpha', '/x/alpha')
  expect(client.deleteSession).toHaveBeenCalledWith('s1', '/x/alpha')
  expect(client.forkSession).toHaveBeenCalledWith('s1', '/x/alpha')
  expect(client.listMessages).toHaveBeenCalledWith('s1', '/x/alpha')
  expect(client.runShell).toHaveBeenCalledWith('s1', 'git status', '/x/alpha')
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

// opencode is the parity baseline, so every flag is true — the flags exist to describe the backends
// that can't do these things, and this pins the baseline they're compared against.
test('opencode declares the full capability set', () => {
  expect(backend().capabilities).toEqual({ rename: true, delete: true, questions: true })
  expect(backend().name).toBe('opencode')
})

// The id is server-supplied and the server may be an adopted foreign one; it becomes argv on
// attach, so a malformed one is refused with a throw rather than handed to a spawn.
test('attach refuses a session id with flag syntax or control bytes', () => {
  expect(() => backend().attach({ id: '--banner', directory: '/x/alpha' })).toThrow(/malformed session id/)
  expect(() => backend().attach({ id: `ok${String.fromCharCode(27)}[2Jbad`, directory: '/x/alpha' })).toThrow(/malformed session id/)
})

// #182: 1.x's --dir value is server-supplied too, and gets the same absolute-path check as 2.x's
// bare argument.
test('1.x attach refuses a directory that is not absolute', () => {
  expect(() => backend().attach({ id: 's1', directory: '--help' })).toThrow(/non-absolute directory/)
  expect(() => backend().attach({ id: 's1', directory: 'rel/dir' })).toThrow(/non-absolute directory/)
})

// #186: the API comes from the probe, and a server nothing probed gets no guessed 1.x argv.
test('attach follows the probed API, and refuses a server that was never probed', () => {
  noteOpencodeApi('http://127.0.0.1:4900', 2)
  expect(backend().attach({ id: 's1', directory: '/x/alpha' })).toEqual(['opencode', '--server', 'http://127.0.0.1:4900', '-s', 's1', '/x/alpha'])
  resetOpencodeApiMemo()
  expect(() => backend().attach({ id: 's1', directory: '/x/alpha' })).toThrow(/not been probed/)
})

// #216: the attached TUI reads the password from its env, so it is held back like every request.
test('attach waits for a re-verified server after a lost connection when a password is set', () => {
  vi.stubEnv('OPENCODE_SERVER_PASSWORD', 'hunter2')
  try {
    ownershipLost('http://127.0.0.1:4900')
    expect(() => backend().attach({ id: 's1', directory: '/x/alpha' })).toThrow(/lost the connection/)
    ownershipVerified('http://127.0.0.1:4900')
    expect(backend().attach({ id: 's1', directory: '/x/alpha' })[1]).toBe('attach')
  } finally {
    vi.unstubAllEnvs()
  }
})
