import { basename } from 'node:path'
import { hasSession, type Roster } from './roster-store.ts'
import { DEFAULT_BACKEND } from './backends/index.ts'
import { rememberSandboxes, isRootProject, displayProject, isSandbox } from './worktree.ts'
import { asNumber } from './types.ts'
import type { Project, PullRequest } from './types.ts'
import type { SessionStore } from './session-store.ts'
import type { RosterSession } from './ui/view-types.ts'

// The fleet as App sees it on one render: every store session decorated with its membership and
// pull requests, regrouped under the repository that owns it, plus the ghost rows (#34/#43) and the
// projects that count as repositories. Pure apart from `rememberSandboxes`, which deliberately grows
// the sticky `knownSandboxes` map (#22). Lifted out of App unchanged; App passes its refs' current
// values, read at the same point in the render as before.
export function fleetRows({
  store,
  rosterState,
  projects,
  pullRequests,
  offlineProjects,
  hasOpencode,
  knownSandboxes,
  seededProjectKeys,
  knownWorktrees,
  projectsListed,
}: {
  store: SessionStore
  rosterState: Roster
  projects: Project[]
  pullRequests: { byBranch: Map<string, PullRequest[]>; branches: Map<string, string> }
  offlineProjects: Set<string>
  hasOpencode: boolean
  knownSandboxes: Map<string, string>
  seededProjectKeys: Set<string>
  knownWorktrees: Set<string>
  projectsListed: boolean
}) {
  const isMember = (worktree: string, id: string) => hasSession(rosterState, worktree, id)

  // Worktree isolation: every dispatched session lives in its own git worktree, which opencode
  // publishes as a project of its own AND lists in its repository's `sandboxes`. Rows are grouped by
  // the repository throughout — a worktree is machinery for running the session safely, not a place
  // the user chose, and agent view likewise groups by directory while isolating underneath.
  // Sticky, not rebuilt from scratch: a worktree deleted server-side drops out of its repository's
  // `sandboxes` while its stale project record lives on (mergeProjects never drops — that is what
  // keeps an OFFLINE project's rows), and a fresh-only map would promote that record to a repo (#22).
  const parents = rememberSandboxes(knownSandboxes, projects, rosterState.sessions)
  const repoOf = (projectKey: string) => displayProject(parents, projectKey)

  // Groups come from the projects list (not the store) so a freshly-discovered,
  // zero-session project is still visible in browse.
  // Every view derives from this map, so decorating here is the one place a session learns about its
  // pull requests — the roster row, the state groups, peek and the `#N` filter all read
  // `session.prs` and none of them knows `gh` exists. `prs` is always an array so no consumer needs
  // a guard.
  const prsFor = (projectKey: string): PullRequest[] => {
    const branch = pullRequests.branches.get(projectKey)
    // Same composite key refreshPullRequests wrote: the repository that owns this directory plus
    // the branch it is on, so a matching branch name in another repository can never answer.
    return (branch && pullRequests.byBranch.get(`${repoOf(projectKey)} ${branch}`)) || []
  }
  const memberOf = (projectKey: string, id: string) => rosterState.sessions.find((m) => m.worktree === projectKey && m.id === id)
  const byProjectSessions = new Map<string, RosterSession[]>(
    store.byProject().map((g): [string, RosterSession[]] => [
      g.projectKey,
      g.sessions.map((s) => {
        const m = memberOf(s.projectKey, s.id)
        // `backend` is only ever set for a row that isn't opencode's — absent is the default, so an
        // opencode-only roster carries no new field and nothing downstream changes shape.
        // `rank` is a roster-member field off the JSON file, so it is narrowed like every other one.
        return { ...s, prs: prsFor(s.projectKey), pinned: Boolean(m?.pinned), rank: asNumber(m?.rank), ...(s.origin ? { backend: s.origin } : {}) }
      }),
    ]),
  )
  // The same sessions, gathered under the repository that owns them rather than the worktree they
  // physically run in. Every group view reads this; only dispatch and the API calls use the real
  // per-session projectKey, which never changes.
  const byRepoSessions = new Map<string, RosterSession[]>()
  for (const [projectKey, list] of byProjectSessions) {
    const repo = repoOf(projectKey)
    byRepoSessions.set(repo, [...(byRepoSessions.get(repo) ?? []), ...list])
  }
  for (const list of byRepoSessions.values())
    list.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  // Every roster member's session — the whole fleet, before any filter, fold or view switch narrows
  // it to what is on screen. The notification snapshot and the two counts below read this and never
  // the rendered rows: a row leaving and re-entering the view is not a state change, but read off
  // the rendered set it looks exactly like one. Typing `s:working` in the dispatch input and pressing
  // esc used to re-fire `agent_needs_input` for every already-blocked session — bell and the user's
  // FLEETVIEW_NOTIFY_CMD — and `^b` did the same. It also kept the header honest: the counts used to
  // fall to zero under a filter while the roster beside them still listed the sessions.
  const allMembers = [...byProjectSessions.values()].flat().filter((s) => isMember(s.projectKey, s.id))
  // #34: a roster member whose session is gone server-side used to render no row at all — the state
  // groups partition `allMembers`, which by construction only holds members whose sessions are in
  // the store — so it was invisible, ↑/↓ could never land on it, ^x could never remove it, and it
  // sat in roster.json forever. These synthesize a row out of the stored member so the membership
  // has a visible exit; `ghost: true` marks it as having nothing behind it, which is what keeps
  // attach, peek and delete off the network.
  //
  // The qualification is deliberately strict, because F1's offline protection is load-bearing: a
  // member is only gone for good if its worktree HAS been listed successfully this run
  // (seededProjectKeys) and its project is not currently flagged offline. A project that never
  // seeded, or whose stream is down, is merely unreachable — its members must survive untouched,
  // or a dropped connection would start eating the roster.
  //
  // #43: that strictness left a residual gap. A per-session worktree that has been DELETED is in no
  // project record at all after a restart, so seedAndStream is never called for it, so it is never
  // seeded — and its members qualified under neither arm. They rendered nothing in any view, could
  // not be selected, could not be removed, and survived every restart. So qualify the complementary
  // case too: a member whose worktree appears in no project record after a successful listProjects
  // round is exactly as gone as one whose seeded listing lacks the session. `projects` is the merged
  // list and mergeProjects never drops, so a directory listed once this run stays listed — absence
  // here means absence for the whole run, not one flaky poll.
  //
  // `knownWorktrees` closes the just-dispatched window: a worktree minted by `createWorktree` is
  // handed to seedAndStream (streamProjectRef) BEFORE createSession, so it is in this set before the
  // membership it is about to gain exists — a session dispatched seconds ago can never satisfy this
  // arm, however far off the next projects poll is. An externally-added member (#44) is unioned in
  // *before* that tick's listProjects, so the listing that judges it always ran after it was known.
  const projectDirs = new Set(projects.map((p) => p.worktree))
  const vanishedProject = (worktree: string) =>
    projectsListed && !projectDirs.has(worktree) && !knownWorktrees.has(worktree)
  const ghostMembers = rosterState.sessions
    // Without opencode its members are unreachable, not gone: ghosting them would invite a ^x that
    // drops a membership the next run with opencode still wants.
    .filter((m) => hasOpencode || (typeof m.backend === 'string' && m.backend !== DEFAULT_BACKEND))
    .filter((m) => !offlineProjects.has(m.worktree) && (seededProjectKeys.has(m.worktree) || vanishedProject(m.worktree)))
    .filter((m) => !(byProjectSessions.get(m.worktree) ?? []).some((s) => s.id === m.id))
    .map((m): RosterSession => ({
      id: m.id,
      projectKey: m.worktree,
      ghost: true,
      status: 'gone',
      // The member's stored fields are all that is left of it. The dispatch prompt is the closest
      // thing to a title (it is what the session was for), the worktree says which project it
      // belonged to, and `addedAt` is the only timestamp there has ever been.
      title: (typeof m.prompt === 'string' && m.prompt) || m.id,
      snippet: basename(m.worktree) || m.worktree,
      updatedAt: typeof m.addedAt === 'number' ? m.addedAt : 0,
      prs: [],
    }))
  // "Rows carry a backend tag when more than one is active" — counted over the sessions that exist,
  // not over the backends fleetview could drive, so launching with `--backend claude` in a directory
  // that has no claude sessions yet still renders the opencode-only view unchanged.
  const showBackendTag =
    new Set([...byProjectSessions.values()].flat().map((s) => s.backend ?? DEFAULT_BACKEND)).size > 1
  // Worktrees are never rows of their own in a project listing — their sessions are already shown
  // under the repository, and a second group named after a hashed cache path helps nobody.
  // opencode's synthetic `global` project (worktree `/`) is filtered out with them: it is nobody's
  // repository, renders as a bare `/` group, and as a dispatch target would run a session in `/` (#25).
  const repoProjects = projects.filter((p) => !isSandbox(parents, p.worktree) && !isRootProject(p))

  return { isMember, parents, repoOf, prsFor, byProjectSessions, byRepoSessions, allMembers, ghostMembers, showBackendTag, repoProjects }
}
