// Helpers shared across both process-backed backends (claude and copilot) and across the store
// modules that sit above them. Each helper extracts a pattern that appears verbatim in two or more
// places so that a future fix lands in one file.

import { mkdirSync, chmodSync, writeFileSync, renameSync, readdirSync, statSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

// --- atomicWrite ---
//
// mkdir/chmod/tmp/rename/0600 write pattern, shared by registry.ts, roster-store.ts, and
// seen-store.ts. writeFileSync's `mode` is only honored when the file does not already exist, so
// overwriting in place left a pre-existing file stuck on whatever perms it was first created with.
// Renaming a fresh 0o600 tmp file over it fixes perms on every save and gets write-atomicity as a
// side effect. mkdirSync's mode only applies when it creates the dir — a pre-existing dir keeps its
// current perms — so chmod is re-applied on every write too.
export function atomicWrite(dest: string, data: string | Buffer): void {
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 })
  try {
    chmodSync(dirname(dest), 0o700)
  } catch {}
  // per-pid: two fleetview instances must not share a tmp inode
  const tmp = `${dest}.${process.pid}.tmp`
  writeFileSync(tmp, data, { mode: 0o600 })
  renameSync(tmp, dest)
}

// --- reapRunLogs ---
//
// How long a finished run's captured log is kept. Shared so the constant does not drift between
// backends — an inconsistency there would silently change which backend retains its logs longer.
export const KEEP_RUNS_MS = 30 * 24 * 60 * 60 * 1000

// Scans `dir` for .jsonl files whose last modification time predates the retention window and
// removes them. `now` is the caller's timestamp (injectable so tests can control the window).
// `onExpired` is called with the id (filename without `.jsonl`) of each file removed, so the
// caller can clean up companion files (e.g. claude's .json meta) or in-memory state. Best effort
// throughout — a file that cannot be removed is not a reason to fail the dispatch.
export function reapRunLogs(dir: string, now: number, onExpired?: (id: string) => void): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  const cutoff = now - KEEP_RUNS_MS
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const id = name.slice(0, -'.jsonl'.length)
    const file = join(dir, name)
    try {
      // mtime, not dispatch time: a session resumed last week is live work whatever day its first
      // prompt was sent, and deleting its log would blank the row it still feeds.
      if (statSync(file).mtimeMs >= cutoff) continue
    } catch {
      continue
    }
    rmSync(file, { force: true })
    onExpired?.(id)
  }
}

// --- parseNdjsonChunk ---
//
// NDJSON (one JSON object per line) incremental parser, shared by both backends' stream readers.
// A chunk read from a tailed file often ends mid-line, so the partial trailing line is returned as
// `rest` for the caller to prepend to the next chunk. The generic parameter T is the expected
// payload type; callers cast it to their own event shape.
export function parseNdjsonChunk<T>(buffer: string): { items: T[]; rest: string } {
  const items: T[] = []
  const lines = buffer.split('\n')
  const rest = lines.pop() ?? '' // partial trailing line stays buffered
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      items.push(JSON.parse(trimmed))
    } catch {
      // Not a JSON line (plain-text stderr or a warning that landed on the same fd).
      // Keeping it in the log is worth more than refusing to parse the rest of the run.
    }
  }
  return { items, rest }
}
