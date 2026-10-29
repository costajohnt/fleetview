// The shell subcommands (`ls`/`--json`, `attach`, `logs`, `stop`, `rm`, `add`, `answer`, `watch`,
// `status`, `bg`), lifted out of cli.ts so that file keeps only the server lifecycle, the roster
// loop and the attach loop. Every command takes its collaborators as an options object with real
// defaults: main() passes what it holds, tests pass fakes.
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { OpencodeClient } from './backends/opencode/client.ts'
import { createOpencodeBackend } from './backends/opencode/index.ts'
import { DEFAULT_BACKEND } from './backends/index.ts'
import { loadServer, childEnv } from './registry.ts'
import { OPENCODE_MISSING } from './backends/opencode/server-manager.ts'
import { loadSeen, defaultSeenFile } from './seen-store.ts'
import { loadRoster, saveRoster, withRosterLock, defaultRosterFile } from './roster-store.ts'
import { createStore, memberTitle, messageBody, errorLabel } from './session-store.ts'
import type { SessionStore } from './session-store.ts'
import { connectEvents } from './backends/opencode/event-mux.ts'
import { summarise } from './ui/header.ts'
import { sandboxParents, displayProject, worktreeSafety, allProjectDirectories } from './worktree.ts'
import { sessionJson, filterForList, underCwd, formatRow, parseModel, sessionIdProblem } from './cli-args.ts'
import { stripControl } from './text-utils.ts'
import type { ParsedArgs } from './cli-args.ts'
import { isListedSession, isRecord } from './types.ts'
import type { Backend, ListedSession, Project, ServerRef } from './types.ts'
import type { SeenMap } from './seen-store.ts'
import type { RosterSession as RosterMember } from './roster-store.ts'
import type { RosterClient } from './backends/opencode/client.ts'
import type { EnsureServer } from './cli.ts'

export const DEFAULT_SERVER: ServerRef = { host: '127.0.0.1', port: 4900, pid: null }
const RECENT_MESSAGES = 10

// The dependency bags below are all written with method syntax rather than function-property syntax.
// That makes TypeScript compare their parameters bivariantly, which is the whole point of an
// injection seam: a test fake may legitimately declare narrower arguments (or return a partial
// roster) than the real implementation it stands in for, without either side reaching for a cast.
type RunBgDeps = {
  ensureServer: EnsureServer
  serverFile: string
  loadServerImpl?(file: string): ServerRef | null
  createClient?(url: string): Pick<RosterClient, 'createSession' | 'renameSession' | 'runShell' | 'promptAsync'>
  realpath?(path: string): string
  rosterFile?: string
  // Loose in the roster shape for the same reason: `bg` only appends to `sessions`, and the fixtures
  // hand over exactly that much.
  loadRosterImpl?(file: string): { sessions: RosterMember[] }
  saveRosterImpl?(file: string, roster: { sessions: RosterMember[] }): unknown
  now?(): number
  log?(message: string): void
  error?(message: string): void
  setExitCode?(code: number): void
}

// The process-backed adapters (claude, copilot), keyed by backend name. opencode is never in here:
// it is reached through the server each command resolves, and its adapter is built from that
// connection. Empty means "opencode only", which is what every caller that passes nothing gets.
export type Backends = Record<string, Backend>

type ListSessionsDeps = {
  createClient?(url: string): RosterClient
  loadSeenImpl?(file: string): SeenMap
  // Called, not read: the state-dir env overrides are per-test, so the path is resolved at call time.
  seenFile?(): string
  loadRosterImpl?(file: string): { sessions: RosterMember[] }
  rosterFile?(): string
  backends?: Backends
  log?(message: string): void
  error?(message: string): void
  setExitCode?(code: number): void
}

type RunAddDeps = {
  ensureServer: EnsureServer
  serverFile: string
  createClient?(url: string): Pick<RosterClient, 'listProjects' | 'listSessions'>
  rosterFile?: string
  loadRosterImpl?(file: string): { sessions: RosterMember[] }
  saveRosterImpl?(file: string, roster: { sessions: RosterMember[] }): unknown
  now?(): number
  log?(message: string): void
  error?(message: string): void
  setExitCode?(code: number): void
}

type RunAnswerDeps = {
  ensureServer: EnsureServer
  serverFile: string
  createClient?(url: string): Pick<RosterClient, 'listProjects' | 'listSessions' | 'listPermissions' | 'listQuestions' | 'respondPermission' | 'respondQuestion' | 'promptAsync'>
  log?(message: string): void
  error?(message: string): void
  setExitCode?(code: number): void
}

type RunRmDeps = {
  ensureServer: EnsureServer
  serverFile: string
  createClient?(url: string): Pick<RosterClient, 'listProjects' | 'listSessions' | 'deleteSession' | 'removeWorktree'>
  rosterFile?: string
  worktreeSafetyImpl?(dir: string, parentDir: string): { removable: boolean; reason: string | null }
  backends?: Backends
  log?(message: string): void
  error?(message: string): void
  setExitCode?(code: number): void
}

type RunWatchDeps = {
  ensureServer: EnsureServer
  serverFile: string
  createClient?(url: string): Pick<RosterClient, 'listProjects' | 'listSessions' | 'sessionStatus'>
  connect?: typeof connectEvents
  log?(message: string): void
  error?(message: string): void
  setExitCode?(code: number): void
}

type RunStatusDeps = {
  ensureServer: EnsureServer
  serverFile: string
  createClient?(url: string): Pick<RosterClient, 'listProjects' | 'listSessions' | 'sessionStatus' | 'listPermissions' | 'listQuestions'>
  loadSeenImpl?(file: string): SeenMap
  seenFile?(): string
  backends?: Backends
  rosterFile?: string
  log?(message: string): void
  error?(message: string): void
  setExitCode?(code: number): void
}

// `fleetview bg`, lifted out of main() for the reason makeEnsureServer was: almost everything here
// is a decision (reject a malformed --model before anything exists server-side, carry the shell flag
// into the roster) and none of it was reachable from a test while it sat inline behind a real server
// and a real createSession. Dependencies arrive as an options object with real defaults, so main()
// passes only what it already holds and tests pass fakes.
export async function runBg(
  args: ParsedArgs,
  {
    ensureServer,
    serverFile,
    loadServerImpl = loadServer,
    createClient = (url: string) => new OpencodeClient(url),
    realpath = realpathSync,
    // Evaluated only when omitted, which keeps the config-dir read as lazy as it was inline — tests
    // (and anything with ROOST_CONFIG_DIR set after import) must not be bound to a path resolved at
    // module load.
    rosterFile = defaultRosterFile(),
    loadRosterImpl = loadRoster,
    saveRosterImpl = saveRoster,
    now = Date.now,
    log = console.log,
    error = console.error,
    setExitCode = (code: number) => {
      process.exitCode = code
    },
  }: RunBgDeps,
) {
  // Dispatch without opening the roster — agent view's `claude --bg`. Runs in the current
  // directory (or --cwd), joins the roster so the next `fleetview` shows it, and prints the id.
  // No worktree isolation from here: that is the interactive dispatch path's business; a shell
  // dispatch runs where you pointed it, like the `!` form.
  // #108: `bg` dispatches on opencode only — there is no multi-backend bg dispatch yet, and the
  // parser accepts `--backend` for every command. Reject it loudly rather than silently running the
  // prompt on opencode regardless, the way the roster path rejects a bad `--backend`.
  if (args.backend !== undefined && args.backend !== DEFAULT_BACKEND) {
    error(`--backend is not supported for bg (bg always dispatches via opencode; remove --backend to proceed)`)
    setExitCode(1)
    return
  }
  const r = await ensureServer(loadServerImpl(serverFile) ?? DEFAULT_SERVER)
  if (!r.ok) {
    error(r.reason ?? 'opencode server unreachable')
    setExitCode(1)
    return
  }
  const client = createClient(`http://${r.server.host}:${r.server.port}`)
  const dir = realpath(args.cwd ?? process.cwd())
  let model
  if (args.model) {
    // Rejected before createSession, not after: a half-dispatched session left on the server is a
    // worse outcome than a usage error, and the provider/model split is the only thing we can check.
    model = parseModel(args.model)
    if (!model) {
      error('--model wants <provider>/<model>')
      setExitCode(1)
      return
    }
  }
  const session = await client.createSession({ agent: args.agent, model }, dir)
  if (args.name) await client.renameSession(session.id, args.name, dir)
  if (args.exec) await client.runShell(session.id, args.prompt ?? '', dir, args.agent ?? 'build')
  else await client.promptAsync(session.id, args.prompt ?? '', dir)
  // #106: locked, because a running TUI persisting a pin or a TTL clean at this moment reads the
  // pre-append file and renames its own merge over ours — the dispatched session keeps running
  // server-side but leaves the roster for good. Same lock makePersistRoster takes.
  withRosterLock(rosterFile, () => {
    const roster = loadRosterImpl(rosterFile)
    // Same membership shape App writes: shell flag drives the job auto-clean, prompt feeds the
    // any-URL filter.
    roster.sessions.push({ worktree: dir, id: session.id, addedAt: now(), ...(args.exec ? { shell: true } : {}), prompt: (args.prompt ?? '').slice(0, 2000) })
    saveRosterImpl(rosterFile, roster)
  })
  log(`${session.id}  ${args.exec ? '!' : ''}${(args.prompt ?? '').slice(0, 60)}`)
}

// Every session across every project whose id matches — exactly, or by prefix, because ids are long
// and nobody retypes one in full. All of them, not the first hit: the old form walked projects
// serially and returned whichever answered first, so an ambiguous prefix silently attached to (or
// deleted) an arbitrary one of the matches. Exported for tests.
// Takes only the one method it calls, in method syntax, for the same reason RosterClient does: the
// tests hand over a two-line fake and the real client satisfies it unchanged.
export async function matchSessions(
  client: { listSessions(directory: string): Promise<unknown> },
  projects: { worktree: string }[],
  id: string,
) {
  // #33: a degenerate id matches nothing rather than everything. Enforced here, not only at the
  // caller, because prefix matching is what makes '' and 's' match every session on the server —
  // any future caller gets the guard for free. withSession says why before it gets this far.
  if (sessionIdProblem(id)) return []
  const lists = await Promise.all(projects.map((p) => client.listSessions(p.worktree).catch(() => [])))
  const matches: { session: ListedSession; worktree: string }[] = []
  lists.forEach((sessions, i) => {
    // A listing is whatever the server sent, so both the array and each row go through a check
    // before an id is read off them — the same treatment every other wire payload gets.
    for (const session of Array.isArray(sessions) ? sessions : []) {
      if (!isListedSession(session)) continue
      if (session.id === id || session.id.startsWith(id)) matches.push({ session, worktree: projects[i].worktree })
    }
  })
  // A whole id the user typed is never ambiguous, even when it happens to also prefix a longer one.
  const exact = matches.filter((m) => m.session.id === id)
  return exact.length === 1 ? exact : matches
}

// The injectable half of `withSession` below: same resolve-server-then-find-the-session steps and
// the same messages, but reporting through the caller's log/error/setExitCode so `add`, `answer`
// and `watch` can be driven end to end in a test without a server. Returns null once it has said
// why, so every caller is a single `if (!found) return`.
async function resolveSession(
  id: string | undefined,
  ensureServer: EnsureServer,
  serverFile: string,
  createClient: (url: string) => Pick<RosterClient, 'listProjects' | 'listSessions'>,
  error: (message: string) => void,
  setExitCode: (code: number) => void,
) {
  const problem = sessionIdProblem(id)
  if (problem) {
    error(`fleetview: ${problem}`)
    setExitCode(1)
    return null
  }
  const r = await ensureServer(loadServer(serverFile) ?? DEFAULT_SERVER)
  if (!r.ok) {
    error(r.reason ?? 'opencode server unreachable')
    setExitCode(1)
    return null
  }
  const client = createClient(`http://${r.server.host}:${r.server.port}`)
  const projects = allProjectDirectories(await client.listProjects())
  const matches = await matchSessions(client, projects, id!)
  if (matches.length === 0) {
    error(`no session matching ${id}`)
    setExitCode(1)
    return null
  }
  if (matches.length > 1) {
    error([`${id} matches ${matches.length} sessions — use more of the id:`, ...matches.map((m) => `  ${m.session.id}  ${m.worktree}`)].join('\n'))
    setExitCode(1)
    return null
  }
  const { session, worktree } = matches[0]
  return { client, server: r.server, session, worktree, repo: displayProject(sandboxParents(projects), worktree) }
}

// `fleetview rm <id>`: delete the session, drop it from the roster, and clean up its worktree when
// nothing in it would be lost.
export async function runRm(
  args: ParsedArgs,
  {
    ensureServer,
    serverFile,
    createClient = (url: string) => new OpencodeClient(url),
    rosterFile = defaultRosterFile(),
    worktreeSafetyImpl = worktreeSafety,
    backends = {},
    log = console.log,
    error = console.error,
    setExitCode = (code: number) => {
      process.exitCode = code
    },
  }: RunRmDeps,
) {
  const found = await findSession(args.id, { ensureServer, serverFile, createClient, backends, rosterFile, error, setExitCode })
  if (!found) return
  // #105: the session is gone, but the roster still lists it — the next TUI shows a ghost completed
  // row for a session that no longer exists. Drop the member (matched by the same worktree+id key
  // the store uses) from roster.json. A missing/corrupt roster is nothing to prune, so failures
  // here are swallowed — the delete already succeeded.
  const prune = () => {
    try {
      withRosterLock(rosterFile, () => {
        const roster = loadRoster(rosterFile)
        const kept = roster.sessions.filter((m) => !(m.worktree === found.worktree && m.id === found.id))
        if (kept.length !== roster.sessions.length) saveRoster(rosterFile, { ...roster, sessions: kept })
      })
    } catch {}
  }
  if (!found.opencode) {
    // A process-backed session: no worktree of fleetview's making to clean up, and the adapter says
    // whether its CLI can delete at all. Neither claude nor copilot can today, so this says so
    // rather than calling a delete that only throws.
    const adapter = backends[found.backend]
    if (!adapter.capabilities.delete) {
      error(`${found.backend} cannot delete a session (its CLI has no way to); fleetview stop ${found.id} ends a running one`)
      setExitCode(1)
      return
    }
    await adapter.delete(found.id, found.worktree)
    prune()
    log(`removed ${found.id}`)
    return
  }
  const { client } = found.opencode
  await client.deleteSession(found.id, found.worktree)
  prune()
  // "`claude rm <id>` keeps the worktree if it has uncommitted changes" — and fleetview keeps it for
  // commits that exist nowhere else too (worktreeSafety). Reported either way, because a worktree
  // left behind is something the user should know about.
  if (found.worktree !== found.repo) {
    const kept = (reason: string) => log(`removed ${found.id} — kept its worktree (${reason}): ${found.worktree}`)
    // The TUI's guard (app.ts removeWorktreeFor): only the last session in a worktree takes it with
    // it — a /fork sibling still runs there. Counted excluding the deleted id rather than trusting
    // the server to have dropped it already; a listing that fails is not proof of "nobody left".
    const listed = await client.listSessions(found.worktree).catch(() => null)
    if (!Array.isArray(listed)) return kept('could not list its sessions')
    const others = listed.filter((s) => isListedSession(s) && s.id !== found.id).length
    if (others > 0) return kept(`${others} other session${others === 1 ? '' : 's'} still use${others === 1 ? 's' : ''} it`)
    const safety = worktreeSafetyImpl(found.worktree, found.repo)
    if (!safety.removable) return kept(safety.reason ?? 'not safe to remove')
    if (!client.removeWorktree) return kept('this server cannot remove worktrees')
    try {
      await client.removeWorktree(found.worktree, found.repo)
    } catch (e) {
      return kept(`removal failed: ${stripControl(e instanceof Error ? e.message : String(e))}`)
    }
    log(`removed ${found.id} and its worktree`)
    return
  }
  log(`removed ${found.id}`)
}

// `fleetview add <id>`: adopt an existing opencode session into the roster without opening the TUI.
// Counterpart to the ^a key in browse view — scripted roster setup, tmux bindings, or a
// one-keypress "background this session" flow from inside opencode.
export async function runAdd(
  args: ParsedArgs,
  {
    ensureServer,
    serverFile,
    createClient = (url: string) => new OpencodeClient(url),
    rosterFile = defaultRosterFile(),
    loadRosterImpl = loadRoster,
    saveRosterImpl = saveRoster,
    now = Date.now,
    log = console.log,
    error = console.error,
    setExitCode = (code: number) => {
      process.exitCode = code
    },
  }: RunAddDeps,
) {
  const found = await resolveSession(args.id, ensureServer, serverFile, createClient, error, setExitCode)
  if (!found) return
  const { session, worktree } = found
  // #106: the already-on-the-roster check and the append are one read-modify-write, so they hold
  // the lock together — checking outside it would let two `add`s of the same id both see "absent"
  // and write the member twice.
  const added = withRosterLock(rosterFile, () => {
    const roster = loadRosterImpl(rosterFile)
    if (roster.sessions.some((s) => s.worktree === worktree && s.id === session.id)) return false
    roster.sessions.push({ worktree, id: session.id, addedAt: now() })
    saveRosterImpl(rosterFile, roster)
    return true
  })
  log(added ? `added ${session.id}` : `${session.id} is already on the roster`)
}

// `fleetview answer <id> <y|a|d|N|text>`: the peek panel's one-keypress answering, from the shell.
// FLEETVIEW_NOTIFY_CMD already fires on `agent_needs_input` with the session id in the environment,
// but until now that notification was a dead end — you had to open the roster to act on it. This is
// the same three replies peek sends: y/a/d answer the oldest pending permission the way the peek
// keys do, a digit picks an option of the oldest pending question, and anything else is sent as a
// follow-up prompt, which is what typing in peek's reply input does.
export async function runAnswer(
  args: ParsedArgs,
  {
    ensureServer,
    serverFile,
    createClient = (url: string) => new OpencodeClient(url),
    log = console.log,
    error = console.error,
    setExitCode = (code: number) => {
      process.exitCode = code
    },
  }: RunAnswerDeps,
) {
  const found = await resolveSession(args.id, ensureServer, serverFile, createClient, error, setExitCode)
  if (!found) return
  const { session, worktree } = found
  const client = found.client as ReturnType<NonNullable<RunAnswerDeps['createClient']>>
  const reply = args.reply!
  // Both lists, always: which one answers depends on the reply word, and a `y` typed at a session
  // whose pending request is a question should say so rather than silently prompting the model
  // with the letter y. Oldest-first is peek's rule (the store sorts pending by asked-order); these
  // come straight off the endpoints, so ordering is the server's list order.
  const [permissions, questions] = await Promise.all([
    client.listPermissions(worktree).catch(() => []),
    client.listQuestions(worktree).catch(() => []),
  ])
  const permission = (permissions ?? []).filter((p) => p?.sessionID === session.id)[0]
  const question = (questions ?? []).filter((q) => q?.sessionID === session.id)[0]

  if (reply === 'y' || reply === 'a' || reply === 'd') {
    if (!permission) {
      error(question ? `${session.id} is waiting on a question, not a permission — answer it with an option number` : `nothing is waiting on ${session.id}`)
      setExitCode(1)
      return
    }
    const decision = reply === 'y' ? 'once' : reply === 'a' ? 'always' : 'reject'
    try {
      await client.respondPermission(permission.id, decision, worktree)
    } catch {
      error(`couldn't answer permission on ${session.id}`)
      setExitCode(1)
      return
    }
    log(`${decision} — ${session.id}`)
    return
  }

  // A bare number is an option pick, but only when a question is actually waiting: "2" typed at a
  // session with no pending question is far more likely to be a short reply than a mis-aimed pick,
  // and prompting with it is recoverable where answering the wrong question is not.
  if (/^\d+$/.test(reply) && question) {
    const options = question.questions?.[0]?.options ?? []
    const option = options[Number(reply) - 1]
    if (!option) {
      error([`${reply} is not one of the options:`, ...options.map((o, i) => `  ${i + 1}  ${stripControl(o.label)}`)].join('\n'))
      setExitCode(1)
      return
    }
    try {
      // One answer array per question, each holding the chosen labels — a single choice is [[label]].
      await client.respondQuestion(question.id, [[option.label]], worktree)
    } catch {
      error(`couldn't answer question on ${session.id}`)
      setExitCode(1)
      return
    }
    log(`answered ${session.id}: ${stripControl(option.label)}`)
    return
  }

  try {
    await client.promptAsync(session.id, reply, worktree)
  } catch {
    error(`couldn't send to ${session.id}`)
    setExitCode(1)
    return
  }
  log(`sent to ${session.id}`)
}

// `fleetview watch <id>`: tail -f for one session. `logs` is a snapshot and `attach` takes the whole
// terminal; this is the middle ground a split pane or a script wants — new output on stdout as it
// arrives, and an exit when the session goes idle.
//
// Deltas, not whole parts: opencode re-sends a growing text part on every token, so printing each
// `message.part.updated` verbatim would reprint the message from the top on every frame. What has
// already been written per part is remembered and only the tail goes out.
export async function runWatch(
  args: ParsedArgs,
  {
    ensureServer,
    serverFile,
    createClient = (url: string) => new OpencodeClient(url),
    connect = connectEvents,
    log = console.log,
    error = console.error,
    setExitCode = (code: number) => {
      process.exitCode = code
    },
  }: RunWatchDeps,
) {
  const found = await resolveSession(args.id, ensureServer, serverFile, createClient, error, setExitCode)
  if (!found) return
  const { session, worktree, server } = found
  const client = found.client as ReturnType<NonNullable<RunWatchDeps['createClient']>>
  const printed = new Map<string, number>()
  // Assigned synchronously inside the executor, so it is set by the time anything can resolve.
  let conn: ReturnType<typeof connect> | null = null
  await new Promise<void>((done) => {
    conn = connect(
      { host: server.host, port: server.port, directory: worktree },
      {
        onEvent: (_directory, event) => {
          if (event.type === 'message.part.updated' && event.properties.sessionID === session.id) {
            const part = event.properties.part
            const text = typeof part?.text === 'string' ? stripControl(part.text) : ''
            if (!text) return
            // messageID rather than the part's own id: parts arrive keyed either way across
            // opencode versions, and a message id is the one field the Part type promises.
            const key = typeof part?.id === 'string' ? part.id : (part?.messageID ?? 'part')
            const already = printed.get(key) ?? 0
            // A shorter text than last time is a different part reusing the key, not a rewind:
            // print it whole rather than slicing into the middle of it.
            const fresh = text.length >= already ? text.slice(already) : text
            printed.set(key, text.length)
            if (fresh.trim()) log(fresh)
            return
          }
          if (event.type === 'session.error' && event.properties.sessionID === session.id) {
            const failure = errorLabel(event.properties.error)
            if (failure) error(`error: ${failure}`)
            return
          }
          // Idle is how a turn ends.
          if (event.type === 'session.status' && event.properties.sessionID === session.id && event.properties.status?.type === 'idle') done()
          if (event.type === 'session.deleted' && event.properties.info?.id === session.id) done()
        },
        // M16: a session already idle (or gone idle before the stream connected) never sends an
        // idle frame, so ask once the stream is up: absent from the status map or idle means there
        // is no output coming, which is the honest answer. Asked after connecting, not before, so a
        // turn ending in between is caught by one side or the other. An unreadable status map
        // proves nothing, so the watch keeps waiting on the stream.
        onOnline: () => {
          void client.sessionStatus(worktree).then(
            (statuses) => {
              if (statuses && typeof statuses === 'object' && (statuses[session.id] ?? { type: 'idle' }).type === 'idle') done()
            },
            () => {},
          )
        },
        // No reconnect: a dropped stream mid-watch should end the command rather than silently
        // resume minutes later having missed the output the caller was waiting for.
        reconnect: false,
      },
    )
    // The stream ending on its own (server stopped, session's project gone) ends the watch too.
    void conn.done.then(() => done(), () => done())
  })
  // Always: a watch that ended because the session went idle still holds an open SSE request, and
  // leaving it open keeps the process alive after the command is logically over.
  ;(conn as ReturnType<typeof connect> | null)?.stop()
}

// --- Every backend: ls/--json, status, attach, logs, stop, rm ---

type Say = (message: string) => void

// opencode if it can be reached. Without any process-backed adapter its absence is the whole answer
// (the error line and exit 1 these commands always gave). With them, opencode missing or down is one
// stderr line and the command carries on with claude and copilot — stderr, so `--json` stays JSON.
async function connectOpencode<C extends Pick<RosterClient, 'listProjects'>>({
  ensureServer,
  serverFile,
  createClient,
  backends,
  error,
  setExitCode,
}: {
  ensureServer: EnsureServer
  serverFile: string
  createClient: (url: string) => C
  backends: Backends
  error: Say
  setExitCode: (code: number) => void
}): Promise<{ opencode: { client: C; server: ServerRef; projects: Project[] } | null } | null> {
  const r = await ensureServer(loadServer(serverFile) ?? DEFAULT_SERVER)
  if (r.ok) {
    const client = createClient(`http://${r.server.host}:${r.server.port}`)
    return { opencode: { client, server: r.server, projects: allProjectDirectories(await client.listProjects()) } }
  }
  const reason = r.reason ?? 'opencode server unreachable'
  const others = Object.keys(backends)
  if (others.length === 0) {
    error(reason)
    setExitCode(1)
    return null
  }
  const why = r.reason === OPENCODE_MISSING ? 'is not installed' : `is unavailable (${reason})`
  error(`fleetview: opencode ${why}; showing ${others.join(' and ')} sessions only`)
  return { opencode: null }
}

// Where claude and copilot are asked for sessions. Both adapters list per directory (Claude Code
// files transcripts by cwd, copilot records the cwd of each session), so this is the set fleetview
// already knows: opencode's project directories, the roster's worktrees, and the directory the
// command runs in (or --cwd).
// ponytail: no crawl of ~/.claude/projects or ~/.copilot/session-state, so a session in a directory
// none of these name is not listed; add a crawl if that gap turns out to matter.
const processDirs = (projects: Project[], rosterWorktrees: string[], cwd: string | undefined) => [
  ...new Set([...projects.map((p) => p.worktree), ...rosterWorktrees, cwd ?? process.cwd()]),
]

const rosterWorktrees = (load: () => { sessions: RosterMember[] }) => {
  try {
    return load().sessions.map((m) => m.worktree)
  } catch {
    return [] // a corrupt roster narrows discovery; it is not a reason to fail the command
  }
}

// The three seeding rounds that give an opencode session its state: sessions, then statuses (which
// only attach once the sessions are in), then pending permissions/questions.
async function seedOpencode(
  store: SessionStore,
  client: Pick<RosterClient, 'listSessions' | 'sessionStatus' | 'listPermissions' | 'listQuestions'>,
  projects: Project[],
  seen: SeenMap,
) {
  // Concurrent, because these are independent HTTP calls against one server and `ls` is something
  // people wait on — serially it took the sum of every project's round trip.
  const lists = await Promise.all(projects.map((p) => client.listSessions(p.worktree).catch(() => null)))
  lists.forEach((sessions, i) => sessions && store.setSessions(projects[i].worktree, sessions, seen))
  // Statuses come from the same endpoints the UI seeds from, so a listing and the roster agree.
  // Still a second round: seedStatuses only has anything to attach to once the sessions are in.
  const statuses = await Promise.all(projects.map((p) => client.sessionStatus(p.worktree).catch(() => null)))
  statuses.forEach((s, i) => s && store.seedStatuses(projects[i].worktree, s))
  // #54: and a third, for the pending state a status map does not carry. Without it both of
  // derive's `waiting` paths are unreachable here by construction, so `ls`/`--json` reported a
  // permission-blocked session as `working` with no `waitingFor` — contradicting the parity with
  // `claude agents --json` the README documents. Concurrent like the rounds above, so the wall
  // clock grows by about one round trip rather than 2N; each catch degrades that project to the
  // previous behaviour rather than failing the listing.
  const mark = store.seedMark()
  await Promise.all(
    projects.flatMap((p) => [
      client
        .listPermissions(p.worktree)
        .then((x) => store.seedPermissions(p.worktree, x, mark))
        .catch(() => {}),
      client
        .listQuestions(p.worktree)
        .then((x) => store.seedQuestions(p.worktree, x, mark))
        .catch(() => {}),
    ]),
  )
}

// The roster's discovery for a process-backed backend (use-discovery's streamBackend), run once per
// directory: one pass of the adapter's events() for run state, then its listing for titles and
// times. Both adapters read every session synchronously when subscribed (claude's poll loop does its
// first pass before it first sleeps, copilot ticks once up front), so stopping straight away keeps
// exactly that pass.
async function seedProcessBackends(store: SessionStore, backends: Backends, dirs: string[], seen: SeenMap) {
  await Promise.all(
    Object.entries(backends).flatMap(([name, backend]) =>
      dirs.map(async (dir) => {
        try {
          const normalise = backend.createNormaliser()
          const sub = backend.events(
            { directory: dir },
            {
              onEvent: (directory, event) => {
                for (const e of normalise(event)) {
                  const id = (e.properties as { sessionID?: string }).sessionID
                  if (id) store.noteOrigin(directory, id, name)
                  store.apply(directory, e)
                }
              },
            },
          )
          sub.stop()
          await sub.done
          const list = backend.normaliseSessions(await backend.listSessions(dir))
          for (const s of list) store.noteOrigin(dir, s.id, name)
          store.setSessions(dir, list, seen)
        } catch {
          // A CLI that isn't installed, or a state directory that doesn't exist: no sessions here.
        }
      }),
    ),
  )
}

// `fleetview --json` / `fleetview ls`: what is running, without opening anything.
// Takes its collaborators the same way `runBg` does, so the listing can be driven end to end in a
// test without a server — the seeding rounds are where `ls` decides a session's state, and
// asserting on the printed rows is the only way to know they all ran.
export async function listSessions(
  { all, json, cwd: rawCwd }: ParsedArgs,
  ensureServer: EnsureServer,
  serverFile: string,
  {
    createClient = (url: string) => new OpencodeClient(url),
    loadSeenImpl = loadSeen,
    seenFile = defaultSeenFile,
    loadRosterImpl = loadRoster,
    rosterFile = defaultRosterFile,
    backends = {},
    log = console.log,
    error = console.error,
    setExitCode = (code: number) => {
      process.exitCode = code
    },
  }: ListSessionsDeps = {},
) {
  const conn = await connectOpencode({ ensureServer, serverFile, createClient, backends, error, setExitCode })
  if (!conn) return
  // #107: resolve `--cwd` the same way the roster (resolve at cli.ts) and `bg` (realpathSync) do,
  // so `ls`/`--json` scope against the absolute project paths the roster stores rather than a raw
  // relative string that matches nothing. Resolved once, here, rather than at each underCwd call.
  const cwd = rawCwd === undefined ? undefined : resolve(rawCwd)
  const projects = conn.opencode?.projects ?? []
  const parents = sandboxParents(projects)
  const store = createStore()
  // Read once, not once per project: the file is the same on every iteration, so re-reading and
  // re-parsing it per project bought nothing and cost a stat + parse per project.
  const seen = loadSeenImpl(seenFile())
  // #32: read-only, and once, for the same reason — the roster is what remembers the dispatch
  // prompt behind a session the server never named (a `! cmd` job never takes a model turn, so
  // opencode's rename never fires and the row reads "New session - <timestamp>"). Keyed the same
  // `worktree:id` way the roster store keys members. A corrupt roster is not a reason to fail a
  // listing — `ls` only wants nicer titles out of it.
  let members = new Map<string, RosterMember>()
  try {
    members = new Map(loadRosterImpl(rosterFile()).sessions.map((m) => [`${m.worktree}:${m.id}`, m]))
  } catch {}
  if (conn.opencode) await seedOpencode(store, conn.opencode.client, projects, seen)
  await seedProcessBackends(store, backends, processDirs(projects, [...members.values()].map((m) => m.worktree), cwd), seen)
  const rows = []
  for (const group of store.byProject()) {
    const repo = displayProject(parents, group.projectKey)
    if (!underCwd(repo, cwd) && !underCwd(group.projectKey, cwd)) continue
    for (const session of group.sessions)
      rows.push(
        sessionJson(
          { ...session, title: memberTitle(session.title, members.get(`${group.projectKey}:${session.id}`)) },
          { repo, worktree: group.projectKey },
        ),
      )
  }
  rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  const visible = filterForList(rows, { all })
  if (json) return log(JSON.stringify(visible, null, 2))
  if (visible.length === 0) return log(all ? 'no sessions' : 'nothing running — fleetview ls --all to include finished sessions')
  for (const row of visible) log(formatRow(row))
}

// `fleetview status`: the header's counts line, once, for a shell prompt or tmux status-right.
// Exits 0 when something awaits input and 1 when nothing does — grep's convention, so
// `fleetview status && notify-send "fleet needs you"` reads the way it looks.
export async function runStatus(
  args: ParsedArgs,
  {
    ensureServer,
    serverFile,
    createClient = (url: string) => new OpencodeClient(url),
    loadSeenImpl = loadSeen,
    seenFile = defaultSeenFile,
    backends = {},
    rosterFile = defaultRosterFile(),
    log = console.log,
    error = console.error,
    setExitCode = (code: number) => {
      process.exitCode = code
    },
  }: RunStatusDeps,
) {
  const conn = await connectOpencode({ ensureServer, serverFile, createClient, backends, error, setExitCode })
  if (!conn) return
  const projects = conn.opencode?.projects ?? []
  const parents = sandboxParents(projects)
  const store = createStore()
  const seen = loadSeenImpl(seenFile())
  // The same seeding `ls` runs, and for the same reason: sessions alone have no status, and
  // statuses alone have no pending permission/question — summarise counts both.
  if (conn.opencode) await seedOpencode(store, conn.opencode.client, projects, seen)
  if (Object.keys(backends).length) await seedProcessBackends(store, backends, processDirs(projects, rosterWorktrees(() => loadRoster(rosterFile)), args.cwd), seen)
  const sessions = []
  for (const group of store.byProject()) {
    const repo = displayProject(parents, group.projectKey)
    if (!underCwd(repo, args.cwd) && !underCwd(group.projectKey, args.cwd)) continue
    sessions.push(...group.sessions)
  }
  log(summarise(sessions))
  setExitCode(sessions.some((s) => s.status === 'waiting' && Boolean(s.pendingRequest)) ? 0 : 1)
}

// The shell commands that take an id (attach, logs, stop, rm) share this: find the session across
// every backend — exactly, or by prefix, because ids are long and nobody retypes one in full — and
// hand back where it lives. Exits with a message rather than a stack when the id matches nothing,
// or more than one thing, because these are things people type by hand from a listing.
async function findSession<C extends Pick<RosterClient, 'listProjects' | 'listSessions'>>(
  id: string | undefined,
  deps: { ensureServer: EnsureServer; serverFile: string; createClient: (url: string) => C; backends: Backends; rosterFile: string; cwd?: string; error: Say; setExitCode: (code: number) => void },
) {
  const { backends, error, setExitCode } = deps
  // #33: said before anything is spawned or asked — a degenerate id is a usage mistake, and
  // starting a server to tell the user their shell variable was unset helps nobody.
  const problem = sessionIdProblem(id)
  if (problem) {
    error(`fleetview: ${problem}`)
    setExitCode(1)
    return null
  }
  const want = id!
  const conn = await connectOpencode(deps)
  if (!conn) return null
  const projects = conn.opencode?.projects ?? []
  const matches: { backend: string; id: string; worktree: string }[] = []
  if (conn.opencode) {
    for (const m of await matchSessions(conn.opencode.client, projects, want)) matches.push({ backend: DEFAULT_BACKEND, id: m.session.id, worktree: m.worktree })
  }
  if (Object.keys(backends).length) {
    const dirs = processDirs(projects, rosterWorktrees(() => loadRoster(deps.rosterFile)), deps.cwd)
    await Promise.all(
      Object.entries(backends).flatMap(([name, backend]) =>
        dirs.map(async (dir) => {
          for (const s of await backend.listSessions(dir).catch(() => [])) {
            if (s.id === want || s.id.startsWith(want)) matches.push({ backend: name, id: s.id, worktree: dir })
          }
        }),
      ),
    )
  }
  // A whole id the user typed is never ambiguous, even when it happens to also prefix a longer one.
  const exact = matches.filter((m) => m.id === want)
  const hits = exact.length === 1 ? exact : matches
  if (hits.length === 0) {
    error(`no session matching ${want}`)
    setExitCode(1)
    return null
  }
  if (hits.length > 1) {
    // Listed, not resolved: the caller is about to attach to, stop, or delete one of these, and
    // guessing which is exactly the failure this replaces.
    const line = (m: (typeof hits)[number]) => `  ${m.id}  ${m.worktree}${m.backend === DEFAULT_BACKEND ? '' : `  (${m.backend})`}`
    error([`${want} matches ${hits.length} sessions — use more of the id:`, ...hits.map(line)].join('\n'))
    setExitCode(1)
    return null
  }
  const hit = hits[0]
  return {
    ...hit,
    repo: displayProject(sandboxParents(projects), hit.worktree),
    // Set only for an opencode hit, which is what tells the callers which family they are acting on.
    opencode: hit.backend === DEFAULT_BACKEND && conn.opencode ? { client: conn.opencode.client, server: conn.opencode.server } : null,
  }
}

type SessionCommandDeps = {
  ensureServer: EnsureServer
  serverFile: string
  createClient?(url: string): RosterClient
  backends?: Backends
  rosterFile?: string
  spawnSyncImpl?: typeof spawnSync
  log?(message: string): void
  error?(message: string): void
  setExitCode?(code: number): void
}

const withDefaults = ({
  createClient = (url: string) => new OpencodeClient(url),
  backends = {},
  rosterFile = defaultRosterFile(),
  spawnSyncImpl = spawnSync,
  log = console.log,
  error = console.error,
  setExitCode = (code: number) => {
    process.exitCode = code
  },
  ...rest
}: SessionCommandDeps) => ({ ...rest, createClient, backends, rosterFile, spawnSyncImpl, log, error, setExitCode })

// The adapter that owns a found session: opencode's is built from the connection that found it.
const adapterFor = (found: { backend: string; opencode: { client: RosterClient; server: ServerRef } | null }, backends: Backends) =>
  found.opencode ? createOpencodeBackend(found.opencode) : backends[found.backend]

// `fleetview attach <id>`: straight handover. No roster to suspend, so this is the plain form of
// what `→` does.
export async function runAttach(args: ParsedArgs, deps: SessionCommandDeps) {
  const d = withDefaults(deps)
  const found = await findSession(args.id, { ...d, cwd: args.cwd })
  if (!found) return
  const [command, ...argv] = adapterFor(found, d.backends).attach({ id: found.id, directory: found.worktree })
  // cwd is the session's worktree: a process-backed resume (`claude --resume <id>`) is cwd-scoped
  // and fails "No conversation found" from fleetview's own directory. Harmless for opencode, which
  // carries the directory in its argv. The env follows attachLoop's rule: only opencode's attach
  // gets the server password (it authenticates with it); a process-backed child gets childEnv().
  const result = d.spawnSyncImpl(command, argv, { stdio: 'inherit', cwd: found.worktree, env: found.opencode ? process.env : childEnv() })
  if (result.error) {
    d.error(`couldn't launch ${found.backend}: ${result.error.message}`)
    d.setExitCode(1)
  }
}

// `fleetview logs <id> [--all]`: a session's recent output, printed once.
export async function runLogs(args: ParsedArgs, deps: SessionCommandDeps) {
  const d = withDefaults(deps)
  const found = await findSession(args.id, { ...d, cwd: args.cwd })
  if (!found) return
  if (!found.opencode) {
    // capabilities.messages is false for both process backends: the transcript is a file in the
    // CLI's own state directory, not something fleetview can fetch, which is also why peek says
    // "attach to read it" for these rows.
    d.error(`${found.backend} sessions have no transcript fleetview can read; fleetview attach ${found.id} to read it`)
    d.setExitCode(1)
    return
  }
  const messages = await found.opencode.client.listMessages(found.id, found.worktree).catch(() => [])
  // "Print recent output" — the whole transcript of a long session is pages of text nobody asked
  // for, and the first thing in it is usually a prompt the user wrote themselves. --all overrides.
  const recent = args.all ? (messages ?? []) : (messages ?? []).slice(-RECENT_MESSAGES)
  for (const m of recent) {
    const role = m?.info?.role
    // #32: shared with peek — 'text' parts, or a message's tool output when it has no text parts
    // at all, which is exactly the shape of a `! cmd` shell job and the reason its output used to
    // be unreachable from here. messageBody also does the stripControl this printed with: message
    // text goes straight to stdout with no Ink backstop, so an escape in a reply (OSC 52 clipboard
    // write, OSC 0/2 title spoof) would drive the terminal.
    const text = messageBody(m, '')
    if (text.trim()) d.log(`${role === 'user' ? 'you' : 'opencode'}: ${text}`)
    // #24: a failed turn's only content is `info.error` — without this, `logs` on a session that
    // failed every dispatch printed the user's own prompt and nothing else. errorLabel strips it
    // for the same reason the body above is stripped.
    const failure = errorLabel(m?.info?.error)
    if (failure) d.log(`error: ${failure}`)
  }
}

// `fleetview stop <id>`: abort the running turn, leaving the session in the list.
export async function runStop(args: ParsedArgs, deps: SessionCommandDeps) {
  const d = withDefaults(deps)
  const found = await findSession(args.id, { ...d, cwd: args.cwd })
  if (!found) return
  const result = await adapterFor(found, d.backends).abort(found.id, found.worktree)
  // A process backend answers {aborted:false} when nothing of this session's is running (no pid, a
  // pid that is no longer this run, or one that already exited); "stopped" would claim otherwise.
  d.log(isRecord(result) && result.aborted === false ? `nothing running to stop on ${found.id}` : `stopped ${found.id}`)
}

