import { readFileSync, statSync, openSync, closeSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite } from './paths.ts'
import { configDir } from './registry.ts'

export const defaultRosterFile = () => join(configDir(), 'roster.json')

export type RosterSession = { worktree: string; id: string; [key: string]: unknown }
export type Roster = { groupBy: 'state' | 'project'; sessions: RosterSession[]; collapsed: string[]; [key: string]: unknown }

const defaultRoster = (): Roster => ({ groupBy: 'state', sessions: [], collapsed: [] })

export function loadRoster(file: string): Roster {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    return defaultRoster()
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`roster file corrupt: ${file} — fix or delete it`)
  }
  // tolerated the same way as seen.json: a non-object parse (e.g. from a torn write) is
  // treated as an empty roster rather than corrupt.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return defaultRoster()
  // sessions must be an array or every roster consumer (App's flattenGroups etc.) throws at
  // render — a torn/foreign write leaving `sessions` as `{}` or missing is tolerated as empty.
  if (!Array.isArray(parsed.sessions)) return defaultRoster()
  if (parsed.groupBy !== 'state' && parsed.groupBy !== 'project') parsed.groupBy = 'state'
  // Which groups are collapsed, persisted so a folded-away group stays folded across restarts.
  // Tolerated like `sessions`: anything that isn't an array of strings is treated as none rather
  // than throwing at render.
  parsed.collapsed = Array.isArray(parsed.collapsed) ? parsed.collapsed.filter((k: unknown) => typeof k === 'string') : []
  return parsed
}

export function saveRoster(file: string, roster: Roster) {
  atomicWrite(file, JSON.stringify(roster, null, 2))
}

export function hasSession(roster: Roster, worktree: string, id: string) {
  return roster.sessions.some((s) => s.worktree === worktree && s.id === id)
}

// Same `worktree:id` identity the session store keys on, and unambiguous for the reason
// makePersistSeen documents: session ids never contain ':', so no two members share a key.
const memberKey = (m: RosterSession) => `${m.worktree}:${m.id}`

// App holds one whole-roster snapshot, loaded at mount, and rewrites the file from it on every
// change. So a `fleetview bg` append from another terminal was silently dropped by the next pin,
// collapse or shell-job TTL clean in the running instance (#70) — the session kept running
// server-side, it just stopped being listed. Merge onto a fresh read instead, same shape and same
// reason as makePersistSeen in cli.ts: a wholesale write drops what this process never saw.
//
// The hard half is telling "this instance removed it" (^x, ^a, deleteGroup, the TTL clean) from
// "another process added it" — on disk and absent from the snapshot, both look identical. `prev`,
// the snapshot this instance last held, decides: a member in prev but gone from snap was removed
// here and must stay removed, while a member on disk that prev never carried is someone else's
// addition and must survive. prev tracks what this instance knew, never the merged result —
// adopting the merge would make the next save read a foreign member as one of its own and delete
// it, resurrecting the bug one write later.
//
// #44: the same file is also the only channel a `fleetview bg` dispatch from another terminal has
// into an already-running TUI, which holds its membership in React state from mount. `reload` is
// hung off the persist callback rather than made a separate export so App needs no new wiring (and
// no roster-file prop) to reach the file cli.ts already chose — a persistRoster stub without it,
// as every existing test passes, simply has no external-member sync.
export type PersistRoster = ((snap: Roster) => void) & {
  // The roster as it is on disk RIGHT NOW, or null when it has not changed since this callback last
  // read or wrote it (and on any read error — an unreadable roster is not news). mtime+size rather
  // than a parse per call, and stamped after our own saves so a write of ours is never re-read as
  // someone else's change.
  reload: () => Roster | null
}

// #106: makePersistRoster's read-merge-write is not atomic — two processes (a TUI and a
// `fleetview bg`) that both loadRoster before either saves each write back a merge missing the
// other's append, so one is lost. An exclusive lockfile serialises the read-merge-write across
// processes: whoever creates `${file}.lock` (open 'wx' — fails if it exists) holds it for one
// persist. A lock older than STALE_LOCK_MS is a crashed holder's leftover and is broken.
// ponytail: busy-wait spin, since persist is fully synchronous anyway; best-effort — if locking
// can't be had (foreign error, or the spin times out) the write falls through unlocked rather than
// throwing, keeping the pre-#106 behaviour as the floor.
const STALE_LOCK_MS = 5000
function withRosterLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`
  let fd: number | null = null
  for (let i = 0; i < 100; i++) {
    try {
      fd = openSync(lock, 'wx')
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') break // undirectory/permission — give up, write unlocked
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
          unlinkSync(lock) // crashed holder — break it and retry immediately
          continue
        }
      } catch {} // lock vanished between open and stat — retry
      const until = Date.now() + 10 // brief spin before the next attempt
      while (Date.now() < until) {}
    }
  }
  try {
    return fn()
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch {}
      try { unlinkSync(lock) } catch {}
    }
  }
}

export function makePersistRoster({ roster, file }: { roster: Roster; file: string }): PersistRoster {
  let prev = roster
  const stamp = () => {
    try {
      const s = statSync(file)
      return `${s.mtimeMs}:${s.size}`
    } catch {
      return '' // missing/unreadable: no stamp to compare, and reload's loadRoster will answer for it
    }
  }
  let lastStamp = stamp()
  const persist = (snap: Roster) => withRosterLock(file, () => {
    let disk: Roster
    try {
      disk = loadRoster(file)
    } catch {
      disk = snap // corrupt mid-run: nothing readable to merge, and writing the snapshot back restores a valid file
    }
    const mine = new Map(snap.sessions.map((m) => [memberKey(m), m]))
    const removedHere = new Set(prev.sessions.map(memberKey).filter((k) => !mine.has(k)))
    // Disk order first with this instance's fields winning (pinned/rank/prompt/shell edits it made),
    // then the members only the snapshot has — makePersistSeen's `{ ...base, ...snap }` in list form.
    const seen = new Set()
    const sessions = []
    for (const m of disk.sessions) {
      const k = memberKey(m)
      if (removedHere.has(k) || seen.has(k)) continue
      seen.add(k)
      sessions.push(mine.get(k) ?? m)
    }
    for (const m of snap.sessions) {
      const k = memberKey(m)
      if (seen.has(k)) continue
      seen.add(k)
      sessions.push(m)
    }
    // groupBy and collapsed are one terminal's view state, not per-member facts, so there is
    // nothing to merge: last writer wins, exactly as before this merge existed.
    saveRoster(file, { ...snap, sessions })
    // Only after the write lands: committing `prev = snap` before a failed save would remember an
    // in-flight removal as done while it never reached disk, and the next successful persist
    // would merge the row back from disk — resurrecting what the user deleted.
    prev = snap
    lastStamp = stamp()
  })
  persist.reload = () => {
    const now = stamp()
    if (now === lastStamp) return null
    lastStamp = now
    try {
      return loadRoster(file)
    } catch {
      return null // corrupt mid-run: the in-memory roster is the better answer, and persist repairs the file
    }
  }
  return persist
}
