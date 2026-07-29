import { test, expect, vi } from 'vitest'
import { titleFor, setTitle, bell, newlyNotable, hookTransitions, runNotifyHook } from '../src/ui/notify.ts'

test('the tab title counts what is waiting on you', () => {
  expect(
    titleFor([{ status: 'waiting', pendingRequest: true }, { status: 'waiting', pendingRequest: true }, { status: 'running' }]),
  ).toBe('2 awaiting input · fleetview')
  expect(titleFor([{ status: 'running' }])).toBe('fleetview')
  expect(titleFor([])).toBe('fleetview')
})

test('title and bell stay silent when the stream is not a terminal', () => {
  const stream = { isTTY: false, write: vi.fn() }
  setTitle(stream, 'fleetview')
  bell(stream)
  expect(stream.write).not.toHaveBeenCalled()
})

test('the title is set with OSC 0 so both window and tab pick it up', () => {
  const stream = { isTTY: true, write: vi.fn() }
  setTitle(stream, '2 awaiting input · fleetview')
  expect(stream.write).toHaveBeenCalledWith(']0;2 awaiting input · fleetview')
  bell(stream)
  expect(stream.write).toHaveBeenLastCalledWith('')
})

// A session already needing input must not re-ring on every unrelated repaint.
test('only a fresh transition into needing you is notable', () => {
  const before = new Map([['p:a', 'running'], ['p:b', 'waiting']])
  const after = new Map([['p:a', 'waiting'], ['p:b', 'waiting']])
  expect(newlyNotable(before, after)).toEqual([{ key: 'p:a', status: 'waiting' }])
})

test('a failure is notable too, but only once', () => {
  const before = new Map([['p:a', 'running']])
  expect(newlyNotable(before, new Map([['p:a', 'error']]))).toEqual([{ key: 'p:a', status: 'error' }])
  expect(newlyNotable(new Map([['p:a', 'error']]), new Map([['p:a', 'error']]))).toEqual([])
})

// Sessions discovered at startup are history, not news — except one that needs you right now.
test('a session that arrives already failed does not ring', () => {
  expect(newlyNotable(new Map(), new Map([['p:a', 'error']]))).toEqual([])
})

test('a session that arrives already waiting does ring: it needs you now', () => {
  expect(newlyNotable(new Map(), new Map([['p:a', 'waiting']]))).toEqual([{ key: 'p:a', status: 'waiting' }])
})

// While a session is attached the render gate is closed, but the bell has to get out anyway:
// noticing that another session needs you is the point of fleetview staying resident.
test('title and bell take the gate bypass when one exists', () => {
  const stream = { isTTY: true, write: vi.fn(), writeThrough: vi.fn() }
  setTitle(stream, 'fleetview')
  bell(stream)
  expect(stream.writeThrough).toHaveBeenCalledTimes(2)
  expect(stream.write).not.toHaveBeenCalled()
})

test('the tab title counts only sessions with a real pending request', () => {
  const rows = [
    { status: 'waiting', pendingRequest: true },
    { status: 'waiting', pendingRequest: false }, // the ? heuristic guessed this one
  ]
  expect(titleFor(rows)).toBe('1 awaiting input · fleetview')
  expect(titleFor([{ status: 'waiting', pendingRequest: false }])).toBe('fleetview')
})

test('hookTransitions: needs-input, completed from running, failed — first sight of waiting counts, of error does not', () => {
  const prev = new Map([
    ['a', 'running'],
    ['b', 'running'],
    ['c', 'done'],
  ])
  const cur = new Map([
    ['a', 'done'], // running → done: completed
    ['b', 'error'], // running → error: failed
    ['c', 'done'], // unchanged: nothing
    ['d', 'waiting'], // first sight of waiting: needs input (same rule as the bell)
    ['e', 'error'], // first sight of error: not news, it did not fail on our watch
  ])
  expect(hookTransitions(prev, cur)).toEqual([
    { key: 'a', event: 'agent_completed' },
    { key: 'b', event: 'agent_failed' },
    { key: 'd', event: 'agent_needs_input' },
  ])
})

test('runNotifyHook: spawns the command detached with the event in its environment; silent without one', () => {
  const calls: any[] = []
  const spawnImpl = (...args: any[]) => (calls.push(args), { unref: () => {} })
  runNotifyHook({ event: 'agent_completed', session: { id: 's1', title: 't', projectKey: '/x' } }, { spawnImpl, command: 'notify-me' })
  expect(calls.length).toBe(1)
  const [cmd, argv, opts] = calls[0]
  expect([cmd, argv]).toEqual(['sh', ['-c', 'notify-me']])
  expect(opts.env.FLEETVIEW_EVENT).toBe('agent_completed')
  expect(opts.env.FLEETVIEW_SESSION_ID).toBe('s1')
  runNotifyHook({ event: 'agent_completed', session: {} }, { spawnImpl, command: undefined })
  expect(calls.length).toBe(1) // no command, no spawn
})

test('runNotifyHook strips control bytes from the model/server-derived env values', () => {
  const calls: any[] = []
  const spawnImpl = (...args: any[]) => (calls.push(args), { unref: () => {} })
  const esc = String.fromCharCode(0x1b)
  runNotifyHook(
    { event: 'agent_needs_input', session: { id: `s1${esc}]0;x`, title: `deploy${esc}[31m`, projectKey: `/r${esc}` } },
    { spawnImpl, command: 'notify-me' },
  )
  const { env } = calls[0][2]
  expect(env.FLEETVIEW_SESSION_TITLE).toBe('deploy[31m') // ESC stripped, printable kept
  expect(env.FLEETVIEW_SESSION_ID).not.toContain(esc)
  expect(env.FLEETVIEW_PROJECT).not.toContain(esc)
})

// M1: the hook is an arbitrary shell command fired on every transition; the opencode server password
// would give it ungated shell on the server through POST /session/:id/shell.
test('runNotifyHook does not pass the opencode server password to the hook', () => {
  vi.stubEnv('OPENCODE_SERVER_PASSWORD', 'minted-for-the-server')
  try {
    const calls: any[] = []
    const spawnImpl = (...args: any[]) => (calls.push(args), { unref: () => {} })
    runNotifyHook({ event: 'agent_completed', session: { id: 's1' } }, { spawnImpl, command: 'notify-me' })
    const { env } = calls[0][2]
    expect(env.OPENCODE_SERVER_PASSWORD).toBeUndefined()
    expect(env.PATH).toBe(process.env.PATH) // the rest of the environment is intact
  } finally {
    vi.unstubAllEnvs()
  }
})
