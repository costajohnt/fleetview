// Claude Code as a Backend (see types.ts). The process-backed family: there is no server, so a
// session is one detached `claude -p` run whose stdout fleetview captures, and everything the roster
// shows is read back out of that capture or out of Claude Code's own transcripts. Wire shapes and
// the reasoning behind each choice below are in docs/specs/2026-07-25-claude-backend-wire.md,
// verified against claude 2.1.220.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Backend, BackendEventHandlers, EventSubscription, SessionRef } from '../../types.ts'
import { claudeNormaliser, normaliseClaudeSessions } from '../../backend-normalise.ts'
import { configDir, childEnv, openPrivateAppend } from '../../registry.ts'
import { encodeProjectDir, listTranscripts, projectsDir } from './projects.ts'
import { parseStreamChunk } from './stream.ts'
import { psInfo, sameRun, type PidInfo } from '../ps.ts'
import { reapRunLogs } from '../run-logs.ts'
import { newTailCursor, tailFile, type TailCursor } from '../tail.ts'
import { assertSessionId } from '../session-id.ts'

// Every flag is a "fleetview can't", stated rather than inherited. `fork` is the one worth naming:
// `claude --resume --fork-session` does exactly what the flag means, but the Backend contract has no
// fork() to invoke it from, so advertising true would put a key in the UI with nothing behind it.
const CAPABILITIES = {
  fork: false, // --fork-session exists; the contract has no fork() yet
  rename: false, // no CLI surface for renaming a stored session (-n only names one at start)
  delete: false, // would mean unlinking a transcript out of ~/.claude/projects, which is Claude Code state
  questions: false, // a headless run can't be answered mid-flight; denials are reported after the fact
  messages: false, // the transcript is a file in ~/.claude/projects, not a wire API peek can fetch
} as const

// How long between reads of a run log. There is no stream to block on, so this is the whole of the
// backend's latency, and it is a local file stat: 500ms costs nothing and keeps a row within half a
// second of the truth.
const POLL_MS = 500

// What fleetview records for a session it dispatched, next to the log. The pid is the only handle
// abort() has, and the directory is what lets events() find this run's log from a directory alone.
type RunMeta = { id: string; directory: string; pid: number | null; startedAt: number }

export function createClaudeBackend({
  home = homedir(),
  runDir = join(configDir(), 'claude-runs'),
  spawnImpl = spawn,
  killImpl = process.kill.bind(process) as (pid: number, signal?: NodeJS.Signals) => void,
  psImpl = psInfo,
  now = Date.now,
  // Injected the way connectEvents takes idleMs: a test that has to prove what happens *between*
  // two polls can't do it against a half-second interval without sleeping for one.
  pollMs = POLL_MS,
}: {
  home?: string
  runDir?: string
  spawnImpl?: typeof spawn
  killImpl?: (pid: number, signal?: NodeJS.Signals) => void
  psImpl?: (pid: number) => PidInfo
  now?: () => number
  pollMs?: number
} = {}): Backend {
  const logPath = (id: string) => join(runDir, `${id}.jsonl`)
  const metaPath = (id: string) => join(runDir, `${id}.json`)

  // Rewritten only by run() (a resume records the new child's pid), and run() refreshes the cache
  // itself, so a successful read is cached — without it every poll re-reads and re-parses every run
  // fleetview has ever dispatched, forever, and the run dir only grows. A failed read isn't cached:
  // the meta of a run being dispatched right now appears a moment later.
  const metaCache = new Map<string, RunMeta>()
  const readMeta = (id: string): RunMeta | null => {
    const cached = metaCache.get(id)
    if (cached) return cached
    try {
      const parsed = JSON.parse(readFileSync(metaPath(id), 'utf8'))
      if (typeof parsed?.id !== 'string' || typeof parsed?.directory !== 'string') return null
      metaCache.set(id, parsed)
      return parsed
    } catch {
      return null // absent (a discovered session fleetview never dispatched) or torn; both mean "no pid"
    }
  }

  // The pair is keyed off the log (run-logs.ts): a reaped run's meta and cache entry go with it.
  function reap() {
    for (const id of reapRunLogs(runDir, now())) {
      rmSync(metaPath(id), { force: true })
      metaCache.delete(id)
    }
  }

  // Both dispatch and prompt spawn the same way: detached, stdout and stderr onto one appended log,
  // and no handle kept. `claude` is not a daemon — it runs, writes and exits — so nothing waits on
  // it, and the log is the only record that it happened.
  function run(argv: string[], id: string, directory: string) {
    // 0o700/0o600 like every other file fleetview writes: the log holds the prompt, the paths and
    // whatever the session printed, so it must not be world-readable (openPrivateAppend re-tightens
    // a pre-existing dir and file, and refuses a symlinked log).
    const fd = openPrivateAppend(runDir, logPath(id))
    // env without the opencode server password, and without this process's Claude Code session
    // markers: a dispatched agent runs attacker-influenced prompts, and that credential would hand
    // it ungated shell on the server; the markers make the child think it is a nested run of
    // fleetview's own session (see childEnv).
    const child = spawnImpl('claude', argv, { cwd: directory, detached: true, stdio: ['ignore', fd, fd], env: childEnv() })
    // An async spawn failure (ENOENT for a missing claude) would otherwise be an unhandled error
    // event that crashes out-of-band. Writing a synthetic failed `result` into the log instead means
    // events() tails it like any other terminal line and the row goes `failed` through the normal
    // path, rather than sitting on `working` forever because nothing ever wrote to its log. Same
    // shape stream.ts reads as a failure (is_error + non-success subtype), keyed to the session so
    // the normaliser can attribute it.
    // Written at most once per spawn: 'error' and 'exit' can both fire for the same child, and two
    // terminal lines in one log is a contradiction the fold would have to arbitrate.
    let wroteSynthetic = false
    const appendSyntheticResult = () => {
      if (wroteSynthetic) return
      wroteSynthetic = true
      try {
        appendFileSync(logPath(id), `${JSON.stringify({ type: 'result', is_error: true, subtype: 'error_during_execution', session_id: id })}\n`)
      } catch {
        // the log is gone; the session is unreadable either way
      }
    }
    child.on('error', appendSyntheticResult)
    // 'error' covers only a *spawn* failure (ENOENT/EACCES on the exec). A spawn that succeeds and
    // then exits non-zero — an unknown flag, an older CLI refusing --agent/--model/--session-id, an
    // auth or config error — writes plain text that parseStreamChunk drops, so no `result` is ever
    // folded and the row renders `idle`: indistinguishable from a session created and never used.
    // The child is detached and unref'd, so this listener costs nothing.
    child.on('exit', (code) => {
      if (code) appendSyntheticResult()
    })
    child.unref()
    // The child duplicated the descriptor; the parent's copy is dead weight and would leak one fd
    // per dispatch (server-manager.ts hit the same thing).
    try {
      closeSync(fd)
    } catch {
      // already closed, or never valid
    }
    const meta: RunMeta = { id, directory, pid: child.pid ?? null, startedAt: now() }
    // tmp+rename, not a plain write: readMeta runs on every poll, and a concurrent read landing
    // mid-write got torn JSON → null → the session looked never-dispatched. Rename is atomic, so a
    // reader sees either the old meta or the new one, never half. (Mirrors registry.saveServer.)
    const tmp = `${metaPath(id)}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(meta, null, 2), { mode: 0o600 })
    renameSync(tmp, metaPath(id))
    // A resume rewrites the meta with the new child's pid, so the cache entry from the first run
    // must go with it — abort() reading the old pid would signal a dead group and leave the live
    // resume running.
    metaCache.set(id, meta)
    return meta
  }

  return {
    name: 'claude',
    capabilities: CAPABILITIES,

    // Claude Code's own transcripts, not fleetview's run dir: a session fleetview dispatched writes
    // one too, so reading both would mean deduplicating two views of the same session for no gain.
    listSessions: async (directory) => listTranscripts(directory, { home }),

    async dispatch({ prompt, directory, agent, model }) {
      // fleetview mints the id instead of parsing it out of the init event. The alternative is
      // holding a detached child open to read its first line before dispatch() can return a ref —
      // a read loop with a timeout, and a window where fleetview owns a process it cannot name.
      const id = randomUUID()
      // Spelled with '=' because that is the form the spike ran; --verbose is not optional, the
      // CLI refuses --output-format=stream-json under --print without it.
      const argv = ['-p', '--output-format=stream-json', '--verbose', '--session-id', id]
      if (model) argv.push('--model', model)
      if (agent) argv.push('--agent', agent)
      // The prompt is a positional (`-p` is bare --print), so a prompt starting with `-` would be
      // eaten as flags — `claude -p '--version' …` prints the version instead of running (verified
      // on 2.1.220, as was `--` making it literal). Last, behind `--`, always.
      argv.push('--', prompt)
      run(argv, id, directory)
      reap()
      return { id, directory }
    },

    // Resume is scoped by cwd: the same id from a sibling directory fails with "No conversation
    // found" before any API call, so `directory` here is load-bearing rather than a label.
    // The text rides behind `--` for the same leading-dash reason as dispatch.
    prompt: async (id, text, directory) => run(['--resume', assertSessionId(id), '-p', '--output-format=stream-json', '--verbose', '--', text], id, directory),

    // Same subscription contract as opencode's, satisfied by polling rather than by a socket:
    // stop() ends the loop, done resolves when the loop has actually finished.
    //
    // Two sources. A run fleetview dispatched is tailed from the stream fleetview captured, which is
    // complete — including the `result` event that says how it ended. A session discovered from
    // ~/.claude/projects is tailed from Claude Code's transcript, whose `assistant` records carry
    // message.content in the same shape, so last-output is real rather than inferred. What the
    // transcript has no record of is completion, which is why such a session is seeded 'idle' by
    // emptyTranscriptState rather than 'working' — see stream.ts.
    events({ directory }: { directory: string }, { onEvent, onOnline }: BackendEventHandlers): EventSubscription {
      let stopped = false
      let wake: (() => void) | undefined
      // One tail cursor per file (see tail.ts), so each poll reads only what was appended.
      const cursors = new Map<string, TailCursor>()

      // Reads whatever has been appended to `file` since the last call and hands each parsed line to
      // onEvent. Keyed separately from the path so a run log and a transcript can never share a
      // cursor, though in practice only one of the two is ever tailed for a given session.
      function tail(key: string, file: string, source: 'run' | 'transcript') {
        const cursor = cursors.get(key) ?? newTailCursor()
        cursors.set(key, cursor)
        const r = tailFile(cursor, file)
        // null: meta written, log not yet — the next poll will find it. Empty text: nothing
        // appended (a bare reset already cleared the cursor; there is nothing to parse).
        if (!r?.text) return
        const { events, rest } = parseStreamChunk(cursor.rest + r.text)
        cursor.rest = rest
        // Raw objects, unnormalised, exactly as opencode hands over its raw SSE payloads — per
        // types.ts the shape is the backend's own and the roster reads it through per-backend
        // normalisation. A transcript line is tagged so the normaliser seeds it 'idle' (a transcript
        // has no `result`, so seeding 'working' would strand it there); a run's lines are untagged
        // and seed 'working' as before.
        for (const e of events) onEvent(directory, source === 'transcript' ? { ...(e as Record<string, unknown>), __source: 'transcript' } : e)
      }

      const done = (async () => {
        // There is no server to be offline from — the CLI is local and either present or not — so
        // the directory is online for as long as anyone is subscribed, and onOffline never fires.
        onOnline?.(directory)
        while (!stopped) {
          let names: string[] = []
          try {
            names = readdirSync(runDir)
          } catch {
            // no run dir yet: nothing has been dispatched. Keep polling; one may be.
          }
          // Ids fleetview dispatched, so the transcript pass below can skip them: a dispatched
          // session has both a captured stream and a transcript, and tailing both would deliver
          // every assistant message twice.
          const dispatched = new Set<string>()
          // Every key this poll tailed. A cursor whose file is no longer visible — its run log
          // reaped after KEEP_RUNS_MS, its transcript deleted — pins an offset, a decoder and a
          // partial-line string forever; in a long-lived TUI that is a slow leak, so anything not
          // seen this poll is dropped. A file that comes back starts from a fresh cursor, which is
          // what a new file needs anyway.
          const live = new Set<string>()
          for (const name of names) {
            if (!name.endsWith('.json')) continue
            const id = name.slice(0, -'.json'.length)
            const meta = readMeta(id)
            if (meta?.directory !== directory) continue
            dispatched.add(id)
            live.add(`run:${id}`)
            tail(`run:${id}`, logPath(id), 'run')
          }
          for (const t of listTranscripts(directory, { home })) {
            if (dispatched.has(t.id)) continue
            live.add(`transcript:${t.id}`)
            tail(`transcript:${t.id}`, join(projectsDir(home), encodeProjectDir(directory), `${t.id}.jsonl`), 'transcript')
          }
          for (const key of cursors.keys()) if (!live.has(key)) cursors.delete(key)
          if (stopped) break
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, pollMs)
            // stop() resolves the sleep instead of waiting it out, so done settles promptly on
            // unmount rather than up to a poll interval later.
            wake = () => {
              clearTimeout(timer)
              resolve()
            }
          })
          wake = undefined
        }
      })()

      return {
        done,
        stop: () => {
          stopped = true
          wake?.()
        },
      }
    },

    // cwd is the caller's job (cli.ts already passes `cwd: target.worktree` to the pty host), and it
    // has to be the session's directory or --resume won't find the session at all. The id is
    // re-asserted here because it becomes argv: discovery already refuses malformed ids, but this is
    // the last line before a spawn and a thrown name beats a spawned flag (session-id.ts).
    attach: ({ id }: SessionRef) => ['claude', '--resume', assertSessionId(id)],

    // Negative signal, so the whole process group goes: `detached: true` made the child a group
    // leader, and killing the pid alone would leave its tool subprocesses (a running test suite, a
    // build) orphaned and still writing.
    abort: async (id) => {
      const meta = readMeta(id)
      if (!meta?.pid) return { aborted: false }
      // The meta outlives the run by up to KEEP_RUNS_MS, so this pid can be weeks stale and the OS
      // may have handed it to an unrelated process — which the group signal below would kill. A
      // live pid is only trusted when it still looks like this run (sameRun in ps.ts).
      // Known trade: the old unconditional kill(-pid) also swept a group whose leader had already
      // exited but whose tool children lived on; the guard gives that up, and such children fall to
      // the run's own teardown instead.
      if (!sameRun(psImpl(meta.pid), id)) return { aborted: false }
      try {
        killImpl(-meta.pid, 'SIGTERM')
        return { aborted: true }
      } catch {
        // ESRCH: the run already finished. Aborting a finished session is a no-op, not a failure.
        return { aborted: false }
      }
    },

    // Not silent no-ops: the roster is supposed to hide these behind the capability flags, and a
    // caller that got here anyway has a bug that a resolved promise would hide.
    rename: async () => {
      throw new Error('claude cannot rename a session: the CLI has no surface for it (capabilities.rename is false)')
    },
    delete: async () => {
      throw new Error('claude cannot delete a session: it would mean unlinking a transcript out of ~/.claude/projects, which is Claude Code state')
    },
    // The translation into the store's vocabulary lives in backend-normalise.ts with the rest of
    // the vocabulary machinery; the contract is what puts it on this adapter (H3).
    normaliseSessions: normaliseClaudeSessions,
    createNormaliser: claudeNormaliser,
  }
}
