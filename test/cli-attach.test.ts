import { test, expect, vi } from 'vitest'

// Force the no-pty fallback path in attachLoop: with node-pty unavailable, `pty` is null and
// attachLoop hands the terminal straight to spawnSync.
vi.mock('node-pty', () => {
  throw new Error('no pty in test')
})

// Capture spawnSync so the test can read the options it was handed — the cwd is the regression.
const spawnSync = vi.fn(() => ({}))
vi.mock('node:child_process', async (orig) => ({ ...(await (orig() as Promise<object>)), spawnSync }))

const { attachLoop } = await import('../src/cli.ts')

// A process-backed resume (`claude --resume <id>`) is cwd-scoped: without cwd it fails "No
// conversation found" from fleetview's own directory. The pty path already passes cwd; this pins
// that the no-pty fallback does too.
test('the no-pty attach fallback runs the resume in the session’s worktree', async () => {
  const out = { close: vi.fn(), open: vi.fn(), write: vi.fn() }
  const backends = { claude: { attach: ({ id }: any) => ['claude', '--resume', id] } } as any
  const result = await attachLoop({ backend: 'claude', sessionId: 'c1', worktree: '/repo/alpha' }, out, null, backends)
  expect(result).toBeUndefined()
  expect(spawnSync).toHaveBeenCalledWith('claude', ['--resume', 'c1'], { stdio: 'inherit', cwd: '/repo/alpha' })
})

// The no-pty fallback hands the terminal over wholesale, so it comes back to exactly the mess the
// pty path does (#5) and needs the same screen wipe on the way out.
test('the no-pty attach fallback clears the screen on the way back', async () => {
  const out = { close: vi.fn(), open: vi.fn(), write: vi.fn() }
  const instance = { clear: vi.fn() }
  const backends = { claude: { attach: ({ id }: any) => ['claude', '--resume', id] } } as any
  await attachLoop({ backend: 'claude', sessionId: 'c1', worktree: '/repo/alpha' }, out, instance, backends)
  expect(instance.clear).toHaveBeenCalled()
  expect(out.write).toHaveBeenCalledWith('\x1b[2J\x1b[3J\x1b[H')
})
