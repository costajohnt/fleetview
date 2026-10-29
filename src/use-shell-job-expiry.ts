import { useEffect, useRef } from 'react'
import { FINISHED_STATUSES } from './session-store.ts'
import { withMember, withoutMember, type Roster, type RosterSession as RosterMember } from './roster-store.ts'
import type { SessionStore } from './session-store.ts'
import type { RosterClient } from './backends/opencode/client.ts'
import type { RosterSession } from './ui/view-types.ts'

// "Cleanup ~5 minutes after completion" — agent view's shell jobs clean up after themselves, and
// a finished `! cmd` row that sits forever is clutter the user has to ^x by hand.
export const SHELL_JOB_TTL_MS = 5 * 60_000

// Pure: the shell-job members whose sessions have settled long enough ago to clean up. A session
// still missing from the store (not yet seeded) is left alone rather than guessed at.
export function expiredShellJobs(
  roster: { sessions: RosterMember[] },
  // ReadonlyMap because this only ever asks: a mutable Map<string, RosterSession> is invariant in its
  // value and would not fit a narrower declaration, while the read-only form takes any richer row.
  sessionsById: ReadonlyMap<string, { status: string; updatedAt?: number }>,
  now = Date.now(),
) {
  return roster.sessions.filter((m) => {
    if (!m.shell) return false
    const s = sessionsById.get(`${m.worktree}:${m.id}`)
    if (!s || !FINISHED_STATUSES.has(s.status)) return false
    // #112.2: a store row that returned no server time defaults updatedAt to 0, which would age out
    // instantly. Fall back to when the member was added so a real 5-minute window always applies;
    // with no timestamp at all, leave it alone rather than reap before `fleetview logs` can read it.
    const settledAt = s.updatedAt || (typeof m.addedAt === 'number' ? m.addedAt : 0)
    return settledAt > 0 && now - settledAt > SHELL_JOB_TTL_MS
  })
}

// Shell jobs clean up after themselves ~5 minutes after finishing, agent view's rule — the
// session is deleted (a job's output is ephemeral by contract; `fleetview logs` reads it before
// the window closes) and the row goes with it. In-flight guard: the effect runs per render and
// a delete takes longer than one. Keyed to "not before" times: Infinity while a delete is in
// flight, and after a failure the next project poll (M13) — the rollback re-renders, which re-runs
// this effect, so clearing the key on failure retried a persistently failing delete in a tight
// loop of HTTP calls and roster rewrites.
export function useShellJobExpiry({
  rosterState,
  byProjectSessions,
  client,
  store,
  projectPollMs,
  updateRoster,
}: {
  rosterState: Roster
  byProjectSessions: Map<string, RosterSession[]>
  client: RosterClient
  store: SessionStore
  projectPollMs: number
  updateRoster: (updater: (prev: Roster) => Roster) => void
}) {
  const cleaningJobs = useRef(new Map<string, number>())
  useEffect(() => {
    const sessionsById = new Map([...byProjectSessions.values()].flat().map((s) => [`${s.projectKey}:${s.id}`, s]))
    for (const m of expiredShellJobs(rosterState, sessionsById)) {
      const key = `${m.worktree}:${m.id}`
      if ((cleaningJobs.current.get(key) ?? 0) > Date.now()) continue
      cleaningJobs.current.set(key, Infinity)
      ;(async () => {
        try {
          updateRoster((prev) => withoutMember(prev, m.worktree, m.id))
          await client.deleteSession(m.id, m.worktree)
          store.apply(m.worktree, { type: 'session.deleted', properties: { info: { id: m.id } } })
          cleaningJobs.current.delete(key)
        } catch {
          cleaningJobs.current.set(key, Date.now() + projectPollMs)
          // Put it back: a failed delete must not orphan a running server-side session invisibly.
          // The whole member, not a `{ shell: true }` stand-in — same reason as deleteGroup's
          // rollback: a rebuilt member loses the row's pin, rank and prompt.
          updateRoster((prev) => withMember(prev, m.worktree, m.id, m))
        }
      })()
    }
  })
}
