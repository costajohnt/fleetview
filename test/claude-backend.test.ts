import { test, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync, renameSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClaudeBackend } from '../src/backends/claude/index.ts'

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), `fleetview-claude-${prefix}-`))

// The child is never real: these tests are about the argv, the cwd and the files fleetview writes
// around the run, and a real `claude` here would mean a live model call in the suite.
const fakeSpawn = () => {
  const calls: any[] = []
  const impl: any = (command: string, argv: string[], options: any) => {
    calls.push({ command, argv, options })
    return { pid: 4242, on: vi.fn(), unref: vi.fn() }
  }
  impl.calls = calls
  return impl
}

// `home` is always a fresh tmp dir, never the real one: events() now reads ~/.claude/projects for
// discovered sessions, and a test that inherited the developer's home would see their sessions.
const backend = (over: any = {}) => {
  const runDir = over.runDir ?? join(tmp('runs'), 'claude-runs')
  const spawnImpl = over.spawnImpl ?? fakeSpawn()
  const home = over.home ?? tmp('home')
  // A pid that always looks like the run it was recorded for, so abort tests exercise the signal
  // path rather than the recycled-pid refusal (which has its own tests below).
  const psImpl = over.psImpl ?? (() => ({ startedAt: Date.now(), command: 'claude' }))
  return { runDir, spawnImpl, home, b: createClaudeBackend({ runDir, spawnImpl, home, psImpl, ...over }) }
}

// A Claude Code transcript, in the shape 2.1.220 writes: one record per line, `cwd` on the
// user/assistant records, assistant content in the same shape the stream uses.
function transcript(home: string, directory: string, id: string, records: unknown[]) {
  const dir = join(home, '.claude', 'projects', directory.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${id}.jsonl`)
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return file
}

test('claude declares what it cannot do rather than inheriting opencode’s answers', () => {
  // fork is the interesting false: `claude --resume --fork-session` works, but the Backend contract
  // has no fork() to reach it, so the flag describes fleetview, not the CLI.
  expect(backend().b.capabilities).toEqual({ fork: false, rename: false, delete: false, questions: false })
  expect(backend().b.name).toBe('claude')
})

test('dispatch spawns a detached headless run in the target directory, with an id it minted itself', async () => {
  const { b, spawnImpl, runDir } = backend()
  const ref = await b.dispatch({ prompt: 'fix the flake', directory: '/repo/alpha', model: 'haiku', agent: 'build' })
  const [call] = spawnImpl.calls
  expect(call.command).toBe('claude')
  // The prompt is positional and rides last behind `--`: a prompt starting with `-` would otherwise
  // be parsed as flags (`claude -p '--version'` prints the version instead of running).
  expect(call.argv).toEqual(['-p', '--output-format=stream-json', '--verbose', '--session-id', ref.id, '--model', 'haiku', '--agent', 'build', '--', 'fix the flake'])
  expect(call.options.cwd).toBe('/repo/alpha')
  expect(call.options.detached).toBe(true)
  expect(ref.directory).toBe('/repo/alpha')
  // The id is known before the process is: no waiting on the init event to name the session.
  expect(ref.id).toMatch(/^[0-9a-f-]{36}$/)
  expect(readdirSync(runDir).sort()).toEqual([`${ref.id}.json`, `${ref.id}.jsonl`])
})

// M1: a dispatched agent runs attacker-influenced prompts, and the opencode server password is
// ungated shell over loopback (POST /session/:id/shell) for anything that holds it.
test('a dispatched run does not inherit the opencode server password', async () => {
  vi.stubEnv('OPENCODE_SERVER_PASSWORD', 'minted-for-the-server')
  try {
    const { b, spawnImpl } = backend()
    await b.dispatch({ prompt: 'fix the flake', directory: '/repo/alpha' })
    expect(spawnImpl.calls[0].options.env).toBeDefined()
    expect(spawnImpl.calls[0].options.env.OPENCODE_SERVER_PASSWORD).toBeUndefined()
    expect(spawnImpl.calls[0].options.env.PATH).toBe(process.env.PATH) // the rest of the environment is intact
  } finally {
    vi.unstubAllEnvs()
  }
})

test('the run is recorded with its pid and directory so abort and events can find it', async () => {
  const { b, runDir } = backend({ now: () => 1_700_000_000_000 })
  const ref = await b.dispatch({ prompt: 'fix the flake', directory: '/repo/alpha' })
  expect(JSON.parse(readFileSync(join(runDir, `${ref.id}.json`), 'utf8'))).toEqual({
    id: ref.id,
    directory: '/repo/alpha',
    pid: 4242,
    startedAt: 1_700_000_000_000,
  })
})

// Both streams onto one appended fd: a spawn failure ends up in the same file as the run it failed
// to start, and the parser skips the line that isn't JSON.
test('stdout and stderr both go to the session log, appended', async () => {
  const { b, spawnImpl, runDir } = backend()
  const ref = await b.dispatch({ prompt: 'fix the flake', directory: '/repo/alpha' })
  const [, out, err] = spawnImpl.calls[0].options.stdio
  expect(spawnImpl.calls[0].options.stdio[0]).toBe('ignore')
  expect(out).toBe(err)
  expect(typeof out).toBe('number')
  expect(readdirSync(runDir)).toContain(`${ref.id}.jsonl`)
})

// A spawn that never starts (ENOENT for a missing claude) fires an async 'error' event and writes
// nothing. Without a synthetic terminal line the row would say `working` forever; here the backend
// writes a failed `result` into the log, which events() tails like any other line.
test('a spawn failure writes a failed result to the log, so the row can leave working', async () => {
  const spawnImpl: any = () => ({
    pid: undefined,
    on: (event: string, cb: () => void) => {
      if (event === 'error') cb()
    },
    unref: vi.fn(),
  })
  const runDir = join(tmp('runs'), 'claude-runs')
  const b = createClaudeBackend({ runDir, spawnImpl, home: tmp('home') })
  const ref = await b.dispatch({ prompt: 'fix the flake', directory: '/repo/alpha' })
  const lines = readFileSync(join(runDir, `${ref.id}.jsonl`), 'utf8').trim().split('\n')
  expect(JSON.parse(lines.at(-1)!)).toEqual({ type: 'result', is_error: true, subtype: 'error_during_execution', session_id: ref.id })
})

// The gap 'error' does not cover: the spawn succeeded and the CLI itself rejected the run — an
// unknown flag, an older CLI refusing --agent/--model/--session-id, an auth failure. It exits
// non-zero having written plain text, which parseStreamChunk drops, so without an exit handler no
// `result` is ever folded and the row renders `idle`: indistinguishable from a session created and
// never used.
test('a run that exits non-zero writes a failed result, and a clean exit writes nothing', async () => {
  const spawnFor = (code: number | null) => (): any => ({
    pid: 4242,
    on: (event: string, cb: (arg: any) => void) => {
      if (event === 'exit') cb(code)
    },
    unref: vi.fn(),
  })
  const failedDir = join(tmp('runs'), 'claude-runs')
  const failed = await createClaudeBackend({ runDir: failedDir, spawnImpl: spawnFor(1), home: tmp('home') }).dispatch({ prompt: 'go', directory: '/repo/alpha' })
  const lines = readFileSync(join(failedDir, `${failed.id}.jsonl`), 'utf8').trim().split('\n')
  expect(JSON.parse(lines.at(-1)!)).toEqual({ type: 'result', is_error: true, subtype: 'error_during_execution', session_id: failed.id })

  // A run that exits 0 reported its own outcome in the stream; a synthetic line here would
  // contradict it.
  const okDir = join(tmp('runs'), 'claude-runs')
  const ok = await createClaudeBackend({ runDir: okDir, spawnImpl: spawnFor(0), home: tmp('home') }).dispatch({ prompt: 'go', directory: '/repo/alpha' })
  expect(readFileSync(join(okDir, `${ok.id}.jsonl`), 'utf8')).toBe('')
})

// 'error' and 'exit' can both fire for the same child (a spawn failure is reported as an error and
// then an exit), and two terminal lines in one log is a contradiction the fold would have to
// arbitrate.
test('error and exit together write exactly one synthetic result', async () => {
  const spawnImpl: any = () => ({
    pid: undefined,
    on: (event: string, cb: (arg: any) => void) => {
      if (event === 'error') cb(new Error('spawn claude ENOENT'))
      if (event === 'exit') cb(127)
    },
    unref: vi.fn(),
  })
  const runDir = join(tmp('runs'), 'claude-runs')
  const ref = await createClaudeBackend({ runDir, spawnImpl, home: tmp('home') }).dispatch({ prompt: 'go', directory: '/repo/alpha' })
  const lines = readFileSync(join(runDir, `${ref.id}.jsonl`), 'utf8').trim().split('\n')
  expect(lines).toHaveLength(1)
})

// Resume is scoped by cwd — the same id from a sibling directory fails with "No conversation found"
// before any API call — so the follow-up has to be spawned in the session's own directory.
test('a follow-up prompt resumes the session in its own directory', async () => {
  const { b, spawnImpl } = backend()
  await b.prompt('aaaa-1111', 'now run the tests', '/repo/alpha')
  expect(spawnImpl.calls[0].argv).toEqual(['--resume', 'aaaa-1111', '-p', '--output-format=stream-json', '--verbose', '--', 'now run the tests'])
  expect(spawnImpl.calls[0].options.cwd).toBe('/repo/alpha')
})

test('attach hands back the interactive resume command', () => {
  expect(backend().b.attach({ id: 'aaaa-1111', directory: '/repo/alpha' })).toEqual(['claude', '--resume', 'aaaa-1111'])
})

// Negative pid: `detached: true` made the run a process group leader, and a session's tool
// subprocesses have to die with it.
test('abort signals the run’s whole process group', async () => {
  const killImpl = vi.fn()
  const { b } = backend({ killImpl })
  const ref = await b.dispatch({ prompt: 'fix the flake', directory: '/repo/alpha' })
  expect(await b.abort(ref.id, '/repo/alpha')).toEqual({ aborted: true })
  expect(killImpl).toHaveBeenCalledWith(-4242, 'SIGTERM')
})

// The regression this pins: abort() read the meta through a cache that a resume never refreshed,
// so it signalled the first run's dead group and the live resume survived the abort.
test('abort after a follow-up prompt signals the new run, not the first one', async () => {
  const killImpl = vi.fn()
  const pids = [100, 200]
  const spawnImpl: any = (command: string, argv: string[], options: any) => {
    spawnImpl.calls.push({ command, argv, options })
    return { pid: pids[spawnImpl.calls.length - 1], on: vi.fn(), unref: vi.fn() }
  }
  spawnImpl.calls = []
  const { b } = backend({ killImpl, spawnImpl })
  const ref = await b.dispatch({ prompt: 'fix the flake', directory: '/repo/alpha' })
  expect(await b.abort(ref.id, '/repo/alpha')).toEqual({ aborted: true }) // primes the cache
  await b.prompt(ref.id, 'now run the tests', '/repo/alpha')
  expect(await b.abort(ref.id, '/repo/alpha')).toEqual({ aborted: true })
  expect(killImpl).toHaveBeenLastCalledWith(-200, 'SIGTERM')
})

test('aborting a run that already finished is a no-op, not a failure', async () => {
  const killImpl = vi.fn(() => {
    throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
  })
  const { b } = backend({ killImpl })
  const ref = await b.dispatch({ prompt: 'fix the flake', directory: '/repo/alpha' })
  expect(await b.abort(ref.id, '/repo/alpha')).toEqual({ aborted: false })
})

// The meta outlives the run by up to thirty days, so its pid can have been handed to an unrelated
// process — abort must refuse to signal a pid that no longer looks like this run.
test('abort refuses a pid that was recycled by another process', async () => {
  const killImpl = vi.fn()
  // Right name, wrong birth: a fresh claude that happens to occupy the old pid.
  const { b } = backend({ killImpl, now: () => 1_700_000_000_000, psImpl: () => ({ startedAt: 1_700_000_000_000 + 3 * 60 * 60 * 1000, command: 'claude' }) })
  const ref = await b.dispatch({ prompt: 'fix the flake', directory: '/repo/alpha' })
  expect(await b.abort(ref.id, '/repo/alpha')).toEqual({ aborted: false })
  expect(killImpl).not.toHaveBeenCalled()
})

test('abort refuses a pid whose process is not a claude', async () => {
  const killImpl = vi.fn()
  const { b } = backend({ killImpl, psImpl: () => ({ startedAt: Date.now(), command: 'Safari' }) })
  const ref = await b.dispatch({ prompt: 'fix the flake', directory: '/repo/alpha' })
  expect(await b.abort(ref.id, '/repo/alpha')).toEqual({ aborted: false })
  expect(killImpl).not.toHaveBeenCalled()
})

// The strongest identity a pid can offer: its argv carries this session's id, so it is this run
// whatever the clock says (a resume started outside fleetview is still the right thing to signal).
test('abort trusts a pid whose argv names the session, even with a stale meta clock', async () => {
  const killImpl = vi.fn()
  let sessionId = 'not yet dispatched'
  const { b } = backend({ killImpl, psImpl: () => ({ startedAt: Date.now() + 3 * 60 * 60 * 1000, command: `claude -p --session-id ${sessionId}` }) })
  const ref = await b.dispatch({ prompt: 'fix the flake', directory: '/repo/alpha' })
  sessionId = ref.id
  expect(await b.abort(ref.id, '/repo/alpha')).toEqual({ aborted: true })
  expect(killImpl).toHaveBeenCalledWith(-4242, 'SIGTERM')
})

// No usable ps is not evidence of staleness — refusing would make every abort on such a host a
// silent no-op forever, so the guard steps aside instead.
test('abort still signals when ps cannot answer', async () => {
  const killImpl = vi.fn()
  const { b } = backend({ killImpl, psImpl: () => 'unavailable' })
  const ref = await b.dispatch({ prompt: 'fix the flake', directory: '/repo/alpha' })
  expect(await b.abort(ref.id, '/repo/alpha')).toEqual({ aborted: true })
  expect(killImpl).toHaveBeenCalledWith(-4242, 'SIGTERM')
})

test('abort of a run whose pid is gone is a no-op without ever signalling', async () => {
  const killImpl = vi.fn()
  const { b } = backend({ killImpl, psImpl: () => null })
  const ref = await b.dispatch({ prompt: 'fix the flake', directory: '/repo/alpha' })
  expect(await b.abort(ref.id, '/repo/alpha')).toEqual({ aborted: false })
  expect(killImpl).not.toHaveBeenCalled()
})

test('aborting a session fleetview never dispatched reports that it did nothing', async () => {
  const killImpl = vi.fn()
  const { b } = backend({ killImpl })
  expect(await b.abort('discovered-elsewhere', '/repo/alpha')).toEqual({ aborted: false })
  expect(killImpl).not.toHaveBeenCalled()
})

// The run dir gains a pair of files per dispatch and nothing else ever removes them, so without
// this a heavy user's events() poll ends up doing a readdir over every session they have ever
// dispatched, twice a second, forever.
test('dispatch reaps runs whose logs have gone cold, and leaves recent ones', async () => {
  const day = 24 * 60 * 60 * 1000
  const runDir = join(tmp('runs'), 'claude-runs')
  const clock = { t: 1_700_000_000_000 }
  const { b } = backend({ runDir, now: () => clock.t })
  const stale = await b.dispatch({ prompt: 'old work', directory: '/repo/alpha' })
  clock.t += 29 * day
  const recent = await b.dispatch({ prompt: 'newer work', directory: '/repo/alpha' })
  // mtime is what decides, not the recorded start: a run resumed last week is live work whatever
  // day its first prompt was sent.
  const old = (clock.t - 40 * day) / 1000
  utimesSync(join(runDir, `${stale.id}.jsonl`), old, old)
  clock.t += 2 * day
  const trigger = await b.dispatch({ prompt: 'triggers the sweep', directory: '/repo/alpha' })
  expect(readdirSync(runDir).sort()).toEqual([`${recent.id}.json`, `${recent.id}.jsonl`, `${trigger.id}.json`, `${trigger.id}.jsonl`].sort())
})

// Hidden behind capability flags in the roster, but a caller that got here anyway has a bug that a
// resolved promise would hide.
test('rename and delete refuse loudly', async () => {
  const { b } = backend()
  await expect(b.rename('aaaa-1111', 'alpha', '/repo/alpha')).rejects.toThrow(/cannot rename/)
  await expect(b.delete('aaaa-1111', '/repo/alpha')).rejects.toThrow(/cannot delete/)
})

test('listSessions reads Claude Code’s own transcripts, so sessions fleetview never started show up', async () => {
  const { b, home } = backend()
  transcript(home, '/repo/alpha', 'aaaa-1111', [{ type: 'user', cwd: '/repo/alpha', entrypoint: 'cli' }])
  expect(await b.listSessions('/repo/alpha')).toMatchObject([{ id: 'aaaa-1111', directory: '/repo/alpha' }])
})

// The subscription contract opencode's events() satisfies with a socket, satisfied here by tailing
// the log fleetview captured: onEvent per stream-json object, stop() ends the reader, done resolves.
test('events tails a dispatched run’s log, emitting only what was appended since the last poll', async () => {
  const { b, runDir } = backend()
  const ref = await b.dispatch({ prompt: 'fix the flake', directory: '/repo/alpha' })
  const log = join(runDir, `${ref.id}.jsonl`)
  const onEvent = vi.fn()
  const onOnline = vi.fn()
  const sub = b.events({ directory: '/repo/alpha' }, { onEvent, onOnline })
  try {
    appendFileSync(log, JSON.stringify({ type: 'system', subtype: 'init', session_id: ref.id }) + '\n')
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1))
    expect(onEvent).toHaveBeenCalledWith('/repo/alpha', { type: 'system', subtype: 'init', session_id: ref.id })
    // Written in two pieces so the poll that reads the first half has to buffer the partial line.
    appendFileSync(log, '{"type":"assistant","mess')
    appendFileSync(log, 'age":{"content":[{"type":"text","text":"hello"}]}}\n')
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(2))
    expect(onEvent).toHaveBeenLastCalledWith('/repo/alpha', { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } })
  } finally {
    sub.stop()
    await sub.done
  }
  // No server to be offline from, so the directory is online for as long as anyone is subscribed.
  expect(onOnline).toHaveBeenCalledWith('/repo/alpha')
})

// A poll reads to wherever the file happens to end, which is regularly mid-character once the
// session prints anything but ASCII — an em dash, an arrow, a box-drawing frame from a test runner.
test('a multi-byte character split across two polls survives', async () => {
  const pollMs = 20
  const { b, runDir } = backend({ pollMs })
  const ref = await b.dispatch({ prompt: 'fix the flake', directory: '/repo/alpha' })
  const log = join(runDir, `${ref.id}.jsonl`)
  const line = Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done — 3 tests → green' }] } }) + '\n', 'utf8')
  const split = line.indexOf(Buffer.from('—', 'utf8')) + 1 // mid em dash
  const onEvent = vi.fn()
  const sub = b.events({ directory: '/repo/alpha' }, { onEvent })
  try {
    // A complete line first, so its event proves the reader is polling and caught up.
    appendFileSync(log, JSON.stringify({ type: 'system', subtype: 'marker' }) + '\n')
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1))
    appendFileSync(log, line.subarray(0, split))
    // Long enough for several polls: the halves have to land in separate reads, or the decoder is
    // never asked the question this test exists for.
    await new Promise((r) => setTimeout(r, pollMs * 5))
    appendFileSync(log, line.subarray(split))
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(2))
    expect(onEvent.mock.calls.at(-1)?.[1]).toEqual({ type: 'assistant', message: { content: [{ type: 'text', text: 'done — 3 tests → green' }] } })
  } finally {
    sub.stop()
    await sub.done
  }
})

// Compaction rewrites a transcript wholesale, and a rewrite is usually shorter than what it
// replaced. Holding the old offset froze that session's tail forever — nothing it printed after a
// compaction was ever read again.
test('a file rewritten shorter is re-read from the start rather than going silent', async () => {
  const pollMs = 20
  const { b, runDir } = backend({ pollMs })
  const ref = await b.dispatch({ prompt: 'fix the flake', directory: '/repo/alpha' })
  const log = join(runDir, `${ref.id}.jsonl`)
  const onEvent = vi.fn()
  const sub = b.events({ directory: '/repo/alpha' }, { onEvent })
  try {
    appendFileSync(log, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'a long first answer that the rewrite will replace' }] } }) + '\n')
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1))
    writeFileSync(log, JSON.stringify({ type: 'system', subtype: 'compacted' }) + '\n')
    await vi.waitFor(() => expect(onEvent).toHaveBeenLastCalledWith('/repo/alpha', { type: 'system', subtype: 'compacted' }))
    appendFileSync(log, JSON.stringify({ type: 'result', subtype: 'success', session_id: ref.id }) + '\n')
    await vi.waitFor(() => expect(onEvent).toHaveBeenLastCalledWith('/repo/alpha', { type: 'result', subtype: 'success', session_id: ref.id }))
  } finally {
    sub.stop()
    await sub.done
  }
})

// M5: the rewrite need not be shorter. A rewritten transcript delivered by rename-over — write a
// temp file, rename it onto the path — is a different inode at whatever size it likes, and one that
// lands equal-or-larger sails past `size < offset`. The tail then reads from an offset that means
// nothing in the new file: the first line of the rewrite is never seen, and what it does read starts
// mid-line.
test('a file replaced by a LARGER rename-over is re-read from the start, not from the stale offset', async () => {
  const pollMs = 20
  const { b, runDir } = backend({ pollMs })
  const ref = await b.dispatch({ prompt: 'fix the flake', directory: '/repo/alpha' })
  const log = join(runDir, `${ref.id}.jsonl`)
  const onEvent = vi.fn()
  const sub = b.events({ directory: '/repo/alpha' }, { onEvent })
  try {
    appendFileSync(log, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'the answer the rewrite replaces' }] } }) + '\n')
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1))
    // Padded so the replacement is comfortably larger than what it replaces.
    const rewritten = { type: 'system', subtype: 'rewritten', pad: 'x'.repeat(500) }
    writeFileSync(`${log}.new`, JSON.stringify(rewritten) + '\n')
    renameSync(`${log}.new`, log)
    // The first line of the new file is only reachable from offset 0 — reading it at all is the
    // proof the cursor reset, and it is what a stale offset would have skipped.
    await vi.waitFor(() => expect(onEvent).toHaveBeenLastCalledWith('/repo/alpha', rewritten))
    expect(onEvent).toHaveBeenCalledTimes(2) // nothing decoded from the middle of a line in between
  } finally {
    sub.stop()
    await sub.done
  }
})

test('events ignores runs belonging to another directory', async () => {
  const { b, runDir } = backend()
  const alpha = await b.dispatch({ prompt: 'a', directory: '/repo/alpha' })
  const beta = await b.dispatch({ prompt: 'b', directory: '/repo/beta' })
  appendFileSync(join(runDir, `${beta.id}.jsonl`), JSON.stringify({ type: 'result', subtype: 'success', session_id: beta.id }) + '\n')
  appendFileSync(join(runDir, `${alpha.id}.jsonl`), JSON.stringify({ type: 'result', subtype: 'success', session_id: alpha.id }) + '\n')
  const onEvent = vi.fn()
  const sub = b.events({ directory: '/repo/alpha' }, { onEvent })
  try {
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalled())
    expect(onEvent.mock.calls.map(([, e]: any) => e.session_id)).toEqual([alpha.id])
  } finally {
    sub.stop()
    await sub.done
  }
})

// A session started by hand in a terminal has no captured stream, but its transcript's assistant
// records carry message.content in the same shape, so its output is real rather than inferred.
test('events tails a discovered session’s transcript, so a hand-started session is not silent', async () => {
  const pollMs = 20
  const { b, home } = backend({ pollMs })
  const file = transcript(home, '/repo/alpha', 'aaaa-1111', [{ type: 'user', cwd: '/repo/alpha', entrypoint: 'cli', message: { role: 'user', content: 'run the tests' } }])
  const onEvent = vi.fn()
  const sub = b.events({ directory: '/repo/alpha' }, { onEvent })
  try {
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1))
    appendFileSync(file, JSON.stringify({ type: 'assistant', cwd: '/repo/alpha', message: { content: [{ type: 'text', text: '17 passed' }] } }) + '\n')
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(2))
    // Tagged so the normaliser seeds it 'idle' rather than 'working': a transcript has no `result`,
    // so a session read out of one can never move off its seed (run lines above are untagged).
    expect(onEvent.mock.calls.at(-1)?.[1]).toMatchObject({ type: 'assistant', __source: 'transcript', message: { content: [{ type: 'text', text: '17 passed' }] } })
  } finally {
    sub.stop()
    await sub.done
  }
})

// A dispatched session writes both a captured stream and a transcript. Tailing both would deliver
// every assistant message twice.
test('a dispatched session is tailed from its captured stream only, never twice', async () => {
  const pollMs = 20
  const { b, runDir, home } = backend({ pollMs })
  const ref = await b.dispatch({ prompt: 'fix the flake', directory: '/repo/alpha' })
  transcript(home, '/repo/alpha', ref.id, [{ type: 'assistant', cwd: '/repo/alpha', message: { content: [{ type: 'text', text: 'hello' }] } }])
  appendFileSync(join(runDir, `${ref.id}.jsonl`), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }) + '\n')
  const onEvent = vi.fn()
  const sub = b.events({ directory: '/repo/alpha' }, { onEvent })
  try {
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, pollMs * 5)) // give a duplicate every chance to arrive
    expect(onEvent).toHaveBeenCalledTimes(1)
  } finally {
    sub.stop()
    await sub.done
  }
})

// Nothing has been dispatched yet, so the run dir doesn't exist. A reader that threw on that would
// take down every roster that mounted before its first claude session.
test('events survives an absent run directory and picks up a run that appears later', async () => {
  const runDir = join(tmp('runs'), 'never-created')
  const spawnImpl = fakeSpawn()
  const b = createClaudeBackend({ runDir, spawnImpl, home: tmp('home') })
  const onEvent = vi.fn()
  const sub = b.events({ directory: '/repo/alpha' }, { onEvent })
  try {
    const ref = await b.dispatch({ prompt: 'fix the flake', directory: '/repo/alpha' })
    appendFileSync(join(runDir, `${ref.id}.jsonl`), JSON.stringify({ type: 'result', subtype: 'success' }) + '\n')
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith('/repo/alpha', { type: 'result', subtype: 'success' }))
  } finally {
    sub.stop()
    await sub.done
  }
})
