import { readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

// Prefer the fleetview dir, but keep reading an existing pre-rename ~/.config/roost until the
// user (or a future migration) moves it — a rename must not orphan anyone's roster or server.
const baseDir = () => {
  const fresh = join(homedir(), '.config', 'fleetview')
  const legacy = join(homedir(), '.config', 'roost')
  return existsSync(fresh) || !existsSync(legacy) ? fresh : legacy
}

export const defaultRosterFile = () =>
  join((process.env.FLEETVIEW_CONFIG_DIR ?? process.env.ROOST_CONFIG_DIR) ?? baseDir(), 'roster.json')

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
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  // mkdir's `mode` only applies when it creates the dir, so one that already exists keeps whatever
  // perms it had. Re-tighten on every save; best-effort, since a dir we can't chmod is no reason to
  // fail the write.
  try {
    chmodSync(dirname(file), 0o700)
  } catch {}
  const tmp = `${file}.${process.pid}.tmp` // per-pid: two fleetview instances must not share a tmp inode
  writeFileSync(tmp, JSON.stringify(roster, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
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
export function makePersistRoster({ roster, file }: { roster: Roster; file: string }) {
  let prev = roster
  return (snap: Roster) => {
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
    prev = snap
    // groupBy and collapsed are one terminal's view state, not per-member facts, so there is
    // nothing to merge: last writer wins, exactly as before this merge existed.
    return saveRoster(file, { ...snap, sessions })
  }
}
