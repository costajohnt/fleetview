import { test, expect, vi } from 'vitest'
import { OpencodeClient } from '../src/backends/opencode/client.ts'

const ok = (body: any) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) })

test('listSessions GETs /session', async () => {
  const fetchImpl = vi.fn(() => ok([{ id: 's1' }]))
  const c = new OpencodeClient('http://127.0.0.1:4801', fetchImpl as any)
  expect(await c.listSessions()).toEqual([{ id: 's1' }])
  expect(fetchImpl).toHaveBeenCalledWith(
    'http://127.0.0.1:4801/session',
    expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) }),
  )
})

// Sending no title is the point: opencode only auto-names a session that was created without one.
test('createSession POSTs no title; promptAsync POSTs text part', async () => {
  const fetchImpl = vi.fn(() => ok({ id: 's2' }))
  const c = new OpencodeClient('http://127.0.0.1:4801', fetchImpl as any)
  await c.createSession()
  expect(fetchImpl).toHaveBeenCalledWith(
    'http://127.0.0.1:4801/session',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({}) }),
  )
  await c.createSession({ agent: 'reviewer', model: { providerID: 'anthropic', id: 'haiku' } } as any)
  expect(fetchImpl).toHaveBeenLastCalledWith(
    'http://127.0.0.1:4801/session',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ agent: 'reviewer', model: { providerID: 'anthropic', id: 'haiku' } }),
    }),
  )
  await c.promptAsync('s2', 'run the tests')
  expect(fetchImpl).toHaveBeenCalledWith(
    'http://127.0.0.1:4801/session/s2/prompt_async',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ parts: [{ type: 'text', text: 'run the tests' }] }) }),
  )
})

test('renameSession PATCHes title; deleteSession DELETEs', async () => {
  const fetchImpl = vi.fn(() => ok({}))
  const c = new OpencodeClient('http://127.0.0.1:4801', fetchImpl as any)
  await c.renameSession('s1', 'new name')
  expect(fetchImpl).toHaveBeenCalledWith(
    'http://127.0.0.1:4801/session/s1',
    expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ title: 'new name' }) }),
  )
  await c.deleteSession('s1')
  expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:4801/session/s1', expect.objectContaining({ method: 'DELETE' }))
})

test('a session id is percent-encoded into the path so it cannot redirect the request', async () => {
  const fetchImpl = vi.fn(() => ok({}))
  const c = new OpencodeClient('http://127.0.0.1:4801', fetchImpl as any)
  await c.deleteSession('../permission/x')
  expect(fetchImpl).toHaveBeenCalledWith(
    'http://127.0.0.1:4801/session/..%2Fpermission%2Fx',
    expect.objectContaining({ method: 'DELETE' }),
  )
})

test('non-2xx throws with status', async () => {
  const fetchImpl = vi.fn(() => Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('boom') }))
  const c = new OpencodeClient('http://127.0.0.1:4801', fetchImpl as any)
  await expect(c.listSessions()).rejects.toThrow(/500/)
})

test('empty body on success resolves null instead of throwing', async () => {
  const fetchImpl = vi.fn(() => Promise.resolve({ ok: true, status: 204, text: () => Promise.resolve('') }))
  const c = new OpencodeClient('http://127.0.0.1:4801', fetchImpl as any)
  await expect(c.deleteSession('s1')).resolves.toBeNull()
})

test('directory param appends encoded ?directory= to each method; omitted when undefined', async () => {
  const fetchImpl = vi.fn(() => ok({}))
  const c = new OpencodeClient('http://127.0.0.1:4801', fetchImpl as any)
  const dir = '/Users/john costa/dev/fleetview'
  const encoded = encodeURIComponent(dir)

  await c.listSessions(dir)
  expect(fetchImpl).toHaveBeenCalledWith(`http://127.0.0.1:4801/session?directory=${encoded}`, expect.objectContaining({ method: 'GET' }))
  await c.listSessions()
  expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:4801/session', expect.objectContaining({ method: 'GET' }))

  await c.createSession('t' as any, dir)
  expect(fetchImpl).toHaveBeenCalledWith(`http://127.0.0.1:4801/session?directory=${encoded}`, expect.objectContaining({ method: 'POST' }))

  await c.promptAsync('s1', 'hi', dir)
  expect(fetchImpl).toHaveBeenCalledWith(`http://127.0.0.1:4801/session/s1/prompt_async?directory=${encoded}`, expect.objectContaining({ method: 'POST' }))

  await c.renameSession('s1', 'new', dir)
  expect(fetchImpl).toHaveBeenCalledWith(`http://127.0.0.1:4801/session/s1?directory=${encoded}`, expect.objectContaining({ method: 'PATCH' }))

  await c.deleteSession('s1', dir)
  expect(fetchImpl).toHaveBeenCalledWith(`http://127.0.0.1:4801/session/s1?directory=${encoded}`, expect.objectContaining({ method: 'DELETE' }))
})

test('listMessages GETs /session/:id/message; directory appends encoded ?directory=', async () => {
  const fetchImpl = vi.fn(() => ok([{ info: { role: 'user' }, parts: [] }]))
  const c = new OpencodeClient('http://127.0.0.1:4801', fetchImpl as any)
  const dir = '/Users/john costa/dev/fleetview'
  const encoded = encodeURIComponent(dir)

  await c.listMessages('s1', dir)
  expect(fetchImpl).toHaveBeenCalledWith(
    `http://127.0.0.1:4801/session/s1/message?directory=${encoded}`,
    expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) }),
  )

  await c.listMessages('s1')
  expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:4801/session/s1/message', expect.objectContaining({ method: 'GET' }))
})

test('listProjects GETs /project', async () => {
  const fetchImpl = vi.fn(() => ok([{ id: 'p1', worktree: '/x' }]))
  const c = new OpencodeClient('http://127.0.0.1:4801', fetchImpl as any)
  expect(await c.listProjects()).toEqual([{ id: 'p1', worktree: '/x' }])
  expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:4801/project', expect.objectContaining({ method: 'GET' }))
})

test('abortSession POSTs /session/:id/abort with no body; directory appends encoded ?directory=', async () => {
  const fetchImpl = vi.fn(() => ok(true))
  const c = new OpencodeClient('http://127.0.0.1:4801', fetchImpl as any)
  expect(await c.abortSession('s1')).toBe(true)
  expect(fetchImpl).toHaveBeenCalledWith(
    'http://127.0.0.1:4801/session/s1/abort',
    expect.objectContaining({ method: 'POST', body: undefined, signal: expect.any(AbortSignal) }),
  )
  const dir = '/Users/john costa/dev/fleetview'
  await c.abortSession('s1', dir)
  expect(fetchImpl).toHaveBeenCalledWith(
    `http://127.0.0.1:4801/session/s1/abort?directory=${encodeURIComponent(dir)}`,
    expect.objectContaining({ method: 'POST' }),
  )
})

test('listPermissions GETs /permission', async () => {
  const fetchImpl = vi.fn(() => ok([{ id: 'per1', sessionID: 's1' }]))
  const c = new OpencodeClient('http://127.0.0.1:4801', fetchImpl as any)
  expect(await c.listPermissions()).toEqual([{ id: 'per1', sessionID: 's1' }])
  expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:4801/permission', expect.objectContaining({ method: 'GET' }))
  const dir = '/x/y'
  await c.listPermissions(dir)
  expect(fetchImpl).toHaveBeenCalledWith(`http://127.0.0.1:4801/permission?directory=${encodeURIComponent(dir)}`, expect.objectContaining({ method: 'GET' }))
})

test('listQuestions GETs /question; directory appends encoded ?directory=', async () => {
  const fetchImpl = vi.fn(() => ok([{ id: 'q1', sessionID: 's1' }]))
  const c = new OpencodeClient('http://127.0.0.1:4801', fetchImpl as any)
  expect(await c.listQuestions()).toEqual([{ id: 'q1', sessionID: 's1' }])
  expect(fetchImpl).toHaveBeenCalledWith(
    'http://127.0.0.1:4801/question',
    expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) }),
  )
  const dir = '/x/y'
  await c.listQuestions(dir)
  expect(fetchImpl).toHaveBeenCalledWith(`http://127.0.0.1:4801/question?directory=${encodeURIComponent(dir)}`, expect.objectContaining({ method: 'GET' }))
})

test('respondPermission POSTs /permission/:requestID/reply with {reply} body per verified enum', async () => {
  const fetchImpl = vi.fn(() => ok(true))
  const c = new OpencodeClient('http://127.0.0.1:4801', fetchImpl as any)
  expect(await c.respondPermission('per1', 'once')).toBe(true)
  expect(fetchImpl).toHaveBeenCalledWith(
    'http://127.0.0.1:4801/permission/per1/reply',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ reply: 'once' }) }),
  )
  const dir = '/x/y'
  await c.respondPermission('per1', 'reject', dir)
  expect(fetchImpl).toHaveBeenCalledWith(
    `http://127.0.0.1:4801/permission/per1/reply?directory=${encodeURIComponent(dir)}`,
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ reply: 'reject' }) }),
  )
})

test('sessionStatus GETs /session/status; returns sessionID→status map', async () => {
  const fetchImpl = vi.fn(() => ok({ ses1: { type: 'idle' }, ses2: { type: 'busy' } }))
  const c = new OpencodeClient('http://127.0.0.1:4801', fetchImpl as any)
  expect(await c.sessionStatus()).toEqual({ ses1: { type: 'idle' }, ses2: { type: 'busy' } })
  expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:4801/session/status', expect.objectContaining({ method: 'GET' }))
  const dir = '/x/y'
  await c.sessionStatus(dir)
  expect(fetchImpl).toHaveBeenCalledWith(`http://127.0.0.1:4801/session/status?directory=${encodeURIComponent(dir)}`, expect.objectContaining({ method: 'GET' }))
})

// The server exposes POST /session/:id/shell — arbitrary command execution — and fleetview spawns it
// detached so it outlives fleetview. opencode supports basic auth; fleetview has to actually send it.
test('requests carry basic auth when a server password is set', async () => {
  const fetchImpl = vi.fn(() => ok({}))
  const c = new OpencodeClient('http://127.0.0.1:4801', fetchImpl as any)
  const saved = process.env.OPENCODE_SERVER_PASSWORD
  process.env.OPENCODE_SERVER_PASSWORD = 'hunter2'
  try {
    await c.listProjects()
    const headers = (fetchImpl.mock.calls.at(-1) as any)[1].headers
    expect(headers.authorization).toBe(`Basic ${Buffer.from('opencode:hunter2').toString('base64')}`)
  } finally {
    if (saved === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
    else process.env.OPENCODE_SERVER_PASSWORD = saved
  }
})

test('no password means no authorization header, so an existing open server still works', async () => {
  const fetchImpl = vi.fn(() => ok({}))
  const c = new OpencodeClient('http://127.0.0.1:4801', fetchImpl as any)
  const saved = process.env.OPENCODE_SERVER_PASSWORD
  delete process.env.OPENCODE_SERVER_PASSWORD
  try {
    await c.listProjects()
    expect((fetchImpl.mock.calls.at(-1) as any)[1].headers.authorization).toBe(undefined)
  } finally {
    if (saved !== undefined) process.env.OPENCODE_SERVER_PASSWORD = saved
  }
})

// Shapes verified live against opencode 1.18.4 — see docs/audits/2026-07-23 addendum.
test('createWorktree posts the name, scoped to the repository it belongs to', async () => {
  const fetchImpl = vi.fn(() =>
    ok({ name: 'fix-tests', branch: 'opencode/fix-tests', directory: '/wt/fix-tests' }),
  )
  const c = new OpencodeClient('http://127.0.0.1:4801', fetchImpl as any)
  await expect(c.createWorktree('fix-tests', '/repo/alpha')).resolves.toMatchObject({
    directory: '/wt/fix-tests',
  })
  const [url, init] = fetchImpl.mock.calls.at(-1) as any
  expect(url).toBe(`http://127.0.0.1:4801/experimental/worktree?directory=${encodeURIComponent('/repo/alpha')}`)
  expect(init.method).toBe('POST')
  expect(JSON.parse(init.body)).toEqual({ name: 'fix-tests' })
})

test('removeWorktree names the worktree in the body and the repository in the query', async () => {
  const fetchImpl = vi.fn(() => ok(true))
  const c = new OpencodeClient('http://127.0.0.1:4801', fetchImpl as any)
  await c.removeWorktree('/wt/fix-tests', '/repo/alpha')
  const [url, init] = fetchImpl.mock.calls.at(-1) as any
  expect(url).toContain(encodeURIComponent('/repo/alpha'))
  expect(init.method).toBe('DELETE')
  expect(JSON.parse(init.body)).toEqual({ directory: '/wt/fix-tests' })
})
