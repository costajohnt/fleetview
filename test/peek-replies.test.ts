import React from 'react'
import { test, expect, vi, afterEach } from 'vitest'
import { render as inkRender } from 'ink-testing-library'
import { App } from '../src/app.ts'
import { waitedLabel, suggestedReply } from '../src/ui/peek.ts'
import { createStore } from '../src/session-store.ts'

const live: any[] = []
const render = (...args: any[]) => {
  const instance = (inkRender as any)(...args)
  live.push(instance)
  return instance
}
afterEach(() => {
  for (const instance of live.splice(0)) instance.unmount()
})

const SPACE = ' '
const TAB = '\t'
const server = { host: '127.0.0.1', port: 4900 }
const project = { id: 'a-1', worktree: '/x/alpha', vcs: 'git', time: { created: 1, updated: 1000 } }
const tick = () => new Promise((r) => setTimeout(r, 20))
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
    listSessions: vi.fn(() => Promise.resolve([{ id: 's1', title: 'fix tests', time: { updated: Date.now() } }])),
    createSession: vi.fn(() => Promise.resolve({ id: 's9' })),
    promptAsync: vi.fn(() => Promise.resolve({})),
    runShell: vi.fn(() => Promise.resolve({})),
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
    roster: { groupBy: 'state', sessions: [{ worktree: '/x/alpha', id: 's1', addedAt: 1 }], collapsed: [] },
    persistRoster: vi.fn(),
  }
}

// --- `waiting Nm` ---

test('waitedLabel counts from when the request arrived, and says nothing when nothing is pending', () => {
  const now = 1_000_000
  expect(waitedLabel(0, now)).toBe(null)
  expect(waitedLabel(null as any, now)).toBe(null)
  expect(waitedLabel(now - 5_000, now)).toBe('waiting 5s')
  expect(waitedLabel(now - 3 * 60_000, now)).toBe('waiting 3m')
  expect(waitedLabel(now - 2 * 3_600_000, now)).toBe('waiting 2h')
  expect(waitedLabel(now - 3 * 86_400_000, now)).toBe('waiting 3d')
  expect(waitedLabel(now + 5_000, now)).toBe('waiting 0s') // a clock that ran backwards is not negative time
})

// The clock belongs to the request, not the session: a second question arriving later must not
// restart it, because the user has been waiting since the first one.
test('the store reports the oldest outstanding request, and clears when answered', () => {
  const store = createStore()
  store.setSessions('r', [{ id: 's1', title: 't', directory: 'r', time: { created: 0, updated: 0 } }], undefined)
  expect(store.get('r', 's1')!.waitingSince).toBe(0)

  store.apply('r', { type: 'permission.asked', properties: { id: 'p1', sessionID: 's1', permission: 'edit', __askedAt: 1000 } })
  expect(store.get('r', 's1')!.waitingSince).toBe(1000)

  store.apply('r', { type: 'question.asked', properties: { id: 'q1', sessionID: 's1', questions: [], __askedAt: 5000 } })
  expect(store.get('r', 's1')!.waitingSince).toBe(1000) // still the first one

  store.apply('r', { type: 'permission.replied', properties: { sessionID: 's1', requestID: 'p1' } })
  expect(store.get('r', 's1')!.waitingSince).toBe(5000) // now the question is the oldest

  store.apply('r', { type: 'question.replied', properties: { sessionID: 's1', requestID: 'q1' } })
  expect(store.get('r', 's1')!.waitingSince).toBe(0) // nothing outstanding
})

// The prose heuristic has no moment it started, so putting a clock on it would be a confident guess.
test('a session waiting only on the question-mark heuristic reports no waiting time', () => {
  const store = createStore()
  store.setSessions('r', [{ id: 's1', title: 't', directory: 'r', time: { created: 0, updated: 0 } }], undefined)
  store.apply('r', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.apply('r', { type: 'message.updated', properties: { sessionID: 's1', info: { id: 'm1', role: 'assistant' } } })
  store.apply('r', {
    type: 'message.part.updated',
    properties: { sessionID: 's1', part: { type: 'text', messageID: 'm1', text: 'shall I continue?' } },
  })
  store.apply('r', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  const view = store.get('r', 's1')!
  expect(view.status).toBe('waiting')
  expect(view.pendingRequest).toBe(false)
  expect(view.waitingSince).toBe(0)
})

// --- Tab fills a suggested reply ---

test('suggestedReply offers the question own first option, and nothing when there are none', () => {
  expect(suggestedReply({ questions: [{ options: [{ label: 'merge it' }, { label: 'wait' }] }] })).toBe('merge it')
  expect(suggestedReply({ questions: [{ options: [] }] })).toBe(null)
  expect(suggestedReply(undefined)).toBe(null)
})

test('tab in peek fills the reply with the option the session offered', async () => {
  const deps = makeDeps()
  deps.client.listQuestions = vi.fn(() =>
    Promise.resolve([
      { id: 'q1', sessionID: 's1', questions: [{ question: 'merge?', header: 'merge', options: [{ label: 'merge it', description: '' }] }] },
    ]),
  ) as any
  const { lastFrame, stdin } = render(React.createElement(App as any, { ...deps, onAction: vi.fn() }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write(SPACE)
  await waitFor(() => lastFrame().includes('merge?'))
  stdin.write(TAB)
  await waitFor(() => lastFrame().includes('> merge it'))
})

// --- saved replies ---

// "Undeliverable replies are saved and sent when the session's process starts again, and the error
// message says the reply was saved."
test('a reply that cannot be delivered is saved, said so, and sent when it becomes reachable', async () => {
  const deps = makeDeps()
  let fail = true
  deps.client.promptAsync = vi.fn(() => (fail ? Promise.reject(new Error('down')) : Promise.resolve({})))
  const { lastFrame, stdin } = render(React.createElement(App as any, { ...deps, onAction: vi.fn(), projectPollMs: 40 }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write(SPACE)
  await waitFor(() => lastFrame().includes('reply · ! runs a shell command'))

  stdin.write('try again')
  await tick()
  stdin.write('\r')
  await waitFor(() => lastFrame().includes("couldn't send — saved"))
  expect(lastFrame()).toContain('saved — will send when it is reachable: try again')

  // the session comes back; the queued reply goes out without being retyped
  fail = false
  await waitFor(() => deps.client.promptAsync.mock.calls.length > 1, 4000)
  expect(deps.client.promptAsync.mock.calls.at(-1)).toEqual(['s1', 'try again', '/x/alpha'])
  await waitFor(() => !lastFrame().includes('saved — will send'))
})

// A shell command that arrives minutes later is a different instruction than the one that was meant.
test('a shell reply that fails is reported and never queued', async () => {
  const deps = makeDeps()
  deps.client.runShell = vi.fn(() => Promise.reject(new Error('down')))
  const { lastFrame, stdin } = render(React.createElement(App as any, { ...deps, onAction: vi.fn(), projectPollMs: 40 }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write(SPACE)
  await waitFor(() => lastFrame().includes('reply · ! runs a shell command'))
  stdin.write('!rm -rf build')
  await tick()
  stdin.write('\r')
  await waitFor(() => lastFrame().includes("shell commands aren't saved"))
  await tick()
  expect(lastFrame()).not.toContain('saved — will send')
  expect(deps.client.runShell).toHaveBeenCalledTimes(1) // never retried
})

// L11: the flush deletes the key, sends, and on failure re-adds it. Unconditionally, it used to —
// so a reply the user typed while the send was in flight was overwritten by the one it replaced,
// and the next tick sent the stale body instead.
test('a reply typed while a queued send is in flight is not clobbered by that send failing', async () => {
  const deps = makeDeps()
  const inFlight: any = { resolve: null, reject: null }
  let firstSends = 0
  deps.client.promptAsync = vi.fn((id: any, body: any) => {
    if (body !== 'first') return Promise.reject(new Error('down')) // 'second' stays queued too
    firstSends += 1
    // The peek reply fails outright (queueing 'first'); the flush's retry hangs, which is the
    // in-flight window the user types into.
    if (firstSends === 1) return Promise.reject(new Error('down'))
    return new Promise((resolve, reject) => {
      inFlight.resolve = resolve
      inFlight.reject = reject
    })
  }) as any
  const { lastFrame, stdin } = render(React.createElement(App as any, { ...deps, onAction: vi.fn(), projectPollMs: 40 }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write(SPACE)
  await waitFor(() => lastFrame().includes('reply · ! runs a shell command'))
  stdin.write('first')
  await tick()
  stdin.write('\r')
  // Queued by the failed peek reply, then picked up by the flush — whose retry hangs, which is the
  // in-flight window the user types into.
  await waitFor(() => firstSends === 2)
  stdin.write('second')
  await tick()
  stdin.write('\r')
  await waitFor(() => lastFrame().includes('saved — will send when it is reachable: second'))

  const secondSends = () => deps.client.promptAsync.mock.calls.filter(([, body]: any) => body === 'second').length
  const mark = secondSends()
  inFlight.reject(new Error('down')) // the superseded send finally fails
  // Two more flush ticks: enough for a clobbered slot to have sent 'first' again.
  await waitFor(() => secondSends() >= mark + 2 || firstSends > 2)
  expect(firstSends).toBe(2) // 'first' was never re-queued, so it is never sent again
  expect(lastFrame()).toContain('saved — will send when it is reachable: second')
})
