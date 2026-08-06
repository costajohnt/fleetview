#!/usr/bin/env node
import React from 'react'
import { render } from 'ink'
// node-pty is a native module with prebuilds for macOS and Windows only, so on Linux it compiles
// at install time and needs python3/make/g++. If it isn't usable, fleetview still works — attaching
// falls back to handing the terminal over the old way, which costs the detach chord and
// quick-switch but not the tool. A hard import would instead make fleetview fail to start at all on a
// machine where everything else about it is fine.
// TODO(types): node-pty is an optional native module; its surface (spawn) is used dynamically.
let pty: any = null
try {
  pty = (await import('node-pty')).default
} catch {
  pty = null
}
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpathSync, existsSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { App } from './app.ts'
import { OpencodeClient } from './backends/opencode/client.ts'
import { createOpencodeBackend } from './backends/opencode/index.ts'
import { BACKEND_NAMES, DEFAULT_BACKEND, createBackends, defaultBackendName, isBackendName } from './backends/index.ts'
import { loadServer, saveServer, defaultServerFile } from './registry.ts'
import { spawnServer, isServerHealthy, isAuthEnforced, probeServer } from './backends/opencode/server-manager.ts'
import { loadSeen, saveSeen, defaultSeenFile } from './seen-store.ts'
import { loadRoster, saveRoster, makePersistRoster, defaultRosterFile } from './roster-store.ts'
import { attachPty } from './pty-host.ts'
import { createStore, memberTitle, messageBody, errorLabel } from './session-store.ts'
import { sandboxParents, displayProject, worktreeSafety, allProjectDirectories } from './worktree.ts'
import { parseArgs, sessionJson, filterForList, underCwd, formatRow, parseModel, sessionIdProblem, USAGE } from './cli-args.ts'
import { stripControl } from './text-utils.ts'
import type { ParsedArgs } from './cli-args.ts'
import type { Backend, ServerRef } from './types.ts'

// Read live from package.json (same as the header banner) rather than a hardcoded literal, so
// `fleetview --version` can't drift from the published version the way a stale '0.0.0' did.
const VERSION = createRequire(import.meta.url)('../package.json').version
const RECENT_MESSAGES = 10
import { gatedStdout } from './gated-stdout.ts'
import { MOUSE_OFF } from './ui/mouse.ts'

const DEFAULT_SERVER = { host: '127.0.0.1', port: 4900, pid: null }

// TODO(types): `seen`/`snap` are wire-derived watermark maps; kept as loose string-keyed records.
export function makePersistSeen({
  seen,
  saveSeen,
  seenFile,
}: {
  seen: Record<string, any>
  saveSeen: (file: string, data: Record<string, any>) => unknown
  seenFile: string
}) {
  // merge onto the loop-iteration's read, never overwrite wholesale — a wholesale write
  // would drop done-flags/watermarks for projects whose listSessions failed this run (offline).
  // liveProjectKeys: projects that successfully listSessions'd this run — only their keys are
  // eligible for pruning, so an offline project's watermarks survive untouched.
  return (snap: Record<string, any>, liveProjectKeys: string[] = []) => {
    const live = new Set(liveProjectKeys)
    const base: Record<string, any> = {}
    for (const [key, value] of Object.entries(seen)) {
      if (!key.startsWith('/')) continue // v1 repoId key (e.g. 'sandbox-...') — v2 keys are always abs worktree paths, drop unconditionally
      const projectKey = key.slice(0, key.lastIndexOf(':')) // session ids never contain ':'; worktrees may, so split on the last one
      if (live.has(projectKey) && !(key in snap)) continue // project listed fresh; key vanished → session gone, prune it
      base[key] = value
    }
    return saveSeen(seenFile, { ...base, ...snap })
  }
}

export function makeEnsureServer({
  isServerHealthy,
  isAuthEnforced = async () => true,
  // Tri-state form of the same probe (server-manager.probeServer). Defaulted off isServerHealthy so
  // every existing caller and test keeps working; only the "is that port occupied by a server whose
  // password we don't hold" question needs the difference between 401 and nothing listening.
  probeServer = async (server: ServerRef) => ((await isServerHealthy(server)) ? 'healthy' : 'unreachable'),
  spawnServer,
  saveServer,
  serverFile,
  pollMs = 500,
  processKill = process.kill,
  spawnSyncImpl = spawnSync,
  warn = console.warn,
  // Informational sink, separate from `warn` on purpose: adopting a server fleetview didn't spawn
  // is supported, documented behaviour, so it gets one plain line rather than a warning voice.
  notice = console.error,
  identifyServer = looksLikeOpencodeServer,
  env = process.env,
}: {
  isServerHealthy: (server: ServerRef) => Promise<boolean>
  isAuthEnforced?: (server: ServerRef) => Promise<boolean>
  probeServer?: (server: ServerRef) => Promise<'healthy' | 'unauthorized' | 'unreachable'>
  spawnServer: (server: ServerRef, opts: any) => number | undefined
  saveServer: (file: string, server: ServerRef) => unknown
  serverFile: string
  pollMs?: number
  processKill?: typeof process.kill
  spawnSyncImpl?: typeof spawnSync
  warn?: typeof console.warn
  notice?: typeof console.error
  identifyServer?: (pid: number) => { ok: boolean; reason?: string; command?: string }
  env?: NodeJS.ProcessEnv
}) {
  // opencode cold boot (plugins) can exceed 5s; observed live on 1.18.4
  const pollUntilHealthy = async (candidate: ServerRef) => {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, pollMs))
      if (await isServerHealthy(candidate)) return true
    }
    return false
  }
  // a candidate whose poll window expired is a leaked child (spawned, never healthy) — kill it
  // before moving on, or every failed candidate/restart accumulates a zombie opencode process.
  const reap = (pid: number | null | undefined) => {
    if (pid) try { processKill(pid, 'SIGTERM') } catch {}
  }
  // One spawn attempt on one port, from persisting the record to knowing the password took.
  // The record is written BEFORE the spawn as well as after: a crash in between used to leave a
  // detached server armed with a password that existed only in a dead process's env — unreachable
  // and unstoppable by the next run. Written again with the pid once there is one.
  const trySpawn = async (candidate: ServerRef) => {
    saveServer(serverFile, { ...candidate, pid: null })
    const pid = spawnServer(candidate, {})
    saveServer(serverFile, { ...candidate, pid })
    if (!(await pollUntilHealthy(candidate))) {
      reap(pid)
      return null
    }
    // M2: a healthy probe is not evidence the password is enforced — a foreign passwordless opencode
    // that got the port first answers our authenticated probe 200 all the same (it ignores auth it
    // doesn't require). Persisting a password for such a server would make the next run trust a
    // credential protecting nothing, so the record is saved without it.
    if (await isAuthEnforced(candidate)) return { ...candidate, pid }
    warn(
      `fleetview: the opencode server now on ${candidate.host}:${candidate.port} does not require OPENCODE_SERVER_PASSWORD — its arbitrary-shell route is reachable without one. Stop it to have fleetview spawn a password-protected server.`,
    )
    const { password, ...bare } = candidate
    saveServer(serverFile, { ...bare, pid })
    return { ...bare, pid }
  }
  // ensureServer runs again on every roster-loop iteration, so the adoption notice below is once per
  // process: the fact is worth stating, restating it every few seconds is not.
  let adoptionNoticed = false
  const noticeIfForeign = (server: ServerRef) => {
    if (adoptionNoticed) return
    // Fleetview's own server is the one whose pid server.json recorded and which is still a live
    // `opencode serve`. Anything else on that port is a server fleetview is adopting: usually the
    // user's own, occasionally not the one they think.
    if (server.pid && identifyServer(server.pid).ok) return
    adoptionNoticed = true
    const unprotected = env.OPENCODE_SERVER_PASSWORD
      ? ''
      : ' No OPENCODE_SERVER_PASSWORD is set, so its shell route is reachable by anything on loopback.'
    notice(`fleetview: using the opencode server already running on ${server.host}:${server.port} — fleetview did not start it.${unprotected}`)
  }
  return async function ensureServer(server: ServerRef) {
    // M11: a password fleetview generated for a server it spawned lives in server.json, because that
    // server is detached and outlives fleetview. Adopt it before the first probe — otherwise the next
    // run probes its own still-running server unauthenticated, reads the 401 as "dead", and spawns a
    // duplicate on every fallback port. probeServer only presents it to a listener that answered 401,
    // so putting it in the environment here is not the same as showing it to whoever holds the port.
    const adoptedSaved = Boolean(server.password) && !env.OPENCODE_SERVER_PASSWORD
    if (adoptedSaved) env.OPENCODE_SERVER_PASSWORD = server.password
    const state = await probeServer(server)
    if (state === 'healthy') {
      // Adopting a server fleetview didn't spawn (v2 reuses any healthy opencode). If a password is
      // set but this already-running server doesn't enforce it, the documented mitigation is silently
      // off — warn rather than fail, since the user may knowingly be pointing at a trusted server.
      if (!(await isAuthEnforced(server))) {
        warn(
          `fleetview: OPENCODE_SERVER_PASSWORD is set, but the opencode server already running on ${server.host}:${server.port} does not require it — its arbitrary-shell route is reachable without a password. Stop that server to have fleetview spawn a password-protected one.`,
        )
      }
      noticeIfForeign(server)
      return { ok: true, server }
    }
    // M4: the user set OPENCODE_SERVER_PASSWORD over a server fleetview started with a generated one,
    // so the adoption above stood down and the probe just 401'd under their password. Retry under the
    // saved one before concluding the server is dead: respawning would fail to bind, walk the fallback
    // ports, and leave the running server orphaned with its shell route alive under a password nobody
    // is holding any more.
    let stalePassword = false
    if (state === 'unauthorized' && adoptedSaved) {
      // The saved password was adopted from server.json and then rejected by whatever holds the
      // port. Two things follow: that listener is not the server the password was saved for, and it
      // has now seen the password. Reusing it for the replacement fleetview is about to spawn on a
      // fallback port would arm that server with a credential the rejecting listener already holds,
      // so the saved one is burned here and `generated` below mints a fresh UUID instead.
      delete env.OPENCODE_SERVER_PASSWORD
      stalePassword = true
    } else if (server.password && env.OPENCODE_SERVER_PASSWORD !== server.password) {
      const userPassword = env.OPENCODE_SERVER_PASSWORD
      env.OPENCODE_SERVER_PASSWORD = server.password
      if (await isServerHealthy(server)) {
        warn(
          `fleetview: the opencode server on ${server.host}:${server.port} was started by fleetview with a different password, so OPENCODE_SERVER_PASSWORD as set has no effect on it — using the saved one. Run \`fleetview server stop\` first if you want yours to take.`,
        )
        return { ok: true, server }
      }
      if (userPassword === undefined) delete env.OPENCODE_SERVER_PASSWORD
      else env.OPENCODE_SERVER_PASSWORD = userPassword
      stalePassword = true // that server is gone; its password must not ride onto the replacement
    }
    // We're spawning the server ourselves, so we own its environment: an unauthenticated opencode
    // serve exposes POST /session/:id/shell (arbitrary shell) to anything on loopback, and it stays
    // up after fleetview exits. Mint a password when the user hasn't set one — the child inherits it
    // through process.env, as do our own requests and `opencode attach` (authHeader in client.ts) —
    // and persist only a generated one (server.json is 0600); a user-set password stays where they
    // put it. Servers fleetview merely adopts are untouched: that branch returned above.
    const generated = env.OPENCODE_SERVER_PASSWORD ? null : (env.OPENCODE_SERVER_PASSWORD = randomUUID())
    // The replacement enforces whatever is in env now, so a saved password whose server is gone is
    // dropped rather than persisted alongside a child that has never heard of it.
    const target = generated ? { ...server, password: generated } : stalePassword ? { ...server, password: undefined } : server
    // `unauthorized` means the port is held by a server enforcing a password we don't have, so our
    // own spawn there could never bind — skip straight to the fallback walk rather than spending the
    // poll window on a child that is already doomed.
    if (state !== 'unauthorized') {
      const spawned = await trySpawn(target)
      if (spawned) return { ok: true, server: spawned }
    } else {
      warn(`fleetview: something on ${server.host}:${server.port} is answering but rejecting fleetview's password — leaving it alone and trying the next port.`)
    }
    // opencode missing entirely (ENOENT) — no fallback port will ever succeed either, fail fast.
    const probe = spawnSyncImpl('opencode', ['--version'])
    if ((probe.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return { ok: false, server, reason: 'opencode not installed — see https://opencode.ai' }
    }
    // configured port never came healthy — a bind failure or a non-opencode squatter holding it.
    // v2 can use ANY healthy opencode server it finds (global db, one server serves all projects),
    // so this fallback is only for the case where our own spawn couldn't bind/serve on `port` at all;
    // a foreign opencode already on that port would have passed isServerHealthy above and returned true.
    for (let p = server.port + 1; p <= server.port + 10; p++) {
      const spawned = await trySpawn({ ...target, port: p })
      if (spawned) return { ok: true, server: spawned }
    }
    return { ok: false, server, reason: 'server did not become healthy' }
  }
}

// A pid in server.json is a claim about the past, not a fact about now: opencode may have exited
// and the OS handed that number to something else, in which case `server stop` would SIGTERM an
// innocent process (an editor, a build) that has nothing to do with fleetview. `ps -o command= -p`
// is the one form macOS and Linux both answer identically, and anything that doesn't read as the
// `opencode serve` fleetview spawned is refused rather than signalled — a server left running is a
// nuisance, a killed unrelated process is lost work.
export function looksLikeOpencodeServer(pid: number, { spawnSyncImpl = spawnSync }: { spawnSyncImpl?: typeof spawnSync } = {}) {
  const probe = spawnSyncImpl('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  // ps exits non-zero when no process matches; an error means no ps at all, which is no evidence
  // either — both leave us unable to confirm, and unconfirmed must not mean "signal it anyway".
  if (probe.error || probe.status !== 0) return { ok: false, reason: 'no such process' }
  const command = String(probe.stdout ?? '').trim()
  if (!command) return { ok: false, reason: 'no such process' }
  // Both halves: `opencode` as a bare argv[0] or a full path, and the `serve` subcommand — an
  // interactive `opencode` TUI holding the recycled pid is not the thing `server stop` is for.
  const isOpencode = /(^|\/|\s)opencode(\s|$)/.test(command) && /(^|\s)serve(\s|$)/.test(command)
  // The refusal quotes another process's argv straight to the user's terminal, so it gets the same
  // treatment as every other foreign string here: control bytes stripped (an OSC in a planted argv
  // would drive the terminal) and cut to one line's worth.
  return isOpencode ? { ok: true, command } : { ok: false, reason: stripControl(command).replace(/\s+/g, ' ').slice(0, 120) }
}

// `fleetview bg`, lifted out of main() for the reason makeEnsureServer was: almost everything here
// is a decision (reject a malformed --model before anything exists server-side, carry the shell flag
// into the roster) and none of it was reachable from a test while it sat inline behind a real server
// and a real createSession. Dependencies arrive as an options object with real defaults, so main()
// passes only what it already holds and tests pass fakes.
// TODO(types): the options bag is a test-injection surface (real deps + fakes); typed loose on purpose.
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
  }: any = {},
) {
  // Dispatch without opening the roster — agent view's `claude --bg`. Runs in the current
  // directory (or --cwd), joins the roster so the next `fleetview` shows it, and prints the id.
  // No worktree isolation from here: that is the interactive dispatch path's business; a shell
  // dispatch runs where you pointed it, like the `!` form.
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
  if (args.exec) await client.runShell(session.id, args.prompt, dir, args.agent ?? 'build')
  else await client.promptAsync(session.id, args.prompt, dir)
  const roster = loadRosterImpl(rosterFile)
  // Same membership shape App writes: shell flag drives the job auto-clean, prompt feeds the
  // any-URL filter.
  roster.sessions.push({ worktree: dir, id: session.id, addedAt: now(), ...(args.exec ? { shell: true } : {}), prompt: (args.prompt ?? '').slice(0, 2000) })
  saveRosterImpl(rosterFile, roster)
  log(`${session.id}  ${args.exec ? '!' : ''}${(args.prompt ?? '').slice(0, 60)}`)
}

// `fleetview server status` / `server stop`. Takes no ensureServer at all, and that is the point:
// `status` answers about the world as it is, and `stop` on a server that isn't running has nothing
// to do — both the opposite of ensureServer's job, so the dependency it would spawn through simply
// isn't in scope here.
// TODO(types): options bag is a test-injection surface; typed loose on purpose.
export async function runServer(
  args: ParsedArgs,
  {
    serverFile,
    loadServerImpl = loadServer,
    isServerHealthyImpl = isServerHealthy,
    identifyServer = looksLikeOpencodeServer,
    processKill = process.kill,
    pollMs = 250,
    log = console.log,
    error = console.error,
    env = process.env,
    setExitCode = (code: number) => {
      process.exitCode = code
    },
  }: any = {},
) {
  const server = loadServerImpl(serverFile) ?? DEFAULT_SERVER
  // H1: the same adoption makeEnsureServer does, for the same reason — the probe below authenticates
  // through authHeader(), which reads the env var and nothing else. A password fleetview generated
  // lives in server.json and never in a fresh process's env, so without this line `server status`
  // reports fleetview's own server dead and `server stop` no-ops before reaching the kill.
  // Putting it in the environment is not the same as showing it to the port: probeServer (which
  // isServerHealthy runs on) asks unauthenticated first and only presents the credential to a
  // listener that answered 401. `status`/`stop` spawn nothing, so there is no replacement server
  // here for a rejected password to ride onto — that half is handled in makeEnsureServer.
  if (server.password && !env.OPENCODE_SERVER_PASSWORD) env.OPENCODE_SERVER_PASSWORD = server.password
  const healthy = await isServerHealthyImpl(server)
  if (args.serverAction === 'status') {
    log(`host     ${server.host}`)
    log(`port     ${server.port}`)
    log(`pid      ${server.pid ?? 'unknown'}`)
    log(`healthy  ${healthy ? 'yes' : 'no'}`)
    setExitCode(healthy ? 0 : 1)
    return
  }
  // stop: sessions live server-side in opencode — stopping the server stops every stream until
  // something starts one again (fleetview will, on next launch). Refuse only when there is
  // nothing to act on.
  if (!healthy) return log('server is not running — nothing to stop')
  if (!server.pid) {
    error('server is healthy but its pid is unknown (not spawned by fleetview) — stop it where it was started')
    setExitCode(1)
    return
  }
  const identity = identifyServer(server.pid)
  if (!identity.ok) {
    error(
      `pid ${server.pid} is not an opencode server (${identity.reason}) — refusing to signal it. Something is answering on :${server.port}; stop it where it was started.`,
    )
    setExitCode(1)
    return
  }
  try {
    processKill(server.pid, 'SIGTERM')
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    error(`couldn't signal pid ${server.pid}: ${err.code ?? err.message}`)
    setExitCode(1)
    return
  }
  // Verify it actually died rather than reporting the signal as the deed.
  for (let i = 0; i < 20 && (await isServerHealthyImpl(server)); i++) await new Promise((r) => setTimeout(r, pollMs))
  const still = await isServerHealthyImpl(server)
  log(still ? 'signalled, but the server is still answering — check it manually' : `stopped opencode server on :${server.port}`)
  setExitCode(still ? 1 : 0)
}

// Every session across every project whose id matches — exactly, or by prefix, because ids are long
// and nobody retypes one in full. All of them, not the first hit: the old form walked projects
// serially and returned whichever answered first, so an ambiguous prefix silently attached to (or
// deleted) an arbitrary one of the matches. Exported for tests.
// TODO(types): `client` and session rows are dynamic opencode wire data; loose by design.
export async function matchSessions(client: any, projects: { worktree: string }[], id: string) {
  // #33: a degenerate id matches nothing rather than everything. Enforced here, not only at the
  // caller, because prefix matching is what makes '' and 's' match every session on the server —
  // any future caller gets the guard for free. withSession says why before it gets this far.
  if (sessionIdProblem(id)) return []
  const lists = await Promise.all(projects.map((p) => client.listSessions(p.worktree).catch(() => [])))
  const matches: { session: any; worktree: string }[] = []
  lists.forEach((sessions, i) => {
    for (const session of sessions ?? []) {
      if (session.id === id || session.id.startsWith(id)) matches.push({ session, worktree: projects[i].worktree })
    }
  })
  // A whole id the user typed is never ambiguous, even when it happens to also prefix a longer one.
  const exact = matches.filter((m) => m.session.id === id)
  return exact.length === 1 ? exact : matches
}

// The shell commands. Each one needs a healthy server and a session id, so they share this: resolve
// the server, find the session across every project, and hand both to the caller. Exits with a
// message rather than a stack when the id doesn't match anything — or matches more than one thing —
// because these are things people type by hand from a listing.
async function withSession(id: string, ensureServer: any, serverFile: string) {
  // #33: said before anything is spawned or asked — a degenerate id is a usage mistake, and
  // starting a server to tell the user their shell variable was unset helps nobody.
  const problem = sessionIdProblem(id)
  if (problem) {
    console.error(`fleetview: ${problem}`)
    process.exitCode = 1
    return null
  }
  const r = await ensureServer(loadServer(serverFile) ?? DEFAULT_SERVER)
  if (!r.ok) {
    console.error(r.reason ?? 'opencode server unreachable')
    process.exitCode = 1
    return null
  }
  const client = new OpencodeClient(`http://${r.server.host}:${r.server.port}`)
  const projects = allProjectDirectories(await client.listProjects())
  const parents = sandboxParents(projects as any)
  const matches = await matchSessions(client, projects, id)
  if (matches.length === 0) {
    console.error(`no session matching ${id}`)
    process.exitCode = 1
    return null
  }
  if (matches.length > 1) {
    // Listed, not resolved: the caller is about to attach to, stop, or delete one of these, and
    // guessing which is exactly the failure this replaces.
    console.error(
      [`${id} matches ${matches.length} sessions — use more of the id:`, ...matches.map((m) => `  ${m.session.id}  ${m.worktree}`)].join('\n'),
    )
    process.exitCode = 1
    return null
  }
  const { session, worktree } = matches[0]
  return { client, server: r.server, session, worktree, repo: displayProject(parents, worktree) }
}

// `fleetview --json` / `fleetview ls`: what is running, without opening anything.
async function listSessions({ all, json, cwd }: ParsedArgs, ensureServer: any, serverFile: string) {
  const r = await ensureServer(loadServer(serverFile) ?? DEFAULT_SERVER)
  if (!r.ok) {
    console.error(r.reason ?? 'opencode server unreachable')
    process.exitCode = 1
    return
  }
  const client = new OpencodeClient(`http://${r.server.host}:${r.server.port}`)
  const projects = allProjectDirectories(await client.listProjects())
  const parents = sandboxParents(projects as any)
  const store = createStore()
  // Read once, not once per project: the file is the same on every iteration, so re-reading and
  // re-parsing it per project bought nothing and cost a stat + parse per project.
  const seen = loadSeen(defaultSeenFile())
  // #32: read-only, and once, for the same reason — the roster is what remembers the dispatch
  // prompt behind a session the server never named (a `! cmd` job never takes a model turn, so
  // opencode's rename never fires and the row reads "New session - <timestamp>"). Keyed the same
  // `worktree:id` way the roster store keys members. A corrupt roster is not a reason to fail a
  // listing — `ls` only wants nicer titles out of it.
  let members = new Map<string, any>()
  try {
    members = new Map(loadRoster(defaultRosterFile()).sessions.map((m) => [`${m.worktree}:${m.id}`, m]))
  } catch {}
  // Concurrent, because these are independent HTTP calls against one server and `ls` is something
  // people wait on — serially it took the sum of every project's round trip.
  const lists = await Promise.all(projects.map((p) => client.listSessions(p.worktree).catch(() => null)))
  lists.forEach((sessions, i) => sessions && store.setSessions(projects[i].worktree, sessions, seen))
  // Statuses come from the same endpoint the UI seeds from, so a listing and the roster agree.
  // Still a second round: seedStatuses only has anything to attach to once the sessions are in.
  const statuses = await Promise.all(projects.map((p) => client.sessionStatus(p.worktree).catch(() => null)))
  statuses.forEach((s, i) => s && store.seedStatuses(projects[i].worktree, s))
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
  if (json) return console.log(JSON.stringify(visible, null, 2))
  if (visible.length === 0) return console.log(all ? 'no sessions' : 'nothing running — fleetview ls --all to include finished sessions')
  for (const row of visible) console.log(formatRow(row))
}

export async function main() {
  // Said once, at startup, because a broken native build is an install problem and the raw ESM
  // import stack it used to surface as named nothing the user could act on.
  if (!pty) console.error('node-pty failed to build during install — attach will be degraded. Reinstall with a C++ toolchain present (xcode-select --install on macOS).')
  const args = parseArgs(process.argv.slice(2))
  if ('error' in args) {
    console.error(`${args.error}\n\n${USAGE}`)
    process.exitCode = 1
    return
  }
  const serverFile = defaultServerFile()
  const ensureServerForCommands = makeEnsureServer({ isServerHealthy, isAuthEnforced, probeServer, spawnServer, saveServer, serverFile })

  if (args.command === 'help') return console.log(USAGE)
  if (args.command === 'version') return console.log(VERSION)

  if (args.command === 'bg') return runBg(args, { ensureServer: ensureServerForCommands, serverFile })
  // No ensureServer passed on purpose — `server` is the one command that must never spawn one.
  if (args.command === 'server') return runServer(args, { serverFile })
  if (args.command === 'ls') return listSessions(args, ensureServerForCommands, serverFile)

  if (args.command === 'attach') {
    const found = await withSession(args.id!, ensureServerForCommands, serverFile)
    if (!found) return
    // Straight handover: no roster to suspend, so this is the plain form of what `→` does.
    const [command, ...argv] = createOpencodeBackend({ server: found.server, client: found.client })
      .attach({ id: found.session.id, directory: found.worktree })
    // cwd is the session's worktree: a process-backed resume (`claude --resume <id>`) is cwd-scoped
    // and fails "No conversation found" from fleetview's own directory. Harmless for opencode, which
    // carries the directory in its argv.
    const result = spawnSync(command, argv, { stdio: 'inherit', cwd: found.worktree })
    if (result.error) {
      console.error(`couldn't launch opencode: ${result.error.message}`)
      process.exitCode = 1
    }
    return
  }

  if (args.command === 'logs') {
    const found = await withSession(args.id!, ensureServerForCommands, serverFile)
    if (!found) return
    const messages = await found.client.listMessages(found.session.id, found.worktree).catch(() => [])
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
      if (text.trim()) console.log(`${role === 'user' ? 'you' : 'opencode'}: ${text}`)
      // #24: a failed turn's only content is `info.error` — without this, `logs` on a session that
      // failed every dispatch printed the user's own prompt and nothing else. errorLabel strips it
      // for the same reason the body above is stripped.
      const failure = errorLabel(m?.info?.error)
      if (failure) console.log(`error: ${failure}`)
    }
    return
  }

  if (args.command === 'stop') {
    const found = await withSession(args.id!, ensureServerForCommands, serverFile)
    if (!found) return
    await found.client.abortSession(found.session.id, found.worktree)
    console.log(`stopped ${found.session.id}`)
    return
  }

  if (args.command === 'rm') {
    const found = await withSession(args.id!, ensureServerForCommands, serverFile)
    if (!found) return
    await found.client.deleteSession(found.session.id, found.worktree)
    // "`claude rm <id>` keeps the worktree if it has uncommitted changes" — and fleetview keeps it for
    // commits that exist nowhere else, which is the case that actually loses work. Reported either
    // way, because a worktree left behind is something the user should know about.
    if (found.worktree !== found.repo) {
      const safety = worktreeSafety(found.worktree, found.repo)
      if (safety.removable) {
        await found.client.removeWorktree(found.worktree, found.repo).catch(() => {})
        console.log(`removed ${found.session.id} and its worktree`)
      } else {
        console.log(`removed ${found.session.id} — kept its worktree (${safety.reason}): ${found.worktree}`)
      }
      return
    }
    console.log(`removed ${found.session.id}`)
    return
  }

  // --model / --agent given to the bare command set the defaults every dispatch from this run
  // inherits (agent view seeds them the same way when the view opens). Validate --model here, before
  // taking over the screen, so a typo is a plain stderr line rather than a silent wrong model.
  let launchModel = null
  if (args.model) {
    launchModel = parseModel(args.model)
    if (!launchModel) {
      console.error('fleetview: --model wants <provider>/<model>')
      process.exitCode = 1
      return
    }
  }
  // A `--backend` the user typed this run is rejected loudly, the way `--model` is: they are looking
  // at the terminal, and a silent fallback to opencode would dispatch onto the wrong CLI. The
  // environment default is the opposite case and falls back quietly — see defaultBackendName.
  if (args.backend !== undefined && !isBackendName(args.backend)) {
    console.error(`fleetview: --backend wants one of ${BACKEND_NAMES.join(', ')}`)
    process.exitCode = 1
    return
  }
  return runRoster(args, serverFile, {
    launchModel,
    launchAgent: args.agent ?? null,
    launchBackend: args.backend ?? defaultBackendName(),
  })
}

type Launch = { launchModel?: { providerID: string; id: string } | null; launchAgent?: string | null; launchBackend?: string }

async function runRoster(args: ParsedArgs, serverFile: string, launch: Launch = {}) {
  const rosterFile = defaultRosterFile()
  const ensureServer = makeEnsureServer({ isServerHealthy, isAuthEnforced, probeServer, spawnServer, saveServer, serverFile })

  // The roster owns the whole screen (alternate buffer), like every full-screen TUI: no shell
  // scrollback bleeding above the header, and quitting restores the terminal exactly as it was.
  // Only interactive mode — `fleetview ls` and friends print to the normal buffer. The `exit` handler
  // covers quit, crash, and process.exit alike; SIGTERM/SIGHUP get handlers so `exit` fires for
  // them too (Node kills the process without it otherwise). Skipped when stdout isn't a TTY so
  // piping fleetview's output somewhere doesn't emit escape garbage.
  const tty = process.stdout.isTTY
  // Mouse-off belongs here too: a crash must never leave the user's shell interpreting clicks.
  // `?25h` too: the crash path must never leave the user's shell without a cursor now that the
  // gate hides it while fleetview owns the terminal.
  const restoreScreen = () => process.stdout.write(`${MOUSE_OFF}\x1b[?25h\x1b[?1049l`)
  if (tty) {
    process.stdout.write('\x1b[?1049h')
    process.on('exit', restoreScreen)
    // SIGINT too: an external `kill -INT` (not the in-TUI ctrl+c, which Ink reads as a raw-mode
    // keypress and never as a signal) otherwise takes the default disposition, skipping the `exit`
    // handler and leaving the alt screen up with mouse reporting on and the cursor hidden.
    for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(sig, () => process.exit(1))
  }

  try {
    await rosterLoop(args, { rosterFile, ensureServer, serverFile, launch })
  } finally {
    if (tty) {
      restoreScreen()
      process.removeListener('exit', restoreScreen)
    }
  }
}

async function rosterLoop(
  args: ParsedArgs,
  { rosterFile, ensureServer, serverFile, launch = {} }: { rosterFile: string; ensureServer: any; serverFile: string; launch?: Launch },
) {
  for (;;) {
    const server = loadServer(serverFile) ?? DEFAULT_SERVER // re-read each iteration — a reconnect action means server.json now points at a new port
    const r = await ensureServer(server)
    const client = new OpencodeClient(`http://${r.server.host}:${r.server.port}`)
    // Every adapter, not just the one being dispatched onto: the roster can hold rows from more than
    // one backend at once, so attach and the key handlers have to be able to reach any of them.
    const backends = createBackends({ server: r.server, client })
    const seen = loadSeen(defaultSeenFile()) // re-read each iteration so post-attach re-mounts see fresh state
    const roster = loadRoster(rosterFile) // re-read each iteration so post-attach re-mounts see fresh membership
    // Ink renders into a gate fleetview can close, so an attached session owns the terminal without
    // fleetview having to unmount — which is what keeps every SSE stream alive while you're attached.
    // Mouse mode breaks native terminal text selection (hold Shift to select), so FLEETVIEW_NO_MOUSE=1
    // opts out entirely.
    const out = gatedStdout(process.stdout, {
      mouse: process.stdout.isTTY && (process.env.FLEETVIEW_NO_MOUSE ?? process.env.ROOST_NO_MOUSE) !== '1',
      cursor: process.stdout.isTTY,
    })
    // TODO(types): the resolved action is a dynamic UI event union; loose by design.
    const action = await new Promise<any>((resolve) => {
      let attaching = false
      let inFlight: Promise<any> | null = null
      const instance = render(
        // TODO(types): App is a React component from an untyped module; cast to satisfy createElement.
        React.createElement(App as any, {
          server: r.server,
          client,
          ensureServerImpl: ensureServer,
          serverReady: r.ok,
          serverFailReason: r.reason,
          seen,
          persistSeen: makePersistSeen({ seen, saveSeen, seenFile: defaultSeenFile() }),
          roster,
          // `--cwd` is what makes the dispatch target predictable: App's pickTarget prefers the
          // launch directory, and without this it can only ever be wherever fleetview was started.
          // Resolved, like `bg` does: `--cwd .` (documented as working) reached pickTarget as the
          // literal ".", which matches no project directory, so the dispatch target fell back to
          // whatever the roster happened to list first.
          cwd: args.cwd ? resolve(args.cwd) : process.cwd(),
          // --model / --agent from the launch command: the dispatch model and default subagent every
          // session started this run inherits, until /model or an @agent prefix overrides one.
          initialModel: launch.launchModel ?? null,
          initialAgent: launch.launchAgent ?? null,
          // --backend / FLEETVIEW_BACKEND: which CLI an unprefixed dispatch runs on, and the one
          // non-opencode backend (if any) the roster streams from the moment it opens.
          backends,
          initialBackend: launch.launchBackend ?? DEFAULT_BACKEND,
          // Opt out of per-session worktree isolation (agent view's bgIsolation:"none"). Isolation
          // is the safe default; this is for a single-session flow or a build that needs the checkout.
          isolate: (process.env.FLEETVIEW_NO_ISOLATE ?? process.env.ROOST_NO_ISOLATE) !== '1',
          // Merge-on-write, not a wholesale rewrite: App's snapshot is this iteration's read, and
          // a `fleetview bg` append from another terminal must survive the next pin/collapse/clean.
          persistRoster: makePersistRoster({ roster, file: rosterFile }),
          onAction: (a: any) => {
            // "Ctrl+G opens the dispatch prompt in $VISUAL or $EDITOR." Same terminal handover as
            // attach — close the render gate, let the editor own the tty, reopen and repaint —
            // because an editor drawing over a live Ink frame corrupts both.
            if (a.type === 'edit') return editPrompt(a.text, out, instance)
            if (a.type !== 'enter') {
              resolve(a)
              instance.unmount()
              return
            }
            // Attach in place. fleetview stays mounted the whole time: its streams keep running, and
            // detaching drops straight back to a live roster instead of a fresh boot.
            //
            // The promise MUST be returned: it is how App knows an attach host exists, and it is
            // what it awaits to suspend its input and rendering for the duration. Without it App
            // falls back to unmounting, which is the behaviour this whole phase replaced.
            // Return the in-flight attachment rather than an already-resolved promise: resolving
            // immediately would make App clear `attached` and hand stdin back to Ink while the PTY
            // child is still running, so both would read the same keystrokes.
            if (attaching) return inFlight
            attaching = true
            inFlight = attachLoop(a, out, instance, backends).finally(() => { attaching = false })
            return inFlight
          },
        }),
        // Ctrl+C clears the dispatch input before it quits, so Ink must not intercept it.
        // out is a gated stdout wrapper standing in for a WriteStream; cast for Ink's option type.
        { exitOnCtrlC: false, stdout: out as any },
      )
    })
    ;(out as any).dispose() // drop this gate's stdout listener before the next iteration builds another
    if (action.type === 'quit') break
    if (action.type === 'reconnect') continue // server.json now points at the fallback port; next loop picks it up
  }
}

// Taking the terminal back from a child that owned it — an attached session, or $EDITOR — is three
// steps, and the order matters.
//
// 1. Reopen the gate. That also re-arms mouse reporting and re-hides the cursor the child showed.
// 2. `instance.clear()`. Ink erases the frame it thinks it last wrote and then re-points its
//    skip-the-identical-frame check at that frame (ink 7's clear() calls log.sync() straight after
//    log.clear()). Both halves are pure bookkeeping here: nothing of Ink's survived the child.
// 3. Wipe the screen. This is the part that was missing, and without it the roster comes back
//    wrong even though Ink does repaint. Ink's repaint is written RELATIVE to wherever the cursor
//    happens to be: eraseLines(n) for the n lines it believes it last wrote, then the frame. The
//    child painted the whole screen and left the cursor somewhere arbitrary, so the roster lands
//    in the middle of the session's leftovers and erases only its own height. The fragments sit
//    there until some later frame's erase happens to cover them — which is the reported "press any
//    key and it fixes itself" (#5). Clearing also parks the cursor at home, so Ink's next frame
//    lands at the top of a blank screen, the same place Ink puts one when it clears the terminal
//    itself. It goes through the gate rather than round it, so a clear can never reach a terminal
//    some other child already owns.
//
// The repaint does not need forcing on top of this: App renders null for the whole attachment
// (`if (attached) return null`) and the roster the instant it ends, so the frame after a resume can
// never be byte-identical to the one clear() just re-armed the skip check with, and Ink writes it.
// Ink 7 has a public useApp().suspendTerminal() that does all of the above, but it is callable only
// from inside the tree and it also takes over the stdin handoff that pty-host owns — not a trade
// worth making for a screen clear.
const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H'

// A child killed with child.kill() never gets to put back the input modes it turned on, and every
// one of them keeps sending fleetview bytes it never asked for: focus reporting answers a window
// focus change with ESC[I / ESC[O, bracketed paste wraps pastes in ESC[200~ … ESC[201~, application
// cursor keys re-spell the arrows, and modifyOtherKeys / kitty keyboard re-spell everything else.
// Those sequences arrive fragmented often enough that their printable tails land in the dispatch
// input as phantom characters (#20). Reclaiming the terminal means reclaiming its modes, so reset
// the ones an attached TUI plausibly set — a terminal ignores a reset for a mode it never had on.
const RESET_INPUT_MODES = '\x1b[?2004l\x1b[?1004l\x1b[?1l\x1b[>4;0m\x1b[<u'

// TODO(types): `out` (gated stdout) and `instance` (Ink render handle) come from untyped modules.
export function reclaimTerminal(out: any, instance: any) {
  out.open()
  instance?.clear()
  out.write(RESET_INPUT_MODES)
  out.write(CLEAR_SCREEN)
}

// Hands the prompt to $VISUAL/$EDITOR through a temp file and returns whatever comes back. Resolves
// to undefined when there is no editor configured or it failed, which App reads as "leave the
// prompt alone" — losing a half-written prompt to a missing $EDITOR would be a poor trade.
// TODO(types): `out` (gated stdout) and `instance` (Ink render handle) come from untyped modules.
export async function editPrompt(text: string, out: any, instance: any) {
  const editor = process.env.VISUAL || process.env.EDITOR
  if (!editor) return undefined
  // A private 0o700 dir, not a predictable /tmp/fleetview-prompt-<pid>.txt. writeFileSync's mode only
  // applies on creation and follows symlinks, so a guessable path in a world-writable /tmp let an
  // attacker pre-create a symlink and turn this into a write-through / read-back of an arbitrary file.
  // mkdtempSync makes a fresh unguessable dir owned by this user; the file inside can't be pre-staged.
  const dir = mkdtempSync(join(tmpdir(), 'fleetview-'))
  const file = join(dir, 'prompt.txt')
  try {
    writeFileSync(file, text ?? '', { mode: 0o600 })
    out.close()
    // `sh -c` so EDITOR can carry flags, which is normal ("code -w", "emacsclient -nw").
    const result = spawnSync('sh', ['-c', `${editor} "$1"`, 'sh', file], { stdio: 'inherit' })
    reclaimTerminal(out, instance)
    if (result.error || result.status !== 0) return undefined
    // Editors add a trailing newline; a prompt should not end in one.
    return readFileSync(file, 'utf8').replace(/\n+$/, '')
  } catch {
    reclaimTerminal(out, instance)
    return undefined
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // never written, or already gone
    }
  }
}

// An attach that dies instantly without drawing anything leaves the user staring at the roster
// wondering whether the keypress registered. The usual cause is a session whose directory is gone —
// a removed git worktree — which makes `opencode attach --dir` exit 1 silently.
// TODO(types): `reason` is a PTY-host exit descriptor (dynamic shape); loose by design.
function describeExit(reason: any, target: { worktree: string }) {
  if (reason.message) return { message: reason.message }
  // `ms` matters: a session attached for ten minutes that then exits non-zero is opencode's
  // business, not a failure to attach. Only an instant, silent death is worth reporting.
  if (reason.type === 'exit' && reason.drewNothing && reason.exitCode !== 0 && reason.ms < 2000) {
    return existsSync(target.worktree)
      ? { message: `couldn't attach (opencode exited ${reason.exitCode})` }
      : { message: `couldn't attach: ${target.worktree} no longer exists` }
  }
  return undefined
}

// Attaches, and keeps attaching while the user quick-switches with Alt+1..9. `switch` carries the
// index of the session to move to, resolved against whatever fleetview last published.
// The argv comes from the backend rather than being spelled out here: it is the one piece of the
// attach path that is specific to what's on the other end (`opencode attach` vs `<tool> --resume`).
// TODO(types): `action` is a dynamic attach/switch event; `out`/`instance` from untyped modules.
export async function attachLoop(action: any, out: any, instance: any, backends: Record<string, Backend>) {
  // Which adapter spells the argv. The row says which backend it belongs to; an older action (or an
  // opencode row, which carries nothing) falls back to opencode, so this can only ever add cases.
  // The cwd the pty host uses is the session's directory either way, which is what `claude --resume`
  // needs to find the session at all — copilot names it a second time with its own `-C`.
  const backendFor = (target: any): Backend => backends[target?.backend ?? DEFAULT_BACKEND] ?? backends[DEFAULT_BACKEND]
  // Without a working PTY there is no way to sit between the terminal and opencode, so fleetview hands
  // the terminal over wholesale and waits. Streams stop for the duration, exactly as they did
  // before the resident host existed; detaching means exiting opencode.
  if (!pty) {
    out.close()
    const [command, ...argv] = backendFor(action).attach({ id: action.sessionId, directory: action.worktree })
    // cwd matches the pty path below: a process-backed resume is cwd-scoped, so without it
    // `claude --resume` fails "No conversation found" from fleetview's directory.
    const result = spawnSync(command, argv, { stdio: 'inherit', cwd: action.worktree })
    reclaimTerminal(out, instance)
    return result.error ? { message: `couldn't launch opencode: ${result.error.message}` } : undefined
  }
  let target = action
  for (;;) {
    const [command, ...argv] = backendFor(target).attach({ id: target.sessionId, directory: target.worktree })
    const reason: any = await attachPty({
      command,
      args: argv,
      cwd: target.worktree,
      spawn: pty.spawn,
      // Detaching mid-turn kills a process-backed child's in-flight work, so claude/copilot get the
      // double-press guard. opencode sessions live on the server — detach loses nothing there.
      busyDetachGuard: (target.backend ?? DEFAULT_BACKEND) !== DEFAULT_BACKEND,
      onSuspend: () => out.close(),
      // Every end of an attachment lands here, including an Alt+1..9 switch on its way to the next
      // child: reclaiming and re-clearing between two children costs one wipe the next child paints
      // straight over.
      onResume: () => reclaimTerminal(out, instance),
    }).catch((error) => {
      reclaimTerminal(out, instance)
      return { type: 'exit', exitCode: 1, drewNothing: true, ms: 0, message: `couldn't launch opencode: ${error.message}` }
    })
    // A detach is reported back to App with which session was left behind: the roster shows the
    // "moved to the background" notice on that row, and Esc can re-open it later. A CLEAN exit of
    // an opencode attach counts too: the recommended `app_exit: left` keybind ends the attach
    // client (fleetview sees 'exit', not a chord), yet the session keeps running on the server —
    // exactly "moved to the background". A dirty or instant exit stays an exit, so real attach
    // failures still surface through describeExit.
    const backgroundedCleanly =
      reason.type === 'detach' ||
      (reason.type === 'exit' && (target.backend ?? DEFAULT_BACKEND) === DEFAULT_BACKEND && reason.exitCode === 0 && !reason.drewNothing)
    if (backgroundedCleanly)
      return { detached: true, sessionId: target.sessionId, worktree: target.worktree, ...(target.backend ? { backend: target.backend } : {}) }
    if (reason.type !== 'switch') return describeExit(reason, target)
    // Alt+N for a row that isn't there must not end the attachment: the chord already killed the
    // viewer, so returning here would dump the user back to the roster with no explanation.
    // Re-attach the same session instead.
    const next = action.siblings?.[reason.index]
    // The sibling's own backend, not the one currently attached: Alt+N can cross from an opencode row
    // to a claude one, and re-using this loop's argv there would resume nothing.
    if (next) target = { ...target, sessionId: next.id, worktree: next.projectKey, backend: next.backend ?? DEFAULT_BACKEND }
  }
}

// only run main when executed as a binary, not when imported by tests.
// realpath argv[1] before comparing: node resolves the ESM main module's
// symlinks for import.meta.url, but argv[1] stays the symlink (e.g. npm link).
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
