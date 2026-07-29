import { readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { ServerRef } from './types.ts'

// Prefer the fleetview dir, but keep reading an existing pre-rename ~/.config/roost until the
// user (or a future migration) moves it — a rename must not orphan anyone's roster or server.
const baseDir = () => {
  const fresh = join(homedir(), '.config', 'fleetview')
  const legacy = join(homedir(), '.config', 'roost')
  return existsSync(fresh) || !existsSync(legacy) ? fresh : legacy
}
// Exported so a second consumer of the config dir doesn't become a third copy of the six lines
// above (roster-store.ts already carries the second), and because the config dir is no longer only
// server.json's parent: the process-backed backends keep a per-session log under it. Read at call
// time, not module load: the tests set FLEETVIEW_CONFIG_DIR per case.
export const configDir = () => (process.env.FLEETVIEW_CONFIG_DIR ?? process.env.ROOST_CONFIG_DIR) ?? baseDir()

export const defaultServerFile = () => join(configDir(), 'server.json')

// M1: the password fleetview mints for the server it spawns lives in process.env, because the
// opencode child and `opencode attach` are meant to inherit it. Nothing else is: a dispatched agent
// (claude/copilot) and the FLEETVIEW_NOTIFY_CMD hook are prompt-injectable, and that credential is
// ungated shell over loopback through POST /session/:id/shell — the exact route the mint closes.
// Lives here rather than in an opencode module so the process-backed backends and the notify hook
// can reach it without importing across backend families.
export const envWithoutServerPassword = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const { OPENCODE_SERVER_PASSWORD, ...rest } = env
  return rest
}

// Local rather than shared with seen-store: a five-line best-effort rename is cheaper than either
// a cross-import between two unrelated stores or a new module to hold one function.
function setAside(file: string) {
  try {
    renameSync(file, `${file}.corrupt`)
  } catch {
    // nothing to do; the caller falls back to discovery either way
  }
}

export function loadServer(file: string): ServerRef | null {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    return null // no server yet
  }
  // server.json is a pointer fleetview writes and can always rebuild: cli.ts falls back to the default
  // host/port and re-spawns or re-discovers a server. Refusing to start over a damaged pointer made
  // the user hand-delete a file to recover something fleetview fixes itself. The bad file is set aside
  // rather than discarded, so nothing is lost silently.
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    setAside(file)
    return null
  }
  if (typeof parsed?.host !== 'string' || typeof parsed?.port !== 'number') {
    setAside(file)
    return null
  }
  // The host drives `opencode serve --hostname` and every request URL. A planted or stale server.json
  // (including a legacy ~/.config/roost one) with a non-loopback host would bind the RCE-capable
  // server to the network, silently turning the localhost-only threat model into a LAN one. Reject
  // anything that isn't loopback and fall back to the default, which fleetview rebuilds.
  if (!LOOPBACK_HOSTS.has(parsed.host)) {
    setAside(file)
    return null
  }
  return parsed
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

export function saveServer(file: string, server: ServerRef) {
  // mkdirSync's mode only applies when it creates the dir — a pre-existing dir keeps its current
  // perms, so re-tighten it on every save (F6). Best-effort: a dir we can't chmod is no reason to
  // fail the write, and the 0o600 file mode below still applies. server.json now holds the spawned
  // server's generated password, so this dir being 0700 is load-bearing.
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  try {
    chmodSync(dirname(file), 0o700)
  } catch {}
  // pid-tmp+rename (matches roster-store.ts/seen-store.ts): writeFileSync's `mode` is only honored
  // when the file doesn't already exist, so overwriting in place left a pre-existing server.json
  // stuck on whatever perms it was first created with. Renaming a fresh 0o600 tmp file over it
  // fixes perms on every save and gets write-atomicity as a side effect (F6).
  const tmp = `${file}.${process.pid}.tmp` // per-pid: two fleetview instances must not share a tmp inode
  writeFileSync(tmp, JSON.stringify({ ...server, pid: server.pid ?? null }, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
}
