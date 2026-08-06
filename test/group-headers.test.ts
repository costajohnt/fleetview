import React from 'react'
import { test, expect, vi, afterEach } from 'vitest'
import { render as inkRender } from 'ink-testing-library'
import { App } from '../src/app.ts'

// Group headers are rows you can land on. That is what makes "Enter on a group header collapses it"
// and "Ctrl+X on a group header deletes every session in the group (confirmation required)"
// possible at all — before this, ↑/↓ walked sessions only and a header was decoration.

const live: any[] = []
// Strip ANSI color codes from frames: rows and headers carry color and the selection bar, so a
// raw frame never contains the contiguous plain strings these tests match on.
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
const render = (...args: Parameters<typeof inkRender>) => {
  const instance = inkRender(...args)
  live.push(instance)
  return { ...instance, lastFrame: () => stripAnsi(instance.lastFrame() ?? '') }
}
afterEach(() => {
  for (const instance of live.splice(0)) instance.unmount()
})

const UP = '\x1B[A'
const RIGHT = '\x1B[C'
const CTRL_X = '\x18'
const server = { host: '127.0.0.1', port: 4900 }
const project = { id: 'a-1', worktree: '/x/alpha', vcs: 'git', time: { created: 1, updated: 1000 } }

const tick = () => new Promise((r) => setTimeout(r, 20))
const waitFor = async (fn: () => boolean, timeoutMs = 3000) => {
  const start = Date.now()
  for (;;) {
    if (fn()) return
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

function makeDeps() {
  const client = {
    listProjects: vi.fn(() => Promise.resolve([project])),
    listSessions: vi.fn(() => Promise.resolve([{ id: 's1', title: 'fix tests', time: { updated: Date.now() } }])),
    createSession: vi.fn(() => Promise.resolve({ id: 's9' })),
    promptAsync: vi.fn(() => Promise.resolve({})),
    deleteSession: vi.fn(() => Promise.resolve({})),
    abortSession: vi.fn(() => Promise.resolve({})),
    listMessages: vi.fn(() => Promise.resolve([])),
    sessionStatus: vi.fn(() => Promise.resolve({})),
    listPermissions: vi.fn(() => Promise.resolve([])),
    listQuestions: vi.fn(() => Promise.resolve([])),
  }
  return {
    server,
    client,
    connectEventsImpl: vi.fn(() => ({ done: Promise.resolve(), stop: vi.fn() })),
    ensureServerImpl: vi.fn(() => Promise.resolve({ ok: true, server })),
    serverReady: true,
    roster: { groupBy: 'state', sessions: [{ worktree: '/x/alpha', id: 's1', addedAt: 1 }], collapsed: [] as string[] },
    persistRoster: vi.fn(),
    // Dispatch refuses a target directory that is gone (#22); this fixture's path is not on disk.
    dirExistsImpl: () => true,
  }
}

test('↑ from the first session lands on its header, and ⏎ collapses the group', async () => {
  const deps = makeDeps()
  const { lastFrame, stdin } = render(React.createElement(App as any, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  expect(lastFrame()).not.toContain('▸ collapsed') // open — a collapsed header would say so at the right edge

  stdin.write(UP)
  await waitFor(() => lastFrame().includes('▾ expanded')) // the selected expanded header says so at its right edge

  stdin.write('\r')
  await waitFor(() => lastFrame().split('\n').some((l: string) => l.includes('completed') && l.includes('▸ collapsed')))
  expect(lastFrame()).not.toContain('fix tests') // sessions folded away
  expect(lastFrame()).toContain('(1)') // header still says how many
  expect(deps.persistRoster).toHaveBeenCalledWith(expect.objectContaining({ collapsed: ['state:completed'] }))

  stdin.write('\r')
  await waitFor(() => lastFrame().includes('fix tests')) // and back
})

// Text in the prompt means the user is dispatching; the highlighted row is incidental.
test('⏎ on a header with text in the input still dispatches', async () => {
  const deps = makeDeps()
  const { lastFrame, stdin } = render(React.createElement(App as any, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write(UP)
  await waitFor(() => lastFrame().includes('▾ expanded')) // the selected expanded header says so at its right edge
  stdin.write('do a thing')
  await tick()
  stdin.write('\r')
  await waitFor(() => deps.client.createSession.mock.calls.length > 0)
  expect(lastFrame()).not.toContain('▸ collapsed') // not collapsed
})

test('a collapsed group is restored from roster.json on the next run', async () => {
  const deps = makeDeps()
  deps.roster = { ...deps.roster, collapsed: ['state:completed'] }
  const { lastFrame } = render(React.createElement(App as any, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().split('\n').some((l: string) => l.includes('completed') && l.includes('▸ collapsed')))
  expect(lastFrame()).not.toContain('fix tests')
})

test('^x on a header asks first, then deletes every session in the group', async () => {
  const deps = makeDeps()
  deps.client.listSessions = vi.fn(() =>
    Promise.resolve([
      { id: 's1', title: 'fix tests', time: { updated: 2 } },
      { id: 's2', title: 'other work', time: { updated: 1 } },
    ]),
  )
  deps.roster = {
    groupBy: 'state',
    sessions: [
      { worktree: '/x/alpha', id: 's1', addedAt: 1 },
      { worktree: '/x/alpha', id: 's2', addedAt: 2 },
    ],
    collapsed: [],
  }
  const { lastFrame, stdin } = render(React.createElement(App as any, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('other work'))
  stdin.write(UP)
  await waitFor(() => lastFrame().includes('▾ expanded')) // the selected expanded header says so at its right edge

  stdin.write(CTRL_X) // arms, deletes nothing
  await waitFor(() => lastFrame().includes('^x again to delete 2 sessions'))
  expect(deps.client.deleteSession).not.toHaveBeenCalled()

  stdin.write(CTRL_X)
  await waitFor(() => deps.client.deleteSession.mock.calls.length === 2)
  expect(deps.client.deleteSession.mock.calls.map((c) => (c as any)[0]).sort()).toEqual(['s1', 's2'])
})

test('a header ^x that is not confirmed within the window deletes nothing', async () => {
  const deps = makeDeps()
  const { lastFrame, stdin } = render(React.createElement(App as any, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write(UP)
  await waitFor(() => lastFrame().includes('▾ expanded')) // the selected expanded header says so at its right edge
  stdin.write(CTRL_X)
  await waitFor(() => lastFrame().includes('^x again to delete'))
  await new Promise((r) => setTimeout(r, 2100)) // the arm expires
  stdin.write(CTRL_X)
  await tick()
  expect(deps.client.deleteSession).not.toHaveBeenCalled()
})

// Row actions must not fire while a header is highlighted — there is no session to act on.
test('row keys do nothing while a group header is selected', async () => {
  const deps = makeDeps()
  const onAction = vi.fn()
  const { lastFrame, stdin } = render(React.createElement(App as any, { ...deps, onAction }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write(UP)
  await waitFor(() => lastFrame().includes('▾ expanded')) // the selected expanded header says so at its right edge
  stdin.write(' ') // peek
  await tick()
  expect(lastFrame()).not.toContain('reply · ! runs a shell command')
  stdin.write(RIGHT) // attach
  await tick()
  expect(onAction).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'enter' }))
})
