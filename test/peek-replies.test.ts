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

// M15: sendReply's success path deletes the key, so a failed flush could not tell "nothing
// happened" from "the user already sent a newer reply directly" — it re-queued the stale body,
// which the next tick delivered AFTER the newer instruction. The per-key epoch a successful send
// bumps makes the late-failing flush drop it instead.
test('a flush that fails after a newer reply was sent directly does not resurrect the stale one', async () => {
  const deps = makeDeps()
  const inFlight: any = { reject: null }
  let staleSends = 0
  deps.client.promptAsync = vi.fn((_id: any, body: any) => {
    if (body === 'stale') {
      staleSends += 1
      if (staleSends === 1) return Promise.reject(new Error('down')) // the peek reply fails, queueing it
      return new Promise((_resolve, reject) => {
        inFlight.reject = reject // the flush's retry hangs — the window the newer reply lands in
      })
    }
    return Promise.resolve({}) // 'newer' goes straight through
  }) as any
  const { lastFrame, stdin } = render(React.createElement(App as any, { ...deps, onAction: vi.fn(), projectPollMs: 40 }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write(SPACE)
  await waitFor(() => lastFrame().includes('reply · ! runs a shell command'))
  stdin.write('stale')
  await tick()
  stdin.write('\r')
  await waitFor(() => staleSends === 2) // queued, then picked up by the flush, now in flight
  stdin.write('newer')
  await tick()
  stdin.write('\r') // delivered directly while the flush send is still hanging
  await waitFor(() => deps.client.promptAsync.mock.calls.some(([, body]: any) => body === 'newer'))
  const polls = () => deps.client.listProjects.mock.calls.length
  const mark = polls()
  inFlight.reject(new Error('down')) // the superseded flush finally fails
  await waitFor(() => polls() >= mark + 3) // enough flush ticks for a re-queued body to have gone out
  expect(staleSends).toBe(2) // never re-queued, never delivered after 'newer'
  expect(lastFrame()).not.toContain('saved — will send')
})

// --- #61: a typed reply must not follow the arrows to another session ---

const DOWN = '[B'
const RIGHT = '[C'

// Two sessions in one project, so an arrow in peek has somewhere to go.
function makeTwoSessionDeps() {
  const deps = makeDeps()
  deps.client.listSessions = vi.fn(() =>
    Promise.resolve([
      { id: 's1', title: 'fix tests', time: { updated: 2000 } },
      { id: 's2', title: 'ship it later', time: { updated: 1000 } },
    ]),
  ) as any
  deps.roster = {
    groupBy: 'state',
    sessions: [
      { worktree: '/x/alpha', id: 's1', addedAt: 1 },
      { worktree: '/x/alpha', id: 's2', addedAt: 2 },
    ],
    collapsed: [],
  }
  return deps
}

// The bug: the arrow retargeted `peekTarget` without touching `peekReply`, so the next return sent
// the text written for s1 to s2 — a real prompt against the wrong agent, with no undo.
test('an arrow with a draft in peek clears the draft instead of retargeting, so return cannot send it elsewhere', async () => {
  const deps = makeTwoSessionDeps()
  const { lastFrame, stdin } = render(React.createElement(App as any, { ...deps, onAction: vi.fn(), projectPollMs: 40 }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write(SPACE)
  await waitFor(() => lastFrame().includes('reply · ! runs a shell command'))

  stdin.write('ship it')
  await waitFor(() => lastFrame().includes('> ship it'))
  stdin.write(DOWN)
  // The arrow is consumed by the draft: it clears, and the panel still shows the session the reply
  // was written for rather than the next one.
  await waitFor(() => !lastFrame().includes('> ship it'))
  expect(lastFrame()).toContain('fix tests')
  expect(lastFrame()).not.toContain('ship it later')
  stdin.write('\r')
  await tick()
  await tick()

  // Nothing was sent at all — and in particular nothing was sent to s2.
  expect(deps.client.promptAsync.mock.calls).toEqual([])
})

// The other half of the fix: with the draft gone the arrow navigates exactly as before, and a
// reply typed after it goes to the session now on screen.
test('an arrow with an empty reply still retargets peek, and the reply that follows goes to that session', async () => {
  const deps = makeTwoSessionDeps()
  const { lastFrame, stdin } = render(React.createElement(App as any, { ...deps, onAction: vi.fn(), projectPollMs: 40 }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write(SPACE)
  await waitFor(() => lastFrame().includes('reply · ! runs a shell command'))

  stdin.write(DOWN)
  await waitFor(() => lastFrame().includes('ship it later'))
  stdin.write('still here')
  await waitFor(() => lastFrame().includes('> still here'))
  stdin.write('\r')
  await waitFor(() => deps.client.promptAsync.mock.calls.length === 1)
  expect(deps.client.promptAsync.mock.calls[0]).toEqual(['s2', 'still here', '/x/alpha'])
})

// The right arrow is documented as attach, but with a draft it used to attach and silently drop
// the text — the same class of loss as sending it to the wrong session. Since #134 the reply has a
// caret, so → with a draft moves it (and ⌥← moves it a word) and the draft is kept; only an empty
// reply lets → attach.
test('the right arrow with a draft in peek moves the caret rather than attaching and discarding it', async () => {
  const deps = makeTwoSessionDeps()
  const onAction = vi.fn()
  const { lastFrame, stdin } = render(React.createElement(App as any, { ...deps, onAction, projectPollMs: 40 }))
  await waitFor(() => lastFrame().includes('fix tests'))
  stdin.write(SPACE)
  await waitFor(() => lastFrame().includes('reply · ! runs a shell command'))

  stdin.write('do not lose me')
  await waitFor(() => lastFrame().includes('> do not lose me█'))
  stdin.write('\x1B[1;3D') // ⌥←
  await waitFor(() => lastFrame().includes('> do not lose █me'))
  stdin.write(RIGHT)
  await waitFor(() => lastFrame().includes('> do not lose m█e'))
  await tick()
  expect(onAction.mock.calls.filter(([a]: any) => a?.type === 'enter')).toEqual([])

  // With the draft cleared, the right arrow attaches as documented.
  stdin.write('\x1B') // esc clears the draft
  await waitFor(() => lastFrame().includes('reply · ! runs a shell command'))
  stdin.write(RIGHT)
  await waitFor(() => onAction.mock.calls.some(([a]: any) => a?.type === 'enter'))
  expect(onAction.mock.calls.find(([a]: any) => a?.type === 'enter')![0].sessionId).toBe('s1')
})
