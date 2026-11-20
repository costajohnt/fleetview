// opencode 2.x support (#166): the 2.x API translated to the 1.x shapes the rest of fleetview reads.
// Wire shapes here are from opencode v2.3.2's source, not a live server.
import { test, expect, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpencodeClient } from '../src/backends/opencode/client.ts'
import { serverHome, v1Messages, v1Question, v2Answer } from '../src/backends/opencode/client-v2.ts'
import { messageBody } from '../src/session-store.ts'
import { createV2Translator } from '../src/backends/opencode/event-v2.ts'
import { probeServer } from '../src/backends/opencode/server-manager.ts'
import { createOpencodeBackend } from '../src/backends/opencode/index.ts'

const json = (body: unknown, status = 200) =>
  Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h === 'content-type' ? 'application/json' : null) },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(body === undefined ? '' : JSON.stringify(body)),
  })
const html = () =>
  Promise.resolve({ ok: true, status: 200, headers: { get: () => 'text/html' }, json: () => Promise.reject(new Error('not json')), text: () => Promise.resolve('<html>') })

// A fake 2.x server: routes keyed "METHOD path" (path without query), answered in order of calls.
const fakeServer = (routes: Record<string, unknown>) => {
  const calls: { method: string; url: string; body?: unknown; headers: Record<string, string> }[] = []
  const fetchImpl = vi.fn((url: string, init: any = {}) => {
    const method = init.method ?? 'GET'
    const path = new URL(url).pathname
    calls.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers ?? {} })
    if (path === '/api/info') return json({ version: '2.3.2', pid: 1, urls: [], paths: { tmp: '/tmp' } })
    const key = `${method} ${path}`
    if (!(key in routes)) return json({ _tag: 'NotFound' }, 404)
    const route = routes[key]
    return typeof route === 'function' ? route() : json(route)
  })
  return { fetchImpl, calls }
}

let port = 5100
const client = (routes: Record<string, unknown>) => {
  const server = fakeServer(routes)
  // A fresh port per test: the API answer is remembered per server URL.
  return { ...server, c: new OpencodeClient(`http://127.0.0.1:${port++}`, server.fetchImpl as any) }
}

test('a 2.x server is detected and its session listing is mapped to 1.x rows, scoped by directory', async () => {
  const { c, calls } = client({
    'GET /api/session': { data: [{ id: 'ses_1', title: 'fix tests', location: { directory: '/repo' }, time: { created: 1, updated: 2 } }], cursor: {} },
  })
  expect(await c.listSessions('/repo')).toEqual([expect.objectContaining({ id: 'ses_1', title: 'fix tests', directory: '/repo', time: { created: 1, updated: 2 } })])
  expect(calls.at(-1)!.url).toContain('/api/session?directory=%2Frepo')
})

// #186: the page cap is not the end of the list, so the listing says it was cut short.
test('a listing that hits the page cap is marked truncated; one that ends is not', async () => {
  let page = 0
  const endless = vi.fn((url: string) => {
    if (new URL(url).pathname === '/api/info') return json({ version: '2.3.2', pid: 1, urls: [], paths: { tmp: '/tmp' } })
    page++
    return json({ data: [{ id: `ses_${page}`, location: { directory: '/repo' }, time: {} }], cursor: { next: `c${page}` } })
  })
  const list = await new OpencodeClient(`http://127.0.0.1:${port++}`, endless as any).listSessions('/repo')
  expect(page).toBe(20)
  expect(list).toHaveLength(20)
  expect((list as { truncated?: boolean }).truncated).toBe(true)
  const ended = client({ 'GET /api/session': { data: [], cursor: {} } })
  expect((await ended.c.listSessions('/repo') as { truncated?: boolean }).truncated).toBeUndefined()
})

test('an untitled 2.x session lists with an empty title, not undefined', async () => {
  const { c } = client({ 'GET /api/session': { data: [{ id: 'ses_1', location: { directory: '/repo' }, time: { created: 1, updated: 1 } }] } })
  expect((await c.listSessions('/repo'))[0].title).toBe('')
})

test('projects map canonical to worktree, with worktrees filled into sandboxes (2.3.2 leaves it empty)', async () => {
  const { c } = client({
    'GET /api/project': [{ id: 'p1', canonical: '/repo', sandboxes: [] }],
    'GET /api/worktree': [{ directory: '/repo' }, { directory: '/wt/feature' }],
  })
  expect(await c.listProjects()).toEqual([expect.objectContaining({ worktree: '/repo', sandboxes: ['/wt/feature'] })])
})

// #172: 2.x makes the directory a request resolves to a project, and ~ as a project floods the
// roster with every Claude Code session run from home.
test('the ~ an earlier fleetview registered and the pinned directory are not projects', async () => {
  const { c } = client({
    'GET /api/project': [
      { id: 'home', canonical: homedir(), sandboxes: [] },
      { id: 'pinned', canonical: serverHome(), sandboxes: [] },
      { id: 'p1', canonical: '/repo', vcs: 'git', sandboxes: [] },
    ],
    'GET /api/worktree': [],
    'GET /api/session': { data: [] },
  })
  expect((await c.listProjects()).map((p) => p.worktree)).toEqual(['/repo'])
})

test('a ~ with opencode sessions of its own stays a project, repository or not', async () => {
  const { c, calls } = client({
    'GET /api/project': [{ id: 'home', canonical: homedir(), sandboxes: [] }],
    'GET /api/worktree': [],
    'GET /api/session': { data: [{ id: 'ses_1', location: { directory: homedir() }, time: {} }] },
  })
  expect((await c.listProjects()).map((p) => p.worktree)).toEqual([homedir()])
  expect(new URL(calls.find((call) => new URL(call.url).pathname === '/api/session')!.url).searchParams.get('directory')).toBe(homedir())
})

// A dotfiles ~/.git: 2.x resolves the pinned directory up to ~ and registers it as a git project.
test('a ~ that is a repository with no opencode sessions is still dropped', async () => {
  const { c } = client({ 'GET /api/project': [{ id: 'home', canonical: homedir(), vcs: 'git', sandboxes: [] }], 'GET /api/worktree': [], 'GET /api/session': { data: [] } })
  expect(await c.listProjects()).toEqual([])
})

test('agents, commands and models are asked for in the pinned directory, never the server cwd', async () => {
  const { c, calls } = client({ 'GET /api/agent': { data: [] }, 'GET /api/command': { data: [] }, 'GET /api/model': { data: [] } })
  await c.listAgents()
  await c.listCommands()
  await c.providers()
  const pinned = encodeURIComponent(serverHome())
  for (const route of ['/api/agent', '/api/command', '/api/model']) {
    expect(calls.find((call) => new URL(call.url).pathname === route)!.headers['x-opencode-directory']).toBe(pinned)
  }
})

test('session status keeps only this directory\'s running sessions, as busy', async () => {
  const { c } = client({
    'GET /api/session/active': { data: { ses_1: { type: 'running' }, ses_other: { type: 'running' } } },
    'GET /api/session': { data: [{ id: 'ses_1', location: { directory: '/repo' }, time: {} }] },
  })
  expect(await c.sessionStatus('/repo')).toEqual({ ses_1: { type: 'busy' } })
})

// #186: the roster's poll asks for every worktree's statuses at once; the active map is fetched once.
test('a status snapshot fetches the active map once for every directory, and reuses a listing it is given', async () => {
  const { c, calls } = client({
    'GET /api/session/active': { data: { ses_1: { type: 'running' }, ses_2: { type: 'running' } } },
    'GET /api/session': { data: [{ id: 'ses_2', location: { directory: '/other' }, time: {} }] },
  })
  const statusOf = (await c.statusSnapshot())!
  expect(await statusOf('/repo', [{ id: 'ses_1' }])).toEqual({ ses_1: { type: 'busy' } })
  expect(await statusOf('/other')).toEqual({ ses_2: { type: 'busy' } })
  const paths = calls.map((call) => new URL(call.url).pathname)
  expect(paths.filter((p) => p === '/api/session/active')).toHaveLength(1)
  expect(paths.filter((p) => p === '/api/session')).toHaveLength(1) // only for the directory with no listing
})

test('dispatch creates in the directory with an object model, then prompts with flat text', async () => {
  const { c, calls } = client({
    'POST /api/session': { data: { id: 'ses_9', location: { directory: '/repo' }, time: { created: 1, updated: 1 } } },
    'POST /api/session/ses_9/prompt': { data: { id: 'msg_1' } },
  })
  const s = await c.createSession({ agent: 'build', model: 'anthropic/claude-x' }, '/repo')
  expect(s.id).toBe('ses_9')
  expect(calls.at(-1)!.body).toEqual({ agent: 'build', model: { providerID: 'anthropic', id: 'claude-x' }, location: { directory: '/repo' } })
  await c.promptAsync('ses_9', 'hello', '/repo')
  expect(calls.at(-1)!.body).toEqual({ text: 'hello' })
})

test('abort is interrupt; location-scoped calls carry the directory header', async () => {
  const { c, calls } = client({ 'POST /api/session/ses_1/interrupt': { interrupted: true }, 'GET /api/permission/request': { data: [] } })
  await c.abortSession('ses_1')
  expect(calls.at(-1)!.url).toMatch(/\/api\/session\/ses_1\/interrupt$/)
  await c.listPermissions('/a b')
  expect(calls.at(-1)!.headers['x-opencode-directory']).toBe('%2Fa%20b')
})

test('a permission reply is routed through its session with `decision`', async () => {
  const { c, calls } = client({
    'GET /api/permission/request': { data: [{ id: 'per_1', sessionID: 'ses_1', action: 'bash', resources: ['rm -rf x'] }] },
    'POST /api/session/ses_1/permission/per_1/reply': undefined,
  })
  expect(await c.listPermissions('/repo')).toEqual([expect.objectContaining({ id: 'per_1', sessionID: 'ses_1', permission: 'bash', patterns: ['rm -rf x'] })])
  await c.respondPermission('per_1', 'once', '/repo')
  expect(calls.at(-1)!.body).toEqual({ decision: 'once' })
})

const form = {
  id: 'frm_1',
  sessionID: 'ses_1',
  title: 'Questions',
  fields: [
    { key: 'q0', type: 'string', title: 'Pick', description: 'Which one?', options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }], custom: true },
    { key: 'q1', type: 'multiselect', title: 'Many', options: [{ value: 'x', label: 'Ex' }, { value: 'y', label: 'Why' }] },
  ],
}

test('a form reads as a 1.x question, one question per field', () => {
  expect(v1Question(form)).toEqual({
    id: 'frm_1',
    sessionID: 'ses_1',
    questions: [
      { question: 'Which one?', header: 'Pick', options: [{ label: 'Alpha', description: '' }, { label: 'Beta', description: '' }], multiple: false, custom: true },
      { question: 'Many', header: 'Many', options: [{ label: 'Ex', description: '' }, { label: 'Why', description: '' }], multiple: true, custom: false },
    ],
  })
})

test('positional label answers become a keyed map of option values; an unknown label is a custom answer', () => {
  expect(v2Answer(form, [['Beta'], ['Ex', 'Why']])).toEqual({ q0: 'b', q1: ['x', 'y'] })
  // #186: a field nothing was picked for is left out, not sent as an empty answer
  expect(v2Answer(form, [['something else'], []])).toEqual({ q0: 'something else' })
  expect(v2Answer(form, [])).toEqual({})
})

test('a picked option sends its declared value even when that is not a string (#186; 2.3.2 declares strings, so defensive)', () => {
  const typed = { fields: [{ key: 'n', type: 'string', options: [{ value: 7, label: 'Seven' }] }, { key: 'b', type: 'boolean', options: [{ value: true, label: 'Yes' }] }] }
  expect(v2Answer(typed, [['Seven'], ['Yes']])).toEqual({ n: 7, b: true })
})

test('a question reply is routed through its session', async () => {
  const { c, calls } = client({ 'GET /api/form': { data: [form] }, 'POST /api/session/ses_1/form/frm_1/reply': undefined })
  await c.respondQuestion('frm_1', [['Alpha'], ['Why']], '/repo')
  expect(calls.at(-1)!.url).toMatch(/\/api\/session\/ses_1\/form\/frm_1\/reply$/)
  expect(calls.at(-1)!.body).toEqual({ answer: { q0: 'a', q1: ['y'] } })
})

test('messages become {info, parts}, oldest first, with 2.x errors as NamedError', () => {
  const rows = [
    { id: 'msg_1', type: 'user', text: 'do it' },
    { id: 'msg_2', type: 'assistant', content: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: 'done' }], error: { type: 'APIError', message: 'overloaded' } },
    { id: 'msg_3', type: 'compaction' },
  ]
  expect(v1Messages(rows)).toEqual([
    { info: { id: 'msg_1', role: 'user' }, parts: [{ type: 'text', text: 'do it', messageID: 'msg_1' }] },
    { info: { id: 'msg_2', role: 'assistant', error: { name: 'APIError', data: { message: 'overloaded' } } }, parts: [{ type: 'text', text: 'done', messageID: 'msg_2' }] },
  ])
})

// #223: a `!` job's output and a tool-only turn's result reach peek and `logs` through messageBody.
// Shapes as opencode 2.3.2 stores them.
test('2.x shell jobs and tool-only turns render their output', () => {
  const rows = [
    { id: 'msg_1', type: 'shell', command: 'sleep 4; echo shellhi', status: 'exited', output: { output: 'shellhi\n', cursor: 8, size: 8, truncated: false } },
    { id: 'msg_2', type: 'shell', command: 'sleep 9', status: 'running' },
    { id: 'msg_2b', type: 'shell', command: 'echo; false', status: 'exited', output: { output: '\n' } },
    { id: 'msg_2c', type: 'shell', command: 'yes', status: 'exited', output: { output: 'y\n', truncated: true } },
    { id: 'msg_3', type: 'assistant', content: [{ type: 'reasoning', text: 'ask' }, { type: 'tool', name: 'question', state: { status: 'completed', content: [{ type: 'text', text: 'User has answered your questions: "Which color?"="blue".' }] } }] },
    { id: 'msg_4', type: 'assistant', content: [{ type: 'text', text: 'blue it is' }, { type: 'tool', name: 'read', state: { status: 'completed', content: [{ type: 'text', text: 'file contents' }] } }] },
  ]
  expect(v1Messages(rows).map((m) => [m.info?.role, messageBody(m)])).toEqual([
    ['assistant', 'shellhi\n'],
    ['assistant', '(exited, no output)'],
    ['assistant', 'y\n\n(output truncated)'],
    ['assistant', 'User has answered your questions: "Which color?"="blue".'],
    ['assistant', 'blue it is'],
  ])
})

test('listMessages reverses 2.x newest-first order', async () => {
  const { c } = client({ 'GET /api/session/ses_1/message': { data: [{ id: 'm2', type: 'user', text: 'second' }, { id: 'm1', type: 'user', text: 'first' }] } })
  expect((await c.listMessages('ses_1')).map((m) => m.info?.id)).toEqual(['m1', 'm2'])
})

// A repository with one commit, and a worktree of it on a detached HEAD: what 2.3.2's create leaves.
const detachedWorktree = (name: string) => {
  const root = mkdtempSync(join(tmpdir(), 'fleetview-v2-wt-'))
  const repo = join(root, 'repo')
  const wt = join(root, name)
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim()
  mkdirSync(repo)
  git('init', '-q')
  git('-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init')
  git('worktree', 'add', '-q', '--detach', wt)
  return { repo, wt, git }
}
const worktreeServer = (directory: string) =>
  client({
    'GET /api/location': { directory: '/repo', project: { id: 'prj_1', directory: '/repo', canonical: '/repo' } },
    'POST /api/worktree': { directory },
    'DELETE /api/worktree': undefined,
  })

test('worktrees go through the directory\'s project id, and removal is forced like 1.x', async () => {
  const { repo, wt } = detachedWorktree('feature')
  const { c, calls } = worktreeServer(wt)
  expect(await c.createWorktree('feature', repo)).toEqual({ name: 'feature', directory: wt })
  expect(calls.find((call) => call.method === 'POST')!.body).toEqual({ projectID: 'prj_1', name: 'feature' })
  await c.removeWorktree(wt, '/repo')
  expect(calls.at(-1)!.body).toEqual({ projectID: 'prj_1', directory: wt, force: true })
})

// #173: 2.x leaves the worktree detached, where 1.x put it on `opencode/<name>`.
test('a created worktree is put on an opencode/ branch, stepping around a leftover one', async () => {
  const { repo, wt, git } = detachedWorktree('feature')
  await worktreeServer(wt).c.createWorktree('feature', repo)
  expect(git('-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('opencode/feature')

  const second = detachedWorktree('fix')
  second.git('branch', 'opencode/fix')
  await worktreeServer(second.wt).c.createWorktree('fix', second.repo)
  expect(second.git('-C', second.wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('opencode/fix-2')
})

// #224: 2.x's DELETE leaves the branch, where 1.x deleted it. Only an `opencode/` branch goes, only
// with `-d`, and only after the server removed the worktree.
test('removing a worktree deletes its opencode/ branch unless it holds commits', async () => {
  const removing = (repo: string, wt: string, status = 200) => () => {
    if (status === 200) execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', wt])
    return json(status === 200 ? undefined : { _tag: 'Boom' }, status)
  }
  const branches = (git: (...a: string[]) => string) => git('branch', '--list', '--format=%(refname:short)').split('\n').sort()
  const created = async (name: string) => {
    const w = detachedWorktree(name)
    await worktreeServer(w.wt).c.createWorktree(name, w.repo)
    return w
  }

  const clean = await created('clean')
  await client({ 'GET /api/location': { project: { id: 'prj_1' } }, 'DELETE /api/worktree': removing(clean.repo, clean.wt) }).c.removeWorktree(clean.wt, clean.repo)
  expect(branches(clean.git)).not.toContain('opencode/clean')

  const kept = await created('kept')
  kept.git('-C', kept.wt, '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'work')
  await client({ 'GET /api/location': { project: { id: 'prj_1' } }, 'DELETE /api/worktree': removing(kept.repo, kept.wt) }).c.removeWorktree(kept.wt, kept.repo)
  expect(branches(kept.git)).toContain('opencode/kept')

  const failed = await created('failed')
  const refused = client({ 'GET /api/location': { project: { id: 'prj_1' } }, 'DELETE /api/worktree': removing(failed.repo, failed.wt, 500) }).c
  await expect(refused.removeWorktree(failed.wt, failed.repo)).rejects.toThrow()
  expect(branches(failed.git)).toContain('opencode/failed')

  const own = detachedWorktree('own')
  own.git('-C', own.wt, 'switch', '-q', '-c', 'mine')
  await client({ 'GET /api/location': { project: { id: 'prj_1' } }, 'DELETE /api/worktree': removing(own.repo, own.wt) }).c.removeWorktree(own.wt, own.repo)
  expect(branches(own.git)).toContain('mine')
})

test('a worktree the server already put on a branch is left on it', async () => {
  const { repo, wt, git } = detachedWorktree('feature')
  git('-C', wt, 'switch', '-q', '-c', 'opencode/feature')
  await worktreeServer(wt).c.createWorktree('feature', repo)
  expect(git('-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('opencode/feature')
  expect(git('branch', '--list', 'opencode/*', '--format=%(refname:short)')).toBe('opencode/feature')
})

test('a worktree that cannot be branched is removed and the failure thrown', async () => {
  const { repo, wt } = detachedWorktree('feature')
  // A held ref lock: update-ref cannot create the branch.
  mkdirSync(join(repo, '.git', 'refs', 'heads', 'opencode'), { recursive: true })
  writeFileSync(join(repo, '.git', 'refs', 'heads', 'opencode', 'feature.lock'), '')
  const { c, calls } = worktreeServer(wt)
  await expect(c.createWorktree('feature', repo)).rejects.toThrow(/git/)
  expect(calls.at(-1)).toMatchObject({ method: 'DELETE', body: { projectID: 'prj_1', directory: wt, force: true } })
})

// A server-named directory that is not a linked worktree of the repository is never written to or
// removed: the repository's own checkout, a path outside any repository, a relative path.
test('a directory that is not a new worktree of the repository is refused untouched', async () => {
  const { repo, git } = detachedWorktree('feature')
  const other = detachedWorktree('elsewhere')
  for (const dir of [repo, mkdtempSync(join(tmpdir(), 'fleetview-v2-wt-')), other.wt, 'feature']) {
    const { c, calls } = worktreeServer(dir)
    await expect(c.createWorktree('feature', repo)).rejects.toThrow()
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
  }
  expect(git('symbolic-ref', '--short', 'HEAD')).not.toMatch(/^opencode\//)
  expect(git('branch', '--list', 'opencode/*')).toBe('')
})

test('providers are regrouped from the flat model list', async () => {
  const { c } = client({ 'GET /api/model': { data: [{ id: 'm1', providerID: 'p' }, { id: 'm2', providerID: 'p' }] } })
  expect(await c.providers()).toEqual({ providers: [{ id: 'p', models: { m1: { id: 'm1', providerID: 'p' }, m2: { id: 'm2', providerID: 'p' } } }] })
})

test('2.x events translate to the 1.x events the store handles', () => {
  const t = createV2Translator()
  expect(t({ type: 'session.status', created: 5, data: { sessionID: 's', status: { type: 'busy' } } })).toEqual([{ type: 'session.status', properties: { sessionID: 's', status: { type: 'busy' } } }])
  expect(t({ type: 'session.renamed', created: 6, data: { sessionID: 's', title: 'New' } })).toEqual([{ type: 'session.updated', properties: { info: { id: 's', title: 'New', time: { updated: 6 } } } }])
  expect(t({ type: 'session.step.started', created: 7, data: { sessionID: 's', assistantMessageID: 'm' } })[0]).toEqual({ type: 'message.updated', properties: { sessionID: 's', info: { id: 'm', role: 'assistant' } } })
  // deltas accumulate into the part's whole text, as 1.x sent it
  t({ type: 'session.text.delta', data: { sessionID: 's', assistantMessageID: 'm', ordinal: 0, delta: 'Hel' } })
  expect(t({ type: 'session.text.delta', data: { sessionID: 's', assistantMessageID: 'm', ordinal: 0, delta: 'lo' } })).toEqual([
    { type: 'message.part.updated', properties: { sessionID: 's', part: { type: 'text', text: 'Hello', messageID: 'm' } } },
  ])
  expect(t({ type: 'session.execution.failed', data: { sessionID: 's', error: { type: 'APIError', message: 'x' } } })[0]).toEqual({ type: 'session.error', properties: { sessionID: 's', error: { name: 'APIError', data: { message: 'x' } } } })
  expect(t({ type: 'form.created', data: { form } })[0]).toMatchObject({ type: 'question.asked', properties: { id: 'frm_1', sessionID: 'ses_1' } })
  expect(t({ type: 'form.replied', data: { id: 'frm_1', sessionID: 'ses_1' } })).toEqual([{ type: 'question.replied', properties: { sessionID: 'ses_1', requestID: 'frm_1' } }])
  expect(t({ type: 'permission.replied', data: { sessionID: 's', requestID: 'per_1', reply: 'once' } })).toEqual([{ type: 'permission.replied', properties: { sessionID: 's', requestID: 'per_1', reply: 'once' } }])
  expect(t({ type: 'server.connected', data: {} })).toEqual([])
})

test('the health probe accepts a 2.x server: its web app on /project, JSON on /api/info', async () => {
  const fetchImpl = vi.fn((url: string) => (url.endsWith('/project') ? html() : json({ version: '2.3.2', pid: 7, urls: [], paths: { tmp: '/t' } })))
  expect(await probeServer({ host: '127.0.0.1', port: 4900 }, fetchImpl as any)).toBe('healthy')
})

// #186: one detector. What the probe found is the client's answer too, with no second ask.
test('a healthy probe records the API, so the client never asks /api/info itself', async () => {
  const p = port++
  const { fetchImpl, calls } = fakeServer({ 'GET /api/session': { data: [] } })
  const probe = vi.fn((url: string) => (url.endsWith('/project') ? html() : fetchImpl(url)))
  expect(await probeServer({ host: '127.0.0.1', port: p }, probe as any)).toBe('healthy')
  calls.length = 0
  await new OpencodeClient(`http://127.0.0.1:${p}`, fetchImpl as any).listSessions('/repo')
  expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/api/session'])
})

test('a 2.x server still booting (503) is not healthy yet', async () => {
  const fetchImpl = vi.fn((url: string) => (url.endsWith('/project') ? html() : json({ version: '2.3.2', pid: 7 }, 503)))
  expect(await probeServer({ host: '127.0.0.1', port: 4900 }, fetchImpl as any)).toBe('unreachable')
})

test('attach on a 2.x server opens its TUI with --server and the directory', async () => {
  const p = port++
  const { fetchImpl } = fakeServer({ 'GET /api/session': { data: [] } })
  const c = new OpencodeClient(`http://127.0.0.1:${p}`, fetchImpl as any)
  await c.listSessions('/repo') // the roster has always listed before anything can be attached
  const backend = createOpencodeBackend({ server: { host: '127.0.0.1', port: p }, client: c })
  expect(backend.attach({ id: 'ses_1', directory: '/repo' } as any)).toEqual(['opencode', '--server', `http://127.0.0.1:${p}`, '-s', 'ses_1', '/repo'])
})

// Review findings on the first cut.
test('busy and idle come from 2.x execution events, which is all 2.3.2 publishes', () => {
  const t = createV2Translator()
  const status = (type: string) => ({ type: 'session.status', properties: { sessionID: 's', status: { type } } })
  expect(t({ type: 'session.execution.started', data: { sessionID: 's' } })).toEqual([status('busy')])
  expect(t({ type: 'session.execution.succeeded', data: { sessionID: 's' } })).toEqual([status('idle')])
  expect(t({ type: 'session.execution.failed', data: { sessionID: 's', error: { type: 'E', message: 'm' } } }).map((e) => e.type)).toEqual(['session.error', 'session.status'])
  expect(t({ type: 'session.execution.interrupted', data: { sessionID: 's', reason: 'user' } })).toEqual([
    { type: 'session.error', properties: { sessionID: 's', error: { name: 'MessageAbortedError', data: { message: 'user' } } } },
    status('idle'),
  ])
  // only the user's own stop reads as stopped
  expect(t({ type: 'session.execution.interrupted', data: { sessionID: 's', reason: 'shutdown' } })).toEqual([status('idle')])
})

test('forms owned by no session (MCP, "global") never become questions', async () => {
  const t = createV2Translator()
  expect(t({ type: 'form.created', data: { form: { ...form, sessionID: 'global' } } })).toEqual([])
  const { c } = client({ 'GET /api/form': { data: [form, { ...form, id: 'frm_g', sessionID: 'global' }] } })
  expect((await c.listQuestions('/repo')).map((q) => q.id)).toEqual(['frm_1'])
})

test('boolean and number fields are answered with their own types', () => {
  const typed = { fields: [{ key: 'b', type: 'boolean' }, { key: 'n', type: 'integer' }] }
  expect(v2Answer(typed, [['true'], ['3']])).toEqual({ b: true, n: 3 })
})

test('agents are named by id, and hidden ones are left out', async () => {
  const { c } = client({ 'GET /api/agent': { data: [{ id: 'build', name: 'Build', hidden: false }, { id: 'compaction', name: 'Compaction', hidden: true }] } })
  expect((await c.listAgents())?.map((a) => a.name)).toEqual(['build'])
})

test('the API probe carries no credential, and only 2.x bodies read as 2.x', async () => {
  const seen: any[] = []
  const answer = (body: unknown, status: number) => (url: string, init: any) => {
    seen.push(init?.headers)
    return json(body, status)
  }
  const base = () => `http://127.0.0.1:${port++}`
  const { opencodeApi } = await import('../src/backends/opencode/client.ts')
  vi.stubEnv('OPENCODE_SERVER_PASSWORD', 'secret')
  try {
    expect(await opencodeApi(base(), answer({ _tag: 'UnauthorizedError', message: 'Authentication required' }, 401) as any)).toBe(2)
    expect(await opencodeApi(base(), answer({ version: '2.3.2', pid: 1 }, 500) as any)).toBe(2) // boot failed is still 2.x
    expect(await opencodeApi(base(), answer({ error: 'not found' }, 404) as any)).toBe(1) // e.g. a proxied 1.x
    expect(await opencodeApi(base(), html as any)).toBe(1)
    // no answer is not an answer: it rejects, and the next ask goes to the network again
    const down = base()
    await expect(opencodeApi(down, (() => Promise.reject(new Error('ECONNREFUSED'))) as any)).rejects.toThrow('ECONNREFUSED')
    expect(await opencodeApi(down, answer({ _tag: 'UnauthorizedError' }, 401) as any)).toBe(2)
  } finally {
    vi.unstubAllEnvs()
  }
  expect(seen.every((h) => !h?.authorization)).toBe(true)
})

test('children never inherit either opencode password name', async () => {
  const { envWithoutServerPassword } = await import('../src/registry.ts')
  expect(envWithoutServerPassword({ OPENCODE_SERVER_PASSWORD: 'a', OPENCODE_PASSWORD: 'b', PATH: '/bin' })).toEqual({ PATH: '/bin' })
})
