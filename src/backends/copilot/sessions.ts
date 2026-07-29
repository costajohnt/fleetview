// Discovery: what copilot itself leaves on disk, which is the only way to see sessions fleetview
// never started. Everything here is a read — copilot owns ~/.copilot and fleetview never writes to
// it. Wire details verified against 1.0.75; see docs/specs/2026-07-25-copilot-backend-wire.md.
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// One directory per session: workspace.yaml (metadata), events.jsonl (transcript), and an
// inuse.<pid>.lock that exists only while a copilot process holds the session.
export const sessionStateDir = () => process.env.COPILOT_STATE_DIR ?? join(homedir(), '.copilot', 'session-state')

export type CopilotWorkspace = {
  id: string
  cwd: string
  name?: string
  created_at?: string
  updated_at?: string
}

// workspace.yaml is a flat map of scalars — no nesting, no lists, no anchors — so a YAML dependency
// would be eight hundred kilobytes to read eight lines. Deliberately not a general YAML parser: it
// handles exactly the shape copilot writes, and anything it can't read comes back null so the
// session is skipped rather than half-parsed.
export function parseWorkspace(text: string): CopilotWorkspace | null {
  const fields: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const at = line.indexOf(':')
    if (at < 1 || line.startsWith('#')) continue
    const key = line.slice(0, at).trim()
    let value = line.slice(at + 1).trim()
    // Copilot single-quotes any value containing a colon — a session named from its first prompt
    // very often does. YAML escapes an inner quote by doubling it.
    if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) value = value.slice(1, -1).replaceAll("''", "'")
    else if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1)
    fields[key] = value
  }
  if (!fields.id || !fields.cwd) return null
  // The id becomes a path segment (join(stateDir, id, 'events.jsonl') and the log path), so a
  // crafted `id: ../../foo` in a planted workspace.yaml would read outside stateDir. Copilot's own
  // ids are opaque tokens with no separators, so reject anything with a slash or `..`.
  if (fields.id.includes('/') || fields.id.includes('\\') || fields.id.includes('..')) return null
  return { id: fields.id, cwd: fields.cwd, name: fields.name, created_at: fields.created_at, updated_at: fields.updated_at }
}

// The pid holding the session, or null when nothing is running it. The lock's name carries the pid
// and its content repeats it; the name is used because it survives the file being mid-write, and it
// is the only running/finished signal copilot exposes — there is no status field anywhere on disk.
export function runningPid(dir: string): number | null {
  return lockInfo(dir)?.pid ?? null
}

// The lock plus when it was written. The mtime is the only birth certificate a foreign session's
// pid has (there is no run meta for a session fleetview never started), and abort compares it
// against the process's actual start time before trusting the pid — a lock left by a crash can name
// a pid the OS has since handed to something unrelated.
export function lockInfo(dir: string): { pid: number; mtimeMs: number } | null {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return null
  }
  for (const entry of entries) {
    const match = /^inuse\.(\d+)\.lock$/.exec(entry)
    if (!match) continue
    const pid = Number(match[1])
    // pid 0 addresses the caller's own process group to kill(2) — a corrupt or planted
    // `inuse.0.lock` must not turn abort into fleetview signalling itself.
    if (pid <= 0 || !Number.isSafeInteger(pid)) continue
    try {
      return { pid, mtimeMs: statSync(join(dir, entry)).mtimeMs }
    } catch {
      return null // removed between the readdir and the stat: an orderly exit just happened
    }
  }
  return null
}

export type CopilotSession = {
  id: string
  directory: string
  title: string
  running: boolean
  // Milliseconds, matching what session-store already reads off an opencode session, so the roster
  // does not need a per-backend timestamp unit.
  time: { created: number; updated: number }
}

const ms = (iso?: string) => {
  const at = iso ? Date.parse(iso) : NaN
  return Number.isNaN(at) ? 0 : at
}

// Copilot records a resolved real path — a session dispatched into /tmp/x on macOS is stored as
// /private/tmp/x — so comparing the caller's string directly finds nothing on a Mac.
const resolved = (path: string) => {
  try {
    return realpathSync(path)
  } catch {
    return path // not on disk (yet); the raw comparison below is still worth trying
  }
}

// Newest first. The roster sorts for itself, but an unsorted listing makes "which of these is the
// one I just started" a guess in every test and every log line.
export function listSessions(directory: string, stateDir = sessionStateDir()): CopilotSession[] {
  let entries: string[]
  try {
    entries = readdirSync(stateDir)
  } catch {
    return [] // copilot has never run on this machine; that is an empty roster, not an error
  }
  const want = resolved(directory)
  const sessions: CopilotSession[] = []
  for (const entry of entries) {
    const dir = join(stateDir, entry)
    let workspace: CopilotWorkspace | null
    try {
      if (!statSync(dir).isDirectory()) continue
      workspace = parseWorkspace(readFileSync(join(dir, 'workspace.yaml'), 'utf8'))
    } catch {
      continue // a session mid-creation, or a directory copilot left behind without metadata
    }
    if (!workspace) continue
    if (workspace.cwd !== want && workspace.cwd !== directory && resolved(workspace.cwd) !== want) continue
    sessions.push({
      id: workspace.id,
      directory,
      // Copilot names an unnamed session after its first prompt, which is what the roster wants to
      // show; the id is the fallback because a titleless row is unidentifiable.
      title: workspace.name || workspace.id,
      running: runningPid(dir) !== null,
      time: { created: ms(workspace.created_at), updated: ms(workspace.updated_at) },
    })
  }
  return sessions.sort((a, b) => b.time.updated - a.time.updated)
}
