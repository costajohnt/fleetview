import React from 'react'
import { test, expect, vi, afterEach } from 'vitest'
import { render as inkRender } from 'ink-testing-library'
import { parseMouseEvents, MOUSE_ON, MOUSE_OFF } from '../src/ui/mouse.ts'
import { gatedStdout } from '../src/gated-stdout.ts'
import { App } from '../src/app.ts'

test('parseMouseEvents reads SGR press, release, and wheel — with or without the ESC byte', () => {
  expect(parseMouseEvents('\x1b[<0;12;5M')).toEqual([{ button: 0, x: 12, y: 5, kind: 'press' }])
  expect(parseMouseEvents('[<0;12;5m')).toEqual([{ button: 0, x: 12, y: 5, kind: 'release' }])
  expect(parseMouseEvents('[<64;1;1M')).toEqual([{ button: 64, x: 1, y: 1, kind: 'wheel-up' }])
  expect(parseMouseEvents('[<65;1;1M')).toEqual([{ button: 65, x: 1, y: 1, kind: 'wheel-down' }])
  // several events in one stdin chunk, in order
  expect(parseMouseEvents('[<65;1;1M[<65;1;2M').map((e) => e.y)).toEqual([1, 2])
  expect(parseMouseEvents('plain typing')).toEqual([])
  expect(parseMouseEvents('')).toEqual([])
})

test('gatedStdout with mouse: on at creation, off when the gate closes, on again when it reopens', () => {
  const writes: any[] = []
  const target = { write: (c: any) => (writes.push(c), true), isTTY: true, columns: 80, rows: 24 }
  const gate = gatedStdout(target as any, { mouse: true })
  expect(writes).toEqual([MOUSE_ON])
  gate.close()
  expect(writes).toEqual([MOUSE_ON, MOUSE_OFF])
  gate.open()
  expect(writes).toEqual([MOUSE_ON, MOUSE_OFF, MOUSE_ON])
  gate.dispose!()
  expect(writes.at(-1)).toBe(MOUSE_OFF)
})

test('gatedStdout without mouse never writes control sequences', () => {
  const writes: any[] = []
  const target = { write: (c: any) => (writes.push(c), true), isTTY: true, columns: 80, rows: 24 }
  const gate = gatedStdout(target as any)
  gate.close()
  gate.open()
  gate.dispose!()
  expect(writes).toEqual([])
})

// --- clicks against the real App ---

const live: any[] = []
const stripAnsi = (s: any) => s.replace(/\x1b\[[0-9;]*m/g, '')
const render = (...args: any[]) => {
  const instance = (inkRender as any)(...args)
  live.push(instance)
  return { ...instance, lastFrame: () => stripAnsi(instance.lastFrame() ?? '') }
}
afterEach(() => {
  for (const instance of live.splice(0)) instance.unmount()
})

const server = { host: '127.0.0.1', port: 4900 }
const project = { id: 'a-1', worktree: '/x/alpha', vcs: 'git', time: { created: 1, updated: 1000 } }
const waitFor = async (fn: any, timeoutMs = 3000) => {
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
    listSessions: vi.fn(() =>
      Promise.resolve([
        { id: 's1', title: 'fix tests', time: { updated: 2 } },
        { id: 's2', title: 'other work', time: { updated: 1 } },
      ]),
    ),
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
    roster: {
      groupBy: 'state',
      sessions: [
        { worktree: '/x/alpha', id: 's1', addedAt: 1 },
        { worktree: '/x/alpha', id: 's2', addedAt: 2 },
      ],
      collapsed: [],
    },
    persistRoster: vi.fn(),
  }
}

// The state-grouped screen these tests click on (header block is rows 1-3):
//  4  needs input      ← header
//  5    no items
//  6                   ← spacer
//  7  working          ← header
//  8    no items
//  9                   ← spacer
// 10  completed        ← header
// 11  ✳ fix tests      ← session s1 (selected at start)
// 12  ✳ other work     ← session s2
const rowOf = (lastFrame: any, text: any) => lastFrame().split('\n').findIndex((l: any) => l.includes(text)) + 1

test('a click on a session row launches it', async () => {
  const deps = makeDeps()
  const onAction = vi.fn()
  const { lastFrame, stdin } = render(React.createElement(App as any, { ...deps, onAction }))
  await waitFor(() => lastFrame().includes('other work'))

  // One click = select AND attach (no select-then-click-again dance).
  stdin.write(`\x1b[<0;5;${rowOf(lastFrame, 'other work')}M`) // click s2
  await waitFor(() => onAction.mock.calls.some((c) => c[0].type === 'enter' && c[0].sessionId === 's2'))
})

test('the wheel moves the selection without launching anything', async () => {
  const deps = makeDeps()
  const onAction = vi.fn()
  const { lastFrame, stdin } = render(React.createElement(App as any, { ...deps, onAction }))
  await waitFor(() => lastFrame().includes('other work'))

  stdin.write('\x1b[<65;1;1M') // wheel down → selection moves from s1 to s2
  await new Promise((r) => setTimeout(r, 30))
  expect(onAction.mock.calls.some((c) => c[0].type === 'enter')).toBe(false) // the wheel never launches
  stdin.write('\r') // ⏎ on the empty input attaches the selection — proving the wheel moved it
  await waitFor(() => onAction.mock.calls.some((c) => c[0].type === 'enter' && c[0].sessionId === 's2'))
})

test('a click on the selected row attaches it', async () => {
  const deps = makeDeps()
  const onAction = vi.fn()
  const { lastFrame, stdin } = render(React.createElement(App as any, { ...deps, onAction }))
  await waitFor(() => lastFrame().includes('fix tests'))

  const row = rowOf(lastFrame, 'fix tests') // s1 is already selected (first-session fallback)
  stdin.write(`\x1b[<0;5;${row}M`)
  await waitFor(() => onAction.mock.calls.some((c) => c[0].type === 'enter'))
})

test('a click on a group header collapses it, and clicks are never typed into the input', async () => {
  const deps = makeDeps()
  const { lastFrame, stdin } = render(React.createElement(App as any, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))

  // trim-exact: the header summary row also contains the word "completed"
  const headerRow = lastFrame().split('\n').findIndex((l: any) => l.trim() === 'completed') + 1
  stdin.write(`\x1b[<0;5;${headerRow}M`)
  await waitFor(() => lastFrame().split('\n').some((l: any) => l.includes('completed (2)') && l.includes('▸ collapsed')))
  expect(lastFrame()).not.toContain('fix tests')
  expect(lastFrame()).toContain('describe a task') // input untouched — no [<0;… garbage typed
})
