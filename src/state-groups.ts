import { FINISHED_STATUSES } from './session-store.ts'
import { hasOpenPr } from './pull-requests.ts'
import type { PullRequest } from './types.ts'
import type { RosterSession } from './ui/view-types.ts'

// The state view's sections and the fold that fits them to the screen — pure, moved out of app.ts
// so App only composes them.

// Agent view's groups: needs-input at the top, then working, then completed. All three are always
// rendered — even when empty they show a "no items" placeholder — so the view keeps a stable
// Claude-Code-style shape from the very first launch.
//
// These deliberately don't map 1:1 to states — "Completed collects finished, failed, and stopped
// sessions together" — which is why each group carries a predicate rather than a status string.
// `idle` folds in here too: a session that isn't blocked and isn't running is, for the user's
// purposes, done (or a just-dispatched row a moment before it starts working).
//
// Agent view also keeps a `Ready for review` group; fleetview deliberately folds those sessions
// into `completed` (John's call 2026-07-24), so there is no fourth section and no header count.
// A pull request instead shows as a `#N` label at the row's right edge (restored for #89, so a
// session the fold keeps on screen shows why), with the full list and URLs in peek.
export const STATE_GROUPS = [
  // Pinned wins the partition: a pinned session appears here and nowhere else, whatever its
  // status. `match` reads the decoration set below (s.pinned), not roster state directly, so the
  // group model stays pure. Unlike the three status groups it has no placeholder — an empty
  // pinned section is noise, agent view hides it too.
  { key: 'pinned', label: 'pinned', match: (s: RosterSession) => Boolean(s.pinned) },
  // `hint` shows under an empty status section, agent view's "description under each" — the skeleton
  // is only worth its rows if it teaches a first-time user what the three sections mean.
  { key: 'waiting', label: 'needs input', hint: 'a session is asking you something', match: (s: RosterSession) => s.status === 'waiting' },
  { key: 'running', label: 'working', hint: 'a session is running right now', match: (s: RosterSession) => s.status === 'running' },
  // #34: ghost rows (members whose session is gone server-side) land here too. They are finished in
  // every sense the user cares about, and `completed` is the section that already collects rows
  // nothing is going to happen to. `ghost` rather than a status test so FINISHED_STATUSES stays
  // exactly what session-store's `derive` can mint.
  { key: 'completed', label: 'completed', hint: 'finished, failed, or stopped sessions land here', match: (s: RosterSession) => FINISHED_STATUSES.has(s.status) || Boolean(s.ghost) },
]

// "Completed sessions that don't fit on screen fold into a `… N more` row. Failures and sessions
// with an open pull request always stay visible." Both halves of that rule are load-bearing and
// only the first was implemented: a completed session with a live pull request was folded away
// like any other success. Protected rows are sorted to the front of the group so the cap can only
// ever eat unprotected ones, and counted here so the cap never cuts into them.
export const isProtectedFromFold = (s: FoldRow) => s.status === 'error' || hasOpenPr(s.prs)
// #49: the row the user is standing on is protected too, or the fold silently retargets the next
// key at whatever ends up first on screen (`navRows` only sees drawn rows). `sel` is an identity
// ({projectKey, id}), not a key: keys are namespaced by the live grouping and go stale exactly
// when a row changes section, which is one of the moments this has to survive.
// What the fold needs off a row and a group, and nothing else: it is arithmetic over counts plus the
// two predicates above, so it never reads a title, an age or a snippet. Deliberately looser than
// RosterSession/RosterGroup — the property tests exercise it with bare `{status}` rows — and generic
// in the group, so App's real groups pass straight through and come back out fit to hand to the
// Roster rather than flattened to this weaker shape.
type FoldRow = { id?: string; projectKey?: string; status?: string; prs?: PullRequest[] }
type FoldGroup = { projectKey: string; repoName: string; sessions: FoldRow[]; empty?: boolean; hidden?: number }

export function foldCompleted<G extends FoldGroup>(
  groups: G[],
  maxRows: number,
  sel?: { projectKey: string; id: string } | null,
  // Collapsed groups draw their header alone (buildLines), so they are counted as one row.
  collapsed: { has(key: string): boolean } = new Set(),
  // `hidden` is added by the fold, so it is announced here rather than being required of a caller
  // that has never folded anything.
): Array<G & { hidden?: number }> {
  // Each group draws its header (1) plus its sessions; an empty always-shown group draws one
  // "no items" placeholder row in place of sessions. Counting those placeholders keeps the fold
  // honest now that needs-input/working are shown even when empty.
  const used =
    groups.reduce(
      (n, g) => n + 1 + (collapsed.has(g.projectKey) ? 0 : g.sessions.length + (g.sessions.length === 0 && g.empty ? 1 : 0)),
      0,
    ) + Math.max(0, groups.length - 1) // one spacer row between adjacent groups
  const completed = groups.find((g) => g.projectKey === 'state:completed')
  // A collapsed `completed` shows none of its rows, so there is nothing to fold.
  if (!completed || collapsed.has(completed.projectKey) || used <= maxRows) return groups
  const isSelected = (s: FoldRow) => !!sel && s.id === sel.id && s.projectKey === sel.projectKey
  const protectedCount = completed.sessions.filter((s) => isProtectedFromFold(s) || isSelected(s)).length
  // The fold costs a row of its own — the `… N more` line — so dropping k sessions only recovers
  // k-1 lines. Without the extra -1 the list still overflows by one and picks up a spurious
  // scroll indicator.
  const room = Math.max(protectedCount, completed.sessions.length - (used - maxRows) - 1)
  if (room >= completed.sessions.length) return groups
  // #49: "prefix ∪ selected", NOT a sort. The selected row is kept by swapping it in for the last
  // row of the prefix, so the list keeps its recency order and the highlighted row does not jump
  // to the top of `completed` the instant it is selected — walking ↓ through completed rows would
  // otherwise reshuffle the list under the cursor on every press. The row it displaces is never a
  // protected one: protected rows are sorted to the front and the selected row adds at most one to
  // `protectedCount`, so index `room - 1` is always unprotected when the swap runs.
  const prefix = completed.sessions.slice(0, room)
  const selectedRow = sel && !prefix.some(isSelected) ? completed.sessions.find(isSelected) : undefined
  const kept = selectedRow ? [...prefix.slice(0, room - 1), selectedRow] : prefix
  // Object.assign onto a fresh `{}` rather than a spread literal, for one reason: it produces
  // `G & {…}`, so the folded group keeps the caller's own row type instead of being widened to
  // FoldGroup and losing everything the Roster renders. Nothing is mutated either way.
  return groups.map((g) =>
    g === completed ? Object.assign({}, g, { sessions: kept, hidden: g.sessions.length - kept.length }) : g,
  )
}
