import React from 'react'
import { test, expect, vi, afterEach } from 'vitest'
import { render as inkRender } from 'ink-testing-library'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from '../src/app.ts'
import { makePersistRoster } from '../src/roster-store.ts'
import { headerRows } from '../src/ui/header.ts'

// Every render is torn down after its test. Without this, each instance keeps its timers alive —
// the working-icon pulse most of all — and by the end of the file the accumulated intervals starve
// the event loop enough to time out later waitFor polls.
const live: any[] = []
// Strip ANSI codes from frames: colored/bold text puts escape codes inside the raw frame, which
// breaks contiguous-string matching and line-shape assertions.
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
const render = (...args: any[]) => {
  const instance = (inkRender as any)(...args)
  live.push(instance)
  return { ...instance, lastFrame: () => stripAnsi(instance.lastFrame() ?? '') } as {
    stdin: { write: (s: string) => void }
    lastFrame: () => string
    unmount: () => void
  }
}
afterEach(() => {
  for (const instance of live.splice(0)) instance.unmount()
})

const server = { host: '127.0.0.1', port: 4900 }
const project = { id: 'a-1', worktree: '/x/alpha', vcs: 'git', time: { created: 1, updated: 1000 } }

// The three state categories are always on screen now, so "is a session under X" can't be asked
// with a bare .includes() — the header word X is always present. This returns just the lines of
// one category's body (everything after its header, up to the next category header), so a test can
// assert what a category does or doesn't contain.
const STATE_HEADERS = ['needs input', 'working', 'completed']
function sectionBody(frame: string, label: string) {
  const lines = frame.split('\n')
  const start = lines.findIndex((l) => l.includes(label))
  if (start < 0) return ''
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (STATE_HEADERS.some((h) => h !== label && lines[i].includes(h))) {
      end = i
      break
    }
  }
  return lines.slice(start + 1, end).join('\n')
}

function makeDeps(): any {
  const client = {
    listProjects: vi.fn(() => Promise.resolve([project])),
    listSessions: vi.fn(() => Promise.resolve([{ id: 's1', title: 'fix tests', time: { updated: Date.now() } }])),
    createSession: vi.fn(() => Promise.resolve({ id: 's9' })),
    promptAsync: vi.fn(() => Promise.resolve({})),
    renameSession: vi.fn(() => Promise.resolve({})),
    deleteSession: vi.fn(() => Promise.resolve({})),
    listMessages: vi.fn(() => Promise.resolve([])),
    sessionStatus: vi.fn(() => Promise.resolve({})),
    listPermissions: vi.fn(() => Promise.resolve([])),
    listQuestions: vi.fn(() => Promise.resolve([])),
    abortSession: vi.fn(() => Promise.resolve({})),
    respondPermission: vi.fn(() => Promise.resolve({})),
  }
  return {
    server,
    client,
    connectEventsImpl: vi.fn(() => ({ done: Promise.resolve(), stop: vi.fn() })),
    ensureServerImpl: vi.fn(() => Promise.resolve({ ok: true, server })),
    serverReady: true,
    // default fixture: s1 is already a roster member so listing/CRUD tests that predate the
    // membership model keep working without every test wiring up dispatch/browse first.
    roster: { groupBy: 'state', sessions: [{ worktree: '/x/alpha', id: 's1', addedAt: 1 }] },
    persistRoster: vi.fn(),
    // Dispatch refuses a target directory that is gone (#22); these fixtures' paths never existed
    // on disk, so the on-disk check is stubbed to "present" unless a test says otherwise.
    dirExistsImpl: () => true,
  }
}

const tick = () => new Promise((r) => setTimeout(r, 20))

// polls a condition instead of sleeping a fixed window — real-timer async chains in this
// environment don't run at a predictable wall-clock pace, so fixed-window assertions on a
// toggling state (banner shown, then cleared) are flaky.
// Writes a key until the condition holds. Node 24 drops the first stdin chunk written after an
// attach/detach cycle re-activates useInput (Node 26 delivers it; the same drop is what made the
// click-after-detach test unpinnable) — a retry makes the tests version-proof without hiding a
// real regression: a broken handler never satisfies the condition no matter how often the key
// lands, and every use sends a key whose repeat is idempotent for what the test asserts.
const pressUntil = async (stdin: any, key: string, fn: () => any, timeoutMs = 3000) => {
  const start = Date.now()
  for (;;) {
    stdin.write(key)
    await new Promise((r) => setTimeout(r, 50))
    if (fn()) return
    if (Date.now() - start > timeoutMs) throw new Error(`pressUntil timed out for ${JSON.stringify(key)}`)
  }
}

const waitFor = async (fn: () => any, timeoutMs = 3000, stepMs = 10) => {
  const start = Date.now()
  for (;;) {
    if (fn()) return
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

// Deflake: this used to await a fixed 20ms tick() before asserting — under load the discovery
// chain (listProjects → listSessions → connectEvents → seedLiveState) can take longer than that,
// making the test flaky. waitFor polls the actual rendered condition instead of a wall-clock guess.
test('discovery populates groups: listProjects + per-project listSessions seed the roster', async () => {
  const deps = makeDeps()
  const { lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  expect(deps.client.listProjects).toHaveBeenCalled()
  expect(deps.client.listSessions).toHaveBeenCalledWith('/x/alpha')
  expect(deps.connectEventsImpl).toHaveBeenCalledWith(
    { ...server, directory: '/x/alpha' },
    expect.objectContaining({ onEvent: expect.any(Function) }),
  )
  const frame = lastFrame()
  expect(frame).toContain('fix tests')
  expect(frame).not.toContain('alpha') // state grouping never names the directory
})

test('server unreachable renders only the restart message', async () => {
  const deps = makeDeps()
  deps.serverReady = false
  deps.serverFailReason = 'server did not become healthy'
  const { lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  const frame = lastFrame()
  expect(frame).toContain('opencode server unreachable — restart fleetview')
  expect(frame).toContain('server did not become healthy')
  expect(frame).not.toContain('move')
  expect(deps.client.listProjects).not.toHaveBeenCalled()
})

test('repoll discovers a new project and seeds + streams it (browse view)', async () => {
  const deps = makeDeps()
  const beta = { id: 'b-1', worktree: '/x/beta', vcs: 'git', time: { created: 1, updated: 2000 } }
  deps.client.listProjects = vi
    .fn()
    .mockResolvedValueOnce([project])
    .mockResolvedValue([project, beta])
  const { stdin, lastFrame, unmount } = render(
    React.createElement(App, { ...deps, onAction: vi.fn(), projectPollMs: 15 }),
  )
  try {
    await waitFor(() => lastFrame().includes('fix tests'))
    stdin.write('\x02') // browse shows every discovered project regardless of roster membership
    await waitFor(() => lastFrame().includes('beta')) // repoll discovered + seeded + rendered it
    expect(deps.client.listSessions).toHaveBeenCalledWith('/x/beta')
    await waitFor(() => deps.client.sessionStatus.mock.calls.some((c: any) => c[0] === '/x/beta'))
    expect(deps.client.listPermissions).toHaveBeenCalledWith('/x/beta')
    expect(deps.connectEventsImpl).toHaveBeenCalledWith(
      { ...server, directory: '/x/beta' },
      expect.objectContaining({ onEvent: expect.any(Function) }),
    )
  } finally {
    unmount() // stop the 15ms repoll interval — it would otherwise fire for the rest of the suite
  }
})

test('lists sessions on start; Enter emits enter action with worktree', async () => {
  const deps = makeDeps()
  const onAction = vi.fn()
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('\r')
  expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ type: 'enter', sessionId: 's1', worktree: '/x/alpha' }))
})

test('typing a prompt and pressing Enter dispatches createSession + promptAsync with directory', async () => {
  const deps = makeDeps()
  const { stdin } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  stdin.write('do a thing')
  await tick()
  stdin.write('\r') // input holds text → dispatch, not attach
  await tick()
  // no title: opencode names it. agent/model ride along, unset unless @agent or /model said so.
  expect(deps.client.createSession).toHaveBeenCalledWith({ agent: undefined, model: null }, '/x/alpha')
  expect(deps.client.promptAsync).toHaveBeenCalledWith('s9', 'do a thing', '/x/alpha')
})

test('launch --model / --agent seed the dispatch model and default agent (#87)', async () => {
  const deps = makeDeps()
  const model = { providerID: 'anthropic', id: 'claude-opus-5' }
  const { stdin } = render(
    React.createElement(App, { ...deps, onAction: vi.fn(), initialModel: model, initialAgent: 'reviewer' }),
  )
  await tick()
  stdin.write('do a thing')
  await tick()
  stdin.write('\r')
  await tick()
  expect(deps.client.createSession).toHaveBeenCalledWith({ agent: 'reviewer', model }, '/x/alpha')
})

test('an @agent prefix overrides the launch --agent default (#87)', async () => {
  const deps = makeDeps()
  deps.client.listAgents = vi.fn(() => Promise.resolve([{ name: 'build' }, { name: 'reviewer' }]))
  const { stdin, lastFrame } = render(
    React.createElement(App, { ...deps, onAction: vi.fn(), initialAgent: 'build' }),
  )
  await waitFor(() => deps.client.listAgents.mock.calls.length > 0)
  stdin.write('@reviewer look at the diff')
  await waitFor(() => lastFrame().includes('@reviewer look at the diff█'))
  stdin.write('\r')
  await waitFor(() => deps.client.createSession.mock.calls.length > 0)
  expect(deps.client.createSession).toHaveBeenCalledWith({ agent: 'reviewer', model: null }, '/x/alpha')
})

test('the header shows the launch --model instead of "default model" (#87)', async () => {
  const deps = makeDeps()
  const { lastFrame } = render(
    React.createElement(App, { ...deps, onAction: vi.fn(), initialModel: { providerID: 'anthropic', id: 'claude-opus-5' } }),
  )
  await waitFor(() => lastFrame().includes('anthropic/claude-opus-5'))
  expect(lastFrame()).not.toContain('default model')
})

test('dispatch auto-adds the new session to the roster and persists before promptAsync', async () => {
  const deps = makeDeps()
  const order: any[] = []
  deps.client.createSession = vi.fn(() => {
    order.push('createSession')
    return Promise.resolve({ id: 's9' })
  })
  deps.persistRoster = vi.fn((r: any) => order.push(`persistRoster:${r.sessions.map((s: any) => s.id).join(',')}`))
  deps.client.promptAsync = vi.fn(() => {
    order.push('promptAsync')
    return Promise.resolve({})
  })
  const { stdin } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  stdin.write('do a thing')
  await tick()
  stdin.write('\r')
  await tick()
  expect(order[0]).toBe('createSession')
  expect(order[1]).toContain('persistRoster')
  expect(order[1]).toContain('s9')
  expect(order[2]).toBe('promptAsync') // membership persisted BEFORE promptAsync — dispatch counts even if the prompt fails
})

test('dispatch membership survives a promptAsync failure', async () => {
  const deps = makeDeps()
  deps.client.promptAsync = vi.fn(() => Promise.reject(new Error('down')))
  const { stdin } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  stdin.write('do a thing')
  await tick()
  stdin.write('\r')
  await tick()
  expect(deps.persistRoster).toHaveBeenCalledWith(
    expect.objectContaining({
      sessions: expect.arrayContaining([expect.objectContaining({ worktree: '/x/alpha', id: 's9' })]),
    }),
  )
})

test('browse: ^x twice deletes selected session (stop, then delete)', async () => {
  const deps = makeDeps()
  const { stdin } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  stdin.write('\x02')
  await tick()
  stdin.write('\x18')
  await tick()
  stdin.write('\x18')
  await tick()
  expect(deps.client.deleteSession).toHaveBeenCalledWith('s1', '/x/alpha')
})

test('browse: ^x twice also prunes the ghost roster membership + persists (F1)', async () => {
  const deps = makeDeps() // s1 starts as a roster member (default fixture)
  const { stdin } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  stdin.write('\x02')
  await tick()
  stdin.write('\x18')
  await tick()
  stdin.write('\x18')
  await tick()
  expect(deps.client.deleteSession).toHaveBeenCalledWith('s1', '/x/alpha')
  expect(deps.persistRoster).toHaveBeenCalledWith(expect.objectContaining({ sessions: [] }))
})

test('main: ^a removes from roster only — session NOT deleted or stopped', async () => {
  const deps = makeDeps()
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('\x01')
  await tick()
  expect(deps.client.deleteSession).not.toHaveBeenCalled()
  expect(deps.client.abortSession).not.toHaveBeenCalled()
  expect(deps.persistRoster).toHaveBeenCalledWith(expect.objectContaining({ sessions: [] }))
  expect(lastFrame()).toContain('a session is asking you something')
})

test('main: ^x twice removes from roster AND deletes the session', async () => {
  const deps = makeDeps()
  const { stdin } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  stdin.write('\x18')
  await tick()
  stdin.write('\x18')
  await tick()
  expect(deps.client.deleteSession).toHaveBeenCalledWith('s1', '/x/alpha')
  expect(deps.persistRoster).toHaveBeenCalledWith(expect.objectContaining({ sessions: [] }))
})

test('main: ^x twice — deleteSession failure re-adds membership so the row reappears, not silently gone (F2)', async () => {
  const deps = makeDeps()
  deps.client.deleteSession = vi.fn(() => Promise.reject(new Error('down')))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('\x18')
  await tick()
  stdin.write('\x18')
  await waitFor(() => lastFrame().includes('fix tests')) // row reappeared instead of vanishing on failure
  await waitFor(() => lastFrame().includes('∙')) // the row's shape carries "can't answer" now
  expect(deps.persistRoster).toHaveBeenLastCalledWith(
    expect.objectContaining({
      sessions: expect.arrayContaining([expect.objectContaining({ worktree: '/x/alpha', id: 's1' })]),
    }),
  )
})

test('main: a single ^x stops without deleting, and says a second press would delete', async () => {
  const deps = makeDeps()
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  stdin.write('\x18')
  await tick()
  expect(deps.client.abortSession).toHaveBeenCalledWith('s1', '/x/alpha')
  expect(deps.client.deleteSession).not.toHaveBeenCalled()
  expect(deps.persistRoster).not.toHaveBeenCalled()
  expect(lastFrame()).toContain('^x again to delete')
  expect(lastFrame()).toContain('fix tests')
})

test('unmount before startup resolves leaks no connections', async () => {
  const deps = makeDeps()
  let resolveList: any
  deps.client.listProjects = vi.fn(() => new Promise((r) => { resolveList = r }))
  const { unmount } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  unmount()
  resolveList([project])
  await tick()
  expect(deps.connectEventsImpl).not.toHaveBeenCalled()
})

test('dispatch failure flags project offline instead of crashing', async () => {
  const deps = makeDeps()
  deps.client.createSession = vi.fn(() => Promise.reject(new Error('server down')))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  stdin.write('do a thing')
  await tick()
  stdin.write('\r')
  await tick()
  stdin.write('\x02') // offline is flagged on the project header — visible in browse
  await tick()
  await waitFor(() => lastFrame().includes('offline'))
})

test('r renames selected session', async () => {
  const deps = makeDeps()
  const { stdin } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  stdin.write('\x12')
  await tick()
  stdin.write(' v2')
  await tick()
  stdin.write('\r')
  await tick()
  expect(deps.client.renameSession).toHaveBeenCalledWith('s1', 'fix tests v2', '/x/alpha')
})

// M3: backspace must remove a whole grapheme, not just the last UTF-16 code unit — a raw
// slice(0, -1) after a surrogate-pair emoji leaves a lone (unpaired) surrogate behind.
test('M3: backspace in the rename input after an emoji removes the whole emoji, not half of it', async () => {
  const deps = makeDeps()
  const { stdin } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  stdin.write('\x12')
  await tick()
  stdin.write('🔥')
  await tick()
  stdin.write('\x7F') // backspace
  await tick()
  stdin.write('\r')
  await tick()
  expect(deps.client.renameSession).toHaveBeenCalledWith('s1', 'fix tests', '/x/alpha')
  expect(deps.client.renameSession.mock.calls[0][1].isWellFormed()).toBe(true) // no lone surrogate left behind
})

test('rename failure flags project offline instead of crashing', async () => {
  const deps = makeDeps()
  deps.client.renameSession = vi.fn(() => Promise.reject(new Error('down')))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  stdin.write('\x12')
  await tick()
  stdin.write(' v2')
  await tick()
  stdin.write('\r')
  await tick()
  stdin.write('\x02') // offline is flagged on the project header — visible in browse
  await tick()
  await waitFor(() => lastFrame().includes('offline'))
})

test('browse: kill failure flags project offline instead of crashing', async () => {
  const deps = makeDeps()
  deps.client.deleteSession = vi.fn(() => Promise.reject(new Error('down')))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  stdin.write('\x02')
  await tick()
  stdin.write('\x18')
  await tick()
  stdin.write('\x18')
  await tick()
  await waitFor(() => lastFrame().includes('offline'))
})

test('a succeeding CRUD call clears a sticky offline flag from an earlier failure', async () => {
  const deps = makeDeps()
  deps.client.deleteSession = vi.fn(() => Promise.reject(new Error('down')))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  stdin.write('\x02')
  await tick()
  stdin.write('\x18')
  await tick()
  stdin.write('\x18')
  await tick()
  await waitFor(() => lastFrame().includes('offline')) // deleteSession failure flagged it

  deps.client.renameSession = vi.fn(() => Promise.resolve({}))
  stdin.write('\x12')
  await tick()
  stdin.write(' v2')
  await tick()
  stdin.write('\r')
  await tick()
  await waitFor(() => !lastFrame().includes('offline')) // renameSession success on the same project clears it
})

test('reconnect (onOnline) re-syncs the session list', async () => {
  const deps = makeDeps()
  deps.client.listSessions = vi
    .fn()
    .mockResolvedValueOnce([{ id: 's1', title: 'fix tests', time: { updated: Date.now() } }])
    .mockResolvedValueOnce([{ id: 's1', title: 'renamed while offline', time: { updated: Date.now() } }])
  const { lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  const onOnline = deps.connectEventsImpl.mock.calls[0][1].onOnline
  onOnline('/x/alpha')
  await tick()
  await waitFor(() => lastFrame().includes('renamed while offline'))
})

test('session.deleted SSE event prunes roster membership and persists (explicit delete evidence, F1)', async () => {
  const deps = makeDeps() // s1 starts as a roster member (default fixture)
  const { lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  const onEvent = deps.connectEventsImpl.mock.calls[0][1].onEvent
  onEvent('/x/alpha', { type: 'session.deleted', properties: { info: { id: 's1' } } })
  await tick()
  expect(deps.persistRoster).toHaveBeenCalledWith(expect.objectContaining({ sessions: [] }))
})

test('killing the selected last row clamps selection; Enter targets the remaining session', async () => {
  const deps = makeDeps()
  deps.roster = {
    groupBy: 'state',
    sessions: [
      { worktree: '/x/alpha', id: 's1', addedAt: 1 },
      { worktree: '/x/alpha', id: 's2', addedAt: 2 },
    ],
  }
  deps.client.listSessions = vi.fn(() =>
    Promise.resolve([
      { id: 's1', title: 'first', time: { updated: Date.now() } },
      { id: 's2', title: 'second', time: { updated: Date.now() - 1 } },
    ]),
  )
  const onAction = vi.fn()
  const { stdin } = render(React.createElement(App, { ...deps, onAction }))
  await tick()
  stdin.write('\x1B[B') // down arrow → select s2 (last row)
  await tick()
  stdin.write('\x01') // main: remove s2 from roster (not a hard delete)
  await tick()
  stdin.write('\r')
  await waitFor(() => onAction.mock.calls.length > 0)
  expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ type: 'enter', sessionId: 's1', worktree: '/x/alpha' }))
})

test('browse caps to 10 most-recent sessions per project and shows hidden count', async () => {
  const deps = makeDeps()
  const now = Date.now() // captured once — calling Date.now() per iteration is flaky under load,
  // since real wall-clock drift between calls can exceed the 1ms-per-index spacing this test relies on.
  const sessions = Array.from({ length: 12 }, (_, i) => ({
    id: `s${i}`,
    title: `session ${i}`,
    time: { updated: now - i }, // s0 newest .. s11 oldest
  }))
  deps.client.listSessions = vi.fn(() => Promise.resolve(sessions))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  stdin.write('\x02')
  await tick()
  const frame = lastFrame()
  for (let i = 0; i < 10; i++) expect(frame).toContain(`session ${i}`)
  expect(frame).not.toContain('session 10')
  expect(frame).not.toContain('session 11')
  expect(frame).toContain('… 2 more')
})

test('seen map prewarms done status on mount; persistSeen called with snapshot', async () => {
  const deps = makeDeps()
  deps.client.listSessions = vi.fn(() => Promise.resolve([{ id: 's1', title: 'fix tests', time: { updated: 0 } }]))
  const persistSeen = vi.fn()
  const seen = { '/x/alpha:s1': { updated: 0, hasRun: true } }
  const { lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn(), seen, persistSeen }))
  await waitFor(() => lastFrame().includes('completed'))
  await waitFor(() => persistSeen.mock.calls.length > 0)
  const snap = persistSeen.mock.calls.at(-1)![0]
  expect(snap['/x/alpha:s1']).toEqual({ updated: 0, hasRun: true, stopped: false })
})

test('a mid-arm reorder cannot make the second ^x delete a different session than the one it armed', async () => {
  const deps = makeDeps()
  deps.client.listSessions = vi.fn(() =>
    Promise.resolve([
      { id: 's1', title: 'first', time: { updated: Date.now() } },
      { id: 's2', title: 'second', time: { updated: Date.now() - 500 } },
    ]),
  )
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  stdin.write('\x02')
  await waitFor(() => lastFrame().includes('❯'))
  stdin.write('\x18') // arms the delete on s1 (top row)
  await waitFor(() => lastFrame().includes('"first"'))
  // SSE event marks s2 busy, bumping its updatedAt above s1 and reordering the roster — the
  // selection index now points at a different session than the one the arm was taken on.
  const onEvent = deps.connectEventsImpl.mock.calls[0][1].onEvent
  onEvent('/x/alpha', { type: 'session.status', properties: { sessionID: 's2', status: { type: 'busy' } } })
  await tick()
  stdin.write('\x18')
  await tick()
  // The arm is keyed on the session, not the row index — and since #18 the selection is too, so it
  // rides the reorder down with s1 and this second press confirms the delete on the session the
  // user actually armed. Either way s2, which merely slid into s1's old slot, is never touched.
  expect(deps.client.deleteSession.mock.calls.every((c: any[]) => c[0] === 's1')).toBe(true)
  expect(deps.client.abortSession.mock.calls.every((c: any[]) => c[0] === 's1')).toBe(true)
})

test('rename dialog survives the target session being deleted mid-dialog via SSE; Esc returns to a responsive roster', async () => {
  const deps = makeDeps()
  const onAction = vi.fn()
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction }))
  await waitFor(() => lastFrame().includes('fix tests')) // ^r is a no-op until a row is selected
  stdin.write('\x12') // open rename on s1
  await waitFor(() => lastFrame().includes('Rename:'))
  const onEvent = deps.connectEventsImpl.mock.calls[0][1].onEvent
  onEvent('/x/alpha', { type: 'session.deleted', properties: { info: { id: 's1' } } })
  await tick()
  // flat is now empty, but the dialog must not freeze (fall through to an inert roster)
  expect(lastFrame()).toContain('Rename:')
  stdin.write('\x1B') // Esc
  await tick()
  stdin.write('\x1B')
  await tick()
  expect(onAction).toHaveBeenCalledWith({ type: 'quit' })
})

test('n does nothing when there are zero projects', async () => {
  const deps = makeDeps()
  deps.client.listProjects = vi.fn(() => Promise.resolve([]))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  stdin.write('n')
  await tick()
  expect(lastFrame()).not.toContain('New session')
})

test('browse: zero-session project still appears with its header', async () => {
  const deps = makeDeps()
  deps.client.listSessions = vi.fn(() => Promise.resolve([]))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  stdin.write('\x02')
  await waitFor(() => lastFrame().split('\n').some((l) => l.trim().replace(/^\u276f /, '').startsWith('alpha')))
})

test('seed retry: a failed first attempt does not orphan the project — next repoll retries it (F1)', async () => {
  const deps = makeDeps()
  deps.client.listSessions = vi
    .fn()
    .mockRejectedValueOnce(new Error('boom'))
    .mockResolvedValue([{ id: 's1', title: 'fix tests', time: { updated: Date.now() } }])
  const { stdin, lastFrame, unmount } = render(
    React.createElement(App, { ...deps, onAction: vi.fn(), projectPollMs: 15 }),
  )
  try {
    await tick()
    stdin.write('\x02')
    await waitFor(() => lastFrame().includes('fix tests')) // initial render lands before any repoll interval can fire
    await waitFor(() => lastFrame().includes('fix tests')) // retried on next repoll, not skipped forever
    // At least, not exactly: the 15ms repoll keeps firing while the assertions run, and each pass
    // may legitimately re-list (periodic reconciliation). Exactly-2 raced that timer and flaked on
    // loaded CI runners — the property is "retried rather than orphaned", which is ≥2.
    expect(deps.client.listSessions.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(deps.connectEventsImpl).toHaveBeenCalledWith(
      { ...server, directory: '/x/alpha' },
      expect.objectContaining({ onEvent: expect.any(Function) }),
    )
  } finally {
    unmount()
  }
})

test('repoll recovers from a dead server: shows a banner then clears it once healthy again (F4)', async () => {
  const deps = makeDeps()
  let listProjectsFailing = false
  deps.client.listProjects = vi.fn(() =>
    listProjectsFailing ? Promise.reject(new Error('down')) : Promise.resolve([project]),
  )
  deps.ensureServerImpl = vi.fn(() => Promise.resolve({ ok: false, server, reason: 'still down' })) // every repoll-triggered recovery attempt fails
  const { lastFrame, unmount } = render(
    React.createElement(App, { ...deps, onAction: vi.fn(), projectPollMs: 10 }),
  )
  try {
    await tick() // let the initial seed land
    expect(lastFrame()).toContain('fix tests')
    listProjectsFailing = true // next repoll tick fails, driving the recovery attempt
    await waitFor(() => lastFrame().includes('opencode server unreachable — will keep retrying'))
    expect(deps.ensureServerImpl.mock.calls.length).toBeGreaterThanOrEqual(1)
    listProjectsFailing = false // recovery: the next repoll tick succeeds again (via listProjects, not ensureServerImpl)
    await waitFor(() => !lastFrame().includes('will keep retrying'))
  } finally {
    unmount() // always stop the interval, even on assertion failure, so it can't bleed into later tests
  }
})

test('repoll recovery via ensureServerImpl with the SAME port clears the banner immediately (audit r2)', async () => {
  const deps = makeDeps()
  // listProjects stays failing for the whole test — the only path back to a clear banner
  // here is the ensureServerImpl same-port branch, not a listProjects success.
  deps.client.listProjects = vi.fn(() => Promise.reject(new Error('down')))
  let recovered = false
  deps.ensureServerImpl = vi.fn(() =>
    Promise.resolve(recovered ? { ok: true, server } : { ok: false, server, reason: 'still down' }),
  )
  const onAction = vi.fn()
  const { lastFrame, unmount } = render(
    React.createElement(App, { ...deps, onAction, projectPollMs: 10 }),
  )
  try {
    await waitFor(() => lastFrame().includes('will keep retrying'))
    recovered = true // ensureServerImpl now reports the SAME port healthy again
    await waitFor(() => !lastFrame().includes('will keep retrying'))
    expect(onAction).not.toHaveBeenCalledWith({ type: 'reconnect' })
  } finally {
    unmount()
  }
})

test('repoll recovery via ensureServerImpl on a DIFFERENT port dispatches reconnect instead of live surgery (audit r2)', async () => {
  const deps = makeDeps()
  let listProjectsFailing = false
  deps.client.listProjects = vi.fn(() =>
    listProjectsFailing ? Promise.reject(new Error('down')) : Promise.resolve([project]),
  )
  deps.ensureServerImpl = vi.fn(() => Promise.resolve({ ok: true, server: { ...server, port: 4901 } }))
  const onAction = vi.fn()
  const { lastFrame, unmount } = render(
    React.createElement(App, { ...deps, onAction, projectPollMs: 10 }),
  )
  try {
    await tick()
    listProjectsFailing = true
    await waitFor(() => onAction.mock.calls.some((c: any) => c[0].type === 'reconnect'))
  } finally {
    unmount()
  }
})

test('dispatch targets the selected row\'s project, so a repoll reorder cannot redirect it (F1)', async () => {
  const deps = makeDeps()
  // beta is newer than alpha, so once discovered it sorts ahead of alpha and becomes the
  // most-recently-updated project — the fallback pickTarget would choose if nothing were selected.
  const beta = { id: 'b-1', worktree: '/x/beta', vcs: 'git', time: { created: 1, updated: 2000 } }
  // gate discovery on a flag so the repoll can't win the race before the prompt is typed
  let discoverBeta = false
  deps.client.listProjects = vi.fn(() => Promise.resolve(discoverBeta ? [beta, project] : [project]))
  deps.client.listSessions = vi.fn((worktree) =>
    Promise.resolve(worktree === '/x/beta' ? [] : [{ id: 's1', title: 'fix tests' }]),
  )
  const { stdin, lastFrame, unmount } = render(
    React.createElement(App, { ...deps, onAction: vi.fn(), projectPollMs: 15 }),
  )
  try {
    await waitFor(() => lastFrame().includes('fix tests')) // initial roster rendered, s1 selected
    discoverBeta = true
    stdin.write('do a thing')
    await waitFor(() => lastFrame().includes('do a thing'))
    // beta must actually have arrived before dispatching, or the assertion proves nothing
    await waitFor(() => deps.client.listSessions.mock.calls.some((c: any) => c[0] === '/x/beta'))
    stdin.write('\r')
    await waitFor(() => deps.client.createSession.mock.calls.length >= 1)
    // the selected row belongs to alpha, so alpha wins over the newer beta
    // no title: opencode names it. agent/model ride along, unset unless @agent or /model said so.
  expect(deps.client.createSession).toHaveBeenCalledWith({ agent: undefined, model: null }, '/x/alpha')
  } finally {
    unmount()
  }
})

// Supersedes F5 ("worktree / renders its own name as the group header"): opencode's synthetic
// `global` project is no longer a group at all, so there is no header to name.
test('the synthetic global project (worktree "/") is neither a browse group nor an @repo target (#25)', async () => {
  const deps = makeDeps()
  const rootProject = { id: 'global', worktree: '/', vcs: 'git', time: { created: 1, updated: 1 } }
  deps.client.listProjects = vi.fn(() => Promise.resolve([rootProject, project]))
  deps.client.listSessions = vi.fn(() => Promise.resolve([]))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn(), cwd: '/x/alpha' }))
  await waitFor(() => deps.client.listProjects.mock.calls.length > 0)
  stdin.write('\x02')
  await waitFor(() => lastFrame().includes('alpha')) // browse rendered, with the real repo in it
  // Header rows carry padding and, when selected, a right-edge tail — normalise before matching.
  expect(
    lastFrame()
      .split('\n')
      .some((l) => ['/', '/ ▾ expanded'].includes(l.replace(/\s+/g, ' ').trim())),
  ).toBe(false)
})

// #22: the worktree of a session deleted with ^x^x vanishes from its repository's `sandboxes` while
// its own project record survives the merge (vanished projects are kept on purpose, so an OFFLINE
// project keeps its rows). Sticky sandbox classification is what stops it being promoted to a repo.
test('a deleted session worktree never becomes a browse group or an @repo completion (#22)', async () => {
  const deps = makeDeps()
  let deleted = false
  const alpha = (sandboxes: string[]) => ({ ...project, sandboxes })
  deps.client.listProjects = vi.fn(() =>
    Promise.resolve(deleted ? [alpha([])] : [alpha(['/x/wt/sleepy'])]),
  )
  deps.client.listSessions = vi.fn(() => Promise.resolve([]))
  const { stdin, lastFrame } = render(
    React.createElement(App, { ...deps, onAction: vi.fn(), cwd: '/x/alpha', projectPollMs: 15 }),
  )
  await waitFor(() => deps.client.listSessions.mock.calls.some((c: any) => c[0] === '/x/wt/sleepy'))
  deleted = true
  const polls = deps.client.listProjects.mock.calls.length
  await waitFor(() => deps.client.listProjects.mock.calls.length > polls + 1)
  stdin.write('\x02')
  await waitFor(() => lastFrame().includes('alpha'))
  expect(lastFrame()).not.toContain('sleepy') // no group of its own, empty or otherwise
  stdin.write('\x02') // back out of browse
  stdin.write('@sleep')
  await waitFor(() => lastFrame().includes('@sleep'))
  expect(lastFrame()).not.toContain('sleepy') // and not offered as a dispatch target
})

test('dispatch into a directory that no longer exists is refused and keeps the prompt (#22)', async () => {
  const deps = makeDeps()
  deps.dirExistsImpl = () => false
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.client.listProjects.mock.calls.length > 0)
  stdin.write('say hi')
  await waitFor(() => lastFrame().includes('say hi'))
  stdin.write('\r')
  await waitFor(() => lastFrame().includes('no longer exists'))
  expect(deps.client.createSession).not.toHaveBeenCalled()
  expect(lastFrame()).toContain('say hi') // the prompt is still there to retarget
})

test('esc quits from the unreachable screen (F6)', async () => {
  const deps = makeDeps()
  deps.serverReady = false
  deps.serverFailReason = 'opencode not installed — see https://opencode.ai'
  const onAction = vi.fn()
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction }))
  await waitFor(() => lastFrame().includes('(esc to quit)'))
  stdin.write('\x1B')
  await tick()
  expect(onAction).toHaveBeenCalledWith({ type: 'quit' })
})

// --- roster membership / state grouping / browse (v3 Task 3) ---

test('membership filtering: non-member session is invisible in main, visible in browse', async () => {
  const deps = makeDeps()
  deps.roster = { groupBy: 'state', sessions: [] } // s1 not a member
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  expect(lastFrame()).not.toContain('fix tests')
  expect(lastFrame()).toContain('a session is asking you something')
  stdin.write('\x02')
  await waitFor(() => lastFrame().includes('fix tests'))
})

test('space in browse adds a non-member session to the roster and marks it; space again removes it', async () => {
  const deps = makeDeps()
  deps.roster = { groupBy: 'state', sessions: [] }
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  stdin.write('\x02')
  await tick()
  expect(lastFrame()).not.toContain('[roster]')
  stdin.write('\x01')
  await tick()
  expect(deps.persistRoster).toHaveBeenCalledWith(
    expect.objectContaining({ sessions: [expect.objectContaining({ worktree: '/x/alpha', id: 's1' })] }),
  )
  expect(lastFrame()).toContain('[roster]')
  stdin.write('\x01')
  await tick()
  expect(deps.persistRoster).toHaveBeenLastCalledWith(expect.objectContaining({ sessions: [] }))
  expect(lastFrame()).not.toContain('[roster]')
})

test('s toggles main groupBy between state and project, persists, and switches rendering', async () => {
  const deps = makeDeps()
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  expect(lastFrame().split('\n').some((l) => l.trim().replace(/^\u276f /, '').startsWith('alpha'))).toBe(false) // state mode: no project header
  stdin.write('\x13')
  await tick()
  expect(deps.persistRoster).toHaveBeenCalledWith(expect.objectContaining({ groupBy: 'project' }))
  expect(lastFrame().split('\n').some((l) => l.trim().replace(/^\u276f /, '').startsWith('alpha'))).toBe(true) // project mode: v2-style project header
  stdin.write('\x13')
  await tick()
  expect(deps.persistRoster).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: 'state' }))
})

// A roster save that throws (full disk, unwritable config dir) used to propagate through
// updateRoster into the Ink input handler and crash the TUI over a disk hiccup.
test('a failing roster save flashes instead of crashing the input handler', async () => {
  const deps = makeDeps()
  deps.persistRoster = vi.fn(() => {
    throw new Error('disk full')
  })
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('\x13') // ^s → updateRoster → persist throws
  await waitFor(() => lastFrame().includes("couldn't save roster"))
  // the in-memory toggle still happened and the app is still alive
  expect(lastFrame().split('\n').some((l) => l.trim().replace(/^❯ /, '').startsWith('alpha'))).toBe(true)
})

test('empty roster in state grouping shows the three-category skeleton with placeholders', async () => {
  const deps = makeDeps()
  deps.roster = { groupBy: 'state', sessions: [] }
  const { lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('needs input'))
  const frame = lastFrame()
  expect(frame).toContain('working')
  expect(frame).toContain('completed')
  // every empty category shows its description, not a bare "no items" (#91.1)
  expect(frame).toContain('a session is asking you something')
  expect(frame).toContain('a session is running right now')
  expect(frame).toContain('finished, failed, or stopped sessions land here')
})

test('ghost-only roster (member session no longer exists anywhere) still shows the skeleton, not a blank screen (F1)', async () => {
  const deps = makeDeps()
  // 'ghost' is a roster member but never appears in listSessions — nothing to render for it.
  deps.roster = { groupBy: 'state', sessions: [{ worktree: '/x/alpha', id: 'ghost', addedAt: 1 }] }
  const { lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('a session is asking you something'))
})

test('state grouping orders needs input → working → completed with correct headers', async () => {
  const deps = makeDeps()
  deps.roster = {
    groupBy: 'state',
    sessions: [
      { worktree: '/x/alpha', id: 'sw', addedAt: 1 },
      { worktree: '/x/alpha', id: 'sr', addedAt: 2 },
      { worktree: '/x/alpha', id: 'sd', addedAt: 3 },
      { worktree: '/x/alpha', id: 'si', addedAt: 4 },
    ],
  }
  deps.seen = { '/x/alpha:sd': { updated: 3, hasRun: true } } // prewarm sd as done without needing a run event
  deps.client.listSessions = vi.fn(() =>
    Promise.resolve([
      { id: 'sw', title: 'waiting one', time: { updated: 1 } },
      { id: 'sr', title: 'running one', time: { updated: 2 } },
      { id: 'sd', title: 'done one', time: { updated: 3 } },
      { id: 'si', title: 'idle one', time: { updated: 4 } },
    ]),
  )
  const { lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn(), seen: deps.seen }))
  await waitFor(() => deps.connectEventsImpl.mock.calls.length > 0)
  const onEvent = deps.connectEventsImpl.mock.calls[0][1].onEvent
  onEvent('/x/alpha', { type: 'permission.asked', properties: { sessionID: 'sw', id: 'p1' } })
  onEvent('/x/alpha', { type: 'session.status', properties: { sessionID: 'sr', status: { type: 'busy' } } })
  await tick()
  // Skip the header block: its summary count also says "working"/"completed", and this
  // test is about the order of the group headers below it. Height comes from headerRows so the
  // wordmark growing the header can't silently re-include the summary line.
  const frame = lastFrame().split('\n').slice(headerRows(80)).join('\n')
  const idx = ['needs input', 'working', 'completed'].map((label) => frame.indexOf(label))
  expect(idx.every((i) => i !== -1), `missing group header in:\n${frame}`).toBe(true)
  expect(idx).toEqual([...idx].sort((a, b) => a - b))
})

test('main footer lists the chords that fit; the rest live behind ?', async () => {
  const deps = makeDeps()
  const { lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('^b browse'))
  // ^s and ^r moved off the footer to keep it on one row; they are still in `?`.
  expect(lastFrame()).toContain('? help')
  expect(lastFrame()).not.toContain('^s group')
})

test('browse footer shows ^a add/remove and back hint', async () => {
  const deps = makeDeps()
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  stdin.write('\x02')
  await waitFor(() => lastFrame().includes('^a add/remove'))
  expect(lastFrame()).toContain('^b back')
})

test('esc in browse returns to main', async () => {
  const deps = makeDeps()
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  stdin.write('\x02')
  await waitFor(() => lastFrame().includes('^a add/remove'))
  stdin.write('\x1B')
  await tick()
  expect(lastFrame()).not.toContain('^a add/remove')
})

// --- peek pane (v3 Task 4) ---

const deferred = () => {
  let resolve: any, reject: any
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('space opens peek: loading then content (text parts only — reasoning excluded); roster chords stay inactive while open', async () => {
  const deps = makeDeps()
  const gate = deferred()
  deps.client.listMessages = vi.fn(() => gate.promise)
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  stdin.write(' ')
  await waitFor(() => lastFrame().includes('loading…'))
  expect(deps.client.listMessages).toHaveBeenCalledWith('s1', '/x/alpha')

  stdin.write('\x18') // ^x belongs to the roster; while peek is open it must not stop anything
  await tick()
  expect(deps.client.abortSession).not.toHaveBeenCalled()

  gate.resolve([
    { info: { role: 'user' }, parts: [{ type: 'text', text: 'say hi' }] },
    {
      info: { role: 'assistant' },
      parts: [
        { type: 'step-start' },
        { type: 'reasoning', text: 'thinking about it, must not render' },
        { type: 'text', text: 'Hi there' },
        { type: 'step-finish' },
      ],
    },
  ])
  await waitFor(() => lastFrame().includes('Hi there'))
  const frame = lastFrame()
  expect(frame).toContain('fix tests') // title line
  expect(frame).toContain('alpha') // dim worktree
  expect(frame).toContain('you:')
  expect(frame).toContain('opencode:')
  expect(frame).toContain('say hi')
  expect(frame).not.toContain('thinking about it')
  expect(frame).toContain('→ attach · ← back')
})

test('esc closes peek and restores the list', async () => {
  const deps = makeDeps()
  deps.client.listMessages = vi.fn(() => Promise.resolve([]))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  stdin.write(' ')
  await waitFor(() => lastFrame().includes('no messages yet'))
  stdin.write('\x1B') // esc
  await waitFor(() => lastFrame().includes('^b browse')) // main footer only — distinct from peek's footer
  expect(lastFrame()).not.toContain('← back')
})

test('up arrow while peeking re-peeks the neighbor session', async () => {
  const deps = makeDeps()
  deps.roster = {
    groupBy: 'state',
    sessions: [
      { worktree: '/x/alpha', id: 's1', addedAt: 1 },
      { worktree: '/x/alpha', id: 's2', addedAt: 2 },
    ],
  }
  deps.client.listSessions = vi.fn(() =>
    Promise.resolve([
      { id: 's1', title: 'first', time: { updated: Date.now() } },
      { id: 's2', title: 'second', time: { updated: Date.now() - 1 } },
    ]),
  )
  deps.client.listMessages = vi.fn((id) =>
    Promise.resolve([
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: id === 's1' ? 'first content' : 'second content' }] },
    ]),
  )
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  stdin.write('\x1B[B') // down arrow → select s2
  await tick()
  stdin.write(' ') // open peek on s2
  await waitFor(() => lastFrame().includes('second content'))
  stdin.write('\x1B[A') // up arrow while peeking → re-peek neighbor s1
  await waitFor(() => lastFrame().includes('first content'))
  expect(deps.client.listMessages).toHaveBeenCalledWith('s1', '/x/alpha')
  expect(lastFrame()).not.toContain('second content')
})

test('peek down arrow steps relative to the peeked row, not row 0', async () => {
  // Discriminates the old flat/keyOf bug: with selection resolving to 0 in state grouping, peeking
  // the middle of three and pressing down re-peeked the same row instead of advancing to the next.
  const deps = makeDeps()
  deps.roster = {
    groupBy: 'state',
    sessions: [
      { worktree: '/x/alpha', id: 's1', addedAt: 1 },
      { worktree: '/x/alpha', id: 's2', addedAt: 2 },
      { worktree: '/x/alpha', id: 's3', addedAt: 3 },
    ],
  }
  const now = Date.now()
  deps.client.listSessions = vi.fn(() =>
    Promise.resolve([
      { id: 's1', title: 'first', time: { updated: now } },
      { id: 's2', title: 'second', time: { updated: now - 1 } },
      { id: 's3', title: 'third', time: { updated: now - 2 } },
    ]),
  )
  deps.client.listMessages = vi.fn((id) =>
    Promise.resolve([
      {
        info: { role: 'assistant' },
        parts: [{ type: 'text', text: `${id} content` }],
      },
    ]),
  )
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  stdin.write('\x1B[B') // down → s2
  await tick()
  stdin.write('\x1B[B') // down → s3
  await tick()
  stdin.write('\x1B[A') // up → back to s2
  await tick()
  stdin.write(' ') // peek s2 (the middle row)
  await waitFor(() => lastFrame().includes('s2 content'))
  stdin.write('\x1B[B') // down while peeking → must advance to s3, not stay on s2
  await waitFor(() => lastFrame().includes('s3 content'))
  expect(deps.client.listMessages).toHaveBeenCalledWith('s3', '/x/alpha')
  expect(lastFrame()).not.toContain('s2 content')
})

test('stale peek response is discarded once a second session is selected (latest-wins)', async () => {
  const deps = makeDeps()
  deps.roster = {
    groupBy: 'state',
    sessions: [
      { worktree: '/x/alpha', id: 's1', addedAt: 1 },
      { worktree: '/x/alpha', id: 's2', addedAt: 2 },
    ],
  }
  deps.client.listSessions = vi.fn(() =>
    Promise.resolve([
      { id: 's1', title: 'first', time: { updated: Date.now() } },
      { id: 's2', title: 'second', time: { updated: Date.now() - 1 } },
    ]),
  )
  const gate1 = deferred()
  const gate2 = deferred()
  deps.client.listMessages = vi.fn((id) => (id === 's1' ? gate1.promise : gate2.promise))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  stdin.write(' ') // peek s1 — fetch in flight
  await waitFor(() => lastFrame().includes('loading…'))
  stdin.write('\x1B[B') // move to s2 before s1's fetch resolves — supersedes it
  await tick()

  gate1.resolve([{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'STALE first' }] }])
  await tick()
  expect(lastFrame()).not.toContain('STALE first') // discarded — superseded fetch never renders

  gate2.resolve([{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'fresh second' }] }])
  await waitFor(() => lastFrame().includes('fresh second'))
})

test('peek fetch failure shows a peek-local error line and the app stays responsive', async () => {
  const deps = makeDeps()
  deps.client.listMessages = vi.fn(() => Promise.reject(new Error('down')))
  const onAction = vi.fn()
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction }))
  await tick()
  stdin.write(' ')
  await waitFor(() => lastFrame().includes("couldn't load messages"))
  expect(lastFrame()).not.toContain('offline') // peek errors are peek-local, not project-offline
  stdin.write('\x1B') // esc — app must still be responsive
  await waitFor(() => lastFrame().includes('^b browse')) // main footer only — distinct from peek's footer
  stdin.write('\x1B')
  await tick()
  expect(onAction).toHaveBeenCalledWith({ type: 'quit' })
})

test('enter while peeking attaches the peeked session', async () => {
  const deps = makeDeps()
  deps.client.listMessages = vi.fn(() =>
    Promise.resolve([{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'hi' }] }]),
  )
  const onAction = vi.fn()
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction }))
  await tick()
  stdin.write(' ')
  await waitFor(() => lastFrame().includes('opencode:'))
  stdin.write('\r')
  expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ type: 'enter', sessionId: 's1', worktree: '/x/alpha' }))
})

test('I1: a hanging delete does not resurrect a session removed from the roster during the in-flight window (audit r2)', async () => {
  const deps = makeDeps()
  deps.roster = {
    groupBy: 'state',
    sessions: [
      { worktree: '/x/alpha', id: 'a', addedAt: 1 },
      { worktree: '/x/alpha', id: 'c', addedAt: 2 },
    ],
  }
  deps.client.listSessions = vi.fn(() =>
    Promise.resolve([
      { id: 'a', title: 'session A', time: { updated: 100 } },
      { id: 'c', title: 'session C', time: { updated: 200 } },
    ]),
  )
  const gate = deferred()
  deps.client.deleteSession = vi.fn(() => gate.promise)
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  // both idle → sorted by updatedAt desc: session C (200) first, session A (100) second
  expect(lastFrame()).toContain('session A')
  expect(lastFrame()).toContain('session C')

  stdin.write('\x1B[B') // down arrow: select session A
  await tick()
  stdin.write('\x18')
  await tick()
  stdin.write('\x18') // delete session A — deleteSession hangs on gate.promise
  await tick()
  expect(lastFrame()).not.toContain('session A') // optimistically removed already

  // while A's delete is still in flight, remove session C from the roster only (^a, no delete)
  expect(lastFrame()).toContain('session C')
  stdin.write('\x01')
  await tick()
  expect(lastFrame()).not.toContain('session C')
  expect(deps.persistRoster).toHaveBeenLastCalledWith(expect.objectContaining({ sessions: [] }))

  gate.reject(new Error('down')) // A's delete fails → restore A only
  await waitFor(() => lastFrame().includes('session A')) // restored
  expect(lastFrame()).not.toContain('session C') // must NOT be resurrected by the stale-state bug
  expect(deps.persistRoster).toHaveBeenLastCalledWith(
    expect.objectContaining({ sessions: [expect.objectContaining({ worktree: '/x/alpha', id: 'a' })] }),
  )
})

test('session with zero messages shows "no messages yet"', async () => {
  const deps = makeDeps()
  deps.client.listMessages = vi.fn(() => Promise.resolve([]))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  stdin.write(' ')
  await waitFor(() => lastFrame().includes('no messages yet'))
})

// --- v4 Wave B: mount/reconnect seeding ---

test('mount seeds live status + pending permissions per project via sessionStatus/listPermissions', async () => {
  const deps = makeDeps()
  deps.client.sessionStatus = vi.fn(() => Promise.resolve({ s1: { type: 'busy' } }))
  deps.client.listPermissions = vi.fn(() => Promise.resolve([{ id: 'p1', sessionID: 's1', permission: 'bash' }]))
  const { lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  expect(deps.client.sessionStatus).toHaveBeenCalledWith('/x/alpha')
  expect(deps.client.listPermissions).toHaveBeenCalledWith('/x/alpha')
  await waitFor(() => lastFrame().includes('needs input')) // seeded pending permission → waiting badge, pre-SSE
})

// I1: GET /question mount seed — a question already pending at launch/reconnect must render
// waiting before any SSE question.asked event would otherwise report it.
test('I1: mount seeds pending questions via listQuestions — seeded question shows waiting at mount', async () => {
  const deps = makeDeps()
  deps.client.listQuestions = vi.fn(() => Promise.resolve([{ id: 'q1', sessionID: 's1', questions: [{ question: 'proceed?', header: 'proceed', options: [] }] }]))
  const { lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  expect(deps.client.listQuestions).toHaveBeenCalledWith('/x/alpha')
  await waitFor(() => lastFrame().includes('needs input'))
})

test('seeding tolerates sessionStatus/listPermissions failures — fleetview stays responsive', async () => {
  const deps = makeDeps()
  deps.client.sessionStatus = vi.fn(() => Promise.reject(new Error('down')))
  deps.client.listPermissions = vi.fn(() => Promise.reject(new Error('down')))
  const { lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
})

// I2: connectEvents must NOT wait for the live-state seed to settle — it connects immediately
// after listSessions, and seedLiveState runs fire-and-forget alongside it. This is the r2 ordering
// reverted: waiting on the seed before connecting just delays the stream for no benefit once the
// seq-watermark (seedMark) makes a seed that resolves after live events have already landed safe
// (event-fresh entries survive the replace instead of being wrongly deleted as "stale").
test('I2: connectEvents connects immediately on the launch path, without waiting for seedLiveState to settle', async () => {
  const deps = makeDeps()
  let resolveStatus: any
  deps.client.sessionStatus = vi.fn(() => new Promise((r) => { resolveStatus = r }))
  render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  expect(deps.client.sessionStatus).toHaveBeenCalledWith('/x/alpha')
  expect(deps.connectEventsImpl).toHaveBeenCalled() // connects without waiting on the still-pending seed
  resolveStatus({}) // let the seed settle so it doesn't leak into later tests
  await tick()
})

// I2: the seq-watermark's whole point — a permission applied live (via SSE) while the mount
// seed's listPermissions GET is still in flight must survive that seed landing, even though the
// seed's own (now-stale) snapshot doesn't include it. Without the watermark this is exactly the
// missed-waiting race: the seed's authoritative-replace would delete it as "stale".
test('I2: a permission applied live while the mount seed is still in flight survives the reseed', async () => {
  const deps = makeDeps()
  const gate = deferred()
  deps.client.listPermissions = vi.fn(() => gate.promise)
  const { lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  expect(deps.client.listPermissions).toHaveBeenCalledWith('/x/alpha') // seed in flight, gated
  const onEvent = deps.connectEventsImpl.mock.calls[0][1].onEvent
  onEvent('/x/alpha', { type: 'permission.asked', properties: { sessionID: 's1', id: 'p1', permission: 'bash' } })
  await waitFor(() => lastFrame().includes('needs input')) // event-fresh permission applied
  gate.resolve([]) // the seed's stale snapshot (captured before the live event) doesn't include p1
  await waitFor(() => lastFrame().includes('needs input')) // must survive — it's event-fresh (__seq >= mark), not stale
})

test('onOnline reconnect resync also reseeds session status + permissions', async () => {
  const deps = makeDeps()
  render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  deps.client.sessionStatus.mockClear()
  deps.client.listPermissions.mockClear()
  const onOnline = deps.connectEventsImpl.mock.calls[0][1].onOnline
  onOnline('/x/alpha')
  await tick()
  expect(deps.client.sessionStatus).toHaveBeenCalledWith('/x/alpha')
  expect(deps.client.listPermissions).toHaveBeenCalledWith('/x/alpha')
})

// M2: seedLiveState calls for one worktree are chained through a per-worktree promise, so a
// second seed triggered while the first is still in flight (mount's initial seed still gated on
// sessionStatus here) must not issue its own GETs until the first one settles.
test('M2: two seeds for the same worktree are serialized — the second seed does not GET until the first resolves', async () => {
  const deps = makeDeps()
  const gate = deferred()
  deps.client.sessionStatus = vi.fn(() => gate.promise)
  render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.client.sessionStatus.mock.calls.length >= 1) // mount's seed, gated in flight
  expect(deps.client.sessionStatus).toHaveBeenCalledTimes(1)

  const onOnline = deps.connectEventsImpl.mock.calls[0][1].onOnline
  onOnline('/x/alpha') // second seed for the same worktree, triggered while the first is still pending
  await waitFor(() => deps.client.listSessions.mock.calls.length >= 2) // onOnline's own resync listSessions ran

  await tick() // give an (incorrect) unserialized second GET a chance to fire
  expect(deps.client.sessionStatus).toHaveBeenCalledTimes(1) // still just the first — queued, not concurrent

  gate.resolve({})
  await waitFor(() => deps.client.sessionStatus.mock.calls.length >= 2) // first resolved, queued second now runs
})

// --- v4 Wave B: peek inline permission answer ---

test('peek: pending permission banner renders (id fallback); y answers the oldest via respondPermission(once) and optimistically clears', async () => {
  const deps = makeDeps()
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.connectEventsImpl.mock.calls.length > 0)
  const onEvent = deps.connectEventsImpl.mock.calls[0][1].onEvent
  onEvent('/x/alpha', { type: 'permission.asked', properties: { sessionID: 's1', id: 'p1', permission: 'bash' } })
  await tick()
  stdin.write(' ') // open peek on s1
  await waitFor(() => lastFrame().includes('⚠ permission'))
  expect(lastFrame()).toContain('⚠ permission: bash') // real schema: labeled by `permission`, not id
  expect(lastFrame()).toContain('y allow · a always · d deny')
  stdin.write('y')
  await tick()
  expect(deps.client.respondPermission).toHaveBeenCalledWith('p1', 'once', '/x/alpha')
  expect(lastFrame()).not.toContain('⚠ permission') // optimistic clear, no need to wait on the network call
})

test('peek: a answers "always"', async () => {
  const deps = makeDeps()
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.connectEventsImpl.mock.calls.length > 0)
  const onEvent = deps.connectEventsImpl.mock.calls[0][1].onEvent
  onEvent('/x/alpha', { type: 'permission.asked', properties: { sessionID: 's1', id: 'p1', permission: 'bash' } })
  await tick()
  stdin.write(' ')
  await waitFor(() => lastFrame().includes('⚠ permission'))
  stdin.write('a')
  await tick()
  expect(deps.client.respondPermission).toHaveBeenCalledWith('p1', 'always', '/x/alpha')
})

test('peek: d answers "reject"', async () => {
  const deps = makeDeps()
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.connectEventsImpl.mock.calls.length > 0)
  const onEvent = deps.connectEventsImpl.mock.calls[0][1].onEvent
  onEvent('/x/alpha', { type: 'permission.asked', properties: { sessionID: 's1', id: 'p1', permission: 'bash' } })
  await tick()
  stdin.write(' ')
  await waitFor(() => lastFrame().includes('⚠ permission'))
  stdin.write('d')
  await tick()
  expect(deps.client.respondPermission).toHaveBeenCalledWith('p1', 'reject', '/x/alpha')
})

test('peek: multiple pending permissions show "(+N more)" and answer oldest first', async () => {
  const deps = makeDeps()
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.connectEventsImpl.mock.calls.length > 0)
  const onEvent = deps.connectEventsImpl.mock.calls[0][1].onEvent
  onEvent('/x/alpha', { type: 'permission.asked', properties: { sessionID: 's1', id: 'p1', permission: 'bash' } })
  onEvent('/x/alpha', { type: 'permission.asked', properties: { sessionID: 's1', id: 'p2', permission: 'edit' } })
  await tick()
  stdin.write(' ')
  await waitFor(() => lastFrame().includes('(+1 more)'))
  stdin.write('y')
  await tick()
  expect(deps.client.respondPermission).toHaveBeenCalledWith('p1', 'once', '/x/alpha')
  expect(lastFrame()).toContain('⚠ permission: edit') // still one left, but no "(+N more)" now
  expect(lastFrame()).not.toContain('more')
})

test('peek: respondPermission failure shows a peek-local error line, no offline flag', async () => {
  const deps = makeDeps()
  deps.client.respondPermission = vi.fn(() => Promise.reject(new Error('down')))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.connectEventsImpl.mock.calls.length > 0)
  const onEvent = deps.connectEventsImpl.mock.calls[0][1].onEvent
  onEvent('/x/alpha', { type: 'permission.asked', properties: { sessionID: 's1', id: 'p1', permission: 'bash' } })
  await tick()
  stdin.write(' ')
  await waitFor(() => lastFrame().includes('⚠ permission'))
  stdin.write('y')
  await waitFor(() => lastFrame().includes("couldn't answer permission"))
  expect(lastFrame()).not.toContain('offline')
})

// I1: a failed respondPermission whose reconcile fetch (listPermissions) ALSO fails (server
// unreachable — the original I3 case) falls back to a blind re-add, preserving pre-I1 behavior.
test('I1: respondPermission failure + listPermissions failure (server unreachable) falls back to a blind re-add — banner and keys return', async () => {
  const deps = makeDeps()
  deps.client.respondPermission = vi.fn(() => Promise.reject(new Error('down')))
  deps.client.listPermissions = vi.fn(() => Promise.reject(new Error('down')))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.connectEventsImpl.mock.calls.length > 0)
  const onEvent = deps.connectEventsImpl.mock.calls[0][1].onEvent
  onEvent('/x/alpha', { type: 'permission.asked', properties: { sessionID: 's1', id: 'p1', permission: 'bash' } })
  await tick()
  stdin.write(' ')
  await waitFor(() => lastFrame().includes('⚠ permission'))
  stdin.write('y')
  await waitFor(() => lastFrame().includes("couldn't answer permission"))
  expect(lastFrame()).toContain('⚠ permission: bash') // rolled back, not left cleared
  stdin.write('y') // keys still active — retrying should behave exactly as the first attempt did
  await tick()
  expect(deps.client.respondPermission).toHaveBeenCalledTimes(2)
})

// I1: a failed respondPermission whose reconcile fetch succeeds and confirms the permission is
// STILL pending server-side (genuine transient failure, not a concurrent answer) — the reconcile
// re-seeds it, same visible effect as the old blind re-add.
test('I1: respondPermission failure + listPermissions confirms the entry is still pending — reconcile re-seeds it, banner returns', async () => {
  const deps = makeDeps()
  deps.client.respondPermission = vi.fn(() => Promise.reject(new Error('down')))
  deps.client.listPermissions = vi.fn(() => Promise.resolve([{ id: 'p1', sessionID: 's1', permission: 'bash' }]))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.connectEventsImpl.mock.calls.length > 0)
  const onEvent = deps.connectEventsImpl.mock.calls[0][1].onEvent
  onEvent('/x/alpha', { type: 'permission.asked', properties: { sessionID: 's1', id: 'p1', permission: 'bash' } })
  await tick()
  stdin.write(' ')
  await waitFor(() => lastFrame().includes('⚠ permission'))
  stdin.write('y')
  await waitFor(() => lastFrame().includes("couldn't answer permission"))
  await waitFor(() => lastFrame().includes('⚠ permission: bash')) // reconcile re-seeded it, not left cleared
})

// I1: the core fix — a failed respondPermission whose reconcile fetch succeeds but the entry is
// GONE from the fresh list means it was already answered elsewhere (concurrent answer from an
// attached terminal, or a duplicate POST from a double keypress). Must NOT blindly re-add it —
// that would resurrect a dead permission and leave the row phantom-waiting forever.
test('I1: respondPermission failure + listPermissions omits the entry (already answered elsewhere) — no re-add, no phantom waiting', async () => {
  const deps = makeDeps()
  deps.client.respondPermission = vi.fn(() => Promise.reject(new Error('down')))
  deps.client.listPermissions = vi.fn(() => Promise.resolve([])) // entry already answered/expired
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.connectEventsImpl.mock.calls.length > 0)
  const onEvent = deps.connectEventsImpl.mock.calls[0][1].onEvent
  onEvent('/x/alpha', { type: 'permission.asked', properties: { sessionID: 's1', id: 'p1', permission: 'bash' } })
  await tick()
  stdin.write(' ')
  await waitFor(() => lastFrame().includes('⚠ permission'))
  stdin.write('y')
  await waitFor(() => lastFrame().includes("couldn't answer permission"))
  await tick()
  expect(lastFrame()).not.toContain('⚠ permission') // reconcile confirmed it's gone — no re-add
  stdin.write('\x1B[D') // back to roster — row must not be stuck "waiting"
  await tick()
  expect(sectionBody(lastFrame(), 'needs input')).toContain('a session is asking you something') // not stuck under needs input
})

// I1: the reconcile's listPermissions GET must capture its own seedMark() BEFORE issuing the GET
// (mirroring seedLiveState), same as any other reseed — otherwise the reconcile omits the mark,
// defaults to Infinity, and deletes a permission that arrived live (via SSE) while the reconcile
// GET was still in flight — the exact race the watermark exists to prevent.
test('I1: a permission added via SSE after the reconcile mark survives the reconcile-reseed that lacks it', async () => {
  const deps = makeDeps()
  deps.client.respondPermission = vi.fn(() => Promise.reject(new Error('down')))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.connectEventsImpl.mock.calls.length > 0)
  const onEvent = deps.connectEventsImpl.mock.calls[0][1].onEvent
  onEvent('/x/alpha', { type: 'permission.asked', properties: { sessionID: 's1', id: 'p1', permission: 'bash' } })
  await tick()
  stdin.write(' ')
  await waitFor(() => lastFrame().includes('⚠ permission'))
  const gate = deferred()
  deps.client.listPermissions = vi.fn(() => gate.promise) // reconcile GET, gated — mark must be captured before this call
  stdin.write('y') // respondPermission fails → reconcile fires
  await waitFor(() => lastFrame().includes("couldn't answer permission"))
  // a second permission arrives live while the reconcile GET is still in flight — event-fresh, must survive
  onEvent('/x/alpha', { type: 'permission.asked', properties: { sessionID: 's1', id: 'p2', permission: 'edit' } })
  await waitFor(() => lastFrame().includes('⚠ permission: edit'))
  gate.resolve([]) // the reconcile's stale snapshot predates p2 (and shows p1 as already answered elsewhere)
  await waitFor(() => lastFrame().includes('⚠ permission: edit')) // must survive the reconcile-reseed, not be deleted as "stale"
})

// M6: peekError must be keyed to the session it was raised for — a reply that fails after the
// user has already navigated away must not paint its error onto the newly-peeked session.
test('M6: respondPermission failure for s1 lands after navigating to s2 — s2 shows no error', async () => {
  const deps = makeDeps()
  deps.roster = {
    groupBy: 'state',
    sessions: [
      { worktree: '/x/alpha', id: 's1', addedAt: 1 },
      { worktree: '/x/alpha', id: 's2', addedAt: 2 },
    ],
  }
  deps.client.listSessions = vi.fn(() =>
    Promise.resolve([
      { id: 's1', title: 'first', time: { updated: Date.now() } },
      { id: 's2', title: 'second', time: { updated: Date.now() - 1 } },
    ]),
  )
  const gate = deferred()
  deps.client.respondPermission = vi.fn(() => gate.promise)
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.connectEventsImpl.mock.calls.length > 0)
  const onEvent = deps.connectEventsImpl.mock.calls[0][1].onEvent
  onEvent('/x/alpha', { type: 'permission.asked', properties: { sessionID: 's1', id: 'p1', permission: 'bash' } })
  await tick()
  stdin.write(' ') // peek s1
  await waitFor(() => lastFrame().includes('⚠ permission'))
  stdin.write('y') // fires respondPermission for s1 — left pending on `gate`
  await tick()
  stdin.write('\x1B[B') // navigate to s2 before the reply settles
  await waitFor(() => lastFrame().includes('second'))
  gate.reject(new Error('down'))
  await tick()
  expect(lastFrame()).not.toContain("couldn't answer permission") // error belongs to s1, not s2
  stdin.write('\x1B[A') // back to s1 — error was raised before this nav, so it's still cleared (nav resets it)
  await tick()
  expect(lastFrame()).not.toContain("couldn't answer permission")
})

test('peek: y/a/d are inert when there is no pending permission', async () => {
  const deps = makeDeps()
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await tick()
  stdin.write(' ')
  await waitFor(() => lastFrame().includes('opencode:') || lastFrame().includes('no messages yet') || lastFrame().includes('loading'))
  stdin.write('y')
  await tick()
  expect(deps.client.respondPermission).not.toHaveBeenCalled()
})

// --- M8: question banner in peek (read-only) ---

test('M8: peek renders a question banner for a pending question, with a +N more suffix when there are several', async () => {
  const deps = makeDeps()
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.connectEventsImpl.mock.calls.length > 0)
  const onEvent = deps.connectEventsImpl.mock.calls[0][1].onEvent
  onEvent('/x/alpha', { type: 'question.asked', properties: { sessionID: 's1', id: 'q1', questions: [{ question: 'proceed?', header: 'proceed', options: [] }] } })
  await tick()
  stdin.write(' ') // open peek on s1
  await waitFor(() => lastFrame().includes('? question'))
  expect(lastFrame()).toContain('? question: proceed?')
  expect(lastFrame()).toContain('type a reply and press ⏎') // no predefined choices on this one
  onEvent('/x/alpha', { type: 'question.asked', properties: { sessionID: 's1', id: 'q2', questions: [{ question: 'or this?', header: 'or', options: [] }] } })
  await waitFor(() => lastFrame().includes('(+1 more)'))
})

// y/a/d answer permissions only. With a question pending and no permission, they are just text
// for the reply input — they must never fire a permission reply.
test('y/a/d never answer a question: with no permission pending they are reply text', async () => {
  const deps = makeDeps()
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.connectEventsImpl.mock.calls.length > 0)
  const onEvent = deps.connectEventsImpl.mock.calls[0][1].onEvent
  onEvent('/x/alpha', { type: 'question.asked', properties: { sessionID: 's1', id: 'q1', questions: [{ question: 'proceed?', header: 'proceed', options: [] }] } })
  await tick()
  stdin.write(' ')
  await waitFor(() => lastFrame().includes('? question'))
  stdin.write('y')
  stdin.write('a')
  stdin.write('d')
  await waitFor(() => lastFrame().includes('yad█'))
  expect(deps.client.respondPermission).not.toHaveBeenCalled()
})

test('a number key answers the oldest pending question with that option label', async () => {
  const deps = makeDeps()
  deps.client.respondQuestion = vi.fn(() => Promise.resolve({}))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.connectEventsImpl.mock.calls.length > 0)
  const onEvent = deps.connectEventsImpl.mock.calls[0][1].onEvent
  onEvent('/x/alpha', {
    type: 'question.asked',
    properties: {
      sessionID: 's1',
      id: 'q1',
      questions: [
        {
          question: 'rebase or merge?',
          header: 'strategy',
          options: [
            { label: 'rebase', description: '' },
            { label: 'merge', description: '' },
          ],
        },
      ],
    },
  })
  stdin.write(' ')
  await waitFor(() => lastFrame().includes('2. merge'))
  stdin.write('2')
  await waitFor(() => deps.client.respondQuestion.mock.calls.length > 0)
  expect(deps.client.respondQuestion).toHaveBeenCalledWith('q1', [['merge']], '/x/alpha')
  await waitFor(() => !lastFrame().includes('? question')) // optimistically cleared
})

test('typing in peek and pressing ⏎ sends a follow-up prompt to that session', async () => {
  const deps = makeDeps()
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write(' ')
  await waitFor(() => lastFrame().includes('reply'))
  stdin.write('try the other branch')
  await waitFor(() => lastFrame().includes('try the other branch█'))
  stdin.write('\r')
  await waitFor(() => deps.client.promptAsync.mock.calls.length > 0)
  expect(deps.client.promptAsync).toHaveBeenCalledWith('s1', 'try the other branch', '/x/alpha')
})

test('a ! prefix in peek runs a shell command instead of prompting the model', async () => {
  const deps = makeDeps()
  deps.client.runShell = vi.fn(() => Promise.resolve({}))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write(' ')
  await waitFor(() => lastFrame().includes('reply'))
  stdin.write('!git status')
  await waitFor(() => lastFrame().includes('!git status█'))
  stdin.write('\r')
  await waitFor(() => deps.client.runShell.mock.calls.length > 0)
  expect(deps.client.runShell).toHaveBeenCalledWith('s1', 'git status', '/x/alpha')
  expect(deps.client.promptAsync).not.toHaveBeenCalled()
})

test('esc clears a half-typed reply before it closes the panel', async () => {
  const deps = makeDeps()
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write(' ')
  await waitFor(() => lastFrame().includes('reply'))
  stdin.write('half typed')
  await waitFor(() => lastFrame().includes('half typed█'))
  stdin.write('\x1B')
  await waitFor(() => !lastFrame().includes('half typed'))
  expect(lastFrame()).toContain('reply') // still in peek
  stdin.write('\x1B')
  await waitFor(() => !lastFrame().includes('reply')) // now it closes
})

// --- v4 Wave B: abort ---

test('main: ^x on a running session calls abortSession, roster membership unchanged', async () => {
  const deps = makeDeps()
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.connectEventsImpl.mock.calls.length > 0)
  const onEvent = deps.connectEventsImpl.mock.calls[0][1].onEvent
  onEvent('/x/alpha', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  await tick()
  stdin.write('\x18')
  await tick()
  expect(deps.client.abortSession).toHaveBeenCalledWith('s1', '/x/alpha')
  expect(deps.client.deleteSession).not.toHaveBeenCalled()
  expect(deps.persistRoster).not.toHaveBeenCalled() // no roster mutation on stop
  expect(lastFrame()).toContain('fix tests') // row stays
})

// I3: a session blocked on a pending permission (waiting, not busy/running) must still be
// abortable from the roster — it was previously stuck server-side with no fleetview-side stop path.
test('I3: ^x on a waiting session calls abortSession', async () => {
  const deps = makeDeps()
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.connectEventsImpl.mock.calls.length > 0)
  const onEvent = deps.connectEventsImpl.mock.calls[0][1].onEvent
  onEvent('/x/alpha', { type: 'permission.asked', properties: { sessionID: 's1', id: 'p1', permission: 'bash' } })
  await tick()
  stdin.write('\x18')
  await tick()
  expect(deps.client.abortSession).toHaveBeenCalledWith('s1', '/x/alpha')
})

// M4: a session whose "waiting" comes only from the ?-heuristic (idle underneath, no real pending
// permission/question) won't get a session.status SSE event from a stop — nothing else would
// clear the heuristic, so a successful abort must clear it locally, leaving waiting immediately.
test('M4: successful stop on a heuristic-waiting session clears the heuristic — row leaves waiting immediately', async () => {
  const deps = makeDeps()
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.connectEventsImpl.mock.calls.length > 0)
  const onEvent = deps.connectEventsImpl.mock.calls[0][1].onEvent
  onEvent('/x/alpha', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  onEvent('/x/alpha', { type: 'message.updated', properties: { sessionID: 's1', info: { id: 'm1', role: 'assistant' } } })
  onEvent('/x/alpha', {
    type: 'message.part.updated',
    properties: { sessionID: 's1', part: { type: 'text', messageID: 'm1', text: 'Should I proceed?' } },
  })
  onEvent('/x/alpha', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  await waitFor(() => sectionBody(lastFrame(), 'needs input').includes('fix tests')) // heuristic engaged, row under needs input
  stdin.write('\x18')
  await tick()
  expect(deps.client.abortSession).toHaveBeenCalledWith('s1', '/x/alpha')
  // The notice reads stopped, not completed — the user stopped it, no result. It lands while the
  // row is still held in needs input by the pending second ^x (#15).
  await waitFor(() => lastFrame().includes('stopped'))
  // The header text always shows now (empty categories keep their placeholder), so the proof the
  // row left waiting is that needs input falls back to its placeholder once the arm lapses.
  await waitFor(() => sectionBody(lastFrame(), 'needs input').includes('a session is asking you something'), 5000)
})

test('main: ^x on an idle session still stops it, and arms the delete', async () => {
  const deps = makeDeps()
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('\x18')
  await waitFor(() => deps.client.abortSession.mock.calls.length > 0)
  expect(lastFrame()).toContain('^x again to delete')
})

test('main: abortSession failure flags the project offline, same as other CRUD', async () => {
  const deps = makeDeps()
  deps.client.abortSession = vi.fn(() => Promise.reject(new Error('down')))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.connectEventsImpl.mock.calls.length > 0)
  const onEvent = deps.connectEventsImpl.mock.calls[0][1].onEvent
  await waitFor(() => lastFrame().includes('fix tests'))
  onEvent('/x/alpha', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  stdin.write('\x18')
  // offline is a row shape now, not a word: the project can't answer, so the glyph says so
  await waitFor(() => lastFrame().includes('∙'))
})

// --- v4 Wave B: footer + error badge ---

test('main footer names the empty-input verbs', async () => {
  const deps = makeDeps()
  const { lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('⏎ attach'))
  expect(lastFrame()).toContain('space peek')
})

test('a failed session renders red and lands in the completed group', async () => {
  const deps = makeDeps()
  const { lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.connectEventsImpl.mock.calls.length > 0)
  const onEvent = deps.connectEventsImpl.mock.calls[0][1].onEvent
  onEvent('/x/alpha', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  onEvent('/x/alpha', { type: 'session.error', properties: { sessionID: 's1', error: { name: 'X' } } })
  onEvent('/x/alpha', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  // ink strips colour outside a TTY, so the visible proof here is placement: a failed session
  // joins `completed`, per "Completed collects finished, failed, and stopped sessions together".
  // That it derives as `error` rather than `done` is covered directly in session-store.test.ts.
  await waitFor(() => lastFrame().includes('completed'))
})

// --- Phase 2: agent-view grouping ---

// #15: the stop the first ^x performs would otherwise re-sort the row into completed while the
// confirming press is still pending, leaving the user to hunt it down the board.
test('a first ^x holds the row in its section until the arm lapses, then lets it fall into completed', async () => {
  const deps = makeDeps()
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.connectEventsImpl.mock.calls.length > 0)
  const onEvent = deps.connectEventsImpl.mock.calls[0][1].onEvent
  onEvent('/x/alpha', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  // sectionBody keys off the first line holding the label, which for these two is the header's
  // summary count ("1 working · 0 completed") — match the section header line itself instead.
  const sectionOf = (title: string) => {
    const lines = lastFrame().split('\n')
    const row = lines.findIndex((l) => l.includes(title))
    const headers = lines.map((l, i) => [l.trim(), i] as const).filter(([l]) => STATE_HEADERS.includes(l))
    return headers.filter(([, i]) => i < row).at(-1)?.[0]
  }
  await waitFor(() => sectionOf('fix tests') === 'working')
  stdin.write('\x18')
  await waitFor(() => deps.client.abortSession.mock.calls.length > 0)
  onEvent('/x/alpha', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } }) // what the server reports once the abort lands
  // Wait for the stop to have actually landed — that is the moment the row would otherwise be
  // re-sorted, and asserting any earlier proves nothing.
  await waitFor(() => lastFrame().includes('stopped "fix tests"'))
  expect(sectionOf('fix tests')).toBe('working') // held where it was, not re-sorted under the cursor
  await waitFor(() => sectionOf('fix tests') === 'completed', 5000) // arm lapsed, row settles
}, 10000) // the 2s arm window is real time, so this test outlasts the default per-test timeout

test('stopping a session moves it under completed without losing the selection (second ^x still lands)', async () => {
  const deps = makeDeps()
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('\x18')
  await waitFor(() => lastFrame().includes('completed')) // the row changed groups under the cursor
  stdin.write('\x18')
  await waitFor(() => deps.client.deleteSession.mock.calls.length > 0)
  expect(deps.client.deleteSession).toHaveBeenCalledWith('s1', '/x/alpha')
})

test('the selection follows a session that changes state group, so a late second ^x targets it and not another running session', async () => {
  const deps = makeDeps()
  deps.client.listSessions = vi.fn(() =>
    Promise.resolve([
      { id: 's1', title: 'sleep 300 quietly', time: { updated: 2000 } },
      { id: 's2', title: 'sleep 301 command', time: { updated: 1000 } },
    ]),
  )
  deps.roster = {
    groupBy: 'state',
    sessions: [
      { worktree: '/x/alpha', id: 's1', addedAt: 1 },
      { worktree: '/x/alpha', id: 's2', addedAt: 1 },
    ],
  }
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.connectEventsImpl.mock.calls.length > 0)
  const onEvent = deps.connectEventsImpl.mock.calls[0][1].onEvent
  // Which section a row is under — the frame's header summary line also contains every category
  // word, so sectionBody() can't be used here (same reason as the arm-hold test above).
  const sectionOf = (title: string) => {
    const lines = lastFrame().split('\n')
    const row = lines.findIndex((l) => l.includes(title))
    const headers = lines.map((l, i) => [l.trim(), i] as const).filter(([l]) => STATE_HEADERS.includes(l))
    return headers.filter(([, i]) => i < row).at(-1)?.[0]
  }
  // Both running, s1 above s2 (more recent) — so s1 is the default selection and s2 is what the
  // old first-session fallback would jump to once s1 left `working`.
  onEvent('/x/alpha', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  onEvent('/x/alpha', { type: 'session.status', properties: { sessionID: 's2', status: { type: 'busy' } } })
  await waitFor(() => sectionOf('sleep 301 command') === 'working' && sectionOf('sleep 300 quietly') === 'working')
  // ^x until it lands: Node can drop the first stdin chunk (see pressUntil). Re-pressing is safe
  // while nothing is armed — an unarmed press only ever arms and stops.
  await pressUntil(stdin, '\x18', () => deps.client.abortSession.mock.calls.length > 0)
  expect(deps.client.abortSession).toHaveBeenCalledWith('s1', '/x/alpha')
  onEvent('/x/alpha', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  // Let the 2s arm window lapse: s1 is released into `completed`, which renames its row key.
  await waitFor(() => sectionOf('sleep 300 quietly') === 'completed', 5000)
  const beforeSecond = deps.client.abortSession.mock.calls.length
  stdin.write('\x18') // second ^x, too late to confirm the delete — it must re-target s1, not s2
  await waitFor(() => deps.client.abortSession.mock.calls.length > beforeSecond || deps.client.deleteSession.mock.calls.length > 0)
  // Whatever the late press did (re-arm or delete), it did it to the session that was selected.
  expect(deps.client.abortSession.mock.calls.every((c: any[]) => c[0] === 's1')).toBe(true)
  expect(deps.client.deleteSession.mock.calls.every((c: any[]) => c[0] === 's1')).toBe(true)
  expect(sectionOf('sleep 301 command')).toBe('working') // the other session is untouched
}, 15000) // the 2s arm window is real time

// --- Phase 5: dispatch grammar ---

const withVocab = (deps: any) => {
  deps.client.listAgents = vi.fn(() => Promise.resolve([{ name: 'build' }, { name: 'reviewer' }, { name: 'title' }]))
  deps.client.listCommands = vi.fn(() => Promise.resolve([{ name: 'review' }]))
  deps.client.runShell = vi.fn(() => Promise.resolve({}))
  return deps
}

test('@agent dispatches the session as that subagent and keeps it out of the prompt', async () => {
  const deps = withVocab(makeDeps())
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  await waitFor(() => deps.client.listAgents.mock.calls.length > 0)
  stdin.write('@reviewer look at the diff')
  await waitFor(() => lastFrame().includes('@reviewer look at the diff█'))
  stdin.write('\r')
  await waitFor(() => deps.client.promptAsync.mock.calls.length > 0)
  expect(deps.client.createSession).toHaveBeenCalledWith({ agent: 'reviewer', model: null }, '/x/alpha')
  expect(deps.client.promptAsync).toHaveBeenCalledWith('s9', 'look at the diff', '/x/alpha')
})

test("opencode's internal agents are not offered as targets", async () => {
  const deps = withVocab(makeDeps())
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.client.listAgents.mock.calls.length > 0)
  stdin.write('@')
  await waitFor(() => lastFrame().includes('@build'))
  expect(lastFrame()).toContain('@reviewer')
  expect(lastFrame()).not.toContain('@title') // opencode uses `title` to name sessions
})

test('tab applies the highlighted suggestion', async () => {
  const deps = withVocab(makeDeps())
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.client.listAgents.mock.calls.length > 0)
  stdin.write('@rev')
  await waitFor(() => lastFrame().includes('@reviewer'))
  stdin.write('\t')
  await waitFor(() => lastFrame().includes('@reviewer █'))
})

test('! dispatches a shell job instead of prompting a model', async () => {
  const deps = withVocab(makeDeps())
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('!npm test')
  await waitFor(() => lastFrame().includes('!npm test█'))
  stdin.write('\r')
  await waitFor(() => deps.client.runShell.mock.calls.length > 0)
  expect(deps.client.runShell).toHaveBeenCalledWith('s9', 'npm test', '/x/alpha', 'build')
  expect(deps.client.promptAsync).not.toHaveBeenCalled()
})

// The `!` branch used to pass `agent ?? 'build'` while the prompt branch fell back to the launch
// --agent default, so a `fleetview --agent reviewer` run silently sent shell jobs as build.
test('! dispatch falls back to the launch --agent default like the prompt branch', async () => {
  const deps = withVocab(makeDeps())
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn(), initialAgent: 'reviewer' }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('!npm test')
  await waitFor(() => lastFrame().includes('!npm test█'))
  stdin.write('\r')
  await waitFor(() => deps.client.runShell.mock.calls.length > 0)
  expect(deps.client.runShell).toHaveBeenCalledWith('s9', 'npm test', '/x/alpha', 'reviewer')
})

test('typing a filter narrows the list instead of dispatching', async () => {
  const deps = makeDeps()
  deps.roster = {
    groupBy: 'state',
    sessions: [
      { worktree: '/x/alpha', id: 's1', addedAt: 1 },
      { worktree: '/x/alpha', id: 's2', addedAt: 2 },
    ],
  }
  deps.client.listSessions = vi.fn(() =>
    Promise.resolve([
      { id: 's1', title: 'the busy one', time: { updated: 2 } },
      { id: 's2', title: 'the idle one', time: { updated: 1 } },
    ]),
  )
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.connectEventsImpl.mock.calls.length > 0)
  const onEvent = deps.connectEventsImpl.mock.calls[0][1].onEvent
  onEvent('/x/alpha', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  await waitFor(() => lastFrame().includes('the idle one'))
  stdin.write('s:working')
  await waitFor(() => !lastFrame().includes('the idle one'))
  expect(lastFrame()).toContain('the busy one')
  expect(lastFrame()).toContain('filtering')
  stdin.write('\r') // Enter must not dispatch while filtering
  await tick()
  expect(deps.client.createSession).not.toHaveBeenCalled()
})

test('/model sets the dispatch model for later sessions and shows it in the header', async () => {
  const deps = withVocab(makeDeps())
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  expect(lastFrame()).toContain('default model')
  stdin.write('/model anthropic/claude-haiku')
  await waitFor(() => lastFrame().includes('/model anthropic/claude-haiku█'))
  stdin.write('\r')
  await waitFor(() => lastFrame().includes('anthropic/claude-haiku'))
  stdin.write('now do a thing')
  await waitFor(() => lastFrame().includes('now do a thing█'))
  stdin.write('\r')
  await waitFor(() => deps.client.createSession.mock.calls.length > 0)
  expect(deps.client.createSession).toHaveBeenCalledWith(
    { agent: undefined, model: { providerID: 'anthropic', id: 'claude-haiku' } },
    '/x/alpha',
  )
})

test('/exit quits', async () => {
  const deps = withVocab(makeDeps())
  const onAction = vi.fn()
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('/exit')
  await waitFor(() => lastFrame().includes('/exit█'))
  stdin.write('\r')
  await waitFor(() => onAction.mock.calls.length > 0)
  expect(onAction).toHaveBeenCalledWith({ type: 'quit' })
})

test('an unknown /command is sent to a new session as its first prompt', async () => {
  const deps = withVocab(makeDeps())
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('/review the parser change')
  await waitFor(() => lastFrame().includes('/review the parser change█'))
  stdin.write('\r')
  await waitFor(() => deps.client.promptAsync.mock.calls.length > 0)
  expect(deps.client.promptAsync).toHaveBeenCalledWith('s9', '/review the parser change', '/x/alpha')
})

// --- Phase 6: attaching in place ---

test('attaching keeps fleetview mounted and stops it reading the keyboard until detach', async () => {
  const deps = makeDeps()
  let detach: any
  const onAction = vi.fn((a: any) => (a.type === 'enter' ? new Promise((r) => { detach = r }) : undefined))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('\r') // empty input → attach
  await waitFor(() => lastFrame() === '') // fleetview draws nothing while the child owns the terminal
  stdin.write('typing at the attached session')
  await tick()
  expect(lastFrame()).toBe('') // those keys belong to opencode, not to the dispatch input
  detach()
  await waitFor(() => lastFrame().includes('fix tests')) // straight back to a live roster
})

test('the attach action carries the on-screen row order for Alt+1..9', async () => {
  const deps = makeDeps()
  deps.roster = {
    groupBy: 'state',
    sessions: [
      { worktree: '/x/alpha', id: 's1', addedAt: 1 },
      { worktree: '/x/alpha', id: 's2', addedAt: 2 },
    ],
  }
  deps.client.listSessions = vi.fn(() =>
    Promise.resolve([
      { id: 's1', title: 'first', time: { updated: 2 } },
      { id: 's2', title: 'second', time: { updated: 1 } },
    ]),
  )
  const onAction = vi.fn(() => new Promise(() => {}))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction }))
  await waitFor(() => lastFrame().includes('second'))
  stdin.write('\r')
  await waitFor(() => onAction.mock.calls.length > 0)
  expect((onAction.mock.calls as any)[0][0].siblings).toEqual([
    { id: 's1', projectKey: '/x/alpha' },
    { id: 's2', projectKey: '/x/alpha' },
  ])
})

test('a dispatch says which directory it landed in', async () => {
  const deps = withVocab(makeDeps())
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  // @nowhere matches no repo, so it stays in the prompt and the target falls back — the notice is
  // the only thing that tells you where the session actually went.
  stdin.write('@nowhere do a thing')
  await waitFor(() => lastFrame().includes('@nowhere do a thing█'))
  stdin.write('\r')
  await waitFor(() => lastFrame().includes('dispatched into alpha'))
  expect(deps.client.promptAsync).toHaveBeenCalledWith('s9', '@nowhere do a thing', '/x/alpha')
})

test('tab on an empty input opens the target list', async () => {
  const deps = withVocab(makeDeps())
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.client.listAgents.mock.calls.length > 0)
  stdin.write('\t')
  await waitFor(() => lastFrame().includes('@reviewer'))
  expect(lastFrame()).toContain('@build')
})

test('an attach that failed without drawing says why instead of flashing a blank screen', async () => {
  const deps = makeDeps()
  const onAction = vi.fn((a) =>
    a.type === 'enter' ? Promise.resolve({ message: "couldn't attach: /x/alpha no longer exists" }) : undefined,
  )
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('\r')
  await waitFor(() => lastFrame().includes('no longer exists'))
  expect(lastFrame()).toContain('fix tests') // and the roster is back
})

test('a failed dispatch keeps the prompt so it can be retried, not retyped', async () => {
  const deps = withVocab(makeDeps())
  deps.client.createSession = vi.fn(() => Promise.reject(new Error('server down')))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('a long prompt worth keeping')
  await waitFor(() => lastFrame().includes('a long prompt worth keeping█'))
  stdin.write('\r')
  await waitFor(() => lastFrame().includes('dispatch failed'))
  expect(lastFrame()).toContain('a long prompt worth keeping█')
})

test('a malformed /model reports how to fix it and leaves the line intact', async () => {
  const deps = withVocab(makeDeps())
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('/model haiku')
  await waitFor(() => lastFrame().includes('/model haiku█'))
  stdin.write('\r')
  await waitFor(() => lastFrame().includes('use /model'))
  expect(lastFrame()).toContain('/model haiku█')
})

test('tab with no suggestion to apply does not type a literal tab', async () => {
  const deps = withVocab(makeDeps())
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('plain text')
  await waitFor(() => lastFrame().includes('plain text█'))
  stdin.write('\t')
  await tick()
  expect(lastFrame()).toContain('plain text█')
})

test('arrows on an empty (skeleton-only) list do not crash and keep the skeleton', async () => {
  const deps = makeDeps()
  deps.roster = { groupBy: 'state', sessions: [] }
  deps.client.listSessions = vi.fn(() => Promise.resolve([]))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('a session is asking you something'))
  stdin.write('\x1B[B')
  stdin.write('\x1B[A')
  await tick()
  expect(lastFrame()).toContain('a session is asking you something')
})

const withProviders = (deps: any) => {
  deps.client.providers = vi.fn(() =>
    Promise.resolve({ providers: [{ id: 'anthropic', models: { 'claude-haiku': {}, 'claude-opus': {} } }] }),
  )
  return deps
}

test('/model rejects a model the server does not have, rather than poisoning later dispatches', async () => {
  const deps = withProviders(withVocab(makeDeps()))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.client.providers.mock.calls.length > 0)
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('/model anthropic/claude-typo')
  await waitFor(() => lastFrame().includes('claude-typo█'))
  stdin.write('\r')
  await waitFor(() => lastFrame().includes('has no model claude-typo'))
  expect(lastFrame()).toContain('default model') // header unchanged
})

test('/model rejects an unknown provider', async () => {
  const deps = withProviders(withVocab(makeDeps()))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.client.providers.mock.calls.length > 0)
  stdin.write('/model nope/whatever')
  await waitFor(() => lastFrame().includes('nope/whatever█'))
  stdin.write('\r')
  await waitFor(() => lastFrame().includes('no such provider: nope'))
})

test('/model accepts a real model, and an unreachable provider list never blocks it', async () => {
  const deps = withProviders(withVocab(makeDeps()))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.client.providers.mock.calls.length > 0)
  stdin.write('/model anthropic/claude-opus')
  await waitFor(() => lastFrame().includes('claude-opus█'))
  stdin.write('\r')
  await waitFor(() => lastFrame().includes('dispatch model: anthropic/claude-opus'))

  const offline = withVocab(makeDeps())
  offline.client.providers = vi.fn(() => Promise.reject(new Error('down')))
  const second = render(React.createElement(App, { ...offline, onAction: vi.fn() }))
  await waitFor(() => second.lastFrame().includes('fix tests'))
  second.stdin.write('/model anything/goes')
  await waitFor(() => second.lastFrame().includes('anything/goes█'))
  second.stdin.write('\r')
  await waitFor(() => second.lastFrame().includes('dispatch model: anything/goes'))
})

// A paste arrives as a single chunk, newline and all. Without folding it the prompt would carry
// raw control bytes straight into a model call.
// Newlines used to be folded into spaces because the prompt was one line. `^j` made it multi-line,
// so a short paste now keeps its shape all the way to the model — the layout of a numbered list or
// a stack trace is part of what was meant.
test('a short multi-line paste keeps its newline, and the prompt arrives with it intact', async () => {
  const deps = withVocab(makeDeps())
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('first line\nsecond line')
  await waitFor(() => lastFrame().includes('second line█'))
  // drawn as two rows, not one folded row
  expect(lastFrame()).toContain('first line')
  expect(lastFrame()).not.toContain('first line second line')
  stdin.write('\r')
  await waitFor(() => deps.client.promptAsync.mock.calls.length > 0)
  expect(deps.client.promptAsync).toHaveBeenCalledWith('s9', 'first line\nsecond line', '/x/alpha')
})

// Control characters other than newline still have no business in a prompt.
test('other control characters are still stripped from a paste', async () => {
  const deps = withVocab(makeDeps())
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('clean\u0007text')
  await waitFor(() => lastFrame().includes('cleantext█'))
})

// "Pasted text over 800 characters or more than two lines collapses to a [Pasted text #N]
// placeholder" — and the model still receives what was pasted, not the placeholder.
test('a long paste collapses to a placeholder and is restored on dispatch', async () => {
  const deps = withVocab(makeDeps())
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  const wall = 'x'.repeat(900)
  stdin.write('review this: ')
  await tick()
  stdin.write(wall)
  await waitFor(() => lastFrame().includes('[Pasted text #1]'))
  expect(lastFrame()).not.toContain('xxxxxxxxxx')
  stdin.write('\r')
  await waitFor(() => deps.client.promptAsync.mock.calls.length > 0)
  expect(deps.client.promptAsync).toHaveBeenCalledWith('s9', `review this: ${wall}`, '/x/alpha')
})

test('text with more than two lines collapses too, and the same paste keeps its number', async () => {
  const deps = withVocab(makeDeps())
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('a\nb\nc\nd')
  await waitFor(() => lastFrame().includes('[Pasted text #1]'))
  await tick()
  stdin.write('a\nb\nc\nd') // the same attachment, not a second one
  await waitFor(() => lastFrame().includes('[Pasted text #1][Pasted text #1]'))
  expect(lastFrame()).not.toContain('#2')
})

// "Ctrl+J inserts a newline in the dispatch input" rather than dispatching.
test('^j adds a line to the prompt instead of sending it', async () => {
  const deps = withVocab(makeDeps())
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('line one')
  await tick()
  stdin.write('\n') // ^j
  await tick()
  stdin.write('line two')
  await waitFor(() => lastFrame().includes('line two█'))
  expect(deps.client.createSession).not.toHaveBeenCalled()
  stdin.write('\r')
  await waitFor(() => deps.client.promptAsync.mock.calls.length > 0)
  expect(deps.client.promptAsync).toHaveBeenCalledWith('s9', 'line one\nline two', '/x/alpha')
})

// "Ctrl+G opens the dispatch prompt in $VISUAL or $EDITOR." The host owns the terminal handover.
test('^g hands the prompt to the host editor and takes back what it returns', async () => {
  const deps = withVocab(makeDeps())
  const onAction = vi.fn((a) => (a.type === 'edit' ? Promise.resolve(`${a.text} and more`) : undefined))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('rough draft')
  await tick()
  stdin.write('\x07') // ^g
  await waitFor(() => lastFrame().includes('rough draft and more'))
  expect(onAction).toHaveBeenCalledWith({ type: 'edit', text: 'rough draft' })
})

// This is the wiring the parser test could not see: dispatch-parse's applyFilter takes an
// agent accessor, and App used to omit it, so `a:<name>` matched nothing and blanked the roster.
test('a: filters by the session agent through the real App wiring', async () => {
  const deps = makeDeps()
  deps.roster = {
    groupBy: 'state',
    sessions: [
      { worktree: '/x/alpha', id: 's1', addedAt: 1 },
      { worktree: '/x/alpha', id: 's2', addedAt: 2 },
    ],
  }
  deps.client.listSessions = vi.fn(() =>
    Promise.resolve([
      { id: 's1', title: 'the reviewer one', agent: 'reviewer', time: { updated: 2 } },
      { id: 's2', title: 'the build one', agent: 'build', time: { updated: 1 } },
    ]),
  )
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('the build one'))
  stdin.write('a:rev')
  await waitFor(() => !lastFrame().includes('the build one'))
  expect(lastFrame()).toContain('the reviewer one')
})

test('a: on sessions with no recorded agent narrows to nothing rather than crashing', async () => {
  const deps = makeDeps()
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('a:build') // fixture sessions carry no agent field
  await waitFor(() => !lastFrame().includes('fix tests'))
  expect(lastFrame()).toContain('filtering')
})

// --- round 4: async and lifecycle ---

// The guard read `attached` from the render closure that created `dispatch` — the one render where
// it is still false — so it could never fire for the race it was written for.
test('a dispatch+attach that resolves after a manual attach does not attach on top of it', async () => {
  const deps = withVocab(makeDeps())
  let releaseCreate: any
  deps.client.createSession = vi.fn(() => new Promise((r) => { releaseCreate = () => r({ id: 's9' }) }))
  const enters: any[] = []
  const onAction = vi.fn((a) => {
    if (a.type !== 'enter') return undefined
    enters.push(a.sessionId)
    return new Promise(() => {}) // an attachment that stays live
  })
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction }))
  await waitFor(() => lastFrame().includes('fix tests'))

  stdin.write('do a thing')
  await waitFor(() => lastFrame().includes('do a thing█'))
  stdin.write('\x1B\r') // alt+enter: dispatch and attach
  await tick()
  stdin.write('\r') // meanwhile, attach to the selected row by hand
  await waitFor(() => enters.length === 1)

  releaseCreate()
  await tick()
  await tick()
  expect(enters).toEqual(['s1']) // and not a second attach for s9
})

test('a failed dispatch does not overwrite a prompt typed while it was in flight', async () => {
  const deps = withVocab(makeDeps())
  let failCreate: any
  deps.client.createSession = vi.fn(() => new Promise((_, reject) => { failCreate = () => reject(new Error('down')) }))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('the first prompt')
  await waitFor(() => lastFrame().includes('the first prompt█'))
  stdin.write('\r')
  await waitFor(() => !lastFrame().includes('the first prompt█'))
  stdin.write('a second prompt')
  await waitFor(() => lastFrame().includes('a second prompt█'))
  failCreate()
  await waitFor(() => lastFrame().includes('dispatch failed'))
  expect(lastFrame()).toContain('a second prompt█') // what the user is typing wins
  expect(lastFrame()).not.toContain('the first prompt')
})

test('help paging clamps at the last page so ↑ responds immediately', async () => {
  const deps = withVocab(makeDeps())
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('?')
  await waitFor(() => lastFrame().includes('Shortcuts'))
  for (let i = 0; i < 8; i++) stdin.write('\x1B[B') // press past the end
  await tick()
  const atEnd = lastFrame()
  stdin.write('\x1B[A') // one press back must move
  await waitFor(() => lastFrame() !== atEnd)
})

test('the peek header follows a rename instead of showing the prompt it opened with', async () => {
  const deps = withVocab(makeDeps())
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.connectEventsImpl.mock.calls.length > 0)
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write(' ')
  await waitFor(() => lastFrame().includes('reply'))
  const onEvent = deps.connectEventsImpl.mock.calls[0][1].onEvent
  onEvent('/x/alpha', { type: 'session.updated', properties: { info: { id: 's1', title: 'Named by opencode' } } })
  await waitFor(() => lastFrame().includes('Named by opencode'))
})


test('browse narrows with the same filter as the main view', async () => {
  const deps = withVocab(makeDeps())
  deps.client.listSessions = vi.fn(() =>
    Promise.resolve([
      { id: 's1', title: 'the busy one', time: { updated: 2 } },
      { id: 's2', title: 'the idle one', time: { updated: 1 } },
    ]),
  )
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.connectEventsImpl.mock.calls.length > 0)
  const onEvent = deps.connectEventsImpl.mock.calls[0][1].onEvent
  onEvent('/x/alpha', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  stdin.write('\x02') // browse
  await waitFor(() => lastFrame().includes('the idle one'))
  stdin.write('s:working')
  // the footer used to say "filtering" while browse showed everything
  await waitFor(() => !lastFrame().includes('the idle one'))
  expect(lastFrame()).toContain('the busy one')
})

// A combined success flag conflated three independent GETs: /session/status timing out made the
// question path re-add a question that /question had correctly reported as answered.
test('an unrelated endpoint failing does not resurrect an answered question', async () => {
  const deps = withVocab(makeDeps())
  deps.client.respondQuestion = vi.fn(() => Promise.reject(new Error('already answered elsewhere')))
  deps.client.sessionStatus = vi.fn(() => Promise.reject(new Error('timeout'))) // the unrelated one
  deps.client.listQuestions = vi.fn(() => Promise.resolve([])) // server says: nothing pending
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.connectEventsImpl.mock.calls.length > 0)
  const onEvent = deps.connectEventsImpl.mock.calls[0][1].onEvent
  onEvent('/x/alpha', {
    type: 'question.asked',
    properties: {
      sessionID: 's1',
      id: 'q1',
      questions: [{ question: 'go on?', header: 'go', options: [{ label: 'yes', description: '' }] }],
    },
  })
  stdin.write(' ')
  await waitFor(() => lastFrame().includes('1. yes'))
  stdin.write('1')
  await waitFor(() => deps.client.respondQuestion.mock.calls.length > 0)
  await waitFor(() => deps.client.listQuestions.mock.calls.length > 1) // the reconcile ran
  await tick()
  expect(lastFrame()).not.toContain('? question') // stays answered
})

// The periodic pass refreshes the pending lists ADDITIVELY. Repeating the authoritative replace on
// a timer would turn any omission from GET /permission into a recurring dropped request rather than
// a rare one; adding what the store is missing carries no such risk, and it is the only recovery
// path for a `permission.asked` frame the stream dropped on an otherwise healthy connection.
test('the periodic reseed surfaces a permission whose permission.asked frame was never delivered', async () => {
  const deps = withVocab(makeDeps())
  const { lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn(), projectPollMs: 60 }))
  await waitFor(() => lastFrame().includes('fix tests'))
  const onEvent = deps.connectEventsImpl.mock.calls[0][1].onEvent
  onEvent('/x/alpha', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  await waitFor(() => lastFrame().includes('1 working'))
  // it has been pending server-side all along — only its event went missing
  deps.client.listPermissions = vi.fn(() => Promise.resolve([{ id: 'p1', sessionID: 's1', permission: 'bash' }]))
  // Recovery costs a whole poll pass, and the pass is a chained sequence of awaited client calls
  // that chainSeed serialises per worktree. waitFor's 3s default is enough locally and not enough
  // on a loaded CI runner with 40 test files competing for the event loop — this timed out once on
  // macOS. The condition is still polled, only the ceiling moves.
  await waitFor(() => lastFrame().includes('1 awaiting input'), 15000)
})

test('the periodic reseed does not drop a pending request the server list omits', async () => {
  const deps = withVocab(makeDeps())
  const { lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn(), projectPollMs: 60 }))
  await waitFor(() => lastFrame().includes('fix tests'))
  const onEvent = deps.connectEventsImpl.mock.calls[0][1].onEvent
  onEvent('/x/alpha', { type: 'question.asked', properties: { sessionID: 's1', id: 'q9', questions: [] } })
  await waitFor(() => lastFrame().includes('1 awaiting input'))
  const questionCalls = () => deps.client.listQuestions.mock.calls.length
  const at = questionCalls()
  await waitFor(() => questionCalls() > at + 1, 15000) // two full poll passes over an empty GET /question; see the timeout note above
  expect(lastFrame()).toContain('1 awaiting input') // additive: it adds, it never sweeps
})

// "Clear the input; press twice to exit" — quitting on the first press lost the view for anyone
// reaching for Ctrl+C to dismiss something.
test('ctrl+c on an empty input warns before it quits', async () => {
  const deps = withVocab(makeDeps())
  const onAction = vi.fn()
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('\x03')
  await waitFor(() => lastFrame().includes('press ^c again'))
  expect(onAction).not.toHaveBeenCalled()
  stdin.write('\x03')
  await waitFor(() => onAction.mock.calls.length > 0)
  expect(onAction).toHaveBeenCalledWith({ type: 'quit' })
})

test('ctrl+c still just clears a non-empty input', async () => {
  const deps = withVocab(makeDeps())
  const onAction = vi.fn()
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('some prompt')
  await waitFor(() => lastFrame().includes('some prompt█'))
  stdin.write('\x03')
  await waitFor(() => !lastFrame().includes('some prompt█'))
  expect(onAction).not.toHaveBeenCalled()
})

// A subagent spawned since the last listing is unknown to the store, so its first session.status
// mints a row that browse shows and ^a could adopt. listSessions is the only thing that learns
// what is a subagent, and it used to run only at first sight, on reconnect, and after a dispatch —
// so on a healthy stream that row stayed until fleetview was restarted. The project poll now relists.
test('the project poll relists sessions, so a subagent ghost is pruned within one interval', async () => {
  const deps = makeDeps()
  let onEvent: any
  deps.connectEventsImpl = vi.fn((_: any, handlers: any) => {
    onEvent = handlers.onEvent
    return { done: Promise.resolve(), stop: vi.fn() }
  })
  // the first listing does not know about the child; later ones do
  deps.client.listSessions = vi
    .fn()
    .mockResolvedValueOnce([{ id: 's1', title: 'fix tests', time: { updated: Date.now() } }])
    .mockResolvedValue([
      { id: 's1', title: 'fix tests', time: { updated: Date.now() } },
      { id: 'ses_sub', title: 'subagent', parentID: 's1' },
    ])
  // A deliberately slow poll: at 15ms the relist prunes the ghost before it can be observed at
  // all, which would make this pass without proving the row was ever there to prune.
  const { lastFrame, stdin } = render(
    React.createElement(App, { ...deps, onAction: vi.fn(), projectPollMs: 500 }),
  )
  await waitFor(() => lastFrame().includes('fix tests'))

  onEvent('/x/alpha', { type: 'session.status', properties: { sessionID: 'ses_sub', status: { type: 'busy' } } })
  stdin.write('\x02') // browse lists every session the store holds, member or not
  await waitFor(() => lastFrame().includes('ses_sub'))

  await waitFor(() => !lastFrame().includes('ses_sub'))
  expect(deps.client.listSessions.mock.calls.length).toBeGreaterThan(1)
})

test('^x on a group header counts and deletes every session, not just the visible subset', async () => {
  // Browse caps each project at VISIBLE_PER_PROJECT (10) on screen. With 12 sessions the group
  // delete must still act on all 12: reading the rendered (capped) group deleted only 10. The count
  // is a size-independent discriminator — the cap is fixed regardless of terminal rows.
  const now = Date.now()
  const ids = Array.from({ length: 12 }, (_, i) => `s${i + 1}`)
  const deps = makeDeps()
  deps.roster = { groupBy: 'state', sessions: ids.map((id, i) => ({ worktree: '/x/alpha', id, addedAt: i + 1 })) }
  deps.client.listSessions = vi.fn(() =>
    Promise.resolve(ids.map((id, i) => ({ id, title: `task ${id}`, time: { updated: now - i } }))),
  )
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('task s1'))
  stdin.write('\x02') // browse
  await waitFor(() => lastFrame().includes('alpha'))
  stdin.write('\x1B[A') // up onto the project group header
  await tick()
  stdin.write('\x18') // ^x arms the group delete
  await waitFor(() => lastFrame().includes('again to delete'))
  expect(lastFrame()).toContain('12 sessions') // the full group, not the capped 10
  stdin.write('\x18') // confirm
  await waitFor(() => deps.client.deleteSession.mock.calls.length === 12)
  expect(new Set(deps.client.deleteSession.mock.calls.map((c: any) => c[0]))).toEqual(new Set(ids))
})


// --- worktree isolation (agent view: background sessions edit in their own worktree) ---

// Shapes verified live against opencode 1.18.4: POST /experimental/worktree returns
// {name, branch, directory}; the worktree becomes a project of its own; and the repository's
// project row lists it in `sandboxes`.
const isolatingDeps = () => {
  const deps = makeDeps()
  const wt = '/wt/alpha/fix-the-thing'
  deps.client.listWorktrees = vi.fn(() => Promise.resolve([]))
  deps.client.createWorktree = vi.fn(() =>
    Promise.resolve({ name: 'fix-the-thing', branch: 'opencode/fix-the-thing', directory: wt }),
  )
  deps.client.removeWorktree = vi.fn(() => Promise.resolve(true))
  deps.client.listProjects = vi.fn(() =>
    Promise.resolve([
      { ...project, sandboxes: [wt] },
      { id: 'a-2', worktree: wt, vcs: 'git', sandboxes: [], time: { created: 2, updated: 2000 } },
    ]),
  )
  deps.client.listSessions = vi.fn((dir) =>
    Promise.resolve(
      dir === wt
        ? [{ id: 's9', title: 'in the worktree', time: { updated: Date.now() } }]
        : [{ id: 's1', title: 'fix tests', time: { updated: Date.now() } }],
    ),
  )
  return { deps, wt }
}

test('a dispatch runs in its own worktree, and the row still says the repository', async () => {
  const { deps, wt } = isolatingDeps()
  const { lastFrame, stdin } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))

  stdin.write('fix the thing')
  await tick() // the input state must flush, or Enter sees an empty input and attaches instead
  stdin.write('\r')
  await waitFor(() => deps.client.promptAsync.mock.calls.length > 0)

  expect(deps.client.createWorktree).toHaveBeenCalledWith('fix-the-thing', '/x/alpha')
  // every call for the session is scoped to the worktree, never the shared checkout
  expect(deps.client.createSession).toHaveBeenCalledWith(expect.anything(), wt)
  expect(deps.client.promptAsync).toHaveBeenCalledWith('s9', 'fix the thing', wt)
  // and the confirmation names the repository, not a hashed cache path
  await waitFor(() => lastFrame().includes('dispatched into alpha'))
  expect(lastFrame()).not.toContain('/wt/alpha')
})

// GET /experimental/worktree answers with objects, not directory strings — so a repository that
// already has one worktree is the ordinary case, not an edge one. Passing the objects straight into
// worktreeName threw into the silent isolation catch, and every dispatch after the first ran in the
// shared checkout with only a "not isolated" flash.
test('a repository that already has worktrees still isolates, and avoids the taken name', async () => {
  const { deps, wt } = isolatingDeps()
  deps.client.listWorktrees = vi.fn(() =>
    Promise.resolve([{ name: 'fix-the-thing', branch: 'opencode/fix-the-thing', directory: '/wt/alpha/fix-the-thing' }]),
  )
  const { lastFrame, stdin } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('fix the thing')
  await tick()
  stdin.write('\r')
  await waitFor(() => deps.client.promptAsync.mock.calls.length > 0)
  expect(deps.client.createWorktree).toHaveBeenCalledWith('fix-the-thing-2', '/x/alpha')
  expect(deps.client.createSession).toHaveBeenCalledWith(expect.anything(), wt)
  expect(lastFrame()).not.toContain('not isolated')
})

// M14: the dispatch path (streamProjectRef after createWorktree) and the discovery poll can both
// hand the same worktree to seedAndStream. Without the in-function guard the second run's
// conns.set orphaned the first connection's stop(), which then reconnected and double-delivered
// events until process exit. Here discovery streams the worktree first; the dispatch must reuse it.
test('a worktree already streamed is not seeded a second time by the dispatch path', async () => {
  const { deps, wt } = isolatingDeps()
  const wtConns = () => deps.connectEventsImpl.mock.calls.filter((c: any[]) => c[0].directory === wt).length
  const { lastFrame, stdin } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  await waitFor(() => wtConns() === 1) // discovery already opened the worktree's event stream
  stdin.write('fix the thing')
  await tick()
  stdin.write('\r')
  await waitFor(() => deps.client.promptAsync.mock.calls.length > 0)
  expect(wtConns()).toBe(1) // one live stream, not a second one with an unreachable stop()
})

test('isolate=false dispatches into the checkout, no worktree, and says so (#88)', async () => {
  const { deps } = isolatingDeps()
  const { lastFrame, stdin } = render(React.createElement(App, { ...deps, onAction: vi.fn(), isolate: false }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('fix the thing')
  await tick()
  stdin.write('\r')
  await waitFor(() => deps.client.promptAsync.mock.calls.length > 0)
  // no worktree made; the session runs in the repository itself
  expect(deps.client.createWorktree).not.toHaveBeenCalled()
  expect(deps.client.createSession).toHaveBeenCalledWith(expect.anything(), '/x/alpha')
  expect(deps.client.promptAsync).toHaveBeenCalledWith('s9', 'fix the thing', '/x/alpha')
  await waitFor(() => lastFrame().includes('isolation off, it edits the checkout'))
})

// "Skips the worktree when the working directory is not a git repository."
test('a project that is not a git repository is dispatched into directly', async () => {
  const { deps } = isolatingDeps()
  deps.client.listProjects = vi.fn(() => Promise.resolve([{ ...project, vcs: undefined, sandboxes: [] }]))
  const { lastFrame, stdin } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('take a note')
  await tick() // the input state must flush, or Enter sees an empty input and attaches instead
  stdin.write('\r')
  await waitFor(() => deps.client.promptAsync.mock.calls.length > 0)
  expect(deps.client.createWorktree).not.toHaveBeenCalled()
  expect(deps.client.createSession).toHaveBeenCalledWith(expect.anything(), '/x/alpha')
})

// Isolation is a safety measure, not a precondition: an older server that has no worktree endpoint
// must not cost the user the dispatch.
test('a worktree the server refuses to create falls back to the repository, and says so', async () => {
  const { deps } = isolatingDeps()
  deps.client.createWorktree = vi.fn(() => Promise.reject(new Error('404')))
  const { lastFrame, stdin } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('fix the thing')
  await tick() // the input state must flush, or Enter sees an empty input and attaches instead
  stdin.write('\r')
  await waitFor(() => deps.client.promptAsync.mock.calls.length > 0)
  expect(deps.client.createSession).toHaveBeenCalledWith(expect.anything(), '/x/alpha')
  // Said in the confirmation itself: a separate notice would be replaced by it milliseconds later.
  await waitFor(() => lastFrame().includes('not isolated'))
})

// "Ctrl+X twice removes the worktree and uncommitted changes."
test('deleting an isolated session removes its worktree when nothing would be lost', async () => {
  const { deps, wt } = isolatingDeps()
  deps.roster = { groupBy: 'state', sessions: [{ worktree: wt, id: 's9', addedAt: 1 }] }
  const { lastFrame, stdin } = render(
    React.createElement(App, {
      ...deps,
      onAction: vi.fn(),
      worktreeSafetyImpl: () => ({ removable: true, dirty: true, unpushed: false, reason: null }),
    }),
  )
  await waitFor(() => lastFrame().includes('in the worktree'))
  stdin.write('\x18')
  stdin.write('\x18')
  await waitFor(() => deps.client.removeWorktree.mock.calls.length > 0)
  expect(deps.client.deleteSession).toHaveBeenCalledWith('s9', wt)
  expect(deps.client.removeWorktree).toHaveBeenCalledWith(wt, '/x/alpha')
})

// "Neither removes a worktree with unpushed commits — it is kept with the session row." The session
// still goes; the work does not.
test('deleting an isolated session keeps a worktree holding commits, and says why', async () => {
  const { deps, wt } = isolatingDeps()
  deps.roster = { groupBy: 'state', sessions: [{ worktree: wt, id: 's9', addedAt: 1 }] }
  const { lastFrame, stdin } = render(
    React.createElement(App, {
      ...deps,
      onAction: vi.fn(),
      worktreeSafetyImpl: () => ({ removable: false, dirty: false, unpushed: true, reason: '2 unpushed commits' }),
    }),
  )
  await waitFor(() => lastFrame().includes('in the worktree'))
  stdin.write('\x18')
  stdin.write('\x18')
  await waitFor(() => deps.client.deleteSession.mock.calls.length > 0)
  await waitFor(() => lastFrame().includes('2 unpushed commits'))
  expect(deps.client.removeWorktree).not.toHaveBeenCalled()
})

// Two sessions share the worktree, so removing the directory would pull it out from under the
// survivor. Note this test does NOT discriminate the fix that prompted it: counting "more than one
// left" also passes here, because the render closure still holds both rows. It diverges only if
// React re-renders during the delete's await, which a test cannot force — excluding the deleted id
// is correct under either ordering, and that is the point of the change rather than something this
// case proves.
test('a worktree with another session left in it is never removed', async () => {
  const { deps, wt } = isolatingDeps()
  deps.client.listSessions = vi.fn((dir) =>
    Promise.resolve(
      dir === wt
        ? [
            { id: 's9', title: 'in the worktree', time: { updated: Date.now() } },
            { id: 's10', title: 'also in there', time: { updated: Date.now() - 1 } },
          ]
        : [],
    ),
  )
  deps.roster = {
    groupBy: 'state',
    sessions: [
      { worktree: wt, id: 's9', addedAt: 1 },
      { worktree: wt, id: 's10', addedAt: 2 },
    ],
  }
  const { lastFrame, stdin } = render(
    React.createElement(App, {
      ...deps,
      onAction: vi.fn(),
      worktreeSafetyImpl: () => ({ removable: true, dirty: false, unpushed: false, reason: null }),
    }),
  )
  await waitFor(() => lastFrame().includes('in the worktree'))
  stdin.write('\x18')
  stdin.write('\x18')
  await waitFor(() => deps.client.deleteSession.mock.calls.length > 0)
  await tick()
  expect(deps.client.removeWorktree).not.toHaveBeenCalled()
})

test('a session on a branch with an open pull request carries it into the view', async () => {
  // One gh call per repository, never per session: the assertion on `calls` is the affordability
  // claim the whole design rests on, so it is asserted rather than assumed.
  const calls: any[] = []
  const fetchPullRequestsImpl = async (dir: any) => {
    calls.push(dir)
    return {
      prs: [{ number: 77, url: 'https://github.com/o/r/pull/77', state: 'OPEN', isDraft: false, headRefName: 'opencode/fix', statusCheckRollup: [], reviewDecision: '' }],
      reason: null,
    }
  }
  const deps = makeDeps()
  const { lastFrame, stdin } = render(
    React.createElement(App, {
      ...deps,
      onAction: vi.fn(),
      fetchPullRequestsImpl,
      branchOfImpl: () => 'opencode/fix',
    }),
  )
  // No #N on rows and no count in the header — peek is where the decoration surfaces.
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write(' ')
  await waitFor(() => lastFrame().includes('#77'))
  // The repository, not each of its sessions and not its worktrees.
  expect(new Set(calls).size).toBe(calls.length)
})

test('a matching branch name in another repository does not lend its pull request label', async () => {
  // Branch names are not unique across repositories — every repo dependabot touches has the same
  // formulaic branch — so the PR map must be keyed by repository + branch, never bare branch.
  const beta = { id: 'b-1', worktree: '/x/beta', vcs: 'git', time: { created: 1, updated: 1000 } }
  const deps = makeDeps()
  deps.client.listProjects = vi.fn(() => Promise.resolve([project, beta]))
  deps.client.listSessions = vi.fn((dir) =>
    Promise.resolve([{ id: 's1', title: dir === '/x/alpha' ? 'alpha row' : 'beta row', time: { updated: Date.now() } }]),
  )
  deps.roster = {
    groupBy: 'state',
    sessions: [
      { worktree: '/x/alpha', id: 's1', addedAt: 1 },
      { worktree: '/x/beta', id: 's1', addedAt: 2 },
    ],
  }
  const { lastFrame, stdin } = render(
    React.createElement(App, {
      ...deps,
      onAction: vi.fn(),
      // Both repositories sit on the same branch name; only alpha has a pull request on it.
      branchOfImpl: () => 'dependabot/github_actions/actions/checkout-7',
      fetchPullRequestsImpl: async (dir: any) =>
        dir === '/x/alpha'
          ? {
              prs: [{ number: 7, url: 'https://github.com/o/alpha/pull/7', state: 'OPEN', isDraft: false, headRefName: 'dependabot/github_actions/actions/checkout-7', statusCheckRollup: [], reviewDecision: '' }],
              reason: null,
            }
          : { prs: [], reason: null },
    }),
  )
  // Peek is the observable now: alpha's session carries #7, its beta twin must not.
  await waitFor(() => lastFrame().includes('alpha row'))
  stdin.write(' ') // peek the selected session
  await waitFor(() => lastFrame().includes('#7') || lastFrame().includes('no pull requests') || lastFrame().includes('beta row'))
  const alphaPeeked = lastFrame().includes('#7')
  stdin.write('\x1B[B') // re-peek the neighbour
  await tick()
  const other = lastFrame()
  // Whichever order the rows came in, exactly one of the two peeks shows the pull request.
  expect(alphaPeeked !== other.includes('#7')).toBe(true)
})

test('peeking a session with an open pull request shows it in the peek panel', async () => {
  // Regression guard for the peek call site's `prs: prsFor(peekTarget.projectKey)` decoration —
  // only the Peek component's own unit test covered this rendering; nothing at the app level
  // proved the app actually wires a target's PRs through to peek, so a future edit could silently
  // revert the call site to a plain `store.get(...)` and no app test would catch it.
  const deps = makeDeps()
  const { stdin, lastFrame } = render(
    React.createElement(App, {
      ...deps,
      onAction: vi.fn(),
      fetchPullRequestsImpl: async () => ({
        prs: [{ number: 77, url: 'https://github.com/o/r/pull/77', state: 'OPEN', isDraft: false, headRefName: 'opencode/fix', statusCheckRollup: [], reviewDecision: '' }],
        reason: null,
      }),
      branchOfImpl: () => 'opencode/fix',
    }),
  )
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write(' ') // open peek on s1 (default selection)
  await waitFor(() => lastFrame().includes('#77')) // peek is where the number lives now
  expect(lastFrame()).toContain('https://github.com/o/r/pull/77')
})

test('gh being unavailable leaves the roster exactly as it was', async () => {
  const deps = makeDeps()
  const { lastFrame } = render(
    React.createElement(App, {
      ...deps,
      onAction: vi.fn(),
      fetchPullRequestsImpl: async () => ({ prs: [], reason: 'gh is not installed' }),
      branchOfImpl: () => 'opencode/fix',
    }),
  )
  await waitFor(() => lastFrame().includes('fix tests'))
  await tick()
  const frame = lastFrame()
  expect(frame).not.toContain('#77')
  expect(frame).not.toContain('gh is not installed') // no startup nag; peek carries the reason
})

const openPr = (number: any) => ({ number, url: `https://github.com/o/r/pull/${number}`, state: 'OPEN', isDraft: false, headRefName: 'opencode/x', statusCheckRollup: [], reviewDecision: '' })

test('an open pull request adds no group and no count — the row sits with its status', async () => {
  const deps = makeDeps()
  const { lastFrame } = render(
    React.createElement(App, {
      ...deps,
      onAction: vi.fn(),
      fetchPullRequestsImpl: async () => ({ prs: [openPr(5)], reason: null }),
      branchOfImpl: () => 'opencode/x',
    }),
  )
  await waitFor(() => lastFrame().includes('fix tests'))
  await tick()
  expect(lastFrame()).not.toContain('ready for review')
})

test('a waiting session with an open pull request stays under needs input — no review group', async () => {
  // fleetview deliberately has no `Ready for review` section (folded into the status groups);
  // the open PR surfaces as the header's count and in peek, and the session sits wherever its
  // status puts it.
  const deps = makeDeps()
  deps.client.listPermissions = vi.fn(() => Promise.resolve([{ id: 'p1', sessionID: 's1', permission: 'bash' }]))
  const { lastFrame } = render(
    React.createElement(App, {
      ...deps,
      onAction: vi.fn(),
      fetchPullRequestsImpl: async () => ({ prs: [openPr(5)], reason: null }),
      branchOfImpl: () => 'opencode/x',
    }),
  )
  await waitFor(() => lastFrame().includes('fix tests'))
  await waitFor(() => lastFrame().includes('1 awaiting input'))
  const lines = lastFrame().split('\n')
  const rows = lines.map((l, i) => (l.includes('fix tests') ? i : -1)).filter((i) => i >= 0)
  expect(rows.length).toBe(1)
  const waitingAt = lines.findIndex((l) => l.includes('needs input'))
  const workingAt = lines.findIndex((l) => l.includes('working') && !l.includes('0 working'))
  expect(rows[0]).toBeGreaterThan(waitingAt)
  expect(rows[0]).toBeLessThan(workingAt)
  expect(lastFrame()).not.toContain('ready for review') // no group, no count — peek carries the PR
})

test('a finished shell job cleans itself up after the TTL; a fresh one stays', async () => {
  const { expiredShellJobs, SHELL_JOB_TTL_MS } = await import('../src/app.ts')
  const now = 1_000_000_000
  const roster = {
    groupBy: 'state',
    sessions: [
      { worktree: '/x/a', id: 'job-old', addedAt: 1, shell: true },
      { worktree: '/x/a', id: 'job-new', addedAt: 2, shell: true },
      { worktree: '/x/a', id: 'chat', addedAt: 3 },
      { worktree: '/x/a', id: 'unseeded-job', addedAt: 4, shell: true },
    ],
  }
  const sessionsById = new Map([
    ['/x/a:job-old', { status: 'idle', updatedAt: now - SHELL_JOB_TTL_MS - 1 }],
    ['/x/a:job-new', { status: 'idle', updatedAt: now - 1000 }],
    ['/x/a:chat', { status: 'idle', updatedAt: now - SHELL_JOB_TTL_MS - 1 }],
    // unseeded-job deliberately absent: not yet in the store must mean left alone
  ])
  expect(expiredShellJobs(roster, sessionsById, now).map((m: any) => m.id)).toEqual(['job-old'])
  // Still running is never cleaned regardless of age.
  sessionsById.set('/x/a:job-old', { status: 'running', updatedAt: now - SHELL_JOB_TTL_MS * 10 })
  expect(expiredShellJobs(roster, sessionsById, now)).toEqual([])
})

test('/fork copies the selected session and sends the argument as the fork prompt', async () => {
  const deps = makeDeps()
  deps.client.forkSession = vi.fn(() => Promise.resolve({ id: 'ses_forked' }))
  const { lastFrame, stdin } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('/fork try the other approach')
  await tick()
  stdin.write('\r')
  await waitFor(() => deps.client.forkSession.mock.calls.length > 0)
  expect(deps.client.forkSession).toHaveBeenCalledWith('s1', '/x/alpha')
  await waitFor(() => deps.client.promptAsync.mock.calls.some((c: any) => c[0] === 'ses_forked'))
  expect(deps.client.promptAsync).toHaveBeenCalledWith('ses_forked', 'try the other approach', '/x/alpha')
  expect(deps.persistRoster).toHaveBeenCalledWith(
    expect.objectContaining({ sessions: expect.arrayContaining([expect.objectContaining({ id: 'ses_forked' })]) }),
  )
})

test('^t pins the selected session: pinned group on top, bold name, ^t again unpins', async () => {
  const deps = makeDeps()
  const { lastFrame, stdin } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  expect(lastFrame()).not.toContain('pinned') // empty pinned group renders nothing
  stdin.write('\x14') // ^t
  await waitFor(() => lastFrame().includes('pinned'))
  const lines = lastFrame().split('\n').slice(headerRows(80))
  const pinnedAt = lines.findIndex((l) => l.includes('pinned'))
  const rowAt = lines.findIndex((l) => l.includes('fix tests'))
  const waitingAt = lines.findIndex((l) => l.includes('needs input'))
  expect(pinnedAt).toBeGreaterThanOrEqual(0)
  expect(rowAt).toBeGreaterThan(pinnedAt)
  expect(rowAt).toBeLessThan(waitingAt) // pinned sits above the status groups
  expect(lastFrame().split('\n').filter((l) => l.includes('fix tests')).length).toBe(1) // partition holds
  expect(deps.persistRoster).toHaveBeenCalledWith(
    expect.objectContaining({ sessions: expect.arrayContaining([expect.objectContaining({ id: 's1', pinned: true })]) }),
  )
  stdin.write('\x14') // ^t again — unpin
  await waitFor(() => !lastFrame().includes('pinned'))
})

test('shift+down moves the selected row within its group and the order persists as ranks', async () => {
  const deps = makeDeps()
  deps.roster = {
    groupBy: 'state',
    sessions: [
      { worktree: '/x/alpha', id: 's1', addedAt: 1 },
      { worktree: '/x/alpha', id: 's2', addedAt: 2 },
    ],
  }
  deps.client.listSessions = vi.fn(() =>
    Promise.resolve([
      { id: 's1', title: 'first row', time: { updated: 2000 } },
      { id: 's2', title: 'second row', time: { updated: 1000 } },
    ]),
  )
  const { lastFrame, stdin } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('second row'))
  const order = () => {
    const lines = lastFrame().split('\n')
    return lines.findIndex((l) => l.includes('first row')) - lines.findIndex((l) => l.includes('second row'))
  }
  expect(order()).toBeLessThan(0) // recency: first row (newer) above second row
  stdin.write('\x1B[1;2B') // shift+down: move "first row" below "second row"
  await waitFor(() => order() > 0)
  expect(deps.persistRoster).toHaveBeenCalledWith(
    expect.objectContaining({
      sessions: expect.arrayContaining([
        expect.objectContaining({ id: 's1', rank: 1 }),
        expect.objectContaining({ id: 's2', rank: 0 }),
      ]),
    }),
  )
  // The selection rides along with the row it moved (#18: selection is a session, not a slot), so
  // undoing the move is shift+↑ on the same row — and that proves a second reorder over rows that
  // already carry ranks works.
  stdin.write('\x1B[1;2A')
  await waitFor(() => order() < 0)
})

// --- #73: what a failed delete restores, and what ^x claims ---

// L9: the rollback used to rebuild the member from (worktree, id), which mints a bare one — so a
// delete that failed silently unpinned the row, forgot it was a shell job (breaking the 5-minute
// auto-clean) and lost the dispatch prompt the URL filter reads.
test('a failed delete restores the member it removed, not a bare one', async () => {
  const deps = makeDeps()
  const member = { worktree: '/x/alpha', id: 's1', addedAt: 1, pinned: true, shell: true, prompt: 'run the suite', rank: 3 }
  deps.roster = { groupBy: 'state', sessions: [member] }
  deps.client.deleteSession = vi.fn(() => Promise.reject(new Error('down')))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('\x18')
  await tick()
  stdin.write('\x18') // second press deletes; the delete fails
  await waitFor(() => lastFrame().includes('delete failed'))
  expect(deps.persistRoster).toHaveBeenLastCalledWith(expect.objectContaining({ sessions: [member] }))
})

// L12: the notice used to say `stopped "<title>"` before the abort had been sent, and never
// corrected itself when it threw — a session that is still running read as stopped.
test('^x reports the stop only once it happened, and says so when it fails', async () => {
  const deps = makeDeps()
  const gate = deferred()
  deps.client.abortSession = vi.fn(() => gate.promise)
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('\x18')
  await waitFor(() => lastFrame().includes('stopping "fix tests"'))
  expect(lastFrame()).not.toContain('stopped "fix tests"') // nothing has stopped yet
  expect(lastFrame()).toContain('^x again to delete') // the arm is live regardless
  gate.resolve({})
  await waitFor(() => lastFrame().includes('stopped "fix tests"'))
})

test('^x on a session whose abort fails says it could not stop it', async () => {
  const deps = makeDeps()
  deps.client.abortSession = vi.fn(() => Promise.reject(new Error('down')))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('\x18')
  await waitFor(() => lastFrame().includes(`couldn't stop "fix tests"`))
  expect(lastFrame()).not.toContain('stopped "fix tests"')
})

// L10: the header counts the fleet, not the rows currently drawn — a filter that hides a blocked
// session used to drop `1 awaiting input` to zero while the roster beside it still listed it.
test('the header count survives a filter that hides the blocked session', async () => {
  const deps = makeDeps()
  deps.client.listQuestions = vi.fn(() =>
    Promise.resolve([{ id: 'q1', sessionID: 's1', questions: [{ question: 'proceed?', header: 'proceed', options: [] }] }]),
  )
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('1 awaiting input'))
  stdin.write('s:working') // a filter the blocked session cannot match
  await waitFor(() => !sectionBody(lastFrame(), 'needs input').includes('fix tests'))
  expect(lastFrame()).toContain('1 awaiting input') // still true of the fleet
})

// ---------------------------------------------------------------------------
// Multi-backend: dispatch routing, roster normalisation, capability gating.
// Every test here builds an explicit registry — App's default is opencode alone, which is what keeps
// every test above describing a single-backend roster.

const ALL_CAPS = { fork: true, rename: true, delete: true, questions: true }

// A stand-in adapter. `handlers` is captured so a test can push an event the way the real poller
// would, without a process, a log file or a timer.
function fakeBackend(name: string, capabilities: any = {}, sessions: any[] = []) {
  const captured: any = { handlers: null, stop: vi.fn() }
  return {
    name,
    capabilities: { fork: false, rename: false, delete: false, questions: false, ...capabilities },
    captured,
    listSessions: vi.fn(async () => sessions),
    dispatch: vi.fn(async ({ directory }: any) => ({ id: `${name}-9`, directory })),
    prompt: vi.fn(async () => ({})),
    events: vi.fn((_target: any, handlers: any) => {
      captured.handlers = handlers
      return { done: Promise.resolve(), stop: captured.stop }
    }),
    attach: ({ id }: any) => [name, '--resume', id],
    abort: vi.fn(async () => ({ aborted: true })),
    rename: vi.fn(async () => {
      throw new Error(`${name} cannot rename`)
    }),
    delete: vi.fn(async () => {
      throw new Error(`${name} cannot delete`)
    }),
  }
}

// The opencode entry only ever answers capability questions — App routes opencode rows through
// `client`, exactly as it did before backends existed — so a stub with every flag on is enough.
const opencodeStub = () => ({ name: 'opencode', capabilities: ALL_CAPS })

// A claude transcript listing, in the shape backends/claude/projects.ts returns.
const claudeRow = (id = 'c1', title = 'claude work') => ({ id, title, directory: '/x/alpha', updatedAt: Date.now() })

test('@backend routes the dispatch to that backend, never to the opencode client', async () => {
  const deps = makeDeps()
  const claude = fakeBackend('claude')
  const { stdin } = render(
    React.createElement(App, { ...deps, onAction: vi.fn(), backends: { opencode: opencodeStub(), claude } }),
  )
  await tick()
  stdin.write('@claude fix the tests')
  await tick()
  stdin.write('\r')
  await waitFor(() => claude.dispatch.mock.calls.length > 0)
  expect(claude.dispatch).toHaveBeenCalledWith({ prompt: 'fix the tests', directory: '/x/alpha', agent: undefined, model: undefined })
  // The whole point of the separate path: opencode's dispatch machinery is not touched at all.
  expect(deps.client.createSession).not.toHaveBeenCalled()
})

test('an unprefixed dispatch still goes to opencode when a second backend is merely available', async () => {
  const deps = makeDeps()
  const claude = fakeBackend('claude')
  const { stdin } = render(
    React.createElement(App, { ...deps, onAction: vi.fn(), backends: { opencode: opencodeStub(), claude } }),
  )
  await tick()
  stdin.write('do a thing')
  await tick()
  stdin.write('\r')
  await waitFor(() => deps.client.createSession.mock.calls.length > 0)
  expect(claude.dispatch).not.toHaveBeenCalled()
})

test('--backend claude makes an unprefixed dispatch land on claude', async () => {
  const deps = makeDeps()
  const claude = fakeBackend('claude')
  const { stdin } = render(
    React.createElement(App, {
      ...deps,
      onAction: vi.fn(),
      backends: { opencode: opencodeStub(), claude },
      initialBackend: 'claude',
    }),
  )
  await tick()
  stdin.write('do a thing')
  await tick()
  stdin.write('\r')
  await waitFor(() => claude.dispatch.mock.calls.length > 0)
  expect(deps.client.createSession).not.toHaveBeenCalled()
})

test('a `!` shell job is refused on a backend with no shell surface', async () => {
  const deps = makeDeps()
  const claude = fakeBackend('claude')
  const { stdin, lastFrame } = render(
    React.createElement(App, {
      ...deps,
      onAction: vi.fn(),
      backends: { opencode: opencodeStub(), claude },
      initialBackend: 'claude',
    }),
  )
  await tick()
  stdin.write('!npm test')
  await tick()
  stdin.write('\r')
  await waitFor(() => lastFrame().includes('shell jobs run on opencode'))
  expect(claude.dispatch).not.toHaveBeenCalled()
})

test('a pure-opencode roster never streams another backend', async () => {
  const deps = makeDeps()
  const claude = fakeBackend('claude', {}, [claudeRow()])
  render(React.createElement(App, { ...deps, onAction: vi.fn(), backends: { opencode: opencodeStub(), claude } }))
  await waitFor(() => deps.client.listSessions.mock.calls.length > 0)
  await tick()
  expect(claude.events).not.toHaveBeenCalled()
  expect(claude.listSessions).not.toHaveBeenCalled()
})

test('claude sessions discovered in a shown directory join the roster with live status', async () => {
  const deps = makeDeps()
  const claude = fakeBackend('claude', {}, [claudeRow('c1', 'claude work')])
  const { lastFrame } = render(
    React.createElement(App, {
      ...deps,
      onAction: vi.fn(),
      backends: { opencode: opencodeStub(), claude },
      initialBackend: 'claude',
      // Browse shows every discovered session, member or not — the roster's main view is memberships.
      roster: { groupBy: 'state', sessions: [{ worktree: '/x/alpha', id: 'c1', addedAt: 1 }] },
    }),
  )
  await waitFor(() => lastFrame().includes('claude work'))
  // A raw stream-json line, normalised into the store's vocabulary and folded into the row.
  claude.captured.handlers.onEvent('/x/alpha', {
    type: 'assistant',
    session_id: 'c1',
    message: { content: [{ type: 'text', text: 'ran the suite' }] },
  })
  await waitFor(() => lastFrame().includes('ran the suite'))
})

// The restart path: the only thing saying c1 is claude's is the persisted membership. If that seed
// skips noteBackend, the store never learns the row's origin and opencode's periodic
// seedStatuses(closeRuns) sweep — which never lists c1 — marks the running row idle.
test('a claude row restored from the roster survives the opencode status sweep', async () => {
  const deps = makeDeps()
  const claude = fakeBackend('claude', {}, [claudeRow('c1', 'transcript work')])
  const { lastFrame } = render(
    React.createElement(App, {
      ...deps,
      onAction: vi.fn(),
      backends: { opencode: opencodeStub(), claude },
      roster: { groupBy: 'state', sessions: [{ worktree: '/x/alpha', id: 'c1', addedAt: 1, backend: 'claude' }] },
      projectPollMs: 20,
    }),
  )
  await waitFor(() => lastFrame().includes('transcript work'))
  claude.captured.handlers.onEvent('/x/alpha', { type: 'system', subtype: 'init', session_id: 'c1' })
  await waitFor(() => lastFrame().includes('1 working')) // the header count, not the group legend
  await new Promise((r) => setTimeout(r, 120)) // several poll ticks, each sweeping /x/alpha
  expect(lastFrame()).toContain('1 working')
})

test('rows carry a backend tag only once a second backend has sessions', async () => {
  const deps = makeDeps()
  // Titled so the tag is the only place the word 'claude' can come from.
  const claude = fakeBackend('claude', {}, [claudeRow('c1', 'transcript work')])
  const { lastFrame } = render(
    React.createElement(App, {
      ...deps,
      onAction: vi.fn(),
      backends: { opencode: opencodeStub(), claude },
      initialBackend: 'claude',
      roster: {
        groupBy: 'state',
        sessions: [
          { worktree: '/x/alpha', id: 's1', addedAt: 1 },
          { worktree: '/x/alpha', id: 'c1', addedAt: 2 },
        ],
      },
    }),
  )
  await waitFor(() => lastFrame().includes('transcript work'))
  const claudeLine = lastFrame().split('\n').find((l) => l.includes('transcript work')) ?? ''
  const opencodeLine = lastFrame().split('\n').find((l) => l.includes('fix tests')) ?? ''
  expect(claudeLine).toContain('claude')
  expect(opencodeLine).toContain('opencode')
})

test('an opencode-only roster renders no backend tag at all', async () => {
  const deps = makeDeps()
  const { lastFrame } = render(
    React.createElement(App, { ...deps, onAction: vi.fn(), backends: { opencode: opencodeStub(), claude: fakeBackend('claude') } }),
  )
  await waitFor(() => lastFrame().includes('fix tests'))
  expect(lastFrame().split('\n').find((l) => l.includes('fix tests'))).not.toContain('opencode')
})

test('^r on a row whose backend cannot rename says so instead of opening the dialog', async () => {
  const deps = makeDeps()
  const claude = fakeBackend('claude', {}, [claudeRow('c1', 'claude work')])
  const { stdin, lastFrame } = render(
    React.createElement(App, {
      ...deps,
      onAction: vi.fn(),
      backends: { opencode: opencodeStub(), claude },
      initialBackend: 'claude',
      roster: { groupBy: 'state', sessions: [{ worktree: '/x/alpha', id: 'c1', addedAt: 1 }] },
    }),
  )
  await waitFor(() => lastFrame().includes('claude work'))
  stdin.write('\x12') // ^r
  await waitFor(() => lastFrame().includes("claude can't rename a session"))
  expect(lastFrame()).not.toContain('Rename:')
})

test('/fork on a row whose backend cannot fork says so instead of calling forkSession', async () => {
  const deps = makeDeps()
  deps.client.forkSession = vi.fn(() => Promise.resolve({ id: 'f1' }))
  const claude = fakeBackend('claude', {}, [claudeRow('c1', 'claude work')])
  const { stdin, lastFrame } = render(
    React.createElement(App, {
      ...deps,
      onAction: vi.fn(),
      backends: { opencode: opencodeStub(), claude },
      initialBackend: 'claude',
      roster: { groupBy: 'state', sessions: [{ worktree: '/x/alpha', id: 'c1', addedAt: 1 }] },
    }),
  )
  await waitFor(() => lastFrame().includes('claude work'))
  stdin.write('/fork')
  await tick()
  stdin.write('\r')
  await waitFor(() => lastFrame().includes("claude can't fork a session"))
  expect(deps.client.forkSession).not.toHaveBeenCalled()
})

test('^x stops a claude row through its own adapter, not the opencode client', async () => {
  const deps = makeDeps()
  const claude = fakeBackend('claude', {}, [claudeRow('c1', 'claude work')])
  const { stdin, lastFrame } = render(
    React.createElement(App, {
      ...deps,
      onAction: vi.fn(),
      backends: { opencode: opencodeStub(), claude },
      initialBackend: 'claude',
      roster: { groupBy: 'state', sessions: [{ worktree: '/x/alpha', id: 'c1', addedAt: 1 }] },
    }),
  )
  await waitFor(() => lastFrame().includes('claude work'))
  stdin.write('\x18') // ^x
  await waitFor(() => claude.abort.mock.calls.length > 0)
  expect(deps.client.abortSession).not.toHaveBeenCalled()
})

test("^x^x on a row whose backend cannot delete says so, keeps the project online, and never calls delete", async () => {
  const deps = makeDeps()
  const claude = fakeBackend('claude', {}, [claudeRow('c1', 'claude work')]) // capabilities.delete false by default
  const { stdin, lastFrame } = render(
    React.createElement(App, {
      ...deps,
      onAction: vi.fn(),
      backends: { opencode: opencodeStub(), claude },
      initialBackend: 'claude',
      roster: { groupBy: 'state', sessions: [{ worktree: '/x/alpha', id: 'c1', addedAt: 1 }] },
    }),
  )
  await waitFor(() => lastFrame().includes('claude work'))
  stdin.write('\x18') // first press: arms and stops (abort still works)
  await waitFor(() => claude.abort.mock.calls.length > 0)
  stdin.write('\x18') // second press: would delete
  await waitFor(() => lastFrame().includes("claude can't delete a session"))
  expect(claude.delete).not.toHaveBeenCalled()
  // The whole point of the gate: a backend that can't delete must not flag the project offline,
  // which would blank the opencode rows sharing the directory.
  expect(lastFrame()).not.toContain('offline')
})

test('attaching a claude row tells the host which backend to launch', async () => {
  const deps = makeDeps()
  const onAction = vi.fn(() => new Promise(() => {})) // never settles: the roster stays attached
  const claude = fakeBackend('claude', {}, [claudeRow('c1', 'claude work')])
  const { stdin, lastFrame } = render(
    React.createElement(App, {
      ...deps,
      onAction,
      backends: { opencode: opencodeStub(), claude },
      initialBackend: 'claude',
      roster: { groupBy: 'state', sessions: [{ worktree: '/x/alpha', id: 'c1', addedAt: 1 }] },
    }),
  )
  await waitFor(() => lastFrame().includes('claude work'))
  stdin.write('\r') // empty input → attach the selected row
  await waitFor(() => onAction.mock.calls.length > 0)
  expect((onAction.mock.calls as any)[0][0]).toMatchObject({ sessionId: 'c1', worktree: '/x/alpha', backend: 'claude' })
})

// --- agent-view parity: the moved-to-background notice and Esc-returns ---

test('detaching shows "Your conversation moved to the background" with that row selected, cleared by the next key', async () => {
  const deps = makeDeps()
  let detach: any
  const onAction = vi.fn((a: any) => (a.type === 'enter' ? new Promise((r) => { detach = r }) : undefined))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('\r') // empty input → attach
  await waitFor(() => lastFrame() === '')
  detach({ detached: true, sessionId: 's1', worktree: '/x/alpha' })
  await waitFor(() => lastFrame().includes('Your conversation moved to the background'))
  expect(lastFrame()).toContain('fix tests') // the roster is back, detached row underneath the notice
  // any keypress — here ↓ — dismisses the notice
  await pressUntil(stdin, '\x1B[B', () => !lastFrame().includes('Your conversation moved to the background'))
})

// Regression: row keys are namespaced by the live grouping (`state:*` by default), so selecting
// the detached row via a `${worktree}:${id}` key silently selected nothing and navigation fell
// back to the FIRST session — `→` after a detach attached the wrong session when several existed.
test('with several sessions, the detached row is the one selected afterwards', async () => {
  const deps = makeDeps()
  deps.client.listSessions = vi.fn(() => Promise.resolve([
    { id: 's1', title: 'fix tests', time: { updated: Date.now() } },
    { id: 's2', title: 'other work', time: { updated: Date.now() - 1000 } },
  ]))
  deps.roster = { groupBy: 'state', sessions: [{ worktree: '/x/alpha', id: 's1', addedAt: 1 }, { worktree: '/x/alpha', id: 's2', addedAt: 2 }] }
  let detach: any
  const onAction = vi.fn((a: any) => (a.type === 'enter' ? new Promise((r) => { detach = r }) : undefined))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction }))
  await waitFor(() => lastFrame().includes('other work'))
  stdin.write('\x1B[B') // step onto s2's row (s1 is first)
  await tick()
  stdin.write('\r')
  await waitFor(() => lastFrame() === '')
  const attachedTo = (onAction.mock.calls as any).at(-1)[0].sessionId
  detach({ detached: true, sessionId: attachedTo, worktree: '/x/alpha' })
  await waitFor(() => lastFrame().includes('moved to the background'))
  // → attaches the selected row: must be the session just left
  await pressUntil(stdin, '\x1B[C', () => onAction.mock.calls.filter((c: any) => c[0].type === 'enter').length === 2)
  expect((onAction.mock.calls as any).at(-1)[0]).toMatchObject({ type: 'enter', sessionId: attachedTo })
})

// The undo window is exactly one interaction wide: any key dismisses the backgrounded state whole,
// so an Esc AFTER that must quit like it always did, not re-open a conversation from minutes ago.
test('Esc after an intervening key exits instead of re-attaching', async () => {
  const deps = makeDeps()
  let detach: any
  const onAction = vi.fn((a: any) => (a.type === 'enter' ? new Promise((r) => { detach = r }) : undefined))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('\r')
  await waitFor(() => lastFrame() === '')
  detach({ detached: true, sessionId: 's1', worktree: '/x/alpha' })
  await waitFor(() => lastFrame().includes('moved to the background'))
  // any interaction spends the undo window
  await pressUntil(stdin, '\x1B[B', () => !lastFrame().includes('moved to the background'))
  await pressUntil(stdin, '\x1B', () => onAction.mock.calls.some((c: any) => c[0].type === 'quit'))
  expect(onAction.mock.calls.filter((c: any) => c[0].type === 'enter').length).toBe(1)
})

test('after backgrounding, the final Esc re-opens that conversation instead of exiting', async () => {
  const deps = makeDeps()
  let detach: any
  const onAction = vi.fn((a: any) => (a.type === 'enter' ? new Promise((r) => { detach = r }) : undefined))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('\r')
  await waitFor(() => lastFrame() === '')
  detach({ detached: true, sessionId: 's1', worktree: '/x/alpha' })
  await waitFor(() => lastFrame().includes('moved to the background'))
  // the Esc that would have exited; repeats are harmless — once the re-attach lands the app is
  // attached (input inactive) and further Escs go nowhere
  await pressUntil(stdin, '\x1B', () => onAction.mock.calls.filter((c: any) => c[0].type === 'enter').length === 2)
  expect(onAction).not.toHaveBeenCalledWith({ type: 'quit' })
  expect((onAction.mock.calls as any).at(-1)[0]).toMatchObject({ type: 'enter', sessionId: 's1', worktree: '/x/alpha' })
  // And the state is spent: detach again without the flag, then Esc must exit as it always did.
  detach(undefined) // plain exit, not a detach — no new backgrounded state
  await waitFor(() => lastFrame().includes('fix tests'))
  await pressUntil(stdin, '\x1B', () => onAction.mock.calls.some((c: any) => c[0].type === 'quit'))
})

// --- #34: ghost roster members (the session is gone server-side) ---

// A member whose session no longer exists used to render no row at all: the state groups partition
// `allMembers`, which only holds members whose sessions are in the store. Nothing on screen, ↑/↓
// could never land on it, ^x could never remove it, and it survived every restart.
test('#34: a member whose session is gone renders a selectable row and ^x drops the membership', async () => {
  const deps = makeDeps()
  deps.roster = { groupBy: 'state', sessions: [{ worktree: '/x/alpha', id: 'g1', addedAt: 1, prompt: 'phantom dispatch' }] }
  deps.client.listSessions = vi.fn(() => Promise.resolve([])) // seeds successfully, and the session is not there
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  // The stored prompt stands in for the title, behind the `∙` "nothing is behind this" glyph.
  await waitFor(() => lastFrame().includes('∙ phantom dispatch'))
  // Under `completed` — the section for rows nothing more is going to happen to. Compared by line
  // order rather than sectionBody, whose first `completed` match is the header's count line.
  const lines = lastFrame().split('\n')
  expect(lines.findIndex((l) => l.includes('phantom dispatch'))).toBeGreaterThan(
    lines.findIndex((l) => l.trim() === 'completed'),
  )
  stdin.write('\x18') // one press: there is no server call to confirm, only a membership to drop
  await waitFor(() => !lastFrame().includes('phantom dispatch'))
  expect(deps.persistRoster).toHaveBeenCalledWith(expect.objectContaining({ sessions: [] }))
  // Nothing was asked of the server: there is no session to abort, delete, or clean a worktree for.
  expect(deps.client.abortSession).not.toHaveBeenCalled()
  expect(deps.client.deleteSession).not.toHaveBeenCalled()
})

// F1's offline protection is load-bearing and the ghost row must not weaken it: a project whose
// stream is down has members that are coming back, and eating them on a dropped connection would
// be far worse than the bug being fixed.
test('#34: a member of an OFFLINE project is not treated as a ghost', async () => {
  const deps = makeDeps()
  deps.roster = { groupBy: 'state', sessions: [{ worktree: '/x/alpha', id: 'g1', addedAt: 1, prompt: 'phantom dispatch' }] }
  deps.client.listSessions = vi.fn(() => Promise.resolve([]))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('phantom dispatch'))
  // The project's stream drops. The member is now indistinguishable from one that is merely
  // unreachable, so the ghost row goes away rather than offering to delete a live membership.
  deps.connectEventsImpl.mock.calls[0][1].onOffline('/x/alpha')
  await waitFor(() => !lastFrame().includes('phantom dispatch'))
  // And ^x with nothing selected must not have removed it behind the scenes either.
  stdin.write('\x18')
  await tick()
  expect(deps.persistRoster).not.toHaveBeenCalled()
})

// --- #43: the residual half of #34 — the worktree itself is gone, not just the session ---

// #34's qualification requires the member's worktree to have listed successfully this run, which a
// DELETED per-session worktree never does: it is in no project record, so seedAndStream is never
// called for it. Its members rendered nothing anywhere, could not be selected, could not be
// removed, and survived every restart (there was a live one in John's own roster.json).
test('#43: a member whose worktree is in no project record renders a ghost row and ^x drops it', async () => {
  const deps = makeDeps()
  deps.roster = {
    groupBy: 'state',
    sessions: [{ worktree: '/wt/alpha/deleted', id: 'v1', addedAt: 1, prompt: 'dispatch into a deleted worktree' }],
  }
  // listProjects only ever answers with /x/alpha, so /wt/alpha/deleted is never seeded at all.
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('∙ dispatch into a deleted worktree'))
  expect(deps.client.listSessions).not.toHaveBeenCalledWith('/wt/alpha/deleted')
  // The only row on screen, so it is the selection; one press, because there is nothing behind it
  // to confirm a delete against.
  stdin.write('\x18')
  await waitFor(() => !lastFrame().includes('dispatch into a deleted worktree'))
  expect(deps.persistRoster).toHaveBeenCalledWith(expect.objectContaining({ sessions: [] }))
  expect(deps.client.deleteSession).not.toHaveBeenCalled()
})

// The new arm must not weaken F1 either: offline is still "unreachable", never "gone".
test('#43: a member of an OFFLINE project is not ghosted by the no-project-record arm', async () => {
  const deps = makeDeps()
  deps.roster = {
    groupBy: 'state',
    sessions: [{ worktree: '/wt/alpha/deleted', id: 'v1', addedAt: 1, prompt: 'dispatch into a deleted worktree' }],
  }
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('dispatch into a deleted worktree'))
  // onOffline is keyed by directory, so a flag can land on this worktree however it was reached.
  // Once it does, the member is merely unreachable again and the exit is withdrawn rather than
  // offering to delete a membership that is coming back.
  deps.connectEventsImpl.mock.calls[0][1].onOffline('/wt/alpha/deleted')
  await waitFor(() => !lastFrame().includes('dispatch into a deleted worktree'))
  stdin.write('\x18')
  await tick()
  expect(deps.persistRoster).not.toHaveBeenCalled()
})

// The projects poll is the evidence, so with no successful round there is no ghost: a server that
// never answers must leave every membership exactly where it is.
test('#43: no member is ghosted before a successful listProjects round', async () => {
  const deps = makeDeps()
  deps.roster = {
    groupBy: 'state',
    sessions: [{ worktree: '/wt/alpha/deleted', id: 'v1', addedAt: 1, prompt: 'dispatch into a deleted worktree' }],
  }
  deps.client.listProjects = vi.fn(() => Promise.reject(new Error('down')))
  const { lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.client.listProjects.mock.calls.length > 0)
  await tick()
  expect(lastFrame()).not.toContain('dispatch into a deleted worktree')
})

// The just-dispatched window: a worktree minted moments ago is legitimately in no project record
// yet, and ghosting its brand-new member would be a far worse bug than the one being fixed. The
// guard is that the dispatch hands the worktree to seedAndStream (knownWorktrees) before the
// session — and so the membership — exists at all.
test('#43: a session dispatched into a not-yet-published worktree is never ghosted', async () => {
  const { deps, wt } = isolatingDeps()
  // The repository alone: the worktree createWorktree just minted is not a project row yet, which
  // is exactly the state every dispatch leaves behind for up to one poll interval.
  deps.client.listProjects = vi.fn(() => Promise.resolve([{ ...project, sandboxes: [] }]))
  deps.projectPollMs = 30 // several polls run inside this test, all of them without the worktree
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('fix the thing')
  await tick()
  stdin.write('\r')
  await waitFor(() => deps.client.promptAsync.mock.calls.length > 0)
  expect(deps.client.createSession).toHaveBeenCalledWith(expect.anything(), wt)
  await waitFor(() => lastFrame().includes('in the worktree'))
  await new Promise((r) => setTimeout(r, 100)) // let a few poll ticks go by without it
  // A live row, not the `∙` glyph the ghost synthesises, and not the stored prompt standing in for
  // a title — the session behind it is real and streaming.
  expect(lastFrame()).toContain('in the worktree')
  expect(lastFrame()).not.toContain('∙ fix the thing')
})

// --- #35: space on a group header ---

// The peek branch requires a selected session; on a header there is none, so the space used to
// fall through to the text handler and silently type a leading space into the dispatch input.
test('#35: space on a selected header collapses it instead of typing into the input', async () => {
  const deps = makeDeps()
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('\x1B[A') // up from the only session row onto its `completed` header
  await waitFor(() => lastFrame().includes('▾ expanded'))
  stdin.write(' ')
  // Collapsed, which is only reachable if the space was read as the header verb.
  await waitFor(() => lastFrame().includes('▸ collapsed'))
  expect(lastFrame()).not.toContain('fix tests')
  // The input is still empty: Enter on a header with an empty input toggles the collapse back. A
  // space that had landed in the input would have made this a dispatch instead.
  stdin.write('\r')
  await waitFor(() => lastFrame().includes('fix tests'))
  expect(deps.client.createSession).not.toHaveBeenCalled()
})

// The other half of the strict qualification: a project whose worktree has never been listed
// successfully this run can't tell "gone" from "never seen", so its members stay put too.
test('#34: a member of a project that never seeded is not treated as a ghost', async () => {
  const deps = makeDeps()
  deps.roster = { groupBy: 'state', sessions: [{ worktree: '/x/alpha', id: 'g1', addedAt: 1, prompt: 'phantom dispatch' }] }
  deps.client.listSessions = vi.fn(() => Promise.reject(new Error('down')))
  const { lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.client.listSessions.mock.calls.length > 0)
  await tick()
  expect(lastFrame()).not.toContain('phantom dispatch')
})

// --- #49 / #60 / #59 / #47: the selection must survive the fold, and the roster must not act on
// bytes it has no business reading ---

// ink-testing-library's stdout reports 100 columns and no rows, so App falls back to whatever the
// runner's terminal is. Defining `rows` and emitting `resize` is what drives useWindowSize — the
// only way to make `maxRows` (and therefore the fold) deterministic from a test.
const setRows = (stdout: any, rows: number) => {
  Object.defineProperty(stdout, 'rows', { value: rows, configurable: true })
  stdout.emit('resize')
}

// #49: `navRows` is built from the *rendered* groups, so a completed row folded into `… N more`
// was in neither the key lookup nor the identity re-resolution added for #18 — the selection
// silently fell back to the first session on screen (a running one) and the next key acted on
// that. The first ^x is not gated by the two-press arm, so it aborted a session the user never
// selected. One row less of terminal is all it takes.
test('#49: a selected completed row that would fold away stays selected, and ^x targets it', async () => {
  const deps = makeDeps()
  const now = Date.now()
  deps.client.listSessions = vi.fn(() =>
    Promise.resolve([
      ...Array.from({ length: 3 }, (_, i) => ({ id: `r${i}`, title: `running job ${i}`, time: { updated: now - i } })),
      ...Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, title: `finished job ${i}`, time: { updated: now - 1000 - i * 10 } })),
    ]),
  )
  deps.roster = {
    groupBy: 'state',
    sessions: [
      ...Array.from({ length: 3 }, (_, i) => ({ worktree: '/x/alpha', id: `r${i}`, addedAt: i })),
      ...Array.from({ length: 6 }, (_, i) => ({ worktree: '/x/alpha', id: `c${i}`, addedAt: 10 + i })),
    ],
  }
  const { stdin, lastFrame, stdout } = render(React.createElement(App, { ...deps, onAction: vi.fn() })) as any
  await tick() // let useWindowSize's resize listener mount before driving the terminal size
  setRows(stdout, 40) // roomy: nothing folds yet
  await waitFor(() => lastFrame().includes('finished job 5'))
  const onEvent = deps.connectEventsImpl.mock.calls[0][1].onEvent
  for (let i = 0; i < 3; i++) onEvent('/x/alpha', { type: 'session.status', properties: { sessionID: `r${i}`, status: { type: 'busy' } } })
  // sectionBody() can't be used here: the header summary line also contains every category word.
  const sectionOf = (title: string) => {
    const lines: string[] = lastFrame().split('\n')
    const row = lines.findIndex((l) => l.includes(title))
    const headers = lines.map((l, i) => [l.trim(), i] as const).filter(([l]) => STATE_HEADERS.includes(l))
    return headers.filter(([, i]) => i < row).at(-1)?.[0]
  }
  await waitFor(() => sectionOf('running job 0') === 'working' && sectionOf('finished job 5') === 'completed')
  // ↓ clamps at the last nav row, which is the oldest completed session — no need to count rows or
  // read the highlight out of the ANSI. Extra presses are idempotent at the clamp.
  for (let i = 0; i < 20; i++) {
    stdin.write('\x1B[B')
    await tick()
  }
  // Shrink one row at a time until the list first stops fitting, rather than computing chromeRows
  // here — that arithmetic is the thing under test, not the test's job to reproduce.
  const allShown = () => Array.from({ length: 6 }, (_, i) => `finished job ${i}`).every((t) => lastFrame().includes(t))
  for (let rows = 40; rows > 8 && allShown(); rows--) {
    setRows(stdout, rows - 1)
    await tick()
  }
  expect(allShown()).toBe(false) // a completed row no longer fits
  expect(lastFrame()).toContain('finished job 5') // ...and it is not the selected one
  expect(lastFrame()).toMatch(/… \d+ more/) // the row that went is folded away, not scrolled off
  await pressUntil(stdin, '\x18', () => deps.client.abortSession.mock.calls.length > 0)
  expect(deps.client.abortSession).toHaveBeenCalledWith('c5', '/x/alpha')
}, 20000)

// #60: Ink 7 turns one stdin read into several key events and dispatches them all in a single
// synchronous pass, but `isActive: false` only lands on the next render — so `→` and `^X` typed
// fast enough to coalesce (key repeat, paste, or a render stalling the loop) both reached the
// roster and the ^X stopped the very row being attached to.
test('#60: → and ^X in one stdin read attach the row without aborting it', async () => {
  const deps = makeDeps()
  const onAction = vi.fn((a: any) => (a.type === 'enter' ? new Promise(() => {}) : undefined))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction }))
  await waitFor(() => lastFrame().includes('fix tests'))
  // One write, two keys. Retried because Node can drop a stdin chunk wholesale (see pressUntil) —
  // a dropped chunk delivers neither key, so the retry cannot mask the bug.
  await pressUntil(stdin, '\x1B[C\x18', () => onAction.mock.calls.some((c: any) => c[0].type === 'enter'))
  await tick()
  expect(deps.client.abortSession).not.toHaveBeenCalled()
  expect(onAction.mock.calls.filter((c: any) => c[0].type === 'enter')).toHaveLength(1)
})

// #59: `if (backgrounded) setBackgrounded(null)` ran before every other branch, so any byte in the
// post-resume quiet window — a fragment of the child's terminal-query answers, a mouse report —
// destroyed the Esc-undo. Unlike clearing the input, that one is not recoverable.
//
// RESUME_QUIET_MS is 50ms of real time and Ink's re-render after a detach occasionally takes
// longer than that on a loaded machine, so the attach/detach is retried until one press really
// lands inside the window. Retrying can only make the assertion easier to fail, never to pass.
test('#59: a byte inside the post-resume quiet window does not dismiss the background notice', async () => {
  const deps = makeDeps()
  let detach: any
  const onAction = vi.fn((a: any) => (a.type === 'enter' ? new Promise((r) => { detach = r }) : undefined))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction }))
  await waitFor(() => lastFrame().includes('fix tests'))
  const gone = () => !lastFrame().includes('moved to the background')
  let landed = false
  for (let attempt = 0; attempt < 8 && !landed; attempt++) {
    await pressUntil(stdin, '\r', () => Boolean(detach)) // empty input → attach
    await waitFor(() => lastFrame() === '')
    const settle = detach
    detach = undefined
    const resumed = Date.now()
    settle({ detached: true, sessionId: 's1', worktree: '/x/alpha' })
    await waitFor(() => !gone(), 3000, 1)
    if (Date.now() - resumed >= 40) {
      await pressUntil(stdin, '\x1B[B', gone) // missed the window — spend the notice and retry
      continue
    }
    // A storm of presses, not one: Node can drop the first stdin chunk written after a detach
    // re-activates useInput (see pressUntil), and a dropped byte would pass this test on the
    // unfixed code by never reaching the handler at all.
    while (Date.now() - resumed < 45) {
      stdin.write('\x1B[B')
      await new Promise((r) => setTimeout(r, 2))
    }
    expect(lastFrame()).toContain('moved to the background')
    landed = true
    // Once the window has lapsed the notice dismisses exactly as it always did.
    await pressUntil(stdin, '\x1B[B', gone)
  }
  expect(landed, 'no press landed inside the quiet window').toBe(true)
}, 30000)

// #47: ^G hands the terminal to $EDITOR through a blocking spawnSync, so Ink never suspends and
// never drains — bytes the editor leaves unread arrive as roster keystrokes. A bare ESC among them
// hit `if (!empty) return setInput('')` and wiped the prompt that had just been edited, after the
// temp file backing it was already deleted. The quiet-window guard now covers the whole branch.
test('#47: Escape inside the post-resume quiet window does not clear the just-edited prompt', async () => {
  const deps = makeDeps()
  let finishEdit: any
  const onAction = vi.fn((a: any) => (a.type === 'edit' ? new Promise((r) => { finishEdit = r }) : undefined))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction }))
  await waitFor(() => lastFrame().includes('fix tests'))
  const cleared = () => !lastFrame().includes('edited prompt text')
  let landed = false
  for (let attempt = 0; attempt < 8 && !landed; attempt++) {
    await pressUntil(stdin, '\x07', () => Boolean(finishEdit)) // ^G
    const settle = finishEdit
    finishEdit = undefined
    const resumed = Date.now()
    settle('edited prompt text')
    await waitFor(() => !cleared(), 3000, 1)
    if (Date.now() - resumed >= 40) {
      await pressUntil(stdin, '\x1B', cleared) // missed the window — clear it and retry
      continue
    }
    // A storm of presses, not one: Node can drop the first stdin chunk written after the editor
    // hand-back re-activates useInput (see pressUntil), and a dropped byte would pass this test on
    // the unfixed code by never reaching the handler at all.
    while (Date.now() - resumed < 45) {
      stdin.write('\x1B')
      await new Promise((r) => setTimeout(r, 2))
    }
    expect(lastFrame()).toContain('edited prompt text')
    landed = true
  }
  expect(landed, 'no press landed inside the quiet window').toBe(true)
  expect(onAction).not.toHaveBeenCalledWith({ type: 'quit' })
  // And after the window a typed Escape clears it, so the guard is a delay and not a new dead key.
  await pressUntil(stdin, '\x1B', cleared)
}, 30000)

// --- #44: a `fleetview bg` dispatch from another terminal must reach an already-running TUI ---

// The TUI reads roster.json once at mount and holds membership in React state from then on, so a
// bg append was invisible until restart — the session streamed fine in browse, the member row just
// never appeared. These drive the real makePersistRoster over a real file, because `reload` and the
// merge-on-write are two halves of the same contract.
const rosterFileDeps = (sessions: any[]) => {
  const deps = makeDeps()
  const dir = mkdtempSync(join(tmpdir(), 'fleetview-roster-'))
  const file = join(dir, 'roster.json')
  const initial = { groupBy: 'state' as const, sessions, collapsed: [] }
  writeFileSync(file, JSON.stringify(initial, null, 2))
  deps.roster = initial
  deps.persistRoster = makePersistRoster({ roster: initial, file })
  deps.projectPollMs = 30 // the sync rides the projects poll; this test should not wait 30s for it
  deps.client.listSessions = vi.fn(() =>
    Promise.resolve([
      { id: 's1', title: 'fix tests', time: { updated: Date.now() } },
      { id: 'bg1', title: 'bg dispatch', time: { updated: Date.now() } },
    ]),
  )
  const writeExternally = (next: any[]) =>
    writeFileSync(file, JSON.stringify({ ...initial, sessions: next }, null, 2))
  return { deps, file, writeExternally }
}

test('#44: a member appended to roster.json externally appears on the next poll tick', async () => {
  const { deps, writeExternally } = rosterFileDeps([{ worktree: '/x/alpha', id: 's1', addedAt: 1, pinned: true, rank: 3 }])
  const { lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  // bg1's session is in the store and streaming; it is only the membership that is missing.
  expect(lastFrame()).not.toContain('bg dispatch')
  writeExternally([
    { worktree: '/x/alpha', id: 's1', addedAt: 1, pinned: true, rank: 3 },
    { worktree: '/x/alpha', id: 'bg1', addedAt: 2, prompt: 'from another terminal' },
  ])
  await waitFor(() => lastFrame().includes('bg dispatch'))
  // And the union did not overwrite what this instance holds: s1 is still pinned (its own group,
  // above the status sections), which the on-disk copy would have had to be re-read to lose.
  const lines = lastFrame().split('\n')
  expect(lines.findIndex((l) => l.includes('fix tests'))).toBeGreaterThan(
    lines.findIndex((l) => l.trim() === 'pinned'),
  )
})

// The other half, and the reason removals are not synced: two instances would fight over deletes,
// and one terminal's ^x would silently eat a membership the other is still using.
test('#44: a member REMOVED from roster.json externally stays in the running TUI', async () => {
  const { deps, writeExternally } = rosterFileDeps([{ worktree: '/x/alpha', id: 's1', addedAt: 1 }])
  const { lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  // First prove the sync is live at all, so the assertion below cannot pass by doing nothing.
  writeExternally([
    { worktree: '/x/alpha', id: 's1', addedAt: 1 },
    { worktree: '/x/alpha', id: 'bg1', addedAt: 2 },
  ])
  await waitFor(() => lastFrame().includes('bg dispatch'))
  // Now the other instance drops both. Neither row may leave this one.
  writeExternally([])
  await new Promise((r) => setTimeout(r, 150)) // several poll ticks
  expect(lastFrame()).toContain('fix tests')
  expect(lastFrame()).toContain('bg dispatch')
})
