import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { basename } from 'node:path'
import { existsSync } from 'node:fs'
import { Box, Text, useInput, useApp, useStdout, useWindowSize } from 'ink'
import { createStore, FINISHED_STATUSES } from './session-store.ts'
import { EMPTY, atEnd, type TextCursor } from './text-cursor.ts'
import { connectEvents } from './backends/opencode/event-mux.ts'
import { createOpencodeBackend } from './backends/opencode/index.ts'
import { DEFAULT_BACKEND, NO_AGENT_CLI, resolveBackend } from './backends/index.ts'
import { OPENCODE_MISSING } from './backends/opencode/server-manager.ts'
import { hasSession, withMember, withoutMember, type Roster as RosterType } from './roster-store.ts'
import { Roster, flattenGroups, navigableRows } from './ui/roster.ts'
import { DispatchInput, inputRows, INPUT_BOX_ROWS } from './ui/dispatch-input.ts'
import { Header, headerRows } from './ui/header.ts'
import { useTerminalSignals } from './use-terminal-signals.ts'
import { Help, helpLines, helpPage } from './ui/help.ts'
import { Peek } from './ui/peek.ts'
import { RenameInput } from './ui/rename-input.ts'
import { usePeek } from './use-peek.ts'
import { useDiscovery } from './use-discovery.ts'
import { useDispatch } from './use-dispatch.ts'
import { useRosterKeys, RESUME_QUIET_MS } from './use-roster-keys.ts'
import { useSlashCommands } from './use-slash-commands.ts'
import { useShellJobExpiry } from './use-shell-job-expiry.ts'
import { useMouse } from './use-mouse.ts'
import { STATE_GROUPS, isProtectedFromFold, foldCompleted } from './state-groups.ts'
import { useStopDelete, type StopArm } from './use-stop-delete.ts'
import { pickTarget, repoChoices, defaultProjectFromEnv } from './dispatch-target.ts'
import { parseInput, suggestFor, applyFilter } from './dispatch-parse.ts'
import { rememberSandboxes, isRootProject, displayProject, isSandbox, worktreeSafety, mergeBackCommand } from './worktree.ts'
import { fetchPullRequests, branchOf } from './pull-requests.ts'
import { theme } from './ui/theme.ts'
import { asNumber, asString, isRecord, isThenable } from './types.ts'
import type { AppAction, AttachSibling, AttachTarget, Backend, BackendCapabilities, ModelPair, Project, PullRequest, SeedChain, ServerRef, StreamProject } from './types.ts'
import type { SeenMap } from './seen-store.ts'
import type { SessionStore } from './session-store.ts'
import type { RosterClient, AgentInfo, CommandInfo, ProviderInfo } from './backends/opencode/client.ts'
import type { RosterSession } from './ui/view-types.ts'

type RosterState = RosterType

const VISIBLE_PER_PROJECT = 10

// opencode's own machinery, not things a user dispatches: `title` names sessions, `summary` and
// `compaction` handle context. Offering them as @targets would just be noise.
const INTERNAL_AGENTS = new Set(['compaction', 'summary', 'title'])

// The host wiring, plus the impls the test corpus injects in place of the real thing. `onAction`
// returns `unknown` because what a host hands back depends on the action (a promise for `enter` and
// `edit`, nothing for the rest) — the two call sites narrow it rather than the type guessing.
type AppProps = {
  server: ServerRef
  client: RosterClient
  connectEventsImpl?: typeof connectEvents
  ensureServerImpl?: (server: ServerRef) => Promise<{ ok: boolean; server: ServerRef; reason?: string }>
  serverReady?: boolean
  serverFailReason?: string
  onAction: (action: AppAction) => unknown
  seen?: SeenMap
  persistSeen?: (snapshot: SeenMap, liveProjectKeys: string[]) => void
  roster?: RosterState
  // `reload` is optional so any caller can pass a bare callback; only makePersistRoster's carries
  // it, and without it the #44 external-member sync is simply off.
  persistRoster?: ((roster: RosterState) => void) & { reload?: () => RosterState | null }
  initialModel?: ModelPair | null
  initialAgent?: string | null
  backends?: Record<string, Backend>
  initialBackend?: string
  isolate?: boolean
  projectPollMs?: number
  stopArmMs?: number
  resumeQuietMs?: number
  fetchPullRequestsImpl?: (dir: string) => Promise<{ prs: PullRequest[]; reason: string | null }>
  branchOfImpl?: (dir: string) => string | null
  cwd?: string
  defaultProject?: string
  worktreeSafetyImpl?: (dir: string, parentDir: string | null | undefined) => { removable: boolean; reason?: string | null }
  dirExistsImpl?: (dir: string) => boolean
}
export function App({
  server,
  client,
  connectEventsImpl = connectEvents,
  ensureServerImpl,
  serverReady = true,
  serverFailReason,
  onAction,
  seen,
  persistSeen,
  roster = { groupBy: 'state', sessions: [], collapsed: [] },
  persistRoster,
  // --model / --agent from the launch command. initialModel seeds the dispatch model (so the header
  // shows it, not "default model"); initialAgent is the default subagent for an unprefixed dispatch.
  initialModel = null,
  initialAgent = null,
  // The agent CLIs this roster can drive, and which one an unprefixed dispatch goes to. The default
  // is opencode alone rather than the full registry: a backend fleetview does not stream is a
  // backend that costs nothing, and a roster that started polling ~/.claude and ~/.copilot for
  // everyone would put other tools' sessions in front of a user who only asked for opencode.
  // cli.ts passes the whole registry; a non-opencode `initialBackend` (or an `@backend` dispatch) is
  // what activates one.
  backends,
  initialBackend = DEFAULT_BACKEND,
  // false (FLEETVIEW_NO_ISOLATE=1) dispatches into the checkout instead of a per-session worktree.
  isolate = true,
  projectPollMs = 30000,
  // The two-press ^x window (stop, then delete). A prop so a test can let it lapse without racing
  // real time (M4).
  stopArmMs = 2000,
  // The post-resume quiet window, a prop for the same reason: a test can widen it instead of racing 50ms of real time.
  resumeQuietMs = RESUME_QUIET_MS,
  fetchPullRequestsImpl = fetchPullRequests,
  branchOfImpl = branchOf,
  cwd = process.cwd(),
  // #119: FLEETVIEW_DEFAULT_PROJECT, read here rather than deep in pickTarget so the environment is
  // touched once per mount and a test can pin a target without setting a variable on the process.
  defaultProject = defaultProjectFromEnv(),
  // Injected so the branch that decides whether deleting a session destroys committed work can be
  // tested without building a git repository per case. Defaults to the real thing.
  worktreeSafetyImpl = worktreeSafety,
  // Injected for the same reason: dispatch refuses a target directory that is gone (#22), and the
  // test corpus dispatches into paths that never existed on disk.
  dirExistsImpl = existsSync,
}: AppProps): React.ReactElement | null {
  const { exit } = useApp()
  const { stdout } = useStdout()
  // Terminal size has to come from the hook, not from `stdout.columns`/`stdout.rows` read during
  // render. Ink's own resize handler re-lays-out the last React output it has — it never re-invokes
  // the components — so a width read at render time stays at the old value and the frame keeps the
  // layout it had before the resize until some unrelated state change re-renders App. `useWindowSize`
  // subscribes to the stdout resize event (gated-stdout forwards the real terminal's) and re-renders
  // with the new size, which is the repaint that was missing.
  const { columns: termColumns, rows: termRows } = useWindowSize()
  const store = useMemo(() => createStore(), [])
  const [, force] = useState(0)
  // A caller that passes no registry gets the opencode adapter built off the client it already
  // handed over — so App behaves for every existing caller exactly as it did before backends were
  // selectable, with one backend and nothing to tag.
  const backendRegistry = useMemo(
    () => backends ?? { opencode: createOpencodeBackend({ server, client }) },
    [backends, server, client],
  )
  // M7: a registry without opencode means the CLI is not installed (cli.ts builds it that way), so
  // the roster runs on claude/copilot alone and every opencode-only surface says so instead of
  // calling a server that does not exist.
  const hasOpencode = Boolean(backendRegistry[DEFAULT_BACKEND])
  const needsOpencode = (what: string) => flash(`${what} needs opencode, which is not installed`, 4000)
  // Which backend a session belongs to, read from the one durable copy: the `origin` the store
  // keeps per record (M10). A parallel `${directory}:${id}` → name map used to live here and had
  // to be manually kept in step with store.noteOrigin — a desync (the map satisfied its dedup
  // guard, the store never learned) already happened once. Absent means opencode, which is what
  // makes an opencode-only roster carry no extra state at all.
  const backendNameOf = (row: AttachTarget) => store.get(row.projectKey, row.id)?.origin ?? DEFAULT_BACKEND
  // The adapter a row's keys and actions go through — opencode's included (H2). Its adapter verbs
  // are byte-for-byte the client calls the roster always made (backends/opencode/index.ts is a
  // mapping onto OpencodeClient and nothing more), so routing opencode rows through it changes no
  // call shape. Falls back to the default adapter when a row's backend can't be resolved: a missing
  // adapter must not make a row inert or silently hide keys that have always worked.
  const backendFor = (row: AttachTarget) => resolveBackend(backendRegistry, backendNameOf(row))
  const capabilitiesOf = (row: AttachTarget): BackendCapabilities => backendFor(row).capabilities
  // Selection is a session identity, not a row number: stopping a session moves it from `working`
  // to `completed` mid-keystroke, and an index would silently retarget the second Ctrl+X at
  // whatever slid into that slot. The index is derived from this on every render.
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  // ...but the key alone is not that identity: row keys are namespaced by the group they render in
  // (`state:running:<id>`), so the key of a session changes when the session changes state group.
  // This remembers which session the current selection means, so it can be re-resolved to whatever
  // key that session has now (#18).
  const selectedSessionRef = useRef<{ projectKey: string; id: string } | null>(null)
  const [view, setView] = useState('main') // main | browse
  const [rosterState, setRosterState] = useState<RosterState>(roster)
  const [mode, setMode] = useState('roster') // roster | rename | peek | help
  // The dispatch input is always mounted in roster mode and owns every printable key. Enter,
  // space and `?` are disambiguated by whether it holds text, exactly as agent view does:
  // "Attach to the selected session, or dispatch if there's text in the input."
  // The dispatch prompt: text plus caret (#134). `input` is the string the rest of the app reads;
  // setInput keeps its old string contract (replace, or map the string) and parks the caret at the
  // end, so every caller that replaces the prompt whole (clear, tab-complete, $EDITOR) stays as
  // it was. Only the key handler edits at the caret, through setEdit.
  const [edit, setEdit] = useState<TextCursor>(EMPTY)
  const input = edit.text
  const setInput = useCallback(
    (value: string | ((current: string) => string)) =>
      setEdit((s) => atEnd(typeof value === 'function' ? value(s.text) : value)),
    [],
  )
  const [notice, setNotice] = useState<string | null>(null) // transient one-liner above the input (stop-arm, dispatch failure)
  // Ctrl+X is a two-stage destructive action ("Stop the session; press again within two seconds to
  // delete it"), so the arm has to survive re-renders without triggering them — a ref, not state.
  // `held` is where the row sat when it was armed (section key + sort time), so the stop the first
  // press performs doesn't reshuffle the row out from under the second one — see stateGroups.
  const stopArm = useRef<StopArm | null>(null) // the row/group a first ^x armed, and when — a second ^x within 2s of `at` deletes
  // "Pasted text over 800 characters or more than two lines collapses to a [Pasted text #N]
  // placeholder." A wall of pasted text otherwise fills the prompt and pushes the roster off
  // screen; the placeholder keeps the input readable and the real text is restored on dispatch.
  const pastes = useRef<string[]>([])
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The row a dialog was opened on, captured at that moment; store churn must not retarget it.
  const [target, setTarget] = useState<RosterSession | null>(null)
  // True while a child PTY owns the terminal. Every input hook goes inactive so Ink releases
  // stdin, and the render collapses to nothing so a background status change can't repaint over
  // the attached session.
  const [attached, setAttached] = useState(false)
  const attachedRef = useRef(false) // read by closures of arbitrary age; see `attach`
  // When the last attachment handed the terminal back. An arrow key still in flight across that
  // handoff reaches Ink fragmented, and a fragmented arrow is a bare Escape — which on an empty
  // input is the quit key, so a detach with a key held could exit fleetview outright (#19).
  const resumedAt = useRef(0)
  // The session the user just backgrounded (detach chord, or the clean opencode-attach exit the
  // app_exit:left keybind produces). While set, the roster shows "Your conversation moved to the
  // background" above the list, and an Esc in that window undoes the switch by re-attaching —
  // agent view's "Press Esc to undo the switch and return to the conversation". Any other
  // interaction clears it whole: the undo is immediate-after-detach only, so Esc stays the quit
  // key the rest of the time and there is no stale ref to attach weeks later.
  const [backgrounded, setBackgrounded] = useState<{ id: string; projectKey: string; notice: boolean } | null>(null)
  // #126: the session the user was last inside, kept for the life of the process — the roster bolds
  // its row so the eye lands where you left off after a detach. Deliberately separate from
  // `backgrounded` above: that is the immediate-after-detach undo window, cleared by any
  // interaction, and its semantics must stay untouched. A ref, not state: it only ever changes
  // during an attach/detach cycle, which re-renders via `attached` anyway. Not persisted across
  // restarts — a stale bold weeks later is worse than none.
  const lastAttached = useRef<{ id: string; projectKey: string } | null>(null)
  // A selection request by identity, resolved against the live rows by the effect below.
  const [pendingSelect, setPendingSelect] = useState<{ id: string; projectKey: string } | null>(null)
  const [helpPageIndex, setHelpPageIndex] = useState(0)
  const [offlineProjects, setOfflineProjects] = useState<Set<string>>(new Set())
  const [serverDown, setServerDown] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])
  // Pull requests, keyed the way they are looked up: branch to pull requests, plus the branch each
  // project directory is on. `reasons` maps repository directory to why THAT repository has no
  // data, shown in peek rather than as a notice — scoped per repo so one repo's failure (e.g. no
  // GitHub remote) never gets attributed to an unrelated repo that simply has no PRs.
  const [pullRequests, setPullRequests] = useState<{ byBranch: Map<string, PullRequest[]>; branches: Map<string, string>; reasons: Map<string, string> }>({ byBranch: new Map(), branches: new Map(), reasons: new Map() })
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [commands, setCommands] = useState<CommandInfo[]>([])
  // null = whatever the server would pick. `/model <name>` overrides it for this run only, which
  // is exactly agent view's rule: "This override lasts for the rest of the current run and doesn't
  // write to your settings file."
  const [dispatchModel, setDispatchModel] = useState<ModelPair | null>(initialModel)
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const rerender = useCallback(() => force((n) => n + 1), [])
  const seededProjectKeys = useRef(new Set<string>()) // worktrees that successfully listSessions'd this process lifetime
  const knownWorktrees = useRef(new Set<string>()) // worktrees already handed to seedAndStream (new-vs-repeat gate for repoll)
  // #43: set once a `client.listProjects()` round has completed successfully. It is the evidence
  // the second ghost arm below needs — an unreachable server never completes one, so F1's offline
  // protection survives untouched.
  const projectsListed = useRef(false)
  const knownSandboxes = useRef(new Map<string, string>()) // every worktree ever listed in a project's `sandboxes` -> its repo (#22)
  // onEvent below is captured once by the mount-only discovery effect, so it can't read fresh
  // rosterState from a render closure — this ref is the escape hatch (F1).
  const reconcileRef = useRef<SeedChain | null>(null) // set by the discovery effect; serializes seeds per worktree
  // Also set by the discovery effect. A worktree created during a dispatch is a brand-new project
  // that nothing is streaming yet, and waiting for the next poll would leave the row static for up
  // to the poll interval right when the user is watching it start.
  const streamProjectRef = useRef<StreamProject | null>(null)
  // Also set by the discovery effect: starts streaming a backend that wasn't active at launch, which
  // is what an `@backend` dispatch needs before its new row can update.
  const activateBackendRef = useRef<((name: string) => Promise<void>) | null>(null)
  const rosterRef = useRef(rosterState)
  useEffect(() => { rosterRef.current = rosterState }, [rosterState])

  useEffect(() => {
    if (!serverReady || !hasOpencode) return
    let cancelled = false
    Promise.resolve(client.listAgents?.() ?? [])
      .then((list) => !cancelled && setAgents((list ?? []).filter((a) => !INTERNAL_AGENTS.has(a.name))))
      .catch(() => {})
    Promise.resolve(client.listCommands?.() ?? [])
      .then((list) => !cancelled && setCommands(list ?? []))
      .catch(() => {})
    // Used to check /model against reality. Without it a typo sets a model that fails on every
    // later dispatch, reported as an offline project — a thoroughly misleading error.
    Promise.resolve(client.providers?.() ?? null)
      .then((r) => !cancelled && setProviders(r?.providers ?? []))
      .catch(() => {})
    return () => { cancelled = true }
  }, [client, serverReady, hasOpencode])

  useEffect(() => {
    const unsub = store.subscribe(rerender)
    return () => { unsub() }
  }, [store, rerender])
  // The store notifies on every streamed message part, and persisting is a synchronous
  // writeFileSync + renameSync over the whole file. Writing on each notify meant hundreds of
  // full-file rewrites per second during one streaming reply, with every other project's event
  // stream stalled behind them. Coalesce to at most one write per second, and flush on the way out
  // so nothing in the last second is lost.
  useEffect(() => {
    if (!persistSeen) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const flush = () => {
      timer = null
      persistSeen(store.snapshot(), [...seededProjectKeys.current])
    }
    const unsubscribe = store.subscribe(() => {
      if (timer) return
      timer = setTimeout(flush, 1000)
    })
    return () => {
      unsubscribe()
      if (timer) {
        clearTimeout(timer)
        flush()
      }
    }
  }, [store, persistSeen])

  const isMember = (worktree: string, id: string) => hasSession(rosterState, worktree, id)

  // Worktree isolation: every dispatched session lives in its own git worktree, which opencode
  // publishes as a project of its own AND lists in its repository's `sandboxes`. Rows are grouped by
  // the repository throughout — a worktree is machinery for running the session safely, not a place
  // the user chose, and agent view likewise groups by directory while isolating underneath.
  // Sticky, not rebuilt from scratch: a worktree deleted server-side drops out of its repository's
  // `sandboxes` while its stale project record lives on (mergeProjects never drops — that is what
  // keeps an OFFLINE project's rows), and a fresh-only map would promote that record to a repo (#22).
  const parents = rememberSandboxes(knownSandboxes.current, projects, rosterState.sessions)
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
    projectsListed.current && !projectDirs.has(worktree) && !knownWorktrees.current.has(worktree)
  const ghostMembers = rosterState.sessions
    // Without opencode its members are unreachable, not gone: ghosting them would invite a ^x that
    // drops a membership the next run with opencode still wants.
    .filter((m) => hasOpencode || (typeof m.backend === 'string' && m.backend !== DEFAULT_BACKEND))
    .filter((m) => !offlineProjects.has(m.worktree) && (seededProjectKeys.current.has(m.worktree) || vanishedProject(m.worktree)))
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

  const browseGroupsWith = (cap: number) =>
    repoProjects.map((p) => {
      // Filters apply here too. The footer switched to "filtering" in browse while the list stayed
      // exactly as it was, which states something the view is not doing.
      const sessions = applyFilter(byRepoSessions.get(p.worktree) ?? [], activeFilter, agentOf, promptOf)
      return {
        projectKey: p.worktree,
        repoName: basename(p.worktree) || p.worktree,
        hidden: Math.max(0, sessions.length - cap),
        sessions: sessions.slice(0, cap),
      }
    })
  const browseGroups = () => browseGroupsWith(VISIBLE_PER_PROJECT)

  const projectKeys = repoProjects.map((p) => p.worktree).join('\n')
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the joined worktrees, not the array identity
  // repoProjects, not projects: completing `@` to a worktree would dispatch into another session's
  // isolated copy, which is the one thing isolation exists to prevent.
  const repos = useMemo<{ name: string; worktree: string }[]>(
    () => repoChoices({ cwd, projects: repoProjects, dirExists: dirExistsImpl }),
    [cwd, projectKeys], // eslint-disable-line react-hooks/exhaustive-deps -- dirExistsImpl is a stable dep
  )
  const vocab = {
    agents: agents.map((a) => a.name),
    repos: repos.map((r) => r.name),
    commands: commands.map((c) => c.name),
    // Every backend fleetview holds an adapter for, not just the active ones: `@claude` is how a
    // backend BECOMES active, so gating the token on activity would make it unreachable.
    // opencode stays a token when it is not installed, so `@opencode …` flashes why instead of
    // sending the literal text to whatever the default backend is (M7).
    backends: hasOpencode ? Object.keys(backendRegistry) : [DEFAULT_BACKEND, ...Object.keys(backendRegistry)],
  }
  const parsed = parseInput(input, vocab)
  const suggestions = suggestFor(input, vocab)
  // "Type in the dispatch input to filter instead of dispatching" — the list narrows as you type,
  // and Enter has nothing to dispatch.
  const activeFilter = parsed.kind === 'filter' ? parsed.filter : null
  const agentOf = (s: RosterSession) => s.agent
  const promptOf = (s: RosterSession): string | undefined =>
    asString(rosterState.sessions.find((m) => m.worktree === s.projectKey && m.id === s.id)?.prompt)

  // Shell jobs reap themselves ~5 minutes after finishing — see use-shell-job-expiry.ts.
  // updateRoster is wrapped because it is declared further down this render.
  useShellJobExpiry({ rosterState, byProjectSessions, client, store, projectPollMs, updateRoster: (u) => updateRoster(u) })

  const stateGroups = () => {
    // #34: ghosts join here rather than in `allMembers`, which is deliberately "every member's
    // session" — the header counts, the notification snapshot and the tab title all read that and
    // must keep describing sessions that exist. This is the one view that has to show a membership
    // with nothing behind it, because it is the only one ^x can reach.
    const members = applyFilter([...allMembers, ...ghostMembers], activeFilter, agentOf, promptOf)
    // All groups are always returned, empty or not — the roster renders a "no items" placeholder
    // for an empty one, so the view keeps its shape. Assignment is first-match-wins so the groups
    // stay a partition and ↑/↓ never visits a session twice: a waiting session with an open pull
    // request is ready for review, because agent view puts that group higher.
    // #15: the first ^x stops the session, and a stopped session belongs in `completed` — but
    // moving it there while the confirming second press is still pending makes the user chase the
    // row down the board. While the arm is live the row keeps the section and sort position it had
    // when armed; by the time the arm lapses the row is either deleted or no longer armed.
    const held = stopArm.current?.held && Date.now() - stopArm.current.at < stopArmMs ? stopArm.current : null
    const isHeld = (s: RosterSession) => held?.key === `${s.projectKey}:${s.id}`
    const groupFor = (s: RosterSession) => (isHeld(s) ? held!.held!.group : STATE_GROUPS.find((g) => g.match(s))?.key)
    const sortTime = (s: RosterSession) => (isHeld(s) ? held!.held!.updatedAt : s.updatedAt ?? 0)
    return STATE_GROUPS.map((g) => ({
      projectKey: `state:${g.key}`,
      repoName: g.label,
      empty: g.key !== 'pinned', // status groups keep their placeholder shape; pinned only exists with members
      hint: g.hint, // shown under the section when it is empty

      sessions: members
        .filter((s) => groupFor(s) === g.key)
        // A manual rank (Shift+↑/↓) wins outright — the user placed the row there. Unranked rows
        // keep the old order: fold-protected rows first inside `completed` (the fold cuts from the
        // end, and a failure or a live pull request must survive it), then recency.
        .sort(
          (a, b) =>
            (a.rank ?? Infinity) - (b.rank ?? Infinity) ||
            (isProtectedFromFold(a) ? -1 : 0) - (isProtectedFromFold(b) ? -1 : 0) ||
            sortTime(b) - sortTime(a),
        ),
    })).filter((g) => g.sessions.length > 0 || g.empty)
  }

  const projectMemberGroups = () =>
    repoProjects
      .map((p) => ({
        projectKey: p.worktree,
        repoName: basename(p.worktree) || p.worktree,
        sessions: applyFilter(
          (byRepoSessions.get(p.worktree) ?? []).filter((s) => isMember(s.projectKey, s.id)),
          activeFilter,
          agentOf,
          promptOf,
        ),
      }))
      .filter((g) => g.sessions.length > 0)

  // Reserve what is actually drawn, not a guess. The old fixed -4 assumed one row each for header,
  // notice, input and hints — but the hints line wrapped to two at 80 columns, the notice was
  // therefore unreserved, and the suggestion list (up to 8 rows, opened by Tab) was never counted
  // at all. Every one of those made the frame taller than the terminal, which scrolls the top of
  // the roster out of the region Ink can repaint.
  //
  // Each of those components now truncates to one row per line, so counting lines is sound.
  const columns = termColumns
  // One name for "the moved-to-the-background line is on screen": chromeRows, the mouse y→row
  // mapping and the render condition must never disagree about this row, or clicks land one line
  // off (that bug shipped once).
  const backgroundedNoticeRows = backgrounded?.notice && mode !== 'peek' ? 1 : 0
  const chromeRows =
    headerRows(columns) +
    (notice ? 1 : 0) +
    backgroundedNoticeRows +
    (suggestions?.matches.length ?? 0) +
    // `^j` makes the prompt multi-line, so this is however many rows it draws — counted by the
    // component that draws them, not guessed at.
    inputRows(input) +
    // The dispatch box's border rows — drawn in every mode except peek, which swaps the box for a
    // one-row hint.
    (mode === 'peek' ? 0 : INPUT_BOX_ROWS) +
    1 + // hints
    (serverDown ? 1 : 0)
  const maxRows = Math.max(1, termRows - chromeRows)
  const groups =
    view === 'browse'
      ? browseGroups()
      : rosterState.groupBy === 'project'
        ? projectMemberGroups()
        : // #49: the fold must know what is selected, or it drops that row and the next key acts
          // on whatever the fallback below lands on — a running session the user never picked.
          foldCompleted(stateGroups(), maxRows, selectedSessionRef.current, new Set(rosterState.collapsed ?? []))
  // The same groups without the fold/slice that fit them to the screen. deleteGroup ("^x on a header
  // deletes every session in the group") must act on all of them, not just the rows currently drawn:
  // the state view folds `completed` to `… N more` and browse caps each project at
  // VISIBLE_PER_PROJECT, so reading the rendered `groups` deleted only the on-screen subset. The
  // active filter is kept — deleting exactly what a filter shows is intended.
  const unfoldedGroups =
    view === 'browse'
      ? browseGroupsWith(Infinity)
      : rosterState.groupBy === 'project'
        ? projectMemberGroups()
        : stateGroups()
  const collapsed = new Set(rosterState.collapsed ?? [])
  const flat = flattenGroups(groups)
  // What ↑/↓ actually walks: group headers and sessions together, in screen order. Built from the
  // same helper the roster draws with, so navigation can never point at a row that isn't there.
  const navRows = navigableRows(groups, collapsed)
  const keyOf = (row: RosterSession) => `${row.projectKey}:${row.id}`
  const keyedIndex = navRows.findIndex((r) => r.key === selectedKey)
  // The key went stale — either the selected session moved groups (its key is namespaced by the
  // group, so stopping a running session renames its row out from under the selection) or the row
  // is really gone. Re-resolve by identity first: without this the selection silently jumps to the
  // first session in the list, and a second Ctrl+X lands on an unrelated running session (#18).
  const navIndex =
    keyedIndex >= 0
      ? keyedIndex
      : navRows.findIndex(
          (r) =>
            r.type === 'session' &&
            r.session.id === selectedSessionRef.current?.id &&
            r.session.projectKey === selectedSessionRef.current?.projectKey,
        )
  // Falls back to the first session rather than the first header: landing on a header at startup
  // would make Enter collapse a group when the user expected it to attach.
  const navSel = navIndex >= 0 ? navIndex : Math.max(0, navRows.findIndex((r) => r.type === 'session'))
  const navRow = navRows[navSel]
  // Remember what the selection currently *means*, including the implicit startup selection nobody
  // pressed a key for — that is the identity the lookup above re-resolves against on the render
  // where the key stops matching. A header selection records nothing: it is a group, not a session,
  // and must not be dragged onto a session row later.
  // #49: a blind fallback (navIndex < 0 — neither the key nor the identity was found) must NOT
  // write its guess back. Doing so destroyed the real selection permanently, so a row that came
  // back on a later render could never be recovered; keeping the old identity lets the next render
  // re-resolve it. The implicit startup selection is still recorded, because there is no identity
  // to lose then. Out of scope for #49: the collapsed-group and browse-cap paths still take this
  // fallback — only recovery is fixed there, not the drop itself.
  if (navRow && (navIndex >= 0 || !selectedSessionRef.current))
    selectedSessionRef.current = navRow.type === 'session' ? { projectKey: navRow.session.projectKey, id: navRow.session.id } : null
  // Write the re-resolved key back to state so everything keyed off `selectedKey` (peek's
  // selection-follow, the roster's highlight) stays in step with the identity resolution above.
  // Only fires when a session was actually re-found, so the plain fallback can't loop.
  const rekeyed = keyedIndex < 0 && navIndex >= 0 ? navRows[navIndex].key : null
  useEffect(() => {
    if (rekeyed) setSelectedKey(rekeyed)
  }, [rekeyed])

  // Resolve a by-identity selection request against whatever rows actually exist this render. The
  // requester (the detach handler) cannot build the key itself: keys are namespaced by the live
  // grouping (`state:*` by default, the worktree in project view).
  useEffect(() => {
    if (!pendingSelect) return
    const match = navRows.find((r) => r.type === 'session' && r.session.id === pendingSelect.id && r.session.projectKey === pendingSelect.projectKey)
    if (match) {
      setSelectedKey(match.key)
      return setPendingSelect(null)
    }
    // Not drawn. A row hidden inside a collapsed group gets its group opened, and the request
    // stays alive to resolve on the next render — "with that row already selected" (agent view)
    // means visibly selected. A session in no group at all is gone, and a visible-but-folded row
    // (the `… N more` cap) can't be landed on either way; both drop the request rather than pin
    // this effect forever.
    const holder = groups.find((g) => (g.sessions ?? []).some((x) => x.id === pendingSelect.id && x.projectKey === pendingSelect.projectKey))
    if (holder && collapsed.has(holder.projectKey)) return toggleCollapsed(holder.projectKey)
    setPendingSelect(null)
  }, [pendingSelect, navRows])
  const selectedHeader = navRow?.type === 'header' ? navRow.projectKey : null
  const found = flat.findIndex((row) => keyOf(row) === selectedKey)
  // Falls back to the top row when the selected session is gone (deleted, filtered out by a view
  // switch, or never set), which is also what makes the first ↑/↓ after startup work.
  const sel = found >= 0 ? found : 0
  const current = selectedHeader ? undefined : navRow?.type === 'session' ? navRow.session : flat[sel]
  const memberKeySet = new Set(rosterState.sessions.map((s) => `${s.worktree}:${s.id}`))
  // Keyed on rendered rows, not roster.sessions.length: a ghost-only roster (members whose
  // sessions no longer exist) must still show the hint rather than an inert blank screen (F1).
  // State grouping always draws its three-category skeleton (each with a "no items" placeholder),
  // so it is never "empty" — the single-line hint is only for project grouping and browse.
  const isMainEmpty = view === 'main' && flat.length === 0 && rosterState.groupBy !== 'state'

  // Plain (non-updater) setState so the persist call runs synchronously in program order —
  // React's setState-updater form defers execution to reconciliation, which reordered
  // persistRoster after an awaited call site (e.g. promptAsync) rather than before it.
  // Reads rosterRef.current, not the render-closure `rosterState` — a call site resuming after
  // an await (dispatch auto-add, browse-x prune, d-failure restore) otherwise mutates a stale
  // snapshot and clobbers any roster change that landed during the in-flight window (I1).
  const updateRoster = (updater: (prev: RosterState) => RosterState) => {
    const updated = updater(rosterRef.current)
    rosterRef.current = updated
    // A failed save must not throw through the Ink input handlers that call this (it would crash
    // the TUI over a disk hiccup). The in-memory update stands; persist retries on the next change.
    try {
      persistRoster?.(updated)
    } catch {
      flash("couldn't save roster — will retry on next change")
    }
    setRosterState(updated)
  }

  // Tab title and bell/notify-hook on session transitions — see use-terminal-signals.ts.
  useTerminalSignals({ stdout, serverReady, allMembers })

  // Transient one-liner above the input. Every caller replaces the previous timer rather than
  // stacking them, so a fast second notice can't be cleared early by the first one's timeout.
  const flash = useCallback((message: string, ms = 2000) => {
    setNotice(message)
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => {
      setNotice(null)
      noticeTimer.current = null
    }, ms)
  }, [])
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current) }, [])

  // Attaching no longer ends fleetview. The host runs `opencode attach` in a child PTY and hands back
  // a promise that settles on detach, so this component stays mounted — streams included — and
  // only has to stop reading the keyboard while somebody else owns the terminal.
  //
  // `siblings` is what Alt+1..9 switches between: the rows as currently ordered on screen.
  const attach = (row: AttachTarget) => {
    // Read through a ref, not the render closure. `dispatch` captures the `attach` of the render
    // where the keypress happened, and in that render `attached` is still false — so the state
    // value can never see an attachment that began while the dispatch was in flight, which is the
    // one case this guard exists for.
    if (attachedRef.current) return
    // #34: there is no session to hand the terminal over to. Say so and name the key that ends it,
    // rather than launching a CLI against an id the server has never heard of.
    if (row.ghost) return flash(`"${row.title}" is gone — ^x removes it from the roster`, 4000)
    const done = onAction({
      type: 'enter',
      sessionId: row.id,
      worktree: row.projectKey,
      // Which CLI to launch, on the action and on every sibling — Alt+1..9 can switch to a row from
      // a different backend, and re-running the previous argv there would resume nothing. Present
      // only when it isn't opencode: the host defaults to opencode for a target that names none, so
      // an opencode-only roster hands over exactly the payload it always did.
      ...(backendNameOf(row) === DEFAULT_BACKEND ? {} : { backend: backendNameOf(row) }),
      // #34: ghost rows are dropped from the sibling list — Alt+1..9 hands the host a session to
      // resume, and a session that no longer exists is not one. From navRows, not flat: flat still
      // carries rows inside collapsed groups, so Alt+N could land on a session that isn't on screen.
      siblings: navRows
        .flatMap((l) => (l.type === 'session' && !l.session.ghost ? [l.session] : []))
        .map((s): AttachSibling => ({ id: s.id, projectKey: s.projectKey, ...(asString(s.backend) ? { backend: asString(s.backend) } : {}) })),
    })
    if (isThenable(done)) {
      // Set on attach, not detach, so a hard exit of the attached PTY still leaves the marker.
      lastAttached.current = { id: row.id, projectKey: row.projectKey }
      attachedRef.current = true
      setAttached(true)
      // `result` is the host's AttachOutcome, read through the same narrowing every other payload
      // gets: the host is injectable, so what settles here is not App's to assume.
      const back = (settled?: unknown) => {
        const result = isRecord(settled) ? settled : undefined
        resumedAt.current = Date.now()
        attachedRef.current = false
        setAttached(false)
        // A detach (not an exit) leaves a conversation running in the background: remember it,
        // select its row, and show the one-line notice above the list. The host reports which
        // session was current on detach — Alt+N may have switched away from `row`.
        if (result?.detached) {
          const left = { id: asString(result.sessionId) ?? row.id, projectKey: asString(result.worktree) ?? row.projectKey, notice: true }
          // Alt+1..9 may have switched sessions while attached — the row actually left wins (#126).
          lastAttached.current = { id: left.id, projectKey: left.projectKey }
          setBackgrounded(left)
          // Selection by identity, not by a precomputed key: row keys are namespaced by whatever
          // grouping is live (`state:waiting` in the default view, the worktree in project view),
          // so a `${worktree}:${id}` template only matches one of the two. The effect below
          // resolves the id against the real rows.
          setPendingSelect({ id: left.id, projectKey: left.projectKey })
        }
        // An attach that failed without drawing anything is otherwise indistinguishable from a
        // keypress that didn't register.
        const message = asString(result?.message)
        if (message) flash(message, 4000)
      }
      done.then(back, () => back())
      return
    }
    exit() // no host (tests, or an older caller): fall back to the unmount-and-spawn behaviour
  }

  // Peek owns its own state, message fetch, reply/answer paths and key handling — see use-peek.ts.
  // Everything it needs from App is handed over explicitly; nothing reaches back the other way.
  const {
    peekTarget,
    peekMessages,
    peekReply,
    peekReplyCursor,
    peekPending,
    peekPendingQuestions,
    peekErrorMessage,
    savedReply,
    openPeek,
    flushSavedReplies,
  } = usePeek({
    client,
    store,
    // Peek answers permissions and questions and sends replies, so it needs both the row's adapter
    // (to send a reply to the right CLI) and its flags (to stop offering an answer that can't be
    // delivered). Handed over as functions of a row, because peek's target changes under ↑/↓.
    backendFor,
    capabilitiesOf,
    navRows,
    selectedKey,
    setSelectedKey,
    attach,
    mode,
    setMode,
    rerender,
    reconcileRef,
    serverReady,
    attached,
  })

  // Discovery, streaming and the project poll live in use-discovery.ts — see the header there.
  // The refs declared above (`reconcileRef`, `streamProjectRef`, `activateBackendRef`) are the
  // seam: the hook publishes its entry points through them, and the dispatch/peek paths call
  // through the refs exactly as they always did. Called after usePeek because the poll flushes
  // peek's saved-reply queue each tick.
  useDiscovery({
    serverReady,
    cwd,
    client,
    store,
    seen,
    server,
    connectEventsImpl,
    ensureServerImpl,
    onAction,
    exit,
    projectPollMs,
    initialBackend,
    backendRegistry,
    fetchPullRequestsImpl,
    branchOfImpl,
    persistRoster,
    rosterRef,
    setRosterState,
    seededProjectKeys,
    knownWorktrees,
    projectsListed,
    reconcileRef,
    streamProjectRef,
    activateBackendRef,
    flushSavedReplies,
    setOfflineProjects,
    setServerDown,
    setProjects,
    setPullRequests,
    onSessionDeleted: (directory, id) => updateRoster((prev) => withoutMember(prev, directory, id)),
    attachedRef,
  })

  // Extracted from the deleted two-stage Launcher. The prompt is the whole interaction now:
  // "Type a prompt in the input at the bottom of agent view and press Enter to start a new
  // background session."
  //
  // `shell` runs the text as a bash job in a fresh session instead of prompting a model, which is
  // agent view's `!` form: "the job appears as a row you can attach to, watch, and detach from".
  // Placeholders are a display convenience; the model must receive what was actually pasted.
  const expandPastes = (text: string) =>
    text.replace(/\[Pasted text #(\d+)\]/g, (whole: string, n: string) => pastes.current[Number(n) - 1] ?? whole)

  // Where a dispatch lands: the repository the user named, else whatever pickTarget decides. Shared
  // by both dispatch paths so an `@repo` token means the same thing on every backend.
  const dispatchTarget = (repo?: string) => {
    const named = repo && repos.find((r) => r.name === repo)?.worktree
    // The repository the user asked for. `pickTarget` sees only repoProjects, so a bare dispatch
    // can never land in someone else's worktree.
    return (
      named ??
      pickTarget({
        cwd,
        projects: repoProjects,
        current: current && { ...current, projectKey: repoOf(current.projectKey) },
        groupBy: rosterState.groupBy,
        defaultProject,
        dirExists: dirExistsImpl,
      }) ?? undefined
    )
  }

  // The dispatch pair and its shared tail live in use-dispatch.ts — see the header there. The
  // hook runs per render, so `dispatch` closes over this render's input/model/projects exactly as
  // the inline functions did.
  const { dispatch } = useDispatch({
    client,
    store,
    seen,
    backendRegistry,
    initialAgent,
    initialBackend,
    dispatchModel,
    isolate,
    projects,
    parents,
    input,
    setInput,
    flash,
    attach,
    expandPastes,
    dispatchTarget,
    addMember: (worktree, id, extra) => updateRoster((prev) => withMember(prev, worktree, id, extra)),
    seededProjectKeys,
    setOfflineProjects,
    streamProjectRef,
    activateBackendRef,
    dirExistsImpl,
    // Post-dispatch auto-select: the hook lands the selection on the row it just created (so
    // Enter attaches to it), by identity because the row may render a poll later.
    selectedSessionRef,
    setSelectedKey,
  })

  // /exit, /quit, /fork and /model live in use-slash-commands.ts.
  const runSlashCommand = useSlashCommands({
    client,
    store,
    seen,
    hasOpencode,
    needsOpencode,
    current,
    capabilitiesOf,
    backendNameOf,
    providers,
    setDispatchModel,
    setInput,
    updateRoster,
    onAction,
    exit,
    flash,
  })

  // Routes whatever is in the input. Everything except `dispatch` and `shell` either changes the
  // view or does nothing, so this is where agent view's overloaded input stops being overloaded.
  const submit = ({ thenAttach = false } = {}) => {
    if (parsed.kind === 'empty') return current ? attach(current) : undefined
    // A filter is not a thing to submit — it is already narrowing the list as you type.
    if (parsed.kind === 'filter') return
    if (parsed.kind === 'view-command') return runSlashCommand(parsed.command, parsed.args)
    if (!hasOpencode && (parsed.kind === 'shell' || parsed.backend === DEFAULT_BACKEND)) {
      return needsOpencode(parsed.kind === 'shell' ? '! shell dispatch' : '@opencode')
    }
    if (parsed.kind === 'shell') return void dispatch(parsed.command ?? '', { thenAttach, shell: true })
    // A `/command` fleetview doesn't run itself is sent as the session's first prompt, which is what
    // agent view does with skills and user commands.
    const text = parsed.kind === 'command' ? input.trim() : parsed.prompt
    return void dispatch(text ?? '', { thenAttach, agent: parsed.agent, repo: parsed.repo, backend: parsed.backend })
  }

  // "Enter on a group header collapses it." Persisted, so a group folded away stays folded.
  const toggleCollapsed = (projectKey: string) =>
    updateRoster((prev) => {
      const list = prev.collapsed ?? []
      return {
        ...prev,
        collapsed: list.includes(projectKey) ? list.filter((k) => k !== projectKey) : [...list, projectKey],
      }
    })

  // ^x — stop, then delete on a second press — lives in use-stop-delete.ts.
  const { deleteGroup, stopOrDelete } = useStopDelete({
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
  })

  // The roster's keyboard lives in use-roster-keys.ts: a pure `rosterKey` decision plus the hook
  // that performs it. Everything it reads or drives is handed over here.
  useRosterKeys({
    active: mode === 'roster' && serverReady && !attached,
    resumeQuietMs,
    mode,
    attachedRef,
    setAttached,
    resumedAt,
    backgrounded,
    setBackgrounded,
    // useMouse is called below, after this hook, so the stdin tap keeps registering after the
    // roster's useInput exactly as it did inline; the call only happens on input, post-render.
    handleMouse: (ev) => handleMouse(ev),
    input,
    setInput,
    setEdit,
    pastes,
    current,
    selectedHeader,
    navRows,
    navSel,
    unfoldedGroups,
    suggestions,
    view,
    setView,
    allMembers,
    setSelectedKey,
    updateRoster,
    capabilitiesOf,
    backendNameOf,
    setTarget,
    setMode,
    deleteGroup,
    stopOrDelete,
    toggleCollapsed,
    submit,
    attach,
    openPeek,
    onAction,
    exit,
    flash,
  })

  // Clicks, the wheel, and the Ink 8 stdin tap that delivers them — see use-mouse.ts.
  const handleMouse = useMouse({
    active: mode === 'roster' && serverReady && !attached,
    groups,
    offlineProjects,
    collapsed,
    navRows,
    navSel,
    navRow,
    maxRows,
    columns,
    backgroundedNoticeRows,
    setSelectedKey,
    toggleCollapsed,
    attach,
  })

  useInput(
    (ch, key) => {
      // Paging keys stay in help; anything else closes it, per "any key to close".
      // Clamp on the way up as well as down: letting the counter climb past the last page made ↑
      // look broken until it had been pressed as many times as ↓ had been over-pressed.
      const lastPage = helpPage(helpLines(), termRows, 0).pages - 1
      if (key.downArrow || key.pageDown || ch === ' ') return setHelpPageIndex((p) => Math.min(lastPage, p + 1))
      if (key.upArrow || key.pageUp) return setHelpPageIndex((p) => Math.max(0, p - 1))
      setHelpPageIndex(0)
      setMode('roster')
    },
    { isActive: mode === 'help' && !attached },
  )

  useInput(
    (input, key) => {
      // esc is the quit key everywhere now that bare letters belong to the dispatch input; `q`
      // stays accepted here because this screen has no input to type into.
      if (input === 'q' || key.escape) {
        onAction({ type: 'quit' })
        exit()
      }
    },
    { isActive: !serverReady && !attached },
  )

  // Nothing at all while attached: the child owns every cell of the terminal.
  if (attached) return null

  if (!serverReady) {
    // A missing opencode CLI is not something a restart fixes, so it is the headline on its own.
    // cli.ts only gets here with OPENCODE_MISSING when claude and copilot are missing too (M7).
    if (serverFailReason === OPENCODE_MISSING) {
      return React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(Text, null, NO_AGENT_CLI),
        React.createElement(Text, { dimColor: true }, '(esc to quit)'),
      )
    }
    return React.createElement(
      Box,
      { flexDirection: 'column' },
      React.createElement(Text, null, 'opencode server unreachable — restart fleetview'),
      React.createElement(Text, null, serverFailReason ?? 'server did not become healthy'),
      React.createElement(Text, { dimColor: true }, '(esc to quit)'),
    )
  }

  // Help is an overlay, so it gets the whole terminal — but bounded, because it is 30-odd rows
  // and a standard terminal is 24. `↓` pages it.
  if (mode === 'help') {
    return React.createElement(Help, { maxRows: termRows, columns, page: helpPageIndex })
  }

  if (mode === 'rename' && target) {
    return React.createElement(RenameInput, {
      initial: target.title ?? '',
      onCancel: () => {
        setMode('roster')
        setTarget(null)
      },
      onSubmit: async (title) => {
        setMode('roster')
        try {
          // Through the adapter, not raw client (H2): rename mode is capability-gated on entry, so
          // only a backend whose adapter can rename ever reaches this call.
          await backendFor(target).rename(target.id, title, target.projectKey)
          store.apply(target.projectKey, { type: 'session.updated', properties: { info: { id: target.id, title } } })
          setOfflineProjects((s) => {
            const next = new Set(s)
            next.delete(target.projectKey)
            return next
          })
        } catch (e) {
          // Only an unreachable server makes the project "(offline)"; a server that answered with
          // an HTTP refusal is plainly online, and the rename just didn't happen.
          if (!(isRecord(e) && typeof e.status === 'number')) setOfflineProjects((s) => new Set(s).add(target.projectKey))
          flash("couldn't rename")
        } finally {
          setTarget(null)
        }
      },
    })
  }

  // Full-height frame: the input is pinned to the terminal's bottom row by a flexGrow spacer
  // after the roster, not by content happening to fill the screen. chromeRows above still guards
  // the other direction — content taller than the terminal breaks Ink's repaint region.
  return React.createElement(
    Box,
    { flexDirection: 'column', height: termRows },
    // allMembers, not the rendered rows: the header describes the fleet, so a filter that hides a
    // blocked session must not make the summary contradict the roster directly under it.
    React.createElement(Header, { sessions: allMembers, model: dispatchModel, cwd, columns, note: hasOpencode ? undefined : `${initialBackend} · opencode not installed` }),
    // One line above the list right after a detach, agent-view verbatim; the just-left session's
    // row is selected underneath it. Cleared by the next keypress or click.
    // wrap:'truncate' is load-bearing: chromeRows counts this as exactly one line, and a narrow
    // terminal wrapping it to two would push the frame past the row-reservation contract.
    backgroundedNoticeRows > 0
      ? React.createElement(Text, { dimColor: true, wrap: 'truncate' }, 'Your conversation moved to the background')
      : null,
    mode === 'peek' && peekTarget
      ? React.createElement(Peek, {
          // Re-read the live row so the header follows a rename — opencode names a session ~20s
          // in, and the snapshot taken when peek opened would keep showing the original prompt.
          // The store carries no `prs` field — only the `byProjectSessions` decoration below adds
          // it to roster rows — so the peek target needs the same `prsFor` decoration applied here,
          // or target.prs would silently stay undefined and no pull request line would ever render.
          target: { ...(store.get(peekTarget.projectKey, peekTarget.id) ?? peekTarget), prs: prsFor(peekTarget.projectKey) },
          messages: peekMessages,
          pending: peekPending,
          pendingQuestions: peekPendingQuestions,
          reply: peekReply,
          replyCursor: peekReplyCursor,
          savedReply,
          error: peekErrorMessage,
          maxRows,
          columns,
          // Scoped to the peek target's own repository: `reasons` is per-repo, and a session must
          // only ever see why ITS repo has no PR data, never why some other repo failed.
          prReason: pullRequests.reasons.get(repoOf(peekTarget.projectKey)) ?? null,
          // #113.4: only for a finished session in its own worktree — a session still working has
          // commits coming, and an unisolated one has nothing to merge back from.
          mergeBack:
            isSandbox(parents, peekTarget.projectKey) && FINISHED_STATUSES.has(store.get(peekTarget.projectKey, peekTarget.id)?.status ?? '')
              ? mergeBackCommand(peekTarget.projectKey, parents.get(peekTarget.projectKey), branchOfImpl(peekTarget.projectKey))
              : null,
          // Drives the answer hints only — the banners still render, because "this session is
          // blocked on a permission" is true whether or not fleetview can answer it from here.
          canAnswer: capabilitiesOf(peekTarget).questions,
          backend: peekTarget.backend ?? backendNameOf(peekTarget),
        })
      : isMainEmpty
        ? React.createElement(Text, { dimColor: true }, 'no sessions yet — type a task below and press ⏎')
        : React.createElement(Roster, {
            groups,
            selected: sel,
            selectedKey: navRow?.key,
            collapsed,
            offlineProjects,
            maxRows,
            columns,
            // Grouped by project, the header names the directory rather than the state, so the
            // row has to say the state itself.
            showStateWord: view === 'main' && rosterState.groupBy === 'project',
            // Only once a second backend actually has sessions; an opencode-only roster renders
            // exactly the row it always did.
            showBackendTag,
            markMembers: view === 'browse' ? memberKeySet : undefined,
            // If the session no longer exists in the live rows, no row matches the key and nothing
            // renders bold — the clearing the issue asks for, with no bookkeeping.
            lastAttached: lastAttached.current ? `${lastAttached.current.projectKey}:${lastAttached.current.id}` : undefined,
          }),
    React.createElement(Box, { flexGrow: 1 }), // pushes the input to the terminal's bottom edge
    // The input stays mounted under the peek panel too: agent view's peek is an overlay on the
    // same screen, not a separate mode that hides the home row.
    mode === 'peek'
      ? React.createElement(
          Text,
          { dimColor: true },
          '↑↓ next/prev · ⏎ send, or attach when the reply is empty · → attach · ← back',
        )
      : React.createElement(DispatchInput, { value: input, cursor: edit.cursor, view, notice, kind: parsed.kind, suggestions, columns, focused: mode === 'roster' }),
    serverDown
      ? React.createElement(
          Text,
          { color: theme.danger },
          'opencode server unreachable — will keep retrying; restart fleetview if this persists',
        )
      : null,
  )
}
