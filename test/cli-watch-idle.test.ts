import { test, expect, vi } from 'vitest'
import { runWatch } from '../src/cli.ts'

// M16: an already-idle session never sends an idle frame, so `watch` has to ask once connected.
const harness = (sessionStatus: () => Promise<any>) => {
  let online: () => void = () => {}
  let endStream: () => void = () => {}
  const stop = vi.fn()
  const status = vi.fn(sessionStatus)
  const deps = {
    ensureServer: vi.fn(() => Promise.resolve({ ok: true, server: { host: '127.0.0.1', port: 4900 } })),
    serverFile: '/tmp/s.json',
    createClient: vi.fn(() => ({
      listProjects: () => Promise.resolve([{ id: '/x/repo', worktree: '/x/repo' }]),
      listSessions: () => Promise.resolve([{ id: 'ses_abc123' }]),
      sessionStatus: status,
    })),
    connect: vi.fn((_target: any, { onOnline }: any) => {
      online = () => onOnline('/x/repo')
      return { done: new Promise<void>((res) => { endStream = res }), stop }
    }),
    log: vi.fn(),
    error: vi.fn(),
    setExitCode: vi.fn(),
  }
  const opened = async () => {
    for (let i = 0; i < 100 && !deps.connect.mock.calls.length; i++) await new Promise((r) => setImmediate(r))
  }
  return { deps, stop, status, opened, online: () => online(), endStream: () => endStream() }
}

const settled = async (p: Promise<unknown>) => {
  let finished = false
  void p.then(() => (finished = true))
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
  return finished
}

test('watch on a session absent from the status map finishes once the stream connects', async () => {
  const h = harness(() => Promise.resolve({}))
  const done = runWatch({ command: 'watch', id: 'ses_abc1' }, h.deps as any)
  await h.opened()
  h.online()
  expect(await settled(done)).toBe(true)
  expect(h.status).toHaveBeenCalledWith('/x/repo')
  expect(h.stop).toHaveBeenCalled()
})

test('watch on an explicitly idle session finishes once the stream connects', async () => {
  const h = harness(() => Promise.resolve({ ses_abc123: { type: 'idle' } }))
  const done = runWatch({ command: 'watch', id: 'ses_abc1' }, h.deps as any)
  await h.opened()
  h.online()
  expect(await settled(done)).toBe(true)
})

test('watch on a busy session keeps waiting for the stream', async () => {
  const h = harness(() => Promise.resolve({ ses_abc123: { type: 'busy' } }))
  const done = runWatch({ command: 'watch', id: 'ses_abc1' }, h.deps as any)
  await h.opened()
  h.online()
  expect(await settled(done)).toBe(false)
  h.endStream()
  await done
})

test('an unreadable status map is not taken as idle', async () => {
  const h = harness(() => Promise.reject(new Error('GET /session/status → 500')))
  const done = runWatch({ command: 'watch', id: 'ses_abc1' }, h.deps as any)
  await h.opened()
  h.online()
  expect(await settled(done)).toBe(false)
  h.endStream()
  await done
})
