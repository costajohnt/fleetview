// GitHub Copilot CLI as a Backend (see types.ts). Process-backed: there is no server, so a session
// is one detached `copilot -p …` run whose JSONL output fleetview captures, plus whatever copilot
// leaves under ~/.copilot/session-state. Every flag and event shape below was measured against
// 1.0.75 — docs/specs/2026-07-25-copilot-backend-wire.md records what was run and what came back.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, openSync, readSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Backend } from '../../types.ts'
import { configDir, childEnv, openPrivateAppend } from '../../registry.ts'
import { foldEvents, initialRun, parseJsonlChunk, type CopilotStatus, type RunState } from './events.ts'
import { listSessions, lockInfo, runningPid, sessionStateDir } from './sessions.ts'
import { psInfo, type PidInfo } from '../ps.ts'
import { assertSessionId } from '../session-id.ts'

// Measured, not aspirational — each `false` is a thing the CLI cannot do, not a thing left unbuilt.
// `questions` is the load-bearing one: a headless run that lacks a permission fails the tool with
// `code: "denied"`, tells nobody, and still exits 0. There is no request to surface and no channel
// to answer it on, so a roster offering to approve something would be lying.
const CAPABILITIES = {
  fork: false, // no fork/branch/clone anywhere in `copilot --help`
  rename: false, // -n/--name titles a session at creation; nothing renames one after
  delete: false, // the CLI has no surface for removing a stored session
  questions: false, // headless denial is silent and unanswerable
} as const

// How often events() re-reads the sessions in a directory. Every tick is a directory listing and a
// short read per session off local disk, so this is cheap — but it is the whole status latency of a
// process-backed backend, and a roster that takes five seconds to notice a session finished reads as
// broken. Injectable so tests don't wait on a real clock.
const POLL_MS = 1500

const logDirFor = () => join(configDir(), 'copilot')

// How long a run's captured log is kept. The log dir gained a file per dispatch and nothing ever
// removed them, so a heavy user accumulated every session they had ever dispatched, forever. Same
// window and same reasoning as the claude backend: copilot's own transcript under
// ~/.copilot/session-state — which fleetview does not own — outlives it anyway, and events() falls
// back to it for an owned session whose capture is gone.
const KEEP_RUNS_MS = 30 * 24 * 60 * 60 * 1000

// Non-interactive mode's fixed argv. `--allow-all-tools` is what the CLI's own help calls "required
// for non-interactive mode", and without it a dispatched session can read and answer but not act —
// see the denial trace in the wire doc. Deliberately not `--allow-all`/`--yolo`, which would also
// mean --allow-all-paths and --allow-all-urls and drop the path sandbox for a backgrounded agent.
const HEADLESS = ['--output-format', 'json', '--no-color', '--allow-all-tools']

export function createCopilotBackend({
  spawnImpl = spawn,
  randomUUIDImpl = randomUUID,
  killImpl = (pid: number, signal?: NodeJS.Signals | 0) => process.kill(pid, signal),
  psImpl = psInfo,
  stateDir = sessionStateDir(),
  logDir = logDirFor(),
  now = Date.now,
  pollMs = POLL_MS,
}: {
  spawnImpl?: typeof spawn
  randomUUIDImpl?: () => string
  killImpl?: (pid: number, signal?: NodeJS.Signals | 0) => void
  psImpl?: (pid: number) => PidInfo
  stateDir?: string
  logDir?: string
  now?: () => number
  pollMs?: number
} = {}): Backend {
  // Runs this fleetview started: the process group abort signals, and the directory events() needs
  // to place a session copilot has not written to disk yet. One entry per dispatch, not persisted —
  // after a restart the lock file under session-state is the better answer anyway, because it is the
  // pid copilot itself is holding the session with.
  const started = new Map<string, { pid: number; directory: string }>()

  // Every id run() ever spawned in this process, and never removed — unlike `started`, which abort
  // deletes from as its group-kill bookkeeping. events() keys its own-capture preference on this
  // set: keying on `started` meant an abort silently repointed the tail at copilot's transcript,
  // discarding the captured stderr and synthetic failure line for exactly the run most likely to
  // have died messily.
  const owned = new Set<string>()

  const logPath = (id: string) => join(logDir, `${id}.jsonl`)

  // 0o700/0o600 like every other fleetview state file: the log holds the prompt, the repository
  // paths, and whatever the session printed, so it must not be world-readable (openPrivateAppend
  // re-tightens a pre-existing dir and file, and refuses a symlinked log).
  const openLog = (id: string) => openPrivateAppend(logDir, logPath(id))

  // Drop captures whose last activity is older than the retention window. Hung off dispatch rather
  // than given a timer: the directory only grows when something is dispatched, so that is when it is
  // worth a look. Best effort — a log that cannot be removed is not a reason to fail the dispatch.
  function reap() {
    let names: string[]
    try {
      names = readdirSync(logDir)
    } catch {
      return
    }
    const cutoff = now() - KEEP_RUNS_MS
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const file = join(logDir, name)
      try {
        // mtime, not the dispatch time: a session resumed last week is live work whatever day its
        // first prompt was sent, and deleting its capture would blank the row it still feeds.
        if (statSync(file).mtimeMs >= cutoff) continue
      } catch {
        continue
      }
      rmSync(file, { force: true })
    }
  }

  // Both dispatch and prompt are the same spawn with a different session flag — copilot has no
  // notion of an existing-but-unprompted session, so "start" and "continue" differ only in whether
  // the uuid is being set or resumed.
  // The two session flags are not written the same way on purpose. `--session-id <id>` takes a
  // required value and is passed as two argv entries, which is the form the spike ran. `--resume`
  // declares its value as optional (`-r, --resume[=value]`), and an optional-value flag only sees a
  // value attached with `=` — space-separated, the id would be parsed as a stray argument and
  // copilot would open its session picker instead of resuming.
  function run(id: string, sessionArgs: string[], prompt: string, directory: string, extra: string[]) {
    const fd = openLog(id)
    try {
      const child = spawnImpl('copilot', [...sessionArgs, '-p', prompt, ...HEADLESS, ...extra], {
        cwd: directory,
        // detached makes the child a process group leader, which is the only reliable way to abort
        // it: `copilot` is a node wrapper that execs a native binary, and killing the wrapper alone
        // was verified to leave the native process running and the session still locked.
        detached: true,
        stdio: ['ignore', fd, fd],
        // Without the opencode server password: a dispatched agent runs attacker-influenced prompts,
        // and that credential would hand it ungated shell on the server (childEnv).
        env: childEnv(),
      })
      // An async spawn failure (ENOENT when copilot isn't installed) would otherwise be an unhandled
      // error event. Writing copilot's own terminal event into the log instead means the status
      // derivation reports `failed` through the same path as any other failed run, rather than
      // leaving a session that says `working` forever because nothing ever wrote to its log.
      child.on('error', () => {
        try {
          appendFileSync(logPath(id), `${JSON.stringify({ type: 'result', sessionId: id, exitCode: 127 })}\n`)
        } catch {
          // the log is gone; the session is unreadable either way
        }
      })
      child.unref()
      owned.add(id)
      if (child.pid === undefined) throw new Error(`copilot did not start for session ${id}`)
      started.set(id, { pid: child.pid, directory })
      return child.pid
    } finally {
      // The child duplicated the descriptor; the parent's copy is dead weight, and one leaks per
      // dispatch without this.
      try {
        closeSync(fd)
      } catch {
        // already closed, or never valid
      }
    }
  }

  return {
    name: 'copilot',
    capabilities: CAPABILITIES,
    listSessions: async (directory) => listSessions(directory, stateDir),

    // fleetview mints the id rather than reading it back. In JSON mode copilot only announces the
    // session id on the run's final `result` line, so a dispatch that waited to learn it would block
    // until the session finished — which is the opposite of backgrounding. `--session-id` is
    // documented as setting the uuid for a new session, and was verified to do exactly that.
    async dispatch({ prompt, directory, agent, model }) {
      const id = randomUUIDImpl()
      const extra = [...(model ? ['--model', model] : []), ...(agent ? ['--agent', agent] : [])]
      run(id, ['--session-id', id], prompt, directory, extra)
      reap()
      return { id, directory }
    },

    // Resume is a second spawn, not a message to a running process: verified that
    // `--resume=<id> -p …` continues the same session (it recalled the previous turn) and appends to
    // the same on-disk transcript rather than starting a new one.
    async prompt(id, text, directory) {
      return { id, pid: run(id, [`--resume=${id}`], text, directory, []) }
    },

    // Polling wearing a subscription's clothes: there is no stream to subscribe to. The
    // alternative wire — `copilot --acp`, a real bidirectional protocol — needs a
    // long-lived process per session and a protocol client, so it is a second backend family rather
    // than a flag (see the wire doc).
    events({ directory }, { onEvent, onOnline }) {
      // Copilot writes a session's state directory a moment after the process starts, and never at
      // all if the process could not start — so a roster built from disk alone would drop a
      // just-dispatched session, and drop a failed-to-spawn one permanently. Sessions fleetview
      // started are therefore carried until disk catches up, with `running` true because the only
      // thing that can say otherwise is their own log, which statusOf reads.
      // The lock is only removed by an orderly exit (SIGTERM included), so a SIGKILL or a crash
      // leaves one behind naming a pid that no longer runs — and a roster trusting the file alone
      // would show that session `working` forever. Signal 0 is the existence probe; EPERM still
      // means "exists", and anything else means the lock is stale.
      const aliveImpl = (pid: number) => {
        try {
          killImpl(pid, 0)
          return true
        } catch (e) {
          return (e as NodeJS.ErrnoException)?.code === 'EPERM'
        }
      }

      const lockAlive = (id: string) => {
        const pid = runningPid(join(stateDir, id))
        if (pid === null) return false
        return aliveImpl(pid)
      }

      const visible = (dir: string) => {
        const disk = listSessions(dir, stateDir).map((s) => (s.running && !lockAlive(s.id) ? { ...s, running: false } : s))
        const onDisk = new Set(disk.map((s) => s.id))
        // Probed, not assumed: a run copilot rejected on argv exits non-zero without ever writing a
        // state directory, so it never reaches `onDisk` and never leaves `started` (only abort()
        // removes entries) — and `child.on('error')` never fires, because that is a *spawn* failure
        // only. Hardcoding `running: true` here left such a session claiming `working` forever.
        // Same probe the disk branch above runs through lockAlive; statusOf then reports `failed`,
        // which is exactly what its comment describes for "no terminal line and no live process".
        const pending = [...started]
          .filter(([id, s]) => s.directory === dir && !onDisk.has(id))
          .map(([id, s]) => ({ id, directory: dir, running: aliveImpl(s.pid) }))
        return [...disk, ...pending]
      }

      // Per session: where the read got to, the partial trailing line, and the folded run state, so
      // each tick reads only the bytes appended since the last one. The decoder is per session and
      // kept across ticks for the same reason event-mux.ts keeps one: a positional read ends
      // wherever the file did, which is happily mid-character, and decoding each chunk on its own
      // turns a multi-byte character straddling a tick into U+FFFD — inside a line that then fails
      // to parse, and the line it kills can be the `result`.
      const tails = new Map<string, { file: string; offset: number; rest: string; ino: number; run: RunState; emitted: string; decoder: InstanceType<typeof TextDecoder> }>()
      let announced = false

      const tick = () => {
        // Local disk with no server in front of it: there is no offline state to report, so
        // onOffline is never called and onOnline fires once, rather than leaving a caller that
        // gates on it waiting forever.
        if (!announced) {
          announced = true
          onOnline?.(directory)
        }
        for (const session of visible(directory)) {
          // fleetview's own capture is preferred for runs this process started, because it also
          // holds stderr and the synthetic failure line above. Only for those: the log dir is never
          // reaped, so after a restart a session's stale capture — frozen on some earlier run's
          // `result` — would otherwise outrank the live transcript forever, pinning a resumed
          // session's status to history. copilot's transcript is what makes every other session
          // readable at all; the fallback the other way covers a spawn failure, which has a capture
          // (with the synthetic result) but never a transcript.
          const own = logPath(session.id)
          const transcript = join(stateDir, session.id, 'events.jsonl')
          const file = owned.has(session.id) && existsSync(own) ? own : existsSync(transcript) ? transcript : own
          let tail = tails.get(session.id)
          if (!tail || tail.file !== file) {
            tail = { file, offset: 0, rest: '', ino: 0, run: initialRun(), emitted: '', decoder: new TextDecoder() }
            tails.set(session.id, tail)
          }
          const chunk = readFrom(tail.file, tail.offset, tail.ino)
          if (chunk === null) continue // no log yet: the run has not written its first line
          if (chunk.reset) {
            // The file shrank or is a different inode — copilot rotated, rewrote or renamed over it.
            // Re-folding from zero is the only way back to a correct state, and a stale offset would
            // otherwise read from the middle of a line forever. The decoder goes with it: it may be
            // holding the head of a character from the file that no longer exists.
            tail.offset = 0
            tail.rest = ''
            tail.run = initialRun()
            tail.decoder = new TextDecoder()
          }
          tail.offset = chunk.offset
          tail.ino = chunk.ino
          const { events, rest } = parseJsonlChunk(tail.rest + tail.decoder.decode(chunk.buf, { stream: true }))
          tail.rest = rest
          tail.run = foldEvents(tail.run, events)

          const status = statusOf(tail.run, session.running)
          // Emitting only on change keeps a quiet roster quiet: without this every session in the
          // directory would produce an event every tick forever.
          const signature = `${status} ${tail.run.lastOutput} ${tail.run.deniedTools}`
          if (signature === tail.emitted) continue
          tail.emitted = signature
          // Copilot-shaped, not opencode-shaped. The contract types events as `unknown` precisely so
          // each backend can report its own facts; normalising these into roster rows is the UI
          // wiring's job, and pre-bending them into another backend's payload here would hide which
          // fields are real.
          onEvent(directory, {
            type: 'copilot.session',
            sessionId: session.id,
            status,
            lastOutput: tail.run.lastOutput,
            deniedTools: tail.run.deniedTools,
            running: session.running,
          })
        }
      }

      let resolveDone!: () => void
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve
      })
      const timer = setInterval(tick, pollMs)
      timer.unref?.() // a poll timer must not be the reason the process stays alive
      tick() // first read now rather than one interval from now, so a fresh roster isn't blank
      return {
        done,
        stop: () => {
          clearInterval(timer)
          resolveDone()
        },
      }
    },

    // -C is applied as a chdir before anything else (verified: pointing it at a missing directory
    // fails with ENOENT from chdir and never reaches the model). Needed because the pty host's cwd
    // is fleetview's, not the session's, and a resume in the wrong repository is a resume in the
    // wrong repository whether or not it errors.
    // The id is re-asserted because it becomes argv: parseWorkspace already refuses separators at
    // discovery, but this is the last line before a spawn (session-id.ts).
    attach: ({ id, directory }) => ['copilot', '-C', directory, `--resume=${assertSessionId(id)}`],

    async abort(id) {
      const own = started.get(id)
      if (own !== undefined) {
        started.delete(id)
        // Negative pid = the whole group, which is what reaches both the node wrapper and the native
        // binary it execs. ESRCH means the run already finished — aborting a finished session is a
        // no-op, not a failure, and throwing here would be the one abort in three backends that can.
        try {
          killImpl(-own.pid, 'SIGTERM')
          return { aborted: true }
        } catch {
          return { aborted: false }
        }
      }
      // Started by another fleetview run, or by the user directly. The lock names the native process
      // holding the session, and it is not a group leader — so it is signalled directly, which was
      // verified to end the run and remove the lock. A lock left behind by a crash names a pid that
      // is gone — or, worse, recycled — so before trusting it the pid has to still look like this
      // session's copilot: a copilot (or the node wrapper it runs under) born when the lock was
      // written. Same guard, same reasons, as the claude backend's abort; 'unavailable' (no usable
      // ps) falls through to the signal because unverifiable is not verified-stale.
      const lock = lockInfo(join(stateDir, id))
      if (lock === null) return { aborted: false } // nothing running; abort has already happened
      const info = psImpl(lock.pid)
      if (info === null) return { aborted: false } // the lock outlived its process
      if (info !== 'unavailable') {
        // The argv naming this session is the only accepted identity — it needs no clock, where the
        // old fallback (any copilot-or-node whose lstart sat within a minute of the lock's mtime)
        // accepted a whole class of processes and reopened the recycled-pid kill through that
        // window. A resume always carries `--resume=<id>`, and the lock's own holder is that
        // resume, so a live run always shows the id; "no id in argv" is refused rather than guessed
        // at. Same rule, same reasons, as the claude backend's abort.
        if (!info.command.includes(id)) return { aborted: false }
      }
      try {
        killImpl(lock.pid, 'SIGTERM')
        return { aborted: true }
      } catch {
        return { aborted: false }
      }
    },

    // The contract requires both, the CLI supports neither, and capabilities says so. Rejecting
    // rather than resolving is the difference between a key the UI hides and a key that looks like
    // it worked.
    async rename() {
      throw new Error('copilot cannot rename a session')
    },
    async delete() {
      throw new Error('copilot cannot delete a session')
    },
  }
}

// The run's own terminal line wins where there is one — `result` in a captured stream,
// `session.shutdown` in a discovered transcript — it is written before the process exits, so
// deferring to the lock instead would report `working` for the moment between the two. Where there
// is neither, the lock is the only evidence — and a session with no terminal line and no live
// process crashed or was SIGKILLed, so calling that `completed` would put a green row on work that
// never happened.
function statusOf(run: RunState, running: boolean): CopilotStatus {
  if (run.exitCode !== null) return run.status
  return running ? 'working' : 'failed'
}

// Positional read rather than readFileSync: a long session's transcript reaches megabytes, and
// re-reading all of it every 1.5 seconds to look at the tail is the difference between a poll that
// costs nothing and one that shows up in a profile. Bytes, not a string — decoding belongs to the
// caller's per-session TextDecoder, because this read ends wherever the file does.
function readFrom(file: string, offset: number, ino: number): { buf: Buffer; offset: number; reset: boolean; ino: number } | null {
  let size: number
  let currentIno: number
  try {
    const st = statSync(file)
    size = st.size
    currentIno = Number(st.ino)
  } catch {
    return null
  }
  // A different inode is a different file: a rewrite delivered by rename-over lands at whatever size
  // it likes, so `size < offset` misses every one that is equal-or-larger and the caller then folds
  // mid-line garbage read from a stale offset. ino 0 (some Windows filesystems report it) is no
  // signal, so it never triggers a reset and those hosts keep the size heuristic they had.
  const reset = size < offset || (ino !== 0 && currentIno !== 0 && ino !== currentIno)
  const from = reset ? 0 : offset
  if (size === from) return { buf: Buffer.alloc(0), offset: from, reset, ino: currentIno }
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return null
  }
  try {
    const buf = Buffer.alloc(size - from)
    const read = readSync(fd, buf, 0, buf.length, from)
    return { buf: buf.subarray(0, read), offset: from + read, reset, ino: currentIno }
  } finally {
    closeSync(fd)
  }
}
