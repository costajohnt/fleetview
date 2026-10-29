import { test, expect, vi } from 'vitest'

// L4: an attach failure names the backend that failed, not "opencode" regardless.
vi.mock('node-pty', () => ({ default: { spawn: vi.fn() } }))
const attachPty = vi.fn()
vi.mock('../src/pty-host.ts', async (orig) => ({ ...(await (orig() as Promise<object>)), attachPty: (...a: any[]) => attachPty(...a) }))

const { attachLoop } = await import('../src/cli.ts')

const out = () => ({ close: vi.fn(), open: vi.fn(), write: vi.fn() })
const backends = { claude: { attach: ({ id }: any) => ['claude', '--resume', id] } } as any

test('an instant silent exit names the backend', async () => {
  attachPty.mockResolvedValueOnce({ type: 'exit', exitCode: 1, drewNothing: true, ms: 100 })
  // An existing directory, so the message is about the exit, not a vanished worktree.
  const result = await attachLoop({ backend: 'claude', sessionId: 'c1', worktree: process.cwd() }, out(), null, backends)
  expect(result).toEqual({ message: "couldn't attach (claude exited 1)" })
})

test('a child that never launched names the backend', async () => {
  attachPty.mockRejectedValueOnce(new Error('spawn claude ENOENT'))
  const result = await attachLoop({ backend: 'claude', sessionId: 'c1', worktree: process.cwd() }, out(), null, backends)
  expect(result).toEqual({ message: "couldn't launch claude: spawn claude ENOENT" })
})
