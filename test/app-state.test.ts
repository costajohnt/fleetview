// Audit 2026-10-29 fixes in App's state handling (M13, M14 and the app-side Lows). A separate file so
// these don't collide with app.test.ts's timing rework.
import React from 'react'
import { test, expect, vi, afterEach } from 'vitest'
import { waitFor } from './helpers.ts'
import { render as inkRender } from 'ink-testing-library'
import { App } from '../src/app.ts'
import { foldCompleted } from '../src/state-groups.ts'
import { SHELL_JOB_TTL_MS } from '../src/use-shell-job-expiry.ts'
import { createOpencodeBackend } from '../src/backends/opencode/index.ts'

const live: any[] = []
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
const render = (el: any) => {
  const instance = (inkRender as any)(el)
  live.push(instance)
  return { stdin: instance.stdin, lastFrame: () => stripAnsi(instance.lastFrame() ?? '') }
}
afterEach(() => {
  for (const instance of live.splice(0)) instance.unmount()
})

const server = { host: '127.0.0.1', port: 4900 }
const project = { id: 'a-1', worktree: '/x/alpha', vcs: 'git', time: { created: 1, updated: 1000 } }

function makeDeps(): any {
  const client = {
    listProjects: vi.fn(() => Promise.resolve([project])),
    listSessions: vi.fn(() => Promise.resolve([{ id: 's1', title: 'fix tests', time: { updated: Date.now() } }])),
    createSession: vi.fn(() => Promise.resolve({ id: 's9' })),
    promptAsync: vi.fn(() => Promise.resolve({})),
    renameSession: vi.fn(() => Promise.resolve({})),
    deleteSession: vi.fn(() => Promise.resolve({})),
    forkSession: vi.fn(() => Promise.resolve({ id: 'forked-123456789' })),
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
    roster: { groupBy: 'state', sessions: [{ worktree: '/x/alpha', id: 's1', addedAt: 1 }], collapsed: [] },
    persistRoster: vi.fn(),
    dirExistsImpl: () => true,
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const typeText = async (stdin: any, text: string) => {
  for (const ch of text) {
    stdin.write(ch)
    await sleep(5)
  }
}

// M13: a failed delete re-renders (the rollback), which re-ran the cleanup effect immediately.
test('a shell job whose TTL delete keeps failing is not retried in a tight loop', async () => {
  const deps = makeDeps()
  deps.roster.sessions = [{ worktree: '/x/alpha', id: 's1', addedAt: 1, shell: true }]
  deps.client.listSessions = vi.fn(() => Promise.resolve([{ id: 's1', title: 'ls', time: { updated: Date.now() - SHELL_JOB_TTL_MS - 1000 } }]))
  deps.client.deleteSession = vi.fn(() => Promise.reject(new Error('down')))
  render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => deps.client.deleteSession.mock.calls.length > 0)
  await sleep(300)
  expect(deps.client.deleteSession).toHaveBeenCalledTimes(1)
})

// M14: {aborted:false} means nothing was signalled, so the row must not be labelled stopped.
test('^x on a run the backend could not abort says so and does not mark it stopped', async () => {
  const deps = makeDeps()
  const opencode = { ...createOpencodeBackend({ server, client: deps.client }), abort: vi.fn(async () => ({ aborted: false })) }
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, backends: { opencode }, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('\x18')
  await waitFor(() => lastFrame().includes('nothing running to stop'))
  expect(opencode.abort).toHaveBeenCalled()
  expect(lastFrame()).not.toContain('stopped "fix tests"')
})

// A server that answers the rename with an HTTP refusal is online; only unreachability is "offline".
test('a refused rename flashes and does not flag the project offline', async () => {
  const deps = makeDeps()
  deps.client.renameSession = vi.fn(() => Promise.reject(Object.assign(new Error('PATCH /session/s1 → 400: bad'), { status: 400 })))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write('\x12')
  await sleep(30)
  stdin.write(' v2')
  await sleep(30)
  stdin.write('\r')
  await waitFor(() => lastFrame().includes("couldn't rename"))
  stdin.write('\x02') // browse shows the offline flag on the project header
  await sleep(100)
  expect(lastFrame()).not.toContain('offline')
})

test('a fork whose prompt fails says the fork exists rather than "couldn\'t fork"', async () => {
  const deps = makeDeps()
  deps.client.promptAsync = vi.fn(() => Promise.reject(new Error('down')))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  await typeText(stdin, '/fork keep going')
  stdin.write('\r')
  await waitFor(() => lastFrame().includes('but the prompt was not sent'))
  expect(deps.client.forkSession).toHaveBeenCalledTimes(1)
  expect(lastFrame()).not.toContain("couldn't fork")
})

// The session exists once createSession answered; restoring the prompt invited a duplicate dispatch.
test('a dispatch whose prompt fails after the session exists does not restore the prompt', async () => {
  const deps = makeDeps()
  deps.client.promptAsync = vi.fn(() => Promise.reject(new Error('down')))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  await typeText(stdin, 'do a thing')
  stdin.write('\r')
  await waitFor(() => lastFrame().includes('session created, prompt not sent'))
  expect(lastFrame()).not.toContain('do a thing')
})

// Alt+1..9 siblings come from what is navigable, so a session inside a collapsed group is not one.
test('the attach siblings leave out sessions inside a collapsed group', async () => {
  const deps = makeDeps()
  deps.roster = {
    groupBy: 'state',
    sessions: [
      { worktree: '/x/alpha', id: 's1', addedAt: 1, pinned: true },
      { worktree: '/x/alpha', id: 's2', addedAt: 2 },
    ],
    collapsed: ['state:completed'],
  }
  deps.client.listSessions = vi.fn(() =>
    Promise.resolve([
      { id: 's1', title: 'first', time: { updated: 2 } },
      { id: 's2', title: 'second', time: { updated: 1 } },
    ]),
  )
  const onAction = vi.fn(() => new Promise(() => {}))
  const { stdin, lastFrame } = render(React.createElement(App, { ...deps, onAction }))
  await waitFor(() => lastFrame().includes('first'))
  stdin.write('\r') // attaches the selected (pinned, first) row
  await waitFor(() => onAction.mock.calls.length > 0)
  const enter = (onAction.mock.calls as any).find((c: any) => c[0].type === 'enter')?.[0]
  expect(enter?.sessionId).toBe('s1')
  expect(enter.siblings).toEqual([{ id: 's1', projectKey: '/x/alpha' }])
})

test('foldCompleted counts a collapsed group as its header alone, and never folds a collapsed completed', () => {
  const row = (id: string) => ({ id, projectKey: '/x', status: 'idle' }) as any
  const working = { projectKey: 'state:running', repoName: 'working', sessions: Array.from({ length: 10 }, (_, i) => row(`w${i}`)) }
  const completed = { projectKey: 'state:completed', repoName: 'completed', sessions: [row('c1'), row('c2'), row('c3')] }
  // 2 headers + 1 spacer + 3 completed = 6 rows when working is collapsed; fits in 6.
  expect(foldCompleted([working, completed], 6, null, new Set(['state:running']))).toEqual([working, completed])
  // Without the collapse it overflows and folds.
  expect(foldCompleted([working, completed], 6)[1].hidden).toBeGreaterThan(0)
  // A collapsed completed shows none of its rows, so nothing is folded.
  expect(foldCompleted([working, completed], 6, null, new Set(['state:completed']))[1]).toBe(completed)
})
