import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ServerRef } from '../../types.ts'
import { loadServer, openPrivateAppend, saveServer, withServerLock } from '../../registry.ts'
import { stripControl } from '../../text-utils.ts'
import { authHeader, isV2Info, isV2Unauthorized, noteOpencodeApi } from './client.ts'
import { serverHome } from './client-v2.ts'
import { ownershipVerified } from './request.ts'

// ensureServer's failure reason when `opencode` is not on PATH. Exported so the roster can tell this
// case (install something, then run again) from a server that merely failed to come up.
export const OPENCODE_MISSING = 'fleetview needs the opencode CLI. Install it from https://opencode.ai and run fleetview again.'

const logDir = () => (process.env.FLEETVIEW_LOG_DIR ?? process.env.ROOST_LOG_DIR) ?? join(homedir(), '.local', 'state', 'fleetview', 'logs')

export function spawnServer(
  server: ServerRef,
  { spawnImpl = spawn, logFd, closeSyncImpl = closeSync }: { spawnImpl?: typeof spawn; logFd?: number; closeSyncImpl?: typeof closeSync } = {},
) {
  // Only close what we opened: a caller-supplied fd stays the caller's to manage.
  let ownFd = false
  if (logFd === undefined) {
    // 0o700/0o600 like the other state files: the log holds server output (prompts, paths, and any
    // token the server prints), so it must not be world-readable. openPrivateAppend re-tightens a
    // pre-existing dir and log on every open, and refuses a symlinked server.log.
    logFd = openPrivateAppend(logDir(), join(logDir(), 'server.log'))
    ownFd = true
  }
  const child = spawnImpl('opencode', ['serve', '--port', String(server.port), '--hostname', server.host], {
    // Not ~: 2.x makes its cwd a project, and ~ as a project floods the roster (#172).
    cwd: serverHome(),
    detached: true,
    stdio: ['ignore', logFd, logFd],
  })
  child.on('error', () => {}) // async spawn failure (e.g. ENOENT) would otherwise crash out-of-band; health poll reports it instead
  child.unref()
  // The child holds its own duplicated descriptor, so the parent's copy is dead weight. Without
  // this, a server that never comes healthy leaks one fd per spawn attempt — up to 11 per
  // ensureServer run, and ensureServer re-runs on every failed poll.
  if (ownFd) {
    try {
      closeSyncImpl(logFd)
    } catch {
      // already closed, or never valid; nothing useful to do
    }
  }
  return child.pid
}

// The health check is a request like any other, so it needs the same credential. Without it,
// setting OPENCODE_SERVER_PASSWORD made every probe come back 401 — which reads as "dead server",
// so ensureServer spawned a replacement on the occupied port, then walked ten fallback ports
// spawning and polling each, and finally gave up with "server did not become healthy". Every
// server it spawned inherited the password and 401'd the same unauthenticated probe, so the
// failure was total and permanent: turning on the documented mitigation stopped fleetview booting.
export async function isServerHealthy(server: ServerRef, fetchImpl = globalThis.fetch) {
  return (await probeServer(server, fetchImpl)) === 'healthy'
}

// The same probe, without collapsing its outcomes to a boolean. A 401 is an answer: something is
// listening on that port and enforcing a password fleetview doesn't hold, which is the opposite of
// "nothing there" even though both read as unhealthy — spawning onto it can never bind, and the
// occupant may be fleetview's own server under a password only server.json remembers.
//
// `unconfirmed` (#202): the listener asked for the credential, was shown it, and then failed to answer
// properly (a non-2xx other than 401, or no answer at all). That is fleetview's own server booting or
// overloaded, or a stranger that now holds the password; only the caller knows which pid it spawned,
// so the caller decides, and anything it cannot prove is its own is treated as having seen it.
//
// `stranger` (#216): the listener is not the server on record, and was never shown the credential.
export type ProbeState = 'healthy' | 'unauthorized' | 'unreachable' | 'unconfirmed' | 'stranger'

// #213: `server.pid`, when set, is the process the caller expects on that port (the child it just
// spawned, or server.json's record). 2.x's /api/info body carries the answering server's pid on
// 200, 503 (booting) and 500 alike, and opencode's own client matches it against the pid it
// recorded; so does this. An answer from any other pid has seen the password: `unauthorized`.
// ponytail: the pid is self-reported, so a squatter that reads `ps` can copy it; asking the OS who
// holds the port (lsof/ss) is the upgrade if that matters. 1.x reports no server pid on any route
// (checked against 1.18.5's /doc), so a 1.x answer is not pid-checked; that is why a server known to
// be 2.x (`api: 2`) is not offered the credential on 1.x's route at all; a listener could otherwise
// pass as 1.x to dodge the check.
export async function probeServer(server: ServerRef, fetchImpl = globalThis.fetch, parentOf = parentPid): Promise<ProbeState> {
  // opencode 1.x answers GET /project with its project list. 2.x serves its web app there (200
  // text/html, no auth) and keeps the JSON API under /api, so a 1.x miss is asked again as 2.x.
  const base = `http://${server.host}:${server.port}`
  const v1 = await askServer(server, '/project', isProjectList, fetchImpl, async () => server.api !== 2)
  // A server recorded as 2.x that answers as 1.x is not that server: 1.x reports no pid, so taking
  // the answer would skip the pid check and hand the stranger the password. Treated as one that
  // rejected it, so the password is burned and rotated all the same (adoptServerCredential, below).
  if (v1 === 'healthy' && server.api === 2) return 'stranger'
  if (v1 === 'healthy') noteOpencodeApi(base, 1)
  if (v1 !== 'unreachable') return v1
  // Credential only to a 401 that is 2.x's own: a 1.x without its embedded UI proxies unknown paths,
  // authorization header included, to app.opencode.ai, and whatever 401 that answers must not earn
  // the password (the reason opencodeApi in client.ts asks this route credential-free).
  const owner = server.pid ? (pid: number) => descendsFrom(pid, server.pid!, parentOf) : undefined
  // #216: a 2.x record whose own password is the one about to be presented, but which has no pid (a
  // crash between trySpawn's two saves), has nothing to match the answer against, so that password
  // is not offered at all. Keyed on what would be presented, not on the record: a user-set password
  // in env is #213's deliberately unmatched case even when the record still holds an old one.
  if (server.api === 2 && !owner && server.password && server.password === process.env.OPENCODE_SERVER_PASSWORD) {
    const bare = await askServer(server, '/api/info', isV2Info, fetchImpl, async () => false)
    if (bare === 'healthy') noteOpencodeApi(base, 2)
    return bare === 'unauthorized' ? 'stranger' : bare
  }
  const v2 = await askServer(server, '/api/info', isV2Info, fetchImpl, isV2UnauthorizedResponse, owner)
  // What the probe found is the server's API for everything after it (client.ts opencodeApi).
  if (v2 === 'healthy') noteOpencodeApi(base, 2)
  return v2
}

// A launcher (npm's, or a version-manager shim in front of it) may be the process fleetview spawned,
// with the server a child or grandchild of it.
function descendsFrom(pid: number, ancestor: number, parentOf: (pid: number) => number | null) {
  for (let p: number | null = pid, i = 0; p && p > 1 && i < 4; p = parentOf(p), i++) if (p === ancestor) return true
  return false
}

function parentPid(pid: number): number | null {
  const ps = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' })
  return ps.status === 0 ? Number(String(ps.stdout).trim()) || null : null
}

async function askServer(
  server: ServerRef,
  path: string,
  looksRight: (body: unknown) => boolean,
  fetchImpl: typeof fetch,
  wantsCredential: (res: Response) => Promise<boolean> = async () => true,
  isOwner?: (pid: number) => boolean,
): Promise<ProbeState> {
  const url = `http://${server.host}:${server.port}${path}`
  let presented = false
  // #216: the only answer that ends a lost connection's doubt (request.ts): one that asked for the
  // credential and then proved itself with it. A healthy answer that never asked proves nothing.
  const verified = (): ProbeState => {
    ownershipVerified(url)
    return 'healthy'
  }
  try {
    // The first request carries NO credential, on purpose. fleetview adopts the password from
    // server.json before it has any evidence about who holds the port, so an authenticated first
    // probe hands that credential to whatever is listening — including a process that is not
    // fleetview's server and not opencode at all. Only a 401 is evidence the listener wants a
    // credential, and only then is one presented, on a single retry. Costs one extra round trip on
    // the password path; changes no adoption semantics.
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(2000) })
    if (res.status !== 401) return (await answered(res, looksRight)) ? 'healthy' : 'unreachable'
    const auth = authHeader()
    if (!auth || !(await wantsCredential(res))) return 'unauthorized'
    presented = true
    const authed = await fetchImpl(url, { headers: { authorization: auth }, signal: AbortSignal.timeout(2000) })
    // #202: the credential has now been shown. A 401 or a 2xx that isn't opencode is a rejection;
    // any other non-2xx is `unconfirmed` (see ProbeState), never plain `unreachable`, since any
    // listener can answer 503 with a copied boot body to keep the password from being burned.
    if (authed.status === 401) return 'unauthorized'
    if (isOwner) {
      // #213: whatever the status, a body that doesn't name the expected server is not it.
      let body: unknown
      try {
        body = await authed.json()
      } catch {}
      const pid = (body as { pid?: unknown } | undefined)?.pid
      if (typeof pid !== 'number' || !isOwner(pid)) return 'unauthorized'
      return authed.ok ? (looksRight(body) ? verified() : 'unauthorized') : 'unconfirmed'
    }
    if (authed.ok) return (await bodyLooksRight(authed, looksRight)) ? verified() : 'unauthorized'
    return 'unconfirmed'
  } catch {
    // Same rule for a listener that took the credential and then hung or reset. #213: when the caller
    // expects a pid, nothing that never named it keeps the password (fleetview's own booting 2.x
    // answers 503 with its pid, so only a hang or reset of its own costs a rotation).
    return presented ? (isOwner ? 'unauthorized' : 'unconfirmed') : 'unreachable'
  }
}

// 2.x answers 503 while it boots; like any other non-2xx, that is "not yet", and the poll asks again.
async function answered(res: Response, looksRight: (body: unknown) => boolean) {
  return res.ok && bodyLooksRight(res, looksRight)
}

async function bodyLooksRight(res: Response, looksRight: (body: unknown) => boolean) {
  try {
    return looksRight(await res.json())
  } catch {
    return false
  }
}

// 2.x's own 401 on /api/info (isV2Unauthorized on its body). The probe's credential retry and
// isAuthEnforced both count only this 401, never one a proxied 1.x path answers.
async function isV2UnauthorizedResponse(res: Response): Promise<boolean> {
  try {
    return isV2Unauthorized(await res.json())
  } catch {
    return false
  }
}

// "Is this opencode" used to be "did it answer with a JSON array", which `[]` from any listener
// satisfies — and fleetview then feeds the adopted server prompts, `!` shell commands, and takes
// back from it the directory arguments it hands to git and spawnSync. Requiring the shape
// `types.ts` declares for a Project turns "answer []" into "reimplement enough of opencode's API".
// It does not stop a listener that mimics the shape; it raises the bar.
//
// The list must be non-empty: a real `opencode serve` always reports at least its own global
// project (verified against opencode 1.18.5 with a fresh, empty config dir — GET /project returned
// [{"id":"global","worktree":"/","time":{...},"sandboxes":[]}]), so requiring one well-formed entry
// costs nothing on the real thing while rejecting a bare `[]`.
function isProjectList(body: unknown): boolean {
  if (!Array.isArray(body) || body.length === 0) return false
  return body.every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false
    const project = entry as Record<string, unknown>
    return typeof project.id === 'string' && project.id !== '' && typeof project.worktree === 'string' && project.worktree !== ''
  })
}

// Whether a set password is actually enforced by the server on `server`. True when no password is
// set (nothing to enforce) or when an unauthenticated request is rejected. False means a password is
// set but the server answers anyway — the case where a passwordless opencode is already running on
// the port and fleetview adopts it rather than replacing it, so OPENCODE_SERVER_PASSWORD (which only
// applies to a server fleetview spawns) is silently off and the shell route stays open.
//
// "True" here means "nothing is being ignored", not "this server is protected": with no password
// set there is nothing to enforce, and that no-password case is exactly where adopting a foreign
// listener is most likely and least visible. Saying so is the adoption notice's job in
// makeEnsureServer, which reports the no-password case rather than leaving this `true` silent.
//
// null: the check itself failed, so there is no evidence either way. #202: that used to read as true,
// and a listener that answered the probe and then hung this one request kept receiving the password.
export async function isAuthEnforced(server: ServerRef, fetchImpl = globalThis.fetch): Promise<boolean | null> {
  if (!authHeader()) return true
  try {
    // Either API refusing counts. 2.x serves /project (its web app) to anyone and enforces on /api,
    // so asking /project alone would call every 2.x server unprotected.
    // On /api/info only 2.x's own 401 body counts: a 1.x without its embedded UI proxies that path to
    // app.opencode.ai, whose 401 would otherwise hide an unprotected 1.x (same test as probeServer).
    const base = `http://${server.host}:${server.port}`
    if ((await fetchImpl(`${base}/project`, { signal: AbortSignal.timeout(2000) })).status === 401) return true
    const info = await fetchImpl(`${base}/api/info`, { signal: AbortSignal.timeout(2000) })
    return info.status === 401 && (await isV2UnauthorizedResponse(info))
  } catch {
    return null
  }
}

// The server lifecycle every entry point shares (#187: moved here from cli.ts unchanged): the
// saved-credential adoption, ensureServer's probe/spawn/fallback walk, and the pid identity check.

// What makeEnsureServer returns and every command takes: resolve a server, or say why not.
export type EnsureServer = (server: ServerRef) => Promise<{ ok: boolean; server: ServerRef; reason?: string }>
type SpawnServer = typeof spawnServer

// A saved password that whatever holds the port has just rejected has also been SEEN by that
// listener (probeServer presents it on the 401 retry), so it is burned: dropped from the env, where
// nothing in this process may present it again, and from server.json, where the next run would
// otherwise adopt it and show it to the same squatter. Shared by ensureServer and `server
// status`/`stop` — the two entry points that adopt the saved credential before probing a port they
// have no other evidence about.
// Both names: opencode 2.x (the server fleetview spawns, and `opencode attach`) reads
// OPENCODE_PASSWORD before OPENCODE_SERVER_PASSWORD, and cli.ts main() only copies the former into the
// latter. Dropping one would leave the other arming the next child with the password just dropped.
function dropPassword(env: NodeJS.ProcessEnv) {
  delete env.OPENCODE_SERVER_PASSWORD
  delete env.OPENCODE_PASSWORD
}

function burnSavedPassword(
  server: ServerRef,
  {
    serverFile,
    saveServerImpl = saveServer,
    env = process.env,
  }: { serverFile: string; saveServerImpl?: typeof saveServer; env?: NodeJS.ProcessEnv },
) {
  dropPassword(env)
  const { password, ...bare } = server
  saveServerImpl(serverFile, bare)
}

// #180: the credential half of every entry point that probes a server it has no other evidence
// about (ensureServer, `server status`/`stop`), in one place so the two cannot drift again. Rules:
// - A saved password is adopted into env before the probe (M11/H1). probeServer presents it only to
//   a listener that answered 401, so adopting is not the same as showing it to the port.
// - M4: a user-set password over a server fleetview spawned with a generated one. On a 401 under
//   the user's, the saved one is tried once; if that answers, it is used (`saved-over-user`).
// - A listener that still rejects has SEEN whatever env held (and the saved one, if retried). That
//   password is never presented again or used to arm a server fleetview spawns: dropped from env,
//   and a saved one is burned from server.json too.
// - A healthy listener that does not enforce auth is not fleetview's server either. Every client
//   request and event stream would send it Basic auth, so the password is dropped the same way
//   before anything does (`unenforced`). #202: when that check itself fails there is no evidence
//   either way, so the password leaves env for this pass but stays in server.json (`unknown`): it
//   was never shown, and the next pass adopts it and asks again.
export async function adoptServerCredential(
  saved: ServerRef,
  {
    probe,
    isAuthEnforced = async () => true,
    isOwnServer = () => false,
    serverFile,
    saveServerImpl = saveServer,
    env = process.env,
  }: {
    probe: (server: ServerRef) => Promise<ProbeState>
    isAuthEnforced?: (server: ServerRef) => Promise<boolean | null>
    isOwnServer?: (server: ServerRef) => boolean
    serverFile: string
    saveServerImpl?: typeof saveServer
    env?: NodeJS.ProcessEnv
  },
): Promise<{ state: 'healthy' | 'unauthorized' | 'unreachable'; server: ServerRef; credential: 'kept' | 'saved-over-user' | 'rejected' | 'stranger' | 'unenforced' | 'unknown' }> {
  const adoptedSaved = Boolean(saved.password) && !env.OPENCODE_SERVER_PASSWORD
  if (adoptedSaved) env.OPENCODE_SERVER_PASSWORD = saved.password
  const forget = () => {
    if (!saved.password) {
      dropPassword(env)
      return saved
    }
    burnSavedPassword(saved, { serverFile, saveServerImpl, env })
    const { password, ...bare } = saved
    return bare
  }
  // `unconfirmed` (the credential was shown, no proper answer) is fleetview's own server only when
  // server.json's pid is still a live `opencode serve`; then it is just not answering yet. Anything
  // else has seen the password and counts as a rejection.
  // #213: the record's pid vouches only for the server minted with the record's password, so it is
  // matched only while that password is the one being presented. A user-set password may belong to a
  // server the user started there since.
  // #216: `stranger` is refused like a rejection (burned all the same), but reported as one that
  // never saw the password unless some other answer here may have.
  let shown = false
  let stranger = false
  const ask = async (): Promise<'healthy' | 'unauthorized' | 'unreachable'> => {
    const asked = await probe(saved.password && env.OPENCODE_SERVER_PASSWORD === saved.password ? saved : { ...saved, pid: null })
    stranger = asked === 'stranger'
    if (asked === 'stranger') return 'unauthorized'
    if (asked === 'unauthorized' || asked === 'unconfirmed') shown = true
    return asked !== 'unconfirmed' ? asked : isOwnServer(saved) ? 'unreachable' : 'unauthorized'
  }
  let state = await ask()
  // Not after a stranger: the saved password's server is not there either, so offering it gains nothing.
  if (state === 'unauthorized' && !stranger && saved.password && env.OPENCODE_SERVER_PASSWORD && env.OPENCODE_SERVER_PASSWORD !== saved.password) {
    env.OPENCODE_SERVER_PASSWORD = saved.password
    delete env.OPENCODE_PASSWORD // the user's, under its 2.x name; it would shadow the saved one for attach
    state = await ask()
    if (state === 'healthy') return { state, server: saved, credential: 'saved-over-user' }
    // Anything short of healthy is not the server the saved password was made for. A listener that
    // 401s and then fails the authenticated retry some other way (a 500, a wrong body) reads as
    // `unreachable`, yet it has seen both passwords, so neither survives.
    return { state, server: forget(), credential: shown ? 'rejected' : 'stranger' }
  }
  if (!env.OPENCODE_SERVER_PASSWORD) return { state, server: saved, credential: 'kept' }
  if (state === 'unauthorized') return { state, server: forget(), credential: shown ? 'rejected' : 'stranger' }
  const enforced = state === 'healthy' ? await isAuthEnforced(saved) : true
  if (enforced === false) return { state, server: forget(), credential: 'unenforced' }
  if (enforced === null) {
    dropPassword(env)
    return { state, server: saved, credential: 'unknown' }
  }
  return { state, server: saved, credential: 'kept' }
}

export function makeEnsureServer({
  isServerHealthy,
  isAuthEnforced = async () => true,
  // Tri-state form of the same probe (the module-level probeServer). Defaulted off isServerHealthy so
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
  loadServerImpl = loadServer,
  env = process.env,
}: {
  isServerHealthy: (server: ServerRef) => Promise<boolean>
  isAuthEnforced?: (server: ServerRef) => Promise<boolean | null>
  probeServer?: (server: ServerRef) => Promise<ProbeState>
  spawnServer: SpawnServer
  saveServer: (file: string, server: ServerRef) => unknown
  serverFile: string
  pollMs?: number
  processKill?: typeof process.kill
  spawnSyncImpl?: typeof spawnSync
  warn?: typeof console.warn
  notice?: typeof console.error
  identifyServer?: (pid: number) => { ok: boolean; reason?: string; command?: string }
  loadServerImpl?: (file: string) => ServerRef | null
  env?: NodeJS.ProcessEnv
}) {
  // opencode cold boot (plugins) can exceed 5s; observed live on 1.18.4
  // #202: `seen` — a poll got `unauthorized`, so whatever holds that port was shown the password and
  // rejected it. That is final for the candidate: a listener that later answers healthy has still
  // seen the password, so it is never trusted with it.
  // `unconfirmed` is tolerated only while the child fleetview just spawned is still alive (it may be
  // booting), and a window that ends without healthy after one still counts as seen: whatever answered
  // may not have been that child.
  const pollUntilHealthy = async (candidate: ServerRef, pid: ServerRef['pid']) => {
    let presented = false
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, pollMs))
      // #213: with the pid, an answer from anything but this child is `unauthorized`.
      const state = await probeServer({ ...candidate, pid })
      if (state === 'healthy') return { healthy: true, seen: false }
      if (state === 'unauthorized') return { healthy: false, seen: true }
      if (state === 'stranger') return { healthy: false, seen: false } // not this child, and never shown it
      if (state === 'unconfirmed') {
        if (!isOwnServer({ ...candidate, pid })) return { healthy: false, seen: true }
        presented = true
      }
    }
    return { healthy: false, seen: presented }
  }
  const isOwnServer = (s: ServerRef) => Boolean(s.pid) && identifyServer(s.pid!).ok
  // a candidate whose poll window expired is a leaked child (spawned, never healthy) — kill it
  // before moving on, or every failed candidate/restart accumulates a zombie opencode process.
  const reap = (pid: number | null | undefined) => {
    if (pid) try { processKill(pid, 'SIGTERM') } catch {}
  }
  // One spawn attempt on one port, from persisting the record to knowing the password took.
  // The record is written BEFORE the spawn as well as after: a crash in between used to leave a
  // detached server armed with a password that existed only in a dead process's env — unreachable
  // and unstoppable by the next run. Written again with the pid once there is one.
  const trySpawn = async (candidate: ServerRef): Promise<{ server?: ServerRef; seen?: boolean }> => {
    saveServer(serverFile, { ...candidate, pid: null })
    const pid = spawnServer(candidate, {})
    saveServer(serverFile, { ...candidate, pid })
    const polled = await pollUntilHealthy(candidate, pid)
    if (!polled.healthy) {
      reap(pid)
      return { seen: polled.seen }
    }
    // M2: a healthy probe is not evidence the password is enforced — a foreign passwordless opencode
    // that got the port first answers our authenticated probe 200 all the same (it ignores auth it
    // doesn't require). Persisting a password for such a server would make the next run trust a
    // credential protecting nothing, so the record is saved without it.
    const enforced = await isAuthEnforced(candidate)
    if (enforced) return { server: { ...candidate, pid } }
    if (enforced === null) {
      // No evidence either way: stop presenting it this pass and ask again on the next.
      withhold()
      return { server: { ...candidate, pid } }
    }
    warn(
      `fleetview: the opencode server now on ${candidate.host}:${candidate.port} does not require OPENCODE_SERVER_PASSWORD — its arbitrary-shell route is reachable without one. Stop it to have fleetview spawn a password-protected server.`,
    )
    // Not enforced, so not ours: nothing in this process may send that listener the password.
    dropPassword(env)
    const { password, ...bare } = candidate
    saveServer(serverFile, { ...bare, pid })
    return { server: { ...bare, pid } }
  }
  // ensureServer runs again on every roster-loop iteration, so the adoption notice below is once per
  // process: the fact is worth stating, restating it every few seconds is not.
  let adoptionNoticed = false
  // `warned`: the unenforced-password warning has already said this server is unprotected.
  const noticeIfForeign = (server: ServerRef, warned = false) => {
    if (adoptionNoticed) return
    // Fleetview's own server is the one whose pid server.json recorded and which is still a live
    // `opencode serve`. Anything else on that port is a server fleetview is adopting: usually the
    // user's own, occasionally not the one they think.
    if (server.pid && identifyServer(server.pid).ok) return
    adoptionNoticed = true
    const unprotected = env.OPENCODE_SERVER_PASSWORD || warned
      ? ''
      : ' No OPENCODE_SERVER_PASSWORD is set, so its shell route is reachable by anything on loopback.'
    notice(`fleetview: using the opencode server already running on ${server.host}:${server.port} — fleetview did not start it.${unprotected}`)
  }
  // A password withheld for one pass because the enforcement check failed (`unknown`). It was never
  // shown, but a user-set one lives nowhere else (server.json keeps only generated ones), so it is
  // held here and put back before the next pass's probe, which asks the question again.
  let withheld: string | undefined
  const withhold = () => {
    withheld = env.OPENCODE_SERVER_PASSWORD
    dropPassword(env)
  }
  const ensure = async (saved: ServerRef, locked: boolean): ReturnType<EnsureServer> => {
    if (withheld && !env.OPENCODE_SERVER_PASSWORD) env.OPENCODE_SERVER_PASSWORD = withheld
    withheld = undefined
    const held = env.OPENCODE_SERVER_PASSWORD
    const adopted = await adoptServerCredential(saved, { probe: probeServer, isAuthEnforced, isOwnServer, serverFile, saveServerImpl: saveServer, env })
    if (adopted.credential === 'unknown') withheld = held ?? saved.password
    const { state, server } = adopted
    if (state === 'healthy') {
      if (adopted.credential === 'saved-over-user') {
        warn(
          `fleetview: the opencode server on ${server.host}:${server.port} was started by fleetview with a different password, so OPENCODE_SERVER_PASSWORD as set has no effect on it — using the saved one. Run \`fleetview server stop\` first if you want yours to take.`,
        )
        return { ok: true, server }
      }
      // Adopting a server fleetview didn't spawn (v2 reuses any healthy opencode). If a password is
      // set but this already-running server doesn't enforce it, the documented mitigation is off —
      // warn rather than fail, since the user may knowingly be pointing at a trusted server.
      if (adopted.credential === 'unenforced') {
        warn(
          `fleetview: OPENCODE_SERVER_PASSWORD is set, but the opencode server already running on ${server.host}:${server.port} does not require it — its arbitrary-shell route is reachable without a password, and fleetview will not send the password to it${saved.password ? ` (the saved one is removed from ${serverFile})` : ''}. Stop that server to have fleetview spawn a password-protected one.`,
        )
      }
      noticeIfForeign(server, adopted.credential === 'unenforced' || adopted.credential === 'unknown')
      return { ok: true, server }
    }
    // #213 F4: two fleetview processes that both found no server would each spawn one on the same
    // port and each write server.json, so the record of one (and the password to it) was lost. Only
    // the lock holder spawns. One that had to wait re-reads server.json and starts over from what
    // the holder recorded, which is usually a healthy server to adopt.
    if (!locked) {
      return withServerLock(
        serverFile,
        (waited) => {
          if (!waited) return replace(server, state, adopted.credential)
          // A password this pass adopted from the old record is not the user's: left in env, the
          // reload would read it as a user-set one and present it before the holder's.
          if (saved.password && env.OPENCODE_SERVER_PASSWORD === saved.password) dropPassword(env)
          return ensure(loadServerImpl(serverFile) ?? server, true)
        },
        () => notice(`fleetview: waiting for another fleetview that is starting the opencode server (${serverFile}.lock)`),
      )
    }
    return replace(server, state, adopted.credential)
  }
  // ensureServer's spawn half: the port's occupant is not a server fleetview can use.
  const replace = async (server: ServerRef, state: 'unauthorized' | 'unreachable', credential: string): ReturnType<EnsureServer> => {
    // M6: everything below spawns `opencode serve`. Without opencode on PATH that spawn fails
    // asynchronously (server-manager swallows the ENOENT), so asking first saves a full poll window
    // of blank waiting and lets the roster lead with the actual problem.
    const probe = spawnSyncImpl('opencode', ['--version'])
    if ((probe.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return { ok: false, server, reason: OPENCODE_MISSING }
    }
    // #213: "opencode v2.3.2" / "1.18.5". Recorded so every probe of this server, now and in later
    // runs, offers the credential only where it can check the answering pid.
    const major = Number(/(\d+)\./.exec(String(probe.stdout ?? ''))?.[1])
    // We're spawning the server ourselves, so we own its environment: an unauthenticated opencode
    // serve exposes POST /session/:id/shell (arbitrary shell) to anything on loopback, and it stays
    // up after fleetview exits. Mint a password when the user hasn't set one — the child inherits it
    // through process.env, as do our own requests and `opencode attach` (authHeader in client.ts) —
    // and persist only a generated one (server.json is 0600); a user-set password stays where they
    // put it. A password the port's occupant rejected is already gone from env
    // (adoptServerCredential), so it is never the one the replacement is armed with.
    const generated = env.OPENCODE_SERVER_PASSWORD ? null : (env.OPENCODE_SERVER_PASSWORD = randomUUID())
    // The replacement enforces whatever is in env now, so a saved password that differs from it
    // belongs to a server that is gone and is dropped rather than persisted alongside a child that
    // has never heard of it.
    const target = { ...(generated ? { ...server, password: generated } : env.OPENCODE_SERVER_PASSWORD === server.password ? server : { ...server, password: undefined }), api: major >= 2 ? (2 as const) : undefined }
    // `unauthorized` means the port is held by a server enforcing a password we don't have, so our
    // own spawn there could never bind — skip straight to the fallback walk rather than spending the
    // poll window on a child that is already doomed.
    // #202: a candidate whose port showed the password to a rejecting listener burns it, and every
    // later candidate is armed with a fresh one instead of the password that listener now holds.
    let armed = target
    const attempt = async (candidate: ServerRef) => {
      const result = await trySpawn(candidate)
      if (result.server) return result.server
      if (result.seen) {
        // Out of server.json as well as env (trySpawn saved the record with it), so a run that ends
        // here with ok:false leaves nothing on disk for the next run to adopt and present again.
        burnSavedPassword({ ...candidate, pid: null }, { serverFile, saveServerImpl: saveServer, env })
        // #213 F5: no password on the candidate means it was the user's (target never carries a
        // user-set one), and it is about to stop applying to the server fleetview ends up with.
        if (!candidate.password) {
          warn(
            `fleetview: OPENCODE_SERVER_PASSWORD may have reached something other than fleetview's server on ${candidate.host}:${candidate.port}, so fleetview has stopped using it and arms any server it starts with a generated password instead. Treat that value as exposed: change it wherever else you use it.`,
          )
        }
        armed = { ...armed, password: (env.OPENCODE_SERVER_PASSWORD = randomUUID()) }
      }
      return null
    }
    if (state !== 'unauthorized') {
      const spawned = await attempt(target)
      if (spawned) return { ok: true, server: spawned }
    } else {
      const dropped = credential === 'rejected' ? ' That listener may have seen the password, so it will not be used again: the replacement gets a freshly generated one.' : ''
      warn(
        credential === 'stranger'
          ? `fleetview: the listener on ${server.host}:${server.port} is not verifiably fleetview's opencode server. It was not shown the password, but fleetview stops using it anyway and tries the next port with a freshly generated one. If it is an opencode server fleetview started, stop it by hand (see SECURITY.md).`
          : `fleetview: something on ${server.host}:${server.port} is answering but rejecting fleetview's password — leaving it alone and trying the next port.${dropped}`,
      )
    }
    // configured port never came healthy — a bind failure or a non-opencode squatter holding it.
    // v2 can use ANY healthy opencode server it finds (global db, one server serves all projects),
    // so this fallback is only for the case where our own spawn couldn't bind/serve on `port` at all;
    // a foreign opencode already on that port would have passed isServerHealthy above and returned true.
    for (let p = server.port + 1; p <= server.port + 10; p++) {
      const spawned = await attempt({ ...armed, port: p })
      if (spawned) return { ok: true, server: spawned }
    }
    // #216: a password minted or rotated above belongs to no server now. Left in env, the next pass
    // would read it as a user-set one and offer it with no pid to check.
    if (armed.password && env.OPENCODE_SERVER_PASSWORD === armed.password) dropPassword(env)
    return { ok: false, server, reason: 'server did not become healthy' }
  }
  return (saved: ServerRef) => ensure(saved, false)
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
