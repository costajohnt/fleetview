// Agent view has a shell surface next to the view itself — `claude agents --cwd/--json`, and
// `attach`, `logs`, `stop`, `rm` as subcommands. fleetview took no arguments at all, which made the
// dispatch target unpredictable (it fell back to wherever you happened to be) and left no way to
// ask what is running without opening the UI.
//
// Pure: parsing is separated from doing so the grammar can be tested without a server, a terminal,
// or a process to kill.

export const USAGE = `fleetview — a roster for opencode sessions

  fleetview                      open the roster
    --model <provider/model>     default model for every session dispatched this run
    --agent <name>               default subagent for an unprefixed dispatch
    --backend <name>             agent CLI to dispatch on: opencode, claude, copilot
                                 (default opencode, or $FLEETVIEW_BACKEND)
  fleetview --cwd <path>         open it scoped to sessions under <path>
  fleetview --json [--all]       print sessions as JSON instead of opening the roster
  fleetview ls [--all]           the same list, one line per session
  fleetview attach <id>          attach to a session in this terminal
  fleetview logs <id> [--all]    print a session's recent output (--all for everything)
  fleetview stop <id>            stop a session, leaving it in the list
  fleetview rm <id>              delete a session (keeps a worktree holding commits)
  fleetview bg "<prompt>"        dispatch a background session without opening the roster
    --name <title>               name the session instead of waiting for opencode's title
    --agent <name>               run as that subagent
    --model <provider/model>     override the model for this dispatch
    --exec                       treat the prompt as a shell command (a ! job)
  fleetview server status        the opencode server fleetview talks to: host, port, pid, health
  fleetview server stop          stop that server (all sessions stop streaming until restart)
  fleetview --help               this text`

const SUBCOMMANDS = new Set(['attach', 'logs', 'stop', 'rm', 'ls', 'server', 'bg'])

export type ParsedArgs = {
  command: string
  all?: boolean
  json?: boolean
  cwd?: string
  id?: string
  prompt?: string
  serverAction?: string
  name?: string
  agent?: string
  model?: string
  backend?: string
  exec?: boolean
}
export type ParseResult = ParsedArgs | { error: string }

// Returns {command, id?, cwd?, all?, json?} or {error}. `command` is 'ui' when there is nothing to
// do but open the roster, which is still the common case.
export function parseArgs(argv: string[] = []): ParseResult {
  const out: ParsedArgs = { command: 'ui', all: false, json: false }
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { command: 'help' }
    if (arg === '--version' || arg === '-v') return { command: 'version' }
    if (arg === '--json') {
      out.json = true
      continue
    }
    if (arg === '--all') {
      out.all = true
      continue
    }
    if (arg === '--cwd') {
      const value = argv[++i]
      if (!value) return { error: '--cwd needs a path' }
      out.cwd = value
      continue
    }
    if (arg.startsWith('--cwd=')) {
      const value = arg.slice('--cwd='.length)
      if (!value) return { error: '--cwd needs a path' }
      out.cwd = value
      continue
    }
    // --backend rides the same value-taking branch as --model/--agent rather than getting a case of
    // its own; the name itself is validated where the backends exist (cli.ts), exactly as --model's
    // provider/model split is, so this stays a parser and not a registry.
    if (arg === '--name' || arg === '--agent' || arg === '--model' || arg === '--backend') {
      const value = argv[++i]
      if (!value) return { error: `${arg} needs a value` }
      ;(out as Record<string, unknown>)[arg.slice(2)] = value
      continue
    }
    if (arg === '--exec') {
      out.exec = true
      continue
    }
    if (arg.startsWith('-')) return { error: `unknown option: ${arg}` }
    rest.push(arg)
  }

  if (rest.length === 0) {
    // `--json` on its own is the listing, which is what agent view's `claude agents --json` means.
    if (out.json) out.command = 'ls'
    return out
  }
  const [name, ...args] = rest
  if (!SUBCOMMANDS.has(name)) return { error: `unknown command: ${name}` }
  out.command = name
  if (name === 'ls') return out
  if (name === 'bg') {
    // The prompt is everything after `bg`, joined — quoting the whole thing is friendlier than
    // demanding one shell-escaped argument, and a prompt with spaces is the only kind there is.
    const prompt = args.join(' ').trim()
    if (!prompt) return { error: 'bg needs a prompt' }
    out.prompt = prompt
    return out
  }
  if (name === 'server') {
    // `server` takes an action word, not a session id.
    if (args.length === 0) return { error: 'server needs an action: status or stop' }
    if (args.length > 1 || !['status', 'stop'].includes(args[0])) return { error: 'server takes one action: status or stop' }
    out.serverAction = args[0]
    return out
  }
  // The rest take exactly one session id. Saying which is missing beats a generic usage dump.
  if (args.length === 0) return { error: `${name} needs a session id` }
  if (args.length > 1) return { error: `${name} takes one session id` }
  out.id = args[0]
  return out
}

// #33: `attach`/`logs`/`stop`/`rm` resolve an id by prefix, because ids are long and nobody retypes
// one in full — but an empty string prefixes EVERY session, so `fleetview logs "$id"` with an unset
// variable listed the whole server back as "matches N sessions", and so does any one- or two-letter
// typo, since every id starts `ses_`. Four characters is the shortest thing that can carry a
// character of the random part, so it is the shortest thing worth resolving. Pure and exported so
// the grammar can be tested without a server.
export const MIN_SESSION_ID_CHARS = 4
export const sessionIdProblem = (id: string | undefined | null): string | null => {
  const trimmed = (id ?? '').trim()
  if (!trimmed) return 'needs a session id — got an empty one (an unset shell variable?)'
  if (trimmed.length < MIN_SESSION_ID_CHARS)
    return `session id "${trimmed}" is too short — give at least ${MIN_SESSION_ID_CHARS} characters of it (every id starts "ses_")`
  return null
}

// Parse a `--model provider/model` flag into the shape createSession and the header want, or null
// when it isn't `<provider>/<model>`. Shared by `bg` and the roster launch so the two can't drift.
export const parseModel = (str: string): { providerID: string; id: string } | null => {
  const [providerID, ...rest] = str.split('/')
  const id = rest.join('/')
  return providerID && id ? { providerID, id } : null
}

// A session as the shell should see it. Mirrors the fields agent view's `--json` documents, with
// fleetview's state vocabulary translated to agent view's words so scripts written against one work
// against the other.
const STATE_WORDS: Record<string, string> = {
  running: 'working',
  waiting: 'blocked',
  done: 'done',
  error: 'failed',
  stopped: 'stopped',
  idle: 'idle',
}

// TODO(types): `session` is a session-store row whose wire-derived fields are dynamic; loose by design.
export function sessionJson(session: any, { repo, worktree }: { repo?: string; worktree?: string } = {}) {
  return {
    id: session.id,
    name: session.title,
    // Every fleetview session is a background session as far as the roster is concerned — there is no
    // interactive-session concept the way agent view has one — so this is a constant, present so a
    // script that switches on `kind` still finds the field agent view documents.
    kind: 'background',
    state: STATE_WORDS[session.status] ?? session.status,
    // The repository, not the worktree it happens to run in — the same thing the rows say.
    cwd: repo ?? session.projectKey,
    // ...but the worktree too when there is one, because a script that wants to inspect the work
    // needs to know where it landed.
    ...(worktree && worktree !== repo ? { worktree } : {}),
    startedAt: session.createdAt || undefined,
    updatedAt: session.updatedAt || undefined,
    agent: session.agent,
    ...(session.ranForMs !== null && session.ranForMs !== undefined ? { ranForMs: session.ranForMs } : {}),
    ...(session.waitingSince ? { waitingSince: session.waitingSince } : {}),
    // agent view's waitingFor: only present while the session is blocked on a reported request.
    ...(session.waitingFor ? { waitingFor: session.waitingFor } : {}),
    ...(session.snippet ? { summary: session.snippet } : {}),
  }
}

// "Include completed sessions" is what --all adds; without it the list is what is still live, which
// is what you want when you are deciding whether it is safe to close the laptop.
//
// Deliberately NOT session-store's FINISHED_STATUSES, despite looking like it: these are the words
// `ls` prints (STATE_WORDS above maps the store's vocabulary onto agent view's, so a store `error`
// is `failed` here), matched against `row.state` rather than a store status. `idle` is left out on
// purpose too: a session that has never run has not finished, and dropping it from the default
// listing would hide the one the user just created.
const FINISHED = new Set(['done', 'failed', 'stopped'])
export const filterForList = <T extends { state: string }>(rows: T[], { all = false }: { all?: boolean } = {}): T[] =>
  all ? rows : rows.filter((r) => !FINISHED.has(r.state))

// Only sessions at or below `cwd`, so `--cwd .` in a repository means that repository. Compares
// path segments rather than string prefixes: /x/alphabet must not match --cwd /x/alpha.
export function underCwd(path: string, cwd?: string): boolean {
  if (!cwd) return true
  // A trailing slash is how shells complete a directory, so `--cwd src/` must mean the same as
  // `--cwd src`. Normalised before comparing, not after, or the equality test misses.
  const root = cwd.length > 1 && cwd.endsWith('/') ? cwd.slice(0, -1) : cwd
  return path === root || path.startsWith(`${root}/`)
}

export const formatRow = (row: { id: string; state: string; name?: string; summary?: string }): string =>
  [row.id, row.state.padEnd(8), row.name ?? '', row.summary ? `— ${row.summary}` : ''].filter(Boolean).join('  ')
