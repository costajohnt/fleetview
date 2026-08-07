import { spawn } from 'node:child_process'
import { openSync, mkdirSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ServerRef } from '../../types.ts'
import { authHeader } from './client.ts'

const logDir = () => (process.env.FLEETVIEW_LOG_DIR ?? process.env.ROOST_LOG_DIR) ?? join(homedir(), '.local', 'state', 'fleetview', 'logs')

export function spawnServer(
  server: ServerRef,
  { spawnImpl = spawn, logFd, closeSyncImpl = closeSync }: { spawnImpl?: typeof spawn; logFd?: number; closeSyncImpl?: typeof closeSync } = {},
) {
  // Only close what we opened: a caller-supplied fd stays the caller's to manage.
  let ownFd = false
  if (logFd === undefined) {
    // 0o700/0o600 like the other state files: the log holds server output (prompts, paths, and any
    // token the server prints), so it must not be world-readable. mode on mkdir only applies when it
    // creates the dir, and on openSync only when it creates the file — both fine for a fresh log.
    mkdirSync(logDir(), { recursive: true, mode: 0o700 })
    logFd = openSync(join(logDir(), 'server.log'), 'a', 0o600)
    ownFd = true
  }
  const child = spawnImpl('opencode', ['serve', '--port', String(server.port), '--hostname', server.host], {
    cwd: homedir(),
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
export async function probeServer(server: ServerRef, fetchImpl = globalThis.fetch): Promise<'healthy' | 'unauthorized' | 'unreachable'> {
  const url = `http://${server.host}:${server.port}/project`
  try {
    // The first request carries NO credential, on purpose. fleetview adopts the password from
    // server.json before it has any evidence about who holds the port, so an authenticated first
    // probe hands that credential to whatever is listening — including a process that is not
    // fleetview's server and not opencode at all. Only a 401 is evidence the listener wants a
    // credential, and only then is one presented, on a single retry. Costs one extra round trip on
    // the password path; changes no adoption semantics.
    let res = await fetchImpl(url, { signal: AbortSignal.timeout(2000) })
    if (res.status === 401) {
      const auth = authHeader()
      if (!auth) return 'unauthorized'
      res = await fetchImpl(url, { headers: { authorization: auth }, signal: AbortSignal.timeout(2000) })
      if (res.status === 401) return 'unauthorized'
    }
    if (!res.ok) return 'unreachable'
    let body
    try {
      body = await res.json()
    } catch {
      return 'unreachable'
    }
    return isProjectList(body) ? 'healthy' : 'unreachable'
  } catch {
    return 'unreachable'
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
export async function isAuthEnforced(server: ServerRef, fetchImpl = globalThis.fetch) {
  if (!authHeader()) return true
  try {
    const res = await fetchImpl(`http://${server.host}:${server.port}/project`, {
      signal: AbortSignal.timeout(2000),
    })
    return res.status === 401
  } catch {
    return true // a transient network failure is not evidence auth is off; don't nag
  }
}

