import { test, expect, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClaudeBackend } from '../src/backends/claude/index.ts'
import { createCopilotBackend } from '../src/backends/copilot/index.ts'
import { STILL_WORKING } from '../src/backends/ps.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'fleetview-still-working-'))
const child = (pid: number) => ({ pid, on: vi.fn(), unref: vi.fn() })

// M15: a follow-up while the recorded run is alive used to spawn a second concurrent --resume,
// overwriting the pid abort needs. It is refused now, and allowed once the run is gone.
test('claude refuses a follow-up while the recorded run is alive, and allows it once it ended', async () => {
  let alive = true
  const spawnImpl = vi.fn(() => child(4242)) as any
  const psImpl = (pid: number) => (alive && pid === 4242 ? { startedAt: Date.now(), command: `claude --session-id ${id}` } : null)
  const b = createClaudeBackend({ runDir: join(tmp(), 'runs'), home: tmp(), spawnImpl, psImpl })
  const { id } = await b.dispatch({ prompt: 'go', directory: '/repo/alpha' })
  await expect(b.prompt(id, 'more', '/repo/alpha')).rejects.toThrow(/still working/)
  expect(spawnImpl).toHaveBeenCalledTimes(1)
  alive = false
  await b.prompt(id, 'more', '/repo/alpha')
  expect(spawnImpl).toHaveBeenCalledTimes(2)
})

test('claude does not refuse when ps cannot tell (unavailable)', async () => {
  const spawnImpl = vi.fn(() => child(4242)) as any
  const b = createClaudeBackend({ runDir: join(tmp(), 'runs'), home: tmp(), spawnImpl, psImpl: () => 'unavailable' as const })
  const { id } = await b.dispatch({ prompt: 'go', directory: '/repo/alpha' })
  await b.prompt(id, 'more', '/repo/alpha')
  expect(spawnImpl).toHaveBeenCalledTimes(2)
})

test('copilot refuses a follow-up while its own run is alive', async () => {
  let alive = true
  const spawnImpl = vi.fn(() => child(4242)) as any
  const psImpl = (pid: number) => (alive && pid === 4242 ? { startedAt: Date.now(), command: 'copilot --session-id session-1' } : null)
  const b = createCopilotBackend({ spawnImpl, psImpl, stateDir: tmp(), logDir: tmp(), randomUUIDImpl: () => 'session-1', pollMs: 5 })
  await b.dispatch({ prompt: 'go', directory: '/repo/alpha' })
  await expect(b.prompt('session-1', 'more', '/repo/alpha')).rejects.toThrow(/still working/)
  alive = false
  await b.prompt('session-1', 'more', '/repo/alpha')
  expect(spawnImpl).toHaveBeenCalledTimes(2)
})

test('copilot refuses a follow-up while another process holds the session lock', async () => {
  const stateDir = tmp()
  mkdirSync(join(stateDir, 'other-1'), { recursive: true })
  writeFileSync(join(stateDir, 'other-1', 'inuse.777.lock'), '777')
  const spawnImpl = vi.fn(() => child(4242)) as any
  const psImpl = (pid: number) => (pid === 777 ? { startedAt: Date.now(), command: 'copilot --resume=other-1' } : null)
  const b = createCopilotBackend({ spawnImpl, psImpl, stateDir, logDir: tmp(), pollMs: 5 })
  await expect(b.prompt('other-1', 'more', '/repo/alpha')).rejects.toThrow(/still working/)
  expect(spawnImpl).not.toHaveBeenCalled()
})

// H1 (audit 2026-11-07): dispatch-and-attach, Enter on the fresh row and `fleetview attach` all
// spawned an interactive --resume beside the still-running headless run. attach() now refuses the
// same way prompt() does, and spells the argv again once the run has ended.
test('claude refuses to attach while the recorded run is alive, and allows it once it ended', async () => {
  let alive = true
  const spawnImpl = vi.fn(() => child(4242)) as any
  const psImpl = (pid: number) => (alive && pid === 4242 ? { startedAt: Date.now(), command: `claude --session-id ${id}` } : null)
  const b = createClaudeBackend({ runDir: join(tmp(), 'runs'), home: tmp(), spawnImpl, psImpl })
  const { id } = await b.dispatch({ prompt: 'go', directory: '/repo/alpha' })
  expect(() => b.attach({ id, directory: '/repo/alpha' })).toThrow(STILL_WORKING)
  alive = false
  expect(b.attach({ id, directory: '/repo/alpha' })).toEqual(['claude', '--resume', id])
})

test('copilot refuses to attach while its own run or another lock holder is alive', async () => {
  let alive = true
  const stateDir = tmp()
  const spawnImpl = vi.fn(() => child(4242)) as any
  const psImpl = (pid: number) => {
    if (pid === 4242 && alive) return { startedAt: Date.now(), command: 'copilot --session-id session-1' }
    if (pid === 777) return { startedAt: Date.now(), command: 'copilot --resume=other-1' }
    return null
  }
  const b = createCopilotBackend({ spawnImpl, psImpl, stateDir, logDir: tmp(), randomUUIDImpl: () => 'session-1', pollMs: 5 })
  await b.dispatch({ prompt: 'go', directory: '/repo/alpha' })
  expect(() => b.attach({ id: 'session-1', directory: '/repo/alpha' })).toThrow(STILL_WORKING)
  alive = false
  expect(b.attach({ id: 'session-1', directory: '/repo/alpha' })).toEqual(['copilot', '-C', '/repo/alpha', '--resume=session-1'])
  mkdirSync(join(stateDir, 'other-1'), { recursive: true })
  writeFileSync(join(stateDir, 'other-1', 'inuse.777.lock'), '777')
  expect(() => b.attach({ id: 'other-1', directory: '/repo/alpha' })).toThrow(STILL_WORKING)
})
