import React from 'react'
import { test, expect, vi, afterEach } from 'vitest'
import { render } from 'ink-testing-library'
import { App } from '../src/app.ts'

// The TUI half of the worktree-removal guard: ^x^x on the last session in an isolated worktree asks
// the server to remove it, and a rejection there must be said out loud, not swallowed. Same deps
// shape as app.test.ts's makeDeps, trimmed to what the delete path touches.
const live: any[] = []
afterEach(() => {
  for (const instance of live.splice(0)) instance.unmount()
})
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
const waitFor = async (fn: () => any, timeoutMs = 4000) => {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const server = { host: '127.0.0.1', port: 4900 }
const repo = '/x/alpha'
const wt = '/wt/alpha/fix-the-thing'

test('^x^x says so when the session is deleted but its worktree could not be removed', async () => {
  const client = {
    listProjects: vi.fn(() =>
      Promise.resolve([
        { id: 'a-1', worktree: repo, vcs: 'git', sandboxes: [wt], time: { created: 1, updated: 1000 } },
        { id: 'a-2', worktree: wt, vcs: 'git', sandboxes: [], time: { created: 2, updated: 2000 } },
      ]),
    ),
    listSessions: vi.fn((dir: string) => Promise.resolve(dir === wt ? [{ id: 's9', title: 'in the worktree', time: { updated: Date.now() } }] : [])),
    deleteSession: vi.fn(() => Promise.resolve({})),
    removeWorktree: vi.fn(() => Promise.reject(new Error('DELETE /experimental/worktree → 500'))),
    listMessages: vi.fn(() => Promise.resolve([])),
    sessionStatus: vi.fn(() => Promise.resolve({})),
    listPermissions: vi.fn(() => Promise.resolve([])),
    listQuestions: vi.fn(() => Promise.resolve([])),
    abortSession: vi.fn(() => Promise.resolve({})),
  }
  const deps = {
    server,
    client,
    connectEventsImpl: vi.fn(() => ({ done: Promise.resolve(), stop: vi.fn() })),
    ensureServerImpl: vi.fn(() => Promise.resolve({ ok: true, server })),
    serverReady: true,
    roster: { groupBy: 'state', sessions: [{ worktree: wt, id: 's9', addedAt: 1 }] },
    persistRoster: vi.fn(),
    dirExistsImpl: () => true,
    worktreeSafetyImpl: vi.fn(() => ({ removable: true, reason: null })),
  }
  const instance = render(React.createElement(App as any, { ...deps, onAction: vi.fn() }))
  live.push(instance)
  const frame = () => stripAnsi(instance.lastFrame() ?? '')
  await waitFor(() => frame().includes('in the worktree'))
  instance.stdin.write('\x18')
  await new Promise((r) => setTimeout(r, 50))
  instance.stdin.write('\x18')
  await waitFor(() => client.removeWorktree.mock.calls.length > 0)
  expect(client.deleteSession).toHaveBeenCalledWith('s9', wt)
  expect(client.removeWorktree).toHaveBeenCalledWith(wt, repo)
  await waitFor(() => frame().includes('session deleted, but its worktree could not be removed'))
})
