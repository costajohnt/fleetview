import { test, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listSessions, runAttach, runLogs, runRm, runStatus, runStop } from '../src/commands.ts'
import { createClaudeBackend } from '../src/backends/claude/index.ts'
import { encodeProjectDir } from '../src/backends/claude/projects.ts'
import { OPENCODE_MISSING } from '../src/backends/opencode/server-manager.ts'

// M10: the shell commands see every backend, not only opencode. claude is the real adapter over a
// fake ~/.claude (so discovery is the same code the roster runs); opencode is a fake client.
const CLAUDE_ID = 'c1a0de00-0000-4000-8000-000000000001'
const server = { host: '127.0.0.1', port: 4900 }

function setup({ opencodeUp = true, opencodeSessions = [{ id: 'ses_open1', title: 'opencode work', time: { created: 1, updated: 3000 } }] as any[] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'fleetview-all-home-'))
  const runDir = mkdtempSync(join(tmpdir(), 'fleetview-all-runs-'))
  const rosterFile = join(mkdtempSync(join(tmpdir(), 'fleetview-all-roster-')), 'roster.json')
  // /x/beta is known only from the roster, which is how a claude-only directory is found.
  writeFileSync(rosterFile, JSON.stringify({ groupBy: 'state', collapsed: [], sessions: [{ worktree: '/x/beta', id: CLAUDE_ID, addedAt: 1, backend: 'claude' }] }))
  const transcriptDir = join(home, '.claude', 'projects', encodeProjectDir('/x/beta'))
  mkdirSync(transcriptDir, { recursive: true })
  writeFileSync(
    join(transcriptDir, `${CLAUDE_ID}.jsonl`),
    `${JSON.stringify({ type: 'user', cwd: '/x/beta', sessionId: CLAUDE_ID, timestamp: '2026-10-01T00:00:00Z', message: { role: 'user', content: 'fix the flaky test' } })}\n`,
  )
  const killImpl = vi.fn()
  const claude = createClaudeBackend({ home, runDir, killImpl, psImpl: () => ({ startedAt: 0, command: `claude --resume ${CLAUDE_ID}` }) })
  const client = {
    listProjects: vi.fn(() => Promise.resolve([{ id: 'a', worktree: '/x/alpha' }])),
    listSessions: vi.fn((dir: string) => Promise.resolve(dir === '/x/alpha' ? opencodeSessions : [])),
    sessionStatus: vi.fn(() => Promise.resolve({ ses_open1: { type: 'busy' } })),
    listPermissions: vi.fn(() => Promise.resolve([])),
    listQuestions: vi.fn(() => Promise.resolve([])),
    abortSession: vi.fn(() => Promise.resolve(true)),
    deleteSession: vi.fn(() => Promise.resolve(true)),
    listMessages: vi.fn(() => Promise.resolve([])),
  }
  const out: string[] = []
  const errs: string[] = []
  const codes: number[] = []
  const ensureServer = vi.fn(() => Promise.resolve(opencodeUp ? { ok: true, server } : { ok: false, server, reason: OPENCODE_MISSING }))
  const deps = {
    ensureServer,
    serverFile: '/tmp/does-not-exist-server.json',
    createClient: () => client as any,
    backends: { claude },
    rosterFile,
    log: (m: string) => out.push(m),
    error: (m: string) => errs.push(m),
    setExitCode: (c: number) => codes.push(c),
  }
  const lsDeps = {
    createClient: deps.createClient,
    loadSeenImpl: () => ({}),
    seenFile: () => '/tmp/does-not-exist-seen.json',
    rosterFile: () => rosterFile,
    backends: deps.backends,
    log: deps.log,
    error: deps.error,
    setExitCode: deps.setExitCode,
  }
  return { client, claude, killImpl, runDir, rosterFile, out, errs, codes, deps, lsDeps, ensureServer }
}

test('--json lists every backend, each row naming its backend', async () => {
  const h = setup()
  await listSessions({ command: 'ls', json: true, all: true }, h.ensureServer, '/tmp/s.json', h.lsDeps)
  const rows = JSON.parse(h.out.join('\n'))
  expect(rows.map((r: any) => [r.id, r.backend])).toEqual([
    ['ses_open1', 'opencode'],
    [CLAUDE_ID, 'claude'],
  ])
  expect(rows[1]).toMatchObject({ name: 'fix the flaky test', cwd: '/x/beta', kind: 'background' })
  expect(h.errs).toEqual([])
})

test('without opencode, --json still lists claude sessions and says why on stderr only', async () => {
  const h = setup({ opencodeUp: false })
  await listSessions({ command: 'ls', json: true, all: true }, h.ensureServer, '/tmp/s.json', h.lsDeps)
  expect(JSON.parse(h.out.join('\n')).map((r: any) => r.id)).toEqual([CLAUDE_ID])
  expect(h.errs).toEqual(['fleetview: opencode is not installed; showing claude sessions only'])
  expect(h.codes).toEqual([])
  expect(h.client.listProjects).not.toHaveBeenCalled()
})

test('with no other backend, opencode missing is still an error', async () => {
  const h = setup({ opencodeUp: false })
  await listSessions({ command: 'ls', json: true }, h.ensureServer, '/tmp/s.json', { ...h.lsDeps, backends: {} })
  expect(h.errs).toEqual([OPENCODE_MISSING])
  expect(h.codes).toEqual([1])
  expect(h.out).toEqual([])
})

// A run fleetview dispatched: meta plus a captured stream that has started and not finished.
const startRun = (runDir: string) => {
  writeFileSync(join(runDir, `${CLAUDE_ID}.json`), JSON.stringify({ id: CLAUDE_ID, directory: '/x/beta', pid: 4242, startedAt: 1 }))
  writeFileSync(join(runDir, `${CLAUDE_ID}.jsonl`), `${JSON.stringify({ type: 'system', subtype: 'init', cwd: '/x/beta', session_id: CLAUDE_ID })}\n`)
}

test('a running claude session reads working in ls, through the same event fold the roster uses', async () => {
  const h = setup({ opencodeUp: false })
  startRun(h.runDir)
  await listSessions({ command: 'ls', json: true }, h.ensureServer, '/tmp/s.json', h.lsDeps)
  expect(JSON.parse(h.out.join('\n'))).toMatchObject([{ id: CLAUDE_ID, backend: 'claude', state: 'working' }])
})

test('status counts claude sessions too', async () => {
  const h = setup({ opencodeUp: false })
  startRun(h.runDir)
  await runStatus({ command: 'status' }, { ...h.deps, loadSeenImpl: () => ({}), seenFile: () => '/tmp/does-not-exist-seen.json' })
  expect(h.out).toEqual(['0 awaiting input · 1 working · 0 completed'])
})

test('an id prefix matching sessions on two backends lists both and acts on neither', async () => {
  // An opencode id sharing the claude session's first characters.
  const h = setup({ opencodeSessions: [{ id: 'c1a0de00-other', title: 'x', time: { created: 1, updated: 1 } }] })
  await runStop({ command: 'stop', id: 'c1a0de00' }, h.deps)
  expect(h.errs).toEqual([
    ['c1a0de00 matches 2 sessions — use more of the id:', '  c1a0de00-other  /x/alpha', `  ${CLAUDE_ID}  /x/beta  (claude)`].join('\n'),
  ])
  expect(h.codes).toEqual([1])
  expect(h.client.abortSession).not.toHaveBeenCalled()
  expect(h.killImpl).not.toHaveBeenCalled()
})

test('an opencode id still resolves to opencode with claude in the mix', async () => {
  const h = setup()
  await runStop({ command: 'stop', id: 'ses_open' }, h.deps)
  expect(h.client.abortSession).toHaveBeenCalledWith('ses_open1', '/x/alpha')
  expect(h.out).toEqual(['stopped ses_open1'])
})

test('stop on a claude session signals its run through the claude adapter', async () => {
  const h = setup({ opencodeUp: false })
  startRun(h.runDir)
  await runStop({ command: 'stop', id: CLAUDE_ID.slice(0, 8) }, h.deps)
  expect(h.killImpl).toHaveBeenCalledWith(-4242, 'SIGTERM')
  expect(h.out).toEqual([`stopped ${CLAUDE_ID}`])
})

test('stop on a claude session with nothing running says so rather than "stopped"', async () => {
  const h = setup({ opencodeUp: false })
  await runStop({ command: 'stop', id: CLAUDE_ID }, h.deps)
  expect(h.killImpl).not.toHaveBeenCalled()
  expect(h.out).toEqual([`nothing running to stop on ${CLAUDE_ID}`])
})

test('rm on a claude session refuses, because claude cannot delete one, and leaves the roster alone', async () => {
  const h = setup()
  const before = readFileSync(h.rosterFile, 'utf8')
  await runRm({ command: 'rm', id: CLAUDE_ID }, h.deps)
  expect(h.errs).toEqual([`claude cannot delete a session (its CLI has no way to); fleetview stop ${CLAUDE_ID} ends a running one`])
  expect(h.codes).toEqual([1])
  expect(h.client.deleteSession).not.toHaveBeenCalled()
  expect(readFileSync(h.rosterFile, 'utf8')).toBe(before)
})

// A claude dispatch fleetview isolated in a local worktree: rm forgets the row and takes the worktree
// with it, under the same guards as ^x^x.
function localWorktreeRoster(h: ReturnType<typeof setup>, extra: object[] = []) {
  writeFileSync(
    h.rosterFile,
    JSON.stringify({ groupBy: 'state', collapsed: [], sessions: [{ worktree: '/x/beta', id: CLAUDE_ID, addedAt: 1, backend: 'claude', repo: '/x/repo' }, ...extra] }),
  )
}

test('rm on a claude session in a local worktree forgets it and removes a clean worktree', async () => {
  const h = setup()
  localWorktreeRoster(h)
  const removeLocalWorktreeImpl = vi.fn()
  const worktreeSafetyImpl = vi.fn(() => ({ removable: true, reason: null }))
  await runRm({ command: 'rm', id: CLAUDE_ID }, { ...h.deps, isLocalWorktreeImpl: () => true, removeLocalWorktreeImpl, worktreeSafetyImpl })
  expect(worktreeSafetyImpl).toHaveBeenCalledWith('/x/beta', '/x/repo')
  expect(removeLocalWorktreeImpl).toHaveBeenCalledWith('/x/beta', '/x/repo')
  expect(h.out).toEqual([`removed ${CLAUDE_ID} and its worktree`])
  expect(h.codes).toEqual([])
  expect(JSON.parse(readFileSync(h.rosterFile, 'utf8')).sessions).toEqual([])
})

test('rm on a claude session in a local worktree keeps a worktree with work in it', async () => {
  const h = setup()
  localWorktreeRoster(h)
  const removeLocalWorktreeImpl = vi.fn()
  await runRm(
    { command: 'rm', id: CLAUDE_ID },
    { ...h.deps, isLocalWorktreeImpl: () => true, removeLocalWorktreeImpl, worktreeSafetyImpl: () => ({ removable: false, reason: 'uncommitted changes' }) },
  )
  expect(removeLocalWorktreeImpl).not.toHaveBeenCalled()
  expect(h.out).toEqual([`removed ${CLAUDE_ID} — kept its worktree (uncommitted changes): /x/beta`])
})

test('rm on a claude session in a local worktree keeps it while another session uses it', async () => {
  const h = setup()
  localWorktreeRoster(h, [{ worktree: '/x/beta', id: 'c1a0de00-0000-4000-8000-000000000002', addedAt: 2, backend: 'claude', repo: '/x/repo' }])
  const removeLocalWorktreeImpl = vi.fn()
  await runRm({ command: 'rm', id: CLAUDE_ID }, { ...h.deps, isLocalWorktreeImpl: () => true, removeLocalWorktreeImpl, worktreeSafetyImpl: () => ({ removable: true, reason: null }) })
  expect(removeLocalWorktreeImpl).not.toHaveBeenCalled()
  expect(h.out).toEqual([`removed ${CLAUDE_ID} — kept its worktree (1 other session still uses it): /x/beta`])
})

test('attach on a claude session runs claude --resume in its directory without the server password', async () => {
  const h = setup({ opencodeUp: false })
  const spawnSyncImpl = vi.fn(() => ({}) as any)
  process.env.OPENCODE_SERVER_PASSWORD = 'secret-for-test'
  try {
    await runAttach({ command: 'attach', id: CLAUDE_ID }, { ...h.deps, spawnSyncImpl })
  } finally {
    delete process.env.OPENCODE_SERVER_PASSWORD
  }
  const [command, argv, options] = spawnSyncImpl.mock.calls[0] as any
  expect([command, ...argv]).toEqual(['claude', '--resume', CLAUDE_ID])
  expect(options.cwd).toBe('/x/beta')
  expect(options.env.OPENCODE_SERVER_PASSWORD).toBe(undefined)
})

test('logs on a claude session points at attach instead of printing nothing', async () => {
  const h = setup()
  await runLogs({ command: 'logs', id: CLAUDE_ID }, h.deps)
  expect(h.errs).toEqual([`claude sessions have no transcript fleetview can read; fleetview attach ${CLAUDE_ID} to read it`])
  expect(h.codes).toEqual([1])
})
