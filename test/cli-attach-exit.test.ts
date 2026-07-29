import { test, expect, vi } from 'vitest'

// The pty path this time (cli-attach.test.ts pins the no-pty fallback): attachPty is mocked so the
// test controls how the attachment ended, which is the whole subject here.
vi.mock('node-pty', () => ({ default: { spawn: vi.fn() } }))

const attachPty = vi.fn()
vi.mock('../src/pty-host.ts', async (orig) => ({ ...(await (orig() as Promise<object>)), attachPty: (...a: any[]) => attachPty(...a) }))

const { attachLoop } = await import('../src/cli.ts')

const out = () => ({ close: vi.fn(), open: vi.fn(), write: vi.fn() })
const backends = { opencode: { attach: ({ id }: any) => ['opencode', 'attach', 'url', '-s', id] } } as any

// The recommended `app_exit: left` opencode keybind ends the attach CLIENT — fleetview sees a
// clean 'exit', not a detach chord — while the session keeps running on the server. That is
// "moved to the background" and must feed the notice/Esc-reopen path like a chord detach does.
test('a clean opencode attach exit reports the session as backgrounded', async () => {
  attachPty.mockResolvedValueOnce({ type: 'exit', exitCode: 0, drewNothing: false, ms: 60_000 })
  const result = await attachLoop({ backend: 'opencode', sessionId: 's1', worktree: '/repo/alpha' }, out(), null, backends)
  expect(result).toEqual({ detached: true, sessionId: 's1', worktree: '/repo/alpha', backend: 'opencode' })
})

// A dirty exit is an attach failure, not a backgrounding — describeExit still owns it.
test('a failing opencode attach exit is not reported as backgrounded', async () => {
  attachPty.mockResolvedValueOnce({ type: 'exit', exitCode: 1, drewNothing: true, ms: 100 })
  const result = await attachLoop({ backend: 'opencode', sessionId: 's1', worktree: '/repo/alpha' }, out(), null, backends)
  expect((result as any)?.detached).toBeUndefined()
})

// claude/copilot interactive exits end the turn with nothing left running — "moved to the
// background" would be a false claim there, so only the chord detach reports it for them.
test('a clean claude attach exit is not reported as backgrounded', async () => {
  attachPty.mockResolvedValueOnce({ type: 'exit', exitCode: 0, drewNothing: false, ms: 60_000 })
  const claudeBackends = { claude: { attach: ({ id }: any) => ['claude', '--resume', id] } } as any
  const result = await attachLoop({ backend: 'claude', sessionId: 'c1', worktree: '/repo/alpha' }, out(), null, claudeBackends)
  expect((result as any)?.detached).toBeUndefined()
})

// #5: the child painted the whole screen and left the cursor somewhere arbitrary, so Ink's next
// frame — written relative to that cursor and erasing only its own height — lands amid the
// session's leftovers. Resuming has to wipe the screen, through the gate and after it reopens, so
// the frame Ink writes next starts from a blank terminal with the cursor at home.
test('resuming from an attachment reopens the gate, drops Ink’s frame memory, and clears the screen', async () => {
  attachPty.mockResolvedValueOnce({ type: 'exit', exitCode: 0, drewNothing: false, ms: 60_000 })
  const o = out()
  const order: string[] = []
  o.open.mockImplementation(() => order.push('open'))
  o.write.mockImplementation(() => order.push('write'))
  const instance = { clear: vi.fn(() => order.push('clear')) }
  await attachLoop({ backend: 'opencode', sessionId: 's1', worktree: '/repo/alpha' }, o, instance, backends)
  // attachPty is mocked, so nothing called onResume for us; drive the hook the pty host would.
  attachPty.mock.calls.at(-1)![0].onResume()
  expect(instance.clear).toHaveBeenCalled()
  expect(o.write).toHaveBeenCalledWith('\x1b[2J\x1b[3J\x1b[H')
  // The order is the fix: a clear written before the gate reopens is swallowed, and one written
  // before Ink's own clear() would be undone by the erase sequences that clear() emits.
  expect(order).toEqual(['open', 'clear', 'write'])
})
