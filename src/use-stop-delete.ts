import { useEffect, useRef } from 'react'
import { withMember, withoutMember, type Roster } from './roster-store.ts'
import { isSandbox, isLocalWorktree, removeLocalWorktree } from './worktree.ts'
import { STATE_GROUPS } from './state-groups.ts'
import { isRecord } from './types.ts'
import type { AttachTarget, Backend, BackendCapabilities } from './types.ts'
import type { SessionStore } from './session-store.ts'
import type { RosterClient } from './backends/opencode/client.ts'
import type { RosterSession } from './ui/view-types.ts'

export type StopArm = { key: string; at: number; held?: { group: string | undefined; updatedAt: number } }

// ^x on a row (stop, then delete) and on a group header (delete the group), lifted out of App the
// same way useDispatch was. Re-invoked per render, so both callbacks close over that render's
// groups and sessions exactly as the inline functions did. `stopArm` stays App's: stateGroups
// reads it to hold an armed row in place.
export function useStopDelete({
  client,
  store,
  parents,
  byProjectSessions,
  unfoldedGroups,
  rosterRef,
  updateRoster,
  setOfflineProjects,
  backendFor,
  capabilitiesOf,
  backendNameOf,
  worktreeSafetyImpl,
  stopArm,
  stopArmMs,
  rerender,
  flash,
  setNotice,
}: {
  client: RosterClient
  store: SessionStore
  parents: Map<string, string>
  byProjectSessions: Map<string, RosterSession[]>
  unfoldedGroups: { projectKey: string; repoName: string; sessions: RosterSession[] }[]
  rosterRef: { current: Roster }
  updateRoster: (updater: (prev: Roster) => Roster) => void
  setOfflineProjects: (updater: (s: Set<string>) => Set<string>) => void
  backendFor: (row: AttachTarget) => Backend
  capabilitiesOf: (row: AttachTarget) => BackendCapabilities
  backendNameOf: (row: AttachTarget) => string
  worktreeSafetyImpl: (dir: string, parentDir: string | null | undefined) => { removable: boolean; reason?: string | null }
  stopArm: { current: StopArm | null }
  stopArmMs: number
  rerender: () => void
  flash: (message: string, ms?: number) => void
  setNotice: (notice: string | null) => void
}) {
  // The hold stateGroups applies while a ^x is armed is time-bound, and nothing else necessarily
  // repaints when it lapses — this repaints once, so the row settles into its real section instead
  // of sitting in the old one until some unrelated event happens to render.
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (armTimer.current) clearTimeout(armTimer.current) }, [])

  // The two verbs ^x drives, through the row's adapter — the only thing that knows whether stopping
  // means an HTTP abort or signalling a detached CLI's process group.
  const abortRow = (row: AttachTarget) => backendFor(row).abort(row.id, row.projectKey)
  // A claude/copilot row in a worktree fleetview made for it (use-dispatch) can't be deleted, but
  // the worktree can: ^x^x forgets the row and removes the worktree under removeWorktreeFor's
  // rules. The CLI's own transcript is left alone, as it is everywhere else.
  const forgetOnly = (row: AttachTarget) => !capabilitiesOf(row).delete && isLocalWorktree(row.projectKey)
  const deleteRow = (row: AttachTarget) => (forgetOnly(row) ? Promise.resolve() : backendFor(row).delete(row.id, row.projectKey))
  // The same lookup off the ref rather than the render closure, for the optimistic-delete paths: by
  // the time one of those runs, earlier rows in the same loop have already changed the roster, and
  // the member it is about to remove has to be the one that is actually there.
  const takeMember = (projectKey: string, id: string) => rosterRef.current.sessions.find((m) => m.worktree === projectKey && m.id === id)

  // Ctrl+X: stop, then delete on a second press within 2s. Replaces the old y/d/n and y/n modal
  // confirms — agent view has no dialog here, and the arm window is its own confirmation.
  // Deleting an isolated session takes its worktree with it, but only when worktreeSafety finds no
  // uncommitted changes and no unpushed commits there; otherwise the worktree is kept rather than
  // silently taking work with it. Stricter than agent view, whose "Ctrl+X twice removes the worktree
  // and uncommitted changes (commit first)" only spares unpushed commits. opencode's DELETE enforces
  // none of this — it will remove a worktree holding uncommitted changes, and its branch, without
  // complaint — so the check has to happen here.
  const removeWorktreeFor = async (projectKey: string, deletedId: string) => {
    if (!isSandbox(parents, projectKey)) return
    const repo = parents.get(projectKey)
    // Only when it was the last session in that worktree. Adopting a second session into one is
    // unusual, but removing the directory out from under it would not be recoverable.
    //
    // Counted by excluding the id just deleted rather than by trusting the count to have gone
    // down. `byProjectSessions` belongs to the render this keypress came from, so whether it has
    // already dropped the deleted row depends on whether React re-rendered during the await — and
    // a guard whose correctness turns on that is a guard waiting to break.
    const remaining = (byProjectSessions.get(projectKey) ?? []).filter((s) => s.id !== deletedId).length
    if (remaining > 0) return
    // #112.4: this safety read is the last synchronous thing before the removal — callers await the
    // session delete first, and nothing async runs between here and removeWorktree — so a commit an
    // agent lands after the session is stopped is measured, not destroyed. The one window the client
    // can't close is the round-trip inside removeWorktree itself; the server does the actual `git
    // worktree remove`, so a commit that lands during that call is the server's race, not this one's.
    const safety = worktreeSafetyImpl(projectKey, repo)
    if (!safety.removable) return flash(`kept the worktree — ${safety.reason}`, 5000)
    try {
      // A worktree fleetview made itself (claude/copilot) has no server record: git removes it here.
      if (repo && isLocalWorktree(projectKey)) removeLocalWorktree(projectKey, repo)
      else await client.removeWorktree?.(projectKey, repo)
    } catch {
      // The session is already gone; a worktree left behind is untidy, not harmful, and `git
      // worktree list` still shows it. Saying so beats a silent failure.
      flash('session deleted, but its worktree could not be removed', 4000)
    }
  }

  // "Ctrl+X on a group header deletes every session in the group (confirmation required)." The
  // confirmation is the same two-press arm the per-session form uses, keyed on the group — one
  // deliberate mechanism rather than a modal for one case and an arm for the other.
  const deleteGroup = async (projectKey: string) => {
    // unfoldedGroups, not groups: the rendered groups are folded/sliced to the screen, so this used
    // to delete (and count) only the visible subset — folded completed rows and browse rows past the
    // cap survived, contradicting "every session in the group".
    const group = unfoldedGroups.find((g) => g.projectKey === projectKey)
    const rows: RosterSession[] = group?.sessions ?? []
    if (rows.length === 0) return
    const armKey = `group:${projectKey}`
    const armed = stopArm.current && stopArm.current.key === armKey && Date.now() - stopArm.current.at < stopArmMs
    if (!armed) {
      stopArm.current = { key: armKey, at: Date.now() }
      return flash(`^x again to delete ${rows.length} session${rows.length === 1 ? '' : 's'} in ${group?.repoName}`, stopArmMs)
    }
    stopArm.current = null
    setNotice(null)
    // Sequential rather than parallel: each one may take its worktree with it, and the safety
    // check reads git state that the previous removal just changed.
    for (const row of rows) {
      // #34: a ghost in the group is just a membership — drop it and move on. Reaching deleteRow
      // with it would fail and flag the whole project offline over a session that is already gone.
      if (row.ghost) {
        updateRoster((prev) => withoutMember(prev, row.projectKey, row.id))
        continue
      }
      // A backend that can't delete is skipped rather than throwing into the catch below, which
      // would flag the whole project offline over a session that was never deletable to begin with.
      if (!capabilitiesOf(row).delete && !forgetOnly(row)) {
        flash(`${backendNameOf(row)} can't delete a session`, 4000)
        continue
      }
      // Captured before the optimistic removal, and restored verbatim below. Rebuilding a member
      // from (worktree, id) mints a bare one — so a failed delete used to silently unpin the row,
      // forget it was a shell job (which is what drives the 5-minute auto-clean) and lose its
      // dispatch prompt (which the URL filter reads).
      const member = takeMember(row.projectKey, row.id)
      updateRoster((prev) => withoutMember(prev, row.projectKey, row.id))
      try {
        await deleteRow(row)
        store.apply(row.projectKey, { type: 'session.deleted', properties: { info: { id: row.id } } })
        await removeWorktreeFor(row.projectKey, row.id)
      } catch {
        updateRoster((prev) => withMember(prev, row.projectKey, row.id, member))
        setOfflineProjects((s) => new Set(s).add(row.projectKey))
        flash('delete failed')
      }
    }
  }

  const stopOrDelete = async (row: RosterSession) => {
    // #34: nothing exists server-side, so there is nothing to abort, nothing to delete and no
    // worktree the session still owns — the only thing ^x can mean on a ghost is "drop the
    // membership". It takes effect on the first press rather than arming a confirmation: the
    // two-press gate exists to guard a destructive server call, and there is no server call.
    if (row.ghost) {
      updateRoster((prev) => withoutMember(prev, row.projectKey, row.id))
      return flash(`removed "${row.title}"`)
    }
    const armKey = `${row.projectKey}:${row.id}`
    const armed = stopArm.current && stopArm.current.key === armKey && Date.now() - stopArm.current.at < stopArmMs
    if (armed) {
      stopArm.current = null
      setNotice(null)
      // A backend that can't delete (claude/copilot) must not reach deleteRow: it would throw, read
      // as a generic "delete failed", and — worst — flag the whole project offline, blanking the
      // opencode rows sharing the directory. The first ^x already stopped the run; that stays.
      if (!capabilitiesOf(row).delete && !forgetOnly(row)) return flash(`${backendNameOf(row)} can't delete a session`, 4000)
      const member = takeMember(row.projectKey, row.id) // see deleteGroup: the rollback restores this object, not a bare one
      updateRoster((prev) => withoutMember(prev, row.projectKey, row.id))
      try {
        await deleteRow(row)
        store.apply(row.projectKey, { type: 'session.deleted', properties: { info: { id: row.id } } })
        setOfflineProjects((s) => {
          const next = new Set(s)
          next.delete(row.projectKey)
          return next
        })
        await removeWorktreeFor(row.projectKey, row.id)
      } catch {
        // restore membership so the row reappears — otherwise a failed delete is visually
        // indistinguishable from a successful one (F2).
        updateRoster((prev) => withMember(prev, row.projectKey, row.id, member))
        setOfflineProjects((s) => new Set(s).add(row.projectKey))
        flash('delete failed')
      }
      return
    }
    const armedAt = Date.now()
    // Where the row is right now, before the abort marks it stopped — stateGroups holds it here
    // until the arm lapses so the confirming press targets a row that hasn't moved (#15).
    stopArm.current = { key: armKey, at: armedAt, held: { group: STATE_GROUPS.find((g) => g.match(row))?.key, updatedAt: row.updatedAt ?? 0 } }
    if (armTimer.current) clearTimeout(armTimer.current)
    armTimer.current = setTimeout(rerender, stopArmMs + 50) // just past the window, so the released row repaints
    // The arm is immediate — the two-press window must not wait on the network — but the notice
    // reports the outcome, not the intention. It used to say `stopped "<title>"` before the abort
    // had even been sent, and never corrected itself when the abort threw: a session that is still
    // running reads as stopped, and the user finds out by watching it keep working.
    flash(`stopping "${row.title}" · ^x again to delete`)
    // What is true once the abort settles. "^x again to delete" is only an offer while the arm is
    // live, so it is repeated only for whatever is left of that window — a notice that outlived the
    // arm would invite a second press that arms again instead of deleting.
    const report = (message: string) => {
      const left = stopArmMs - (Date.now() - armedAt)
      return left > 0 ? flash(`${message} · ^x again to delete`, left) : flash(message)
    }
    try {
      const result = await abortRow(row)
      // M14: a process backend answers {aborted:false} when there was nothing of this run left to
      // signal (no pid, a recycled one, already exited). Marking that "stopped" would label a row
      // whose run may still be going — or that finished on its own — with a stop that never happened.
      if (isRecord(result) && result.aborted === false) return report('nothing running to stop')
      // M4: a session whose "waiting" came only from the ?-heuristic (idle underneath, no real
      // pending permission/question) won't get a session.status SSE event from this abort —
      // nothing else would ever clear the heuristic, so the row would stay stuck showing waiting.
      store.clearHeuristicWaiting(row.projectKey, row.id)
      // The server reports the aborted session as plain idle, which would render as "completed" —
      // a result the user never got. Remember the stop so the row says so.
      store.markStopped(row.projectKey, row.id)
      setOfflineProjects((s) => {
        const next = new Set(s)
        next.delete(row.projectKey)
        return next
      })
      report(`stopped "${row.title}"`)
    } catch {
      setOfflineProjects((s) => new Set(s).add(row.projectKey))
      report(`couldn't stop "${row.title}"`)
    }
  }

  return { deleteGroup, stopOrDelete }
}
