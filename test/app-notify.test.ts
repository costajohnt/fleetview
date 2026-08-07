import React from 'react'
import { test, expect, vi, afterEach } from 'vitest'
import { render as inkRender } from 'ink-testing-library'

// Its own file because of this mock: `runNotifyHook` is what the user's FLEETVIEW_NOTIFY_CMD hangs
// off, and spawning a real command is the one thing a test must not do. Everything else in
// ui/notify.ts stays real — the transition rules are the thing under test.
vi.mock('../src/ui/notify.ts', async (importOriginal) => ({
  ...(await importOriginal()),
  runNotifyHook: vi.fn(),
}))

const { App } = await import('../src/app.ts')
const notifyMod = await import('../src/ui/notify.ts')
const runNotifyHook = vi.mocked(notifyMod.runNotifyHook)

const live: any[] = []
const render = (...args: Parameters<typeof inkRender>) => {
  const instance = inkRender(...args)
  live.push(instance)
  return instance
}
afterEach(() => {
  for (const instance of live.splice(0)) instance.unmount()
  runNotifyHook.mockClear()
})

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
    // A real server-reported block, not the question-mark heuristic: only these ring the bell and
    // run the hook, so only these can prove the false re-fire.
    listPermissions: vi.fn(() => Promise.resolve([{ id: 'p1', sessionID: 's1', permission: 'bash' }])),
    listQuestions: vi.fn(() => Promise.resolve([])),
  }
  return {
    server,
    client,
    connectEventsImpl: vi.fn(() => ({ done: Promise.resolve(), stop: vi.fn() })),
    ensureServerImpl: vi.fn(() => Promise.resolve({ ok: true, server })),
    serverReady: true,
    roster: { groupBy: 'state', sessions: [{ worktree: '/x/alpha', id: 's1', addedAt: 1 }], collapsed: [] },
    persistRoster: vi.fn(),
    // Fast enough that the negative tests can wait for one MORE poll round (the re-fire window)
    // without the default 30s interval making that wait a timeout.
    projectPollMs: 50,
  }
}

const events = () => runNotifyHook.mock.calls.map(([a]) => a.event)

// L10: the snapshot the notifications compare against used to be built from the rendered rows, so a
// row leaving and re-entering the view read as a state transition. Typing a filter and clearing it
// re-fired agent_needs_input for every already-blocked session — bell, and the user's notifier
// command — for nothing that happened.
test('filtering the blocked session out of view and back does not re-fire agent_needs_input', async () => {
  const deps = makeDeps()
  const { stdin, lastFrame } = render(React.createElement(App as any, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame()!.includes('fix tests'))
  await waitFor(() => events().includes('agent_needs_input')) // the real block, fired once
  const before = events().length

  stdin.write('s:working') // a filter the blocked session cannot match
  await waitFor(() => !lastFrame()!.includes('fix tests'))
  stdin.write('\x1B') // esc clears the filter and the row comes back
  await waitFor(() => lastFrame()!.includes('fix tests'))
  // The re-fire mechanism runs on the poll cycle, so the observation window has to contain one:
  // wait until listPermissions has answered at least once more, then a spurious event had its chance.
  const polls = deps.client.listPermissions.mock.calls.length
  await waitFor(() => deps.client.listPermissions.mock.calls.length > polls)
  await tick()

  expect(events().length).toBe(before)
})

// Same root cause through the other door: ^b lists every session opencode knows about, members or
// not, so the rendered set grew by a blocked session that is not in the fleet — and off the rendered
// set that read as one starting to need you.
test('browsing sessions that are not roster members does not fire the hook for them', async () => {
  const deps = makeDeps()
  deps.client.listSessions = vi.fn(() =>
    Promise.resolve([
      { id: 's1', title: 'fix tests', time: { updated: Date.now() } },
      { id: 's2', title: 'someone elses session', time: { updated: Date.now() } },
    ]),
  )
  deps.client.listPermissions = vi.fn(() =>
    Promise.resolve([
      { id: 'p1', sessionID: 's1', permission: 'bash' },
      { id: 'p2', sessionID: 's2', permission: 'bash' },
    ]),
  )
  const { stdin, lastFrame } = render(React.createElement(App as any, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame()!.includes('fix tests'))
  await waitFor(() => events().includes('agent_needs_input')) // s1 is a member; it earns one
  const before = events().length

  stdin.write('\x02') // browse: s2 is now on screen
  await waitFor(() => lastFrame()!.includes('someone elses session'))
  stdin.write('\x02') // and back
  await waitFor(() => lastFrame()!.includes('needs input'))
  // Same widened window as above: a spurious fire off the next poll's snapshot must get its chance
  // before the count is declared frozen.
  const polls = deps.client.listPermissions.mock.calls.length
  await waitFor(() => deps.client.listPermissions.mock.calls.length > polls)
  await tick()

  expect(events().length).toBe(before)
})

// The transitions that are real still have to get through — a snapshot that never fires is not a fix.
test('a session that starts needing input still fires the hook once', async () => {
  const deps = makeDeps()
  deps.client.listPermissions = vi.fn(() => Promise.resolve([]))
  const { lastFrame } = render(React.createElement(App as any, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame()!.includes('fix tests'))
  await waitFor(() => deps.connectEventsImpl.mock.calls.length > 0)
  expect(events()).not.toContain('agent_needs_input')

  const onEvent = (deps.connectEventsImpl.mock.calls[0] as any)[1].onEvent
  onEvent('/x/alpha', { type: 'permission.asked', properties: { sessionID: 's1', id: 'p1', permission: 'bash' } })
  await waitFor(() => events().filter((e) => e === 'agent_needs_input').length === 1)
  await tick()
  expect(events().filter((e) => e === 'agent_needs_input')).toHaveLength(1) // once, not once per render
})
