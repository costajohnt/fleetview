import { readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { atomicWrite, fleetviewDir } from './paths.ts'

// Same legacy fallback as the config stores: an existing pre-rename state dir keeps working.
export const defaultSeenFile = () =>
  join((process.env.FLEETVIEW_STATE_DIR ?? process.env.ROOST_STATE_DIR) ?? fleetviewDir(join(homedir(), '.local', 'state')), 'seen.json')

// { "<repoId>:<sessionId>": { updated: <ms>, hasRun: <bool>, stopped?: <bool>, error?: <string|true> } }
// #53: `stopped` is written by the store's snapshot() and read back by setSessions — the server
// reports an aborted session as plain idle, so the flag is fleetview's own memory of the abort. It
// was on disk but missing from this declaration, which made reading it off the typed loadSeen
// return a type error for a field that really is there.
// #45: `error` is the same kind of fleetview-side memory as `stopped`, for the same reason — the
// server's session list and /session/status carry no last error, so `lastError` only ever existed
// in the process that saw the live `session.error` frame. Persisting it is what makes `ls` (which
// builds a fresh store per invocation) and a restarted TUI agree with the live view. Stored in the
// compact `errorLabel` form the #24 row snippet renders, or `true` for an error frame that carried
// no text — the same string-or-sentinel shape `lastError` itself holds, so it restores as-is.
export type SeenEntry = { updated: number; hasRun: boolean; stopped?: boolean; error?: string | true }
export type SeenMap = Record<string, SeenEntry>

export function loadSeen(file: string): SeenMap {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    return {} // no file yet
  }
  // seen.json is disposable state — watermarks fleetview rebuilds by watching. The old code said
  // exactly that, then threw on unparseable JSON, which is the most likely corruption and the very
  // failure mode the tolerance was meant to cover: a damaged cache stopped fleetview starting at all
  // until the user deleted it by hand.
  //
  // Unreadable content is set aside rather than discarded, so nothing is silently lost and the
  // evidence survives for anyone who wants to look.
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    setAside(file)
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    setAside(file)
    return {}
  }
  return parsed
}

// Moves an unreadable file out of the way instead of overwriting it. Best-effort: if it can't be
// renamed, carrying on with empty state still beats refusing to start.
export function setAside(file: string) {
  try {
    renameSync(file, `${file}.corrupt`)
  } catch {
    // nothing to do; the caller falls back to empty state either way
  }
}

export function saveSeen(file: string, map: SeenMap) {
  atomicWrite(file, JSON.stringify(map, null, 2))
}
