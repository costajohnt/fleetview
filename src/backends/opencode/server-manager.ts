import { spawn } from 'node:child_process'
import { closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ServerRef } from '../../types.ts'
import { openPrivateAppend } from '../../registry.ts'
import { authHeader, isV2Info, isV2Unauthorized, noteOpencodeApi } from './client.ts'
import { serverHome } from './client-v2.ts'

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
export type ProbeState = 'healthy' | 'unauthorized' | 'unreachable' | 'unconfirmed'
export async function probeServer(server: ServerRef, fetchImpl = globalThis.fetch): Promise<ProbeState> {
  // opencode 1.x answers GET /project with its project list. 2.x serves its web app there (200
  // text/html, no auth) and keeps the JSON API under /api, so a 1.x miss is asked again as 2.x.
  const base = `http://${server.host}:${server.port}`
  const v1 = await askServer(server, '/project', isProjectList, fetchImpl)
  if (v1 === 'healthy') noteOpencodeApi(base, 1)
  if (v1 !== 'unreachable') return v1
  // Credential only to a 401 that is 2.x's own: a 1.x without its embedded UI proxies unknown paths,
  // authorization header included, to app.opencode.ai, and whatever 401 that answers must not earn
  // the password (the reason opencodeApi in client.ts asks this route credential-free).
  const v2 = await askServer(server, '/api/info', isV2Info, fetchImpl, isV2UnauthorizedResponse)
  // What the probe found is the server's API for everything after it (client.ts opencodeApi).
  if (v2 === 'healthy') noteOpencodeApi(base, 2)
  return v2
}

async function askServer(
  server: ServerRef,
  path: string,
  looksRight: (body: unknown) => boolean,
  fetchImpl: typeof fetch,
  wantsCredential: (res: Response) => Promise<boolean> = async () => true,
): Promise<ProbeState> {
  const url = `http://${server.host}:${server.port}${path}`
  let presented = false
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
    if (authed.ok) return (await bodyLooksRight(authed, looksRight)) ? 'healthy' : 'unauthorized'
    return authed.status === 401 ? 'unauthorized' : 'unconfirmed'
  } catch {
    // Same rule for a listener that took the credential and then hung or reset.
    return presented ? 'unconfirmed' : 'unreachable'
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

