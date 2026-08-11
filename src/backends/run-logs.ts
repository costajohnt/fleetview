// Reaping the captured run logs both process-backed backends keep under the config dir. The two
// backends carried this loop verbatim; a fix to the retention logic must land once.
import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

// How long a run's captured log is kept. The log dir gains a file per dispatch and nothing else
// ever removed them, so a heavy user accumulated every session they had ever dispatched, forever.
// Thirty days is long enough that the log is still there for anything the roster is plausibly still
// showing, and the CLI's own transcript — which fleetview does not own and does not touch —
// outlives it anyway.
export const KEEP_RUNS_MS = 30 * 24 * 60 * 60 * 1000

// Drop run logs whose last activity is older than the retention window, returning the session ids
// reaped so a caller with per-run side state (the claude backend's meta file and cache) can drop
// that too. Hung off dispatch by both callers rather than given a timer: there is no long-lived
// process here to schedule against, and the dir only grows when something is dispatched, so that is
// exactly when it is worth a look. Best effort throughout — a log that cannot be listed or removed
// is not a reason to fail the dispatch.
export function reapRunLogs(dir: string, now: number): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const cutoff = now - KEEP_RUNS_MS
  const reaped: string[] = []
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    try {
      // mtime, not the dispatch time: a session resumed last week is live work whatever day its
      // first prompt was sent, and deleting its log would blank the row it still feeds.
      if (statSync(join(dir, name)).mtimeMs >= cutoff) continue
    } catch {
      continue
    }
    rmSync(join(dir, name), { force: true })
    reaped.push(name.slice(0, -'.jsonl'.length))
  }
  return reaped
}
