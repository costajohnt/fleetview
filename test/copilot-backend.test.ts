import { test, expect, vi } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCopilotBackend } from '../src/backends/copilot/index.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'fleetview-copilot-'))

// Enough of a ChildProcess for the adapter: a pid, an `error` listener, and unref. A fuller fake
// would stop these tests noticing the adapter reaching for something a detached child doesn't have.
const fakeChild = (pid: number | undefined) => {
  const handlers: Record<string, (e: Error) => void> = {}
  return {
    pid,
    on: vi.fn((event: string, fn: (e: Error) => void) => {
      handlers[event] = fn
    }),
    unref: vi.fn(),
    fail: (e: Error) => handlers.error?.(e),
  }
}

function harness({ pid = 4242, noPid = false, killImpl = vi.fn(), psImpl, now }: { pid?: number; noPid?: boolean; killImpl?: any; psImpl?: any; now?: () => number } = {}) {
  const child = fakeChild(noPid ? undefined : pid)
  const spawnImpl = vi.fn(() => child) as any
  const stateDir = tmp()
  const logDir = tmp()
  let n = 0
  const backend = createCopilotBackend({
    spawnImpl,
    killImpl,
    // A pid that always looks like the process its lock claims, so abort tests exercise the signal
    // path; the recycled-pid refusals inject their own psImpl below.
    psImpl: psImpl ?? (() => ({ startedAt: Date.now(), command: 'copilot' })),
    stateDir,
    logDir,
    randomUUIDImpl: () => `session-${++n}`,
    ...(now ? { now } : {}),
    pollMs: 5,
  })
  return { backend, spawnImpl, killImpl, child, stateDir, logDir }
}

// copilot's on-disk shape, written by hand so a test can put a session in a state a live run would
// take real credits to reach.
function writeSession(stateDir: string, id: string, cwd: string, { pid, events }: { pid?: number; events?: string } = {}) {
  const dir = join(stateDir, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'workspace.yaml'), `id: ${id}\ncwd: ${cwd}\nname: '${id}'\ncreated_at: 2026-07-25T20:00:00.000Z\nupdated_at: 2026-07-25T20:01:00.000Z\n`)
  if (pid !== undefined) writeFileSync(join(dir, `inuse.${pid}.lock`), String(pid))
  if (events !== undefined) writeFileSync(join(dir, 'events.jsonl'), events)
  return dir
}

test("copilot declares what it cannot do rather than inheriting opencode's answers", () => {
  const { backend } = harness()
  expect(backend.name).toBe('copilot')
  expect(backend.capabilities).toEqual({ fork: false, rename: false, delete: false, questions: false, messages: false })
})

// The id is minted, not read back: in JSON mode copilot only announces it on the final `result`
// line, so waiting for it would mean dispatch could not return until the session had finished.
test('dispatch mints the session id, passes it to copilot, and returns before the run does', async () => {
  const { backend, spawnImpl } = harness()
  const ref = await backend.dispatch({ prompt: 'fix the flake', directory: '/repo/alpha' })
  expect(ref).toEqual({ id: 'session-1', directory: '/repo/alpha' })
  const [command, args, options] = spawnImpl.mock.calls[0]
  expect(command).toBe('copilot')
  expect(args).toEqual(['--session-id', 'session-1', '-p', 'fix the flake', '--output-format', 'json', '--no-color', '--allow-all-tools'])
  expect(options).toMatchObject({ cwd: '/repo/alpha', detached: true })
})

// M1: same reason as the claude backend — a dispatched agent must not hold a credential that is
// ungated shell on the opencode server.
test('a dispatched run does not inherit the opencode server password', async () => {
  vi.stubEnv('OPENCODE_SERVER_PASSWORD', 'minted-for-the-server')
  try {
    const { backend, spawnImpl } = harness()
    await backend.dispatch({ prompt: 'go', directory: '/repo/alpha' })
    const { env } = spawnImpl.mock.calls[0][2]
    expect(env.OPENCODE_SERVER_PASSWORD).toBeUndefined()
    expect(env.PATH).toBe(process.env.PATH) // the rest of the environment is intact
  } finally {
    vi.unstubAllEnvs()
  }
})

// Without it a backgrounded session can read and answer but not act, and the denial is silent.
test('dispatch allows tools, but does not open paths or urls', async () => {
  const { backend, spawnImpl } = harness()
  await backend.dispatch({ prompt: 'go', directory: '/repo/alpha' })
  const args: string[] = spawnImpl.mock.calls[0][1]
  expect(args).toContain('--allow-all-tools')
  expect(args).not.toContain('--allow-all')
  expect(args).not.toContain('--yolo')
  expect(args).not.toContain('--allow-all-paths')
})

test('model and agent are passed through only when asked for', async () => {
  const { backend, spawnImpl } = harness()
  await backend.dispatch({ prompt: 'go', directory: '/repo/alpha', model: 'gpt-5-mini', agent: 'reviewer' })
  expect(spawnImpl.mock.calls[0][1]).toEqual(expect.arrayContaining(['--model', 'gpt-5-mini', '--agent', 'reviewer']))
})

test('dispatch writes the run to a per-session log under the fleetview config dir', async () => {
  const { backend, spawnImpl, logDir } = harness()
  await backend.dispatch({ prompt: 'go', directory: '/repo/alpha' })
  const { stdio } = spawnImpl.mock.calls[0][2]
  expect(stdio[0]).toBe('ignore')
  expect(stdio[1]).toBe(stdio[2]) // one fd for stdout and stderr, so a CLI error lands in the transcript
  expect(readFileSync(join(logDir, 'session-1.jsonl'), 'utf8')).toBe('')
})

// The log dir gained a file per dispatch and nothing ever removed them, so a heavy user's captures
// accumulated forever — the same leak the claude backend's reap fixed.
test('dispatch reaps captures that have gone cold, and leaves recent ones', async () => {
  const day = 24 * 60 * 60 * 1000
  const clock = { t: 1_700_000_000_000 } // injected, so the window is exercised against a fixed cutoff
  const { backend, logDir } = harness({ now: () => clock.t })
  await backend.dispatch({ prompt: 'old work', directory: '/repo/alpha' })
  clock.t += 29 * day
  await backend.dispatch({ prompt: 'newer work', directory: '/repo/alpha' })
  // mtime is what decides, not the dispatch time: a session resumed last week is live work whatever
  // day its first prompt was sent.
  const old = (clock.t - 40 * day) / 1000
  utimesSync(join(logDir, 'session-1.jsonl'), old, old)
  clock.t += 2 * day
  await backend.dispatch({ prompt: 'triggers the sweep', directory: '/repo/alpha' })
  expect(readdirSync(logDir).sort()).toEqual(['session-2.jsonl', 'session-3.jsonl'])
})

// A session whose log never gets a line would sit at `working` forever, which is the one status a
// roster must never be wrong about.
test('a spawn that fails asynchronously is recorded as a failed run, not left running', async () => {
  const { backend, child, logDir } = harness()
  await backend.dispatch({ prompt: 'go', directory: '/repo/alpha' })
  child.fail(new Error('spawn copilot ENOENT'))
  expect(JSON.parse(readFileSync(join(logDir, 'session-1.jsonl'), 'utf8'))).toEqual({ type: 'result', sessionId: 'session-1', exitCode: 127 })
})

test('a spawn with no pid fails the dispatch rather than returning a ref', async () => {
  const { backend } = harness({ noPid: true })
  await expect(backend.dispatch({ prompt: 'go', directory: '/repo/alpha' })).rejects.toThrow('did not start')
})

// Resume is a second process, not a message to a running one.
test('prompt resumes the session in place', async () => {
  const { backend, spawnImpl } = harness()
  await backend.prompt('abc-123', 'and now the tests', '/repo/alpha')
  expect(spawnImpl.mock.calls[0][1]).toEqual(['--resume=abc-123', '-p', 'and now the tests', '--output-format', 'json', '--no-color', '--allow-all-tools'])
  expect(spawnImpl.mock.calls[0][2]).toMatchObject({ cwd: '/repo/alpha' })
})

// -C is applied as a chdir before anything else; the pty host's cwd is fleetview's, not the
// session's, so without it a resume lands in the wrong repository.
test('attach argv resumes the session in its own directory', () => {
  expect(harness().backend.attach({ id: 'abc-123', directory: '/repo/alpha' })).toEqual(['copilot', '-C', '/repo/alpha', '--resume=abc-123'])
})

test("listSessions reads the directory's sessions off disk", async () => {
  const { backend, stateDir } = harness()
  writeSession(stateDir, 'here', '/repo/alpha')
  writeSession(stateDir, 'there', '/repo/beta')
  expect((await backend.listSessions('/repo/alpha')).map((s: any) => s.id)).toEqual(['here'])
})

// The node wrapper and the native binary it execs are two processes; killing the wrapper alone was
// verified to leave the native one running and the session still locked.
test('abort signals the whole process group of a run fleetview started', async () => {
  const { backend, killImpl } = harness({ pid: 777 })
  await backend.dispatch({ prompt: 'go', directory: '/repo/alpha' })
  expect(await backend.abort('session-1', '/repo/alpha')).toEqual({ aborted: true })
  expect(killImpl).toHaveBeenCalledWith(-777, 'SIGTERM')
})

// Started by another fleetview run or by the user: the lock names the native process, which is not a
// group leader, so it is signalled directly.
test('abort falls back to the pid in the lock file for a session it did not start', async () => {
  // The lock's holder is a resume, and a resume's argv always carries `--resume=<id>` — which is
  // now the only identity abort accepts for a pid it did not spawn itself.
  const { backend, killImpl, stateDir } = harness({ psImpl: () => ({ startedAt: Date.now(), command: 'copilot --resume=foreign' }) })
  writeSession(stateDir, 'foreign', '/repo/alpha', { pid: 555 })
  expect(await backend.abort('foreign', '/repo/alpha')).toEqual({ aborted: true })
  expect(killImpl).toHaveBeenCalledWith(555, 'SIGTERM')
})

// The lock survives a crash, and a crashed session's pid can have been handed to anything — the
// same recycled-pid refusal as the claude backend's abort, anchored on the lock's mtime because a
// foreign session has no run meta to say when it started.
test('abort refuses a lock whose pid was recycled by another process', async () => {
  const { backend, killImpl, stateDir } = harness({ psImpl: () => ({ startedAt: Date.now() + 3 * 60 * 60 * 1000, command: 'copilot' }) })
  writeSession(stateDir, 'crashed', '/repo/alpha', { pid: 555 })
  expect(await backend.abort('crashed', '/repo/alpha')).toEqual({ aborted: false })
  expect(killImpl).not.toHaveBeenCalled()
})

// A right-class process born inside the old one-minute slack window used to be accepted with no id
// in its argv — the recycled-pid window the guard now closes by refusing anything unverifiable.
test('abort refuses a copilot born at the lock time when its argv does not name the session', async () => {
  const { backend, killImpl, stateDir } = harness({ psImpl: () => ({ startedAt: Date.now(), command: 'copilot' }) })
  writeSession(stateDir, 'foreign', '/repo/alpha', { pid: 555 })
  expect(await backend.abort('foreign', '/repo/alpha')).toEqual({ aborted: false })
  expect(killImpl).not.toHaveBeenCalled()
})

test('abort refuses a lock whose pid is not a copilot', async () => {
  const { backend, killImpl, stateDir } = harness({ psImpl: () => ({ startedAt: Date.now(), command: 'Safari' }) })
  writeSession(stateDir, 'crashed', '/repo/alpha', { pid: 555 })
  expect(await backend.abort('crashed', '/repo/alpha')).toEqual({ aborted: false })
  expect(killImpl).not.toHaveBeenCalled()
})

test('abort of a lock whose process is gone is a no-op without ever signalling', async () => {
  const { backend, killImpl, stateDir } = harness({ psImpl: () => null })
  writeSession(stateDir, 'gone', '/repo/alpha', { pid: 555 })
  expect(await backend.abort('gone', '/repo/alpha')).toEqual({ aborted: false })
  expect(killImpl).not.toHaveBeenCalled()
})

// No usable ps is not evidence of staleness: refusing would make every abort on such a host a
// silent no-op forever, so the guard steps aside instead.
test('abort still signals when ps cannot answer', async () => {
  const { backend, killImpl, stateDir } = harness({ psImpl: () => 'unavailable' })
  writeSession(stateDir, 'foreign', '/repo/alpha', { pid: 555 })
  expect(await backend.abort('foreign', '/repo/alpha')).toEqual({ aborted: true })
  expect(killImpl).toHaveBeenCalledWith(555, 'SIGTERM')
})

// pid 0 addresses the caller's own process group to kill(2): a corrupt or planted inuse.0.lock
// must not turn abort into fleetview signalling itself.
test('abort ignores a lock naming pid 0 instead of signalling its own process group', async () => {
  const { backend, killImpl, stateDir } = harness()
  writeSession(stateDir, 'planted', '/repo/alpha', { pid: 0 })
  expect(await backend.abort('planted', '/repo/alpha')).toEqual({ aborted: false })
  expect(killImpl).not.toHaveBeenCalled()
})

test('aborting a session that is not running signals nothing', async () => {
  const { backend, killImpl, stateDir } = harness()
  writeSession(stateDir, 'done', '/repo/alpha')
  expect(await backend.abort('done', '/repo/alpha')).toEqual({ aborted: false })
  expect(killImpl).not.toHaveBeenCalled()
})

// capabilities says false; rejecting is the difference between a key the UI hides and a key that
// looks like it worked.
test('rename and delete reject instead of silently doing nothing', async () => {
  const { backend } = harness()
  await expect(backend.rename('id', 'title', '/repo/alpha')).rejects.toThrow('cannot rename')
  await expect(backend.delete('id', '/repo/alpha')).rejects.toThrow('cannot delete')
})

const RESULT = (id: string, exitCode = 0) => `${JSON.stringify({ type: 'result', sessionId: id, exitCode })}\n`
const SAID = (text: string) => `${JSON.stringify({ type: 'assistant.message', data: { content: text } })}\n`

test('events reports a running session as working, from the lock alone', async () => {
  const { backend, stateDir } = harness()
  writeSession(stateDir, 'busy', '/repo/alpha', { pid: 12, events: SAID('halfway there') })
  const onEvent = vi.fn()
  const sub = backend.events({ directory: '/repo/alpha' }, { onEvent })
  await vi.waitFor(() => expect(onEvent).toHaveBeenCalled())
  sub.stop()
  await sub.done
  expect(onEvent).toHaveBeenCalledWith('/repo/alpha', expect.objectContaining({ type: 'copilot.session', sessionId: 'busy', status: 'working', lastOutput: 'halfway there' }))
})

// The reader has to fold onto the state it already had: it only sees the bytes appended since the
// last tick, so a status that arrives in a later chunk must not lose the output from an earlier one.
test('events picks up appended lines without re-reading the log', async () => {
  const { backend, stateDir } = harness()
  const dir = writeSession(stateDir, 'growing', '/repo/alpha', { pid: 12, events: SAID('starting') })
  const onEvent = vi.fn()
  const sub = backend.events({ directory: '/repo/alpha' }, { onEvent })
  await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1))
  appendFileSync(join(dir, 'events.jsonl'), SAID('all green') + RESULT('growing'))
  rmSync(join(dir, 'inuse.12.lock')) // the process exited and took its lock with it
  await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(2))
  sub.stop()
  await sub.done
  expect(onEvent.mock.calls[1][1]).toMatchObject({ status: 'completed', lastOutput: 'all green' })
})

// M5: readFrom's `size < offset` only catches a rewrite that came out shorter. A transcript replaced
// by rename-over is a different inode at whatever size it likes, and one that lands larger keeps the
// old offset — which now points into the middle of some line of a file the reader has never seen.
test('a transcript replaced by a LARGER rename-over is re-folded from the start, not from the stale offset', async () => {
  const { backend, stateDir } = harness()
  const dir = writeSession(stateDir, 'swapped', '/repo/alpha', { pid: 12, events: SAID('first answer') })
  const onEvent = vi.fn()
  const sub = backend.events({ directory: '/repo/alpha' }, { onEvent })
  try {
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1))
    // Padded so the replacement is comfortably larger than what it replaces.
    writeFileSync(join(dir, 'events.jsonl.new'), SAID(`second answer ${'x'.repeat(500)}`) + RESULT('swapped'))
    renameSync(join(dir, 'events.jsonl.new'), join(dir, 'events.jsonl'))
    rmSync(join(dir, 'inuse.12.lock')) // the process exited and took its lock with it
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(2))
  } finally {
    sub.stop()
    await sub.done
  }
  // The message line lives before the stale offset: seeing it at all is the proof the tail reset.
  expect(onEvent.mock.calls[1][1]).toMatchObject({ status: 'completed', lastOutput: `second answer ${'x'.repeat(500)}` })
})

// Without this every session in the directory would produce an event every 1.5 seconds forever.
test('events stay quiet while nothing about a session changes', async () => {
  const { backend, stateDir } = harness()
  writeSession(stateDir, 'settled', '/repo/alpha', { events: SAID('done') + RESULT('settled') })
  const onEvent = vi.fn()
  const sub = backend.events({ directory: '/repo/alpha' }, { onEvent })
  await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1))
  await new Promise((r) => setTimeout(r, 30)) // several poll intervals
  sub.stop()
  await sub.done
  expect(onEvent).toHaveBeenCalledTimes(1)
})

// Aborted or crashed: the process is gone and it never reported a result. Calling that `completed`
// would put a green row on work that never happened.
test('a session whose process vanished without a result is failed, not completed', async () => {
  const { backend, stateDir } = harness()
  writeSession(stateDir, 'killed', '/repo/alpha', { events: SAID('was working on it') })
  const onEvent = vi.fn()
  const sub = backend.events({ directory: '/repo/alpha' }, { onEvent })
  await vi.waitFor(() => expect(onEvent).toHaveBeenCalled())
  sub.stop()
  await sub.done
  expect(onEvent.mock.calls[0][1]).toMatchObject({ status: 'failed', lastOutput: 'was working on it' })
})

// fleetview's own capture also holds stderr and the synthetic failure line, so it wins for runs
// this process started; copilot's transcript is what makes a session fleetview never started
// readable at all.
test("events prefer fleetview's own log for a run this process started", async () => {
  const { backend, stateDir, logDir } = harness()
  await backend.dispatch({ prompt: 'go', directory: '/repo/alpha' })
  writeSession(stateDir, 'session-1', '/repo/alpha', { events: SAID('from copilot') + RESULT('session-1') })
  writeFileSync(join(logDir, 'session-1.jsonl'), SAID('from fleetview') + RESULT('session-1'))
  const onEvent = vi.fn()
  const sub = backend.events({ directory: '/repo/alpha' }, { onEvent })
  await vi.waitFor(() => expect(onEvent).toHaveBeenCalled())
  sub.stop()
  await sub.done
  expect(onEvent.mock.calls[0][1]).toMatchObject({ lastOutput: 'from fleetview' })
})

// `started` is abort's bookkeeping and abort deletes from it — the own-capture preference must not
// follow it, or aborting a run silently repoints its tail at copilot's transcript and the captured
// stderr and synthetic failure line become unreachable.
test('abort does not repoint events at the transcript for a run this process started', async () => {
  const { backend, stateDir, logDir } = harness({ pid: 777 })
  await backend.dispatch({ prompt: 'go', directory: '/repo/alpha' })
  writeSession(stateDir, 'session-1', '/repo/alpha', { events: SAID('from copilot') + RESULT('session-1') })
  writeFileSync(join(logDir, 'session-1.jsonl'), SAID('from fleetview stderr') + RESULT('session-1'))
  await backend.abort('session-1', '/repo/alpha')
  const onEvent = vi.fn()
  const sub = backend.events({ directory: '/repo/alpha' }, { onEvent })
  await vi.waitFor(() => expect(onEvent).toHaveBeenCalled())
  sub.stop()
  await sub.done
  expect(onEvent.mock.calls[0][1]).toMatchObject({ lastOutput: 'from fleetview stderr' })
})

// On Linux a forward wall-clock step shifts every procps lstart while the lock mtime stays put —
// an argv naming the session is the clock-independent identity that keeps a live run abortable.
test('abort trusts a lock whose pid argv names the session, whatever the clock says', async () => {
  const { backend, killImpl, stateDir } = harness({ psImpl: () => ({ startedAt: Date.now() + 3 * 60 * 60 * 1000, command: 'copilot --resume=stepped -p go' }) })
  writeSession(stateDir, 'stepped', '/repo/alpha', { pid: 555 })
  expect(await backend.abort('stepped', '/repo/alpha')).toEqual({ aborted: true })
  expect(killImpl).toHaveBeenCalledWith(555, 'SIGTERM')
})

// The log dir is never reaped, so after a restart an old capture — frozen on some earlier run's
// result — must not outrank the transcript a live resume is appending to.
test('a stale capture from a previous fleetview run does not pin a discovered session', async () => {
  const { backend, stateDir, logDir } = harness()
  writeSession(stateDir, 'resumed', '/repo/alpha', { events: SAID('live answer') + RESULT('resumed') })
  writeFileSync(join(logDir, 'resumed.jsonl'), SAID('stale answer') + RESULT('resumed'))
  const onEvent = vi.fn()
  const sub = backend.events({ directory: '/repo/alpha' }, { onEvent })
  await vi.waitFor(() => expect(onEvent).toHaveBeenCalled())
  sub.stop()
  await sub.done
  expect(onEvent.mock.calls[0][1]).toMatchObject({ lastOutput: 'live answer' })
})

// Copilot writes the state directory a moment after the process starts, and never at all if the
// process could not start. Built from disk alone, the roster would drop the first case for a tick
// and the second one forever.
test('a session fleetview just dispatched is visible before copilot has written it to disk', async () => {
  const { backend } = harness()
  await backend.dispatch({ prompt: 'go', directory: '/repo/alpha' })
  const onEvent = vi.fn()
  const sub = backend.events({ directory: '/repo/alpha' }, { onEvent })
  await vi.waitFor(() => expect(onEvent).toHaveBeenCalled())
  sub.stop()
  await sub.done
  expect(onEvent.mock.calls[0][1]).toMatchObject({ sessionId: 'session-1', status: 'working' })
})

// The gap the spawn-failure handler doesn't cover: copilot started, rejected the argv, and exited
// non-zero with plain text on stdout. No state directory is ever written, so the id never reaches
// disk and never leaves `started` (only abort() removes entries), and `child.on('error')` never
// fires because that is a spawn failure only. Hardcoding `running: true` for pending entries left
// such a session claiming `working` until fleetview restarted.
test('a pending session whose process is gone reads as failed, and one still alive stays working', async () => {
  const dead = harness({
    killImpl: vi.fn((_pid: number, signal?: any) => {
      if (signal === 0) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    }),
  })
  await dead.backend.dispatch({ prompt: 'go', directory: '/repo/alpha' })
  const deadEvents = vi.fn()
  const deadSub = dead.backend.events({ directory: '/repo/alpha' }, { onEvent: deadEvents })
  await vi.waitFor(() => expect(deadEvents).toHaveBeenCalled())
  deadSub.stop()
  await deadSub.done
  expect(deadEvents.mock.calls[0][1]).toMatchObject({ sessionId: 'session-1', status: 'failed' })
  // The probe is signal 0 against the pid `started` recorded, not a signal that would end the run.
  expect(dead.killImpl).toHaveBeenCalledWith(4242, 0)

  // EPERM means the process exists and belongs to somebody else — still alive, still working.
  const live = harness({
    killImpl: vi.fn((_pid: number, signal?: any) => {
      if (signal === 0) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
    }),
  })
  await live.backend.dispatch({ prompt: 'go', directory: '/repo/alpha' })
  const liveEvents = vi.fn()
  const liveSub = live.backend.events({ directory: '/repo/alpha' }, { onEvent: liveEvents })
  await vi.waitFor(() => expect(liveEvents).toHaveBeenCalled())
  liveSub.stop()
  await liveSub.done
  expect(liveEvents.mock.calls[0][1]).toMatchObject({ sessionId: 'session-1', status: 'working' })
})

test('a dispatch that could not spawn is reported as failed rather than staying working', async () => {
  const { backend, child } = harness()
  await backend.dispatch({ prompt: 'go', directory: '/repo/alpha' })
  child.fail(new Error('spawn copilot ENOENT'))
  const onEvent = vi.fn()
  const sub = backend.events({ directory: '/repo/alpha' }, { onEvent })
  await vi.waitFor(() => expect(onEvent).toHaveBeenCalled())
  sub.stop()
  await sub.done
  expect(onEvent.mock.calls[0][1]).toMatchObject({ sessionId: 'session-1', status: 'failed' })
})

// Sessions dispatched elsewhere are not this directory's business, however loud their log is.
test('a session dispatched into another directory is not carried into this one', async () => {
  const { backend } = harness()
  await backend.dispatch({ prompt: 'go', directory: '/repo/beta' })
  const onEvent = vi.fn()
  const sub = backend.events({ directory: '/repo/alpha' }, { onEvent })
  await new Promise((r) => setTimeout(r, 30))
  sub.stop()
  await sub.done
  expect(onEvent).not.toHaveBeenCalled()
})

// The result is written before the process exits, so deferring to the lock would report `working`
// for the moment between the two.
test('a run that has reported its result is not held at working by a lingering lock', async () => {
  const { backend, stateDir } = harness()
  writeSession(stateDir, 'exiting', '/repo/alpha', { pid: 12, events: SAID('all done') + RESULT('exiting') })
  const onEvent = vi.fn()
  const sub = backend.events({ directory: '/repo/alpha' }, { onEvent })
  await vi.waitFor(() => expect(onEvent).toHaveBeenCalled())
  sub.stop()
  await sub.done
  expect(onEvent.mock.calls[0][1]).toMatchObject({ status: 'completed' })
})

// There is no server in front of this, so there is no offline state — but a caller that gates on
// onOnline must not wait forever for a signal that never comes.
test('events announce online once and never offline', async () => {
  const { backend, stateDir } = harness()
  writeSession(stateDir, 'x', '/repo/alpha', { events: RESULT('x') })
  const onOnline = vi.fn()
  const onOffline = vi.fn()
  const sub = backend.events({ directory: '/repo/alpha' }, { onEvent: vi.fn(), onOnline, onOffline })
  await vi.waitFor(() => expect(onOnline).toHaveBeenCalledTimes(1))
  await new Promise((r) => setTimeout(r, 30))
  sub.stop()
  await sub.done
  expect(onOnline).toHaveBeenCalledTimes(1)
  expect(onOffline).not.toHaveBeenCalled()
})

test('stop() ends the poller and settles done', async () => {
  const { backend } = harness()
  const sub = backend.events({ directory: '/repo/alpha' }, { onEvent: vi.fn() })
  sub.stop()
  await expect(sub.done).resolves.toBeUndefined()
})

// The lock is only removed by an orderly exit, so a SIGKILL or crash leaves one naming a dead pid.
// Trusting the file alone showed that session `working` forever.
test('a stale lock from a crashed process reads as failed, not working', async () => {
  const killImpl = vi.fn((pid: number, signal?: unknown) => {
    if (signal === 0) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
  })
  const { backend, stateDir } = harness({ killImpl })
  writeSession(stateDir, 'crashed', '/repo/alpha', { pid: 99, events: SAID('was working') })
  const onEvent = vi.fn()
  const sub = backend.events({ directory: '/repo/alpha' }, { onEvent })
  await vi.waitFor(() => expect(onEvent).toHaveBeenCalled())
  sub.stop()
  await sub.done
  expect(onEvent.mock.calls[0][1]).toMatchObject({ sessionId: 'crashed', status: 'failed' })
})

// EPERM answers the probe for a live process owned by someone else, which still means "exists".
test('a lock whose pid answers EPERM still counts as running', async () => {
  const killImpl = vi.fn((pid: number, signal?: unknown) => {
    if (signal === 0) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
  })
  const { backend, stateDir } = harness({ killImpl })
  writeSession(stateDir, 'shared', '/repo/alpha', { pid: 99, events: SAID('still going') })
  const onEvent = vi.fn()
  const sub = backend.events({ directory: '/repo/alpha' }, { onEvent })
  await vi.waitFor(() => expect(onEvent).toHaveBeenCalled())
  sub.stop()
  await sub.done
  expect(onEvent.mock.calls[0][1]).toMatchObject({ sessionId: 'shared', status: 'working' })
})

// ESRCH from either kill path means the run already ended; the other two backends answer
// `aborted: false` there, and this one used to throw instead.
test('aborting a run whose process already exited is a no-op, not a rejection', async () => {
  const killImpl = vi.fn(() => {
    throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
  })
  const { backend, stateDir } = harness({ killImpl })
  const ref = await backend.dispatch({ prompt: 'x', directory: '/repo/alpha' })
  await expect(backend.abort(ref.id, '/repo/alpha')).resolves.toEqual({ aborted: false })
  writeSession(stateDir, 'foreign-dead', '/repo/alpha', { pid: 555 })
  await expect(backend.abort('foreign-dead', '/repo/alpha')).resolves.toEqual({ aborted: false })
})

// A positional read ends wherever the file did — routinely mid-character once a session prints an
// em dash. Decoding each chunk on its own corrupts the line it lands in, and the parse failure that
// follows can swallow the `result`.
test('a multi-byte character split across two ticks decodes intact', async () => {
  const { backend, stateDir } = harness()
  const dir = writeSession(stateDir, 'utf8', '/repo/alpha', { pid: 12 })
  const line = Buffer.from(SAID('done — verified'))
  const cut = line.indexOf(Buffer.from('—')) + 1 // one byte into the three-byte dash
  writeFileSync(join(dir, 'events.jsonl'), line.subarray(0, cut))
  const onEvent = vi.fn()
  const sub = backend.events({ directory: '/repo/alpha' }, { onEvent })
  await new Promise((r) => setTimeout(r, 20)) // let a tick read the torn half
  appendFileSync(join(dir, 'events.jsonl'), line.subarray(cut))
  await vi.waitFor(() => expect(onEvent.mock.calls.at(-1)?.[1]).toMatchObject({ lastOutput: 'done — verified' }))
  sub.stop()
  await sub.done
})

// The id becomes argv on attach, so a malformed one is refused with a throw rather than handed to
// a spawn — parseWorkspace filters separators at discovery, but attach is the last line before the child.
test('attach refuses a session id with flag syntax or control bytes', () => {
  const { backend } = harness()
  expect(() => backend.attach({ id: '--banner', directory: '/repo/alpha' })).toThrow(/malformed session id/)
  expect(() => backend.attach({ id: `ok${String.fromCharCode(27)}[2Jbad`, directory: '/repo/alpha' })).toThrow(/malformed session id/)
})

// prompt() spawns `copilot --resume=<id> …`; defense-in-depth, the id is asserted before the spawn.
test('prompt refuses a session id with flag syntax', async () => {
  const { backend, spawnImpl } = harness()
  await expect(backend.prompt('--banner', 'go', '/repo/alpha')).rejects.toThrow(/malformed session id/)
  expect(spawnImpl).not.toHaveBeenCalled()
})

// mode on open only applies when it creates, so a pre-existing capture kept its perms while
// receiving prompts and repo paths — every open re-tightens the file and its dir now.
test('a pre-existing capture is re-tightened to 0600 on the next run', async () => {
  const { backend, logDir } = harness()
  await backend.dispatch({ prompt: 'fix the flake', directory: '/repo/alpha' })
  const log = join(logDir, 'session-1.jsonl')
  const { chmodSync, statSync } = await import('node:fs')
  chmodSync(log, 0o644)
  chmodSync(logDir, 0o755)
  await backend.prompt('session-1', 'again', '/repo/alpha')
  expect(statSync(log).mode & 0o777).toBe(0o600)
  expect(statSync(logDir).mode & 0o777).toBe(0o700)
})

// The tails map gains an entry per session ever seen, and copilot deleting a session's state dir is
// the only thing that removes its files — so without pruning a long-lived subscription pins a folded
// RunState, a decoder and a partial-line string per session forever. The proof pruning happened is
// behavioral: the transcript keeps its inode across the rename, so no reset fires, and only a
// dropped tail (fresh fold, fresh emitted-signature) explains the event re-emitting unchanged.
test('a tail whose session vanished is pruned, so a returning session re-folds and re-emits from scratch', async () => {
  const { backend, stateDir } = harness()
  const dir = writeSession(stateDir, 'wanderer', '/repo/alpha', { pid: 12, events: SAID('halfway there') })
  const onEvent = vi.fn()
  const sub = backend.events({ directory: '/repo/alpha' }, { onEvent })
  try {
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1))
    // Hide the workspace.yaml, as deletion of the session would: a dir without one is skipped as
    // mid-creation, so the session drops out of visible() and its tail must be dropped with it.
    // events.jsonl itself never moves, so its inode and size are unchanged throughout — a surviving
    // tail would see no reset, no new bytes, an unchanged emitted-signature, and never emit again.
    renameSync(join(dir, 'workspace.yaml'), join(dir, 'workspace.yaml.hidden'))
    await new Promise((r) => setTimeout(r, 50)) // several ticks with the session invisible
    renameSync(join(dir, 'workspace.yaml.hidden'), join(dir, 'workspace.yaml'))
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(2))
    expect(onEvent.mock.calls[1][1]).toMatchObject({ sessionId: 'wanderer', status: 'working', lastOutput: 'halfway there' })
  } finally {
    sub.stop()
    await sub.done
  }
})
