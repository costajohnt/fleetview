import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { basename } from 'node:path'
import { existsSync } from 'node:fs'
import { Box, Text, useInput, useApp, useStdout, useWindowSize } from 'ink'
import { createStore, FINISHED_STATUSES } from './session-store.ts'
import { graphemes, stripEscapeResidue } from './text-utils.ts'
import { connectEvents } from './backends/opencode/event-mux.ts'
import { createOpencodeBackend, OPENCODE_CAPABILITIES } from './backends/opencode/index.ts'
import { DEFAULT_BACKEND } from './backends/index.ts'
import { hasSession, type Roster as RosterType, type RosterSession as RosterMember } from './roster-store.ts'
import { Roster, flattenGroups, navigableRows, buildLines, windowLines } from './ui/roster.ts'
import { parseMouseEvents } from './ui/mouse.ts'
import { DispatchInput, inputRows, INPUT_BOX_ROWS } from './ui/dispatch-input.ts'
import { Header, headerRows } from './ui/header.ts'
import { titleFor, setTitle, bell, newlyNotable, hookTransitions, runNotifyHook } from './ui/notify.ts'
import { Help, helpLines, helpPage } from './ui/help.ts'
import { Peek } from './ui/peek.ts'
import { usePeek } from './use-peek.ts'
import { useDiscovery } from './use-discovery.ts'
import { useDispatch } from './use-dispatch.ts'
import { pickTarget, repoChoices, defaultProjectFromEnv } from './dispatch-target.ts'
import { parseInput, suggestFor, applyFilter } from './dispatch-parse.ts'
import { rememberSandboxes, isRootProject, displayProject, isSandbox, worktreeSafety, mergeBackCommand } from './worktree.ts'
import { fetchPullRequests, branchOf, hasOpenPr } from './pull-requests.ts'
import { theme } from './ui/theme.ts'
import { asNumber, asString, isRecord } from './types.ts'
import type { AppAction, AttachSibling, AttachTarget, Backend, BackendCapabilities, ModelPair, MouseEvent as SgrMouseEvent, Project, PullRequest, SeedChain, ServerRef, StreamProject } from './types.ts'
import type { SeenMap } from './seen-store.ts'
import type { SessionStore } from './session-store.ts'
import type { RosterClient, AgentInfo, CommandInfo, ProviderInfo } from './backends/opencode/client.ts'
import type { RosterGroup, RosterSession } from './ui/view-types.ts'

type RosterState = RosterType

const VISIBLE_PER_PROJECT = 10

// opencode's own machinery, not things a user dispatches: `title` names sessions, `summary` and
// `compaction` handle context. Offering them as @targets would just be noise.
const INTERNAL_AGENTS = new Set(['compaction', 'summary', 'title'])

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
const STATE_GROUPS = [
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
const isProtectedFromFold = (s: FoldRow) => s.status === 'error' || hasOpenPr(s.prs)
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
  // `hidden` is added by the fold, so it is announced here rather than being required of a caller
  // that has never folded anything.
): Array<G & { hidden?: number }> {
  // Each group draws its header (1) plus its sessions; an empty always-shown group draws one
  // "no items" placeholder row in place of sessions. Counting those placeholders keeps the fold
  // honest now that needs-input/working are shown even when empty.
  const used =
    groups.reduce((n, g) => n + 1 + g.sessions.length + (g.sessions.length === 0 && g.empty ? 1 : 0), 0) +
    Math.max(0, groups.length - 1) // one spacer row between adjacent groups
  const completed = groups.find((g) => g.projectKey === 'state:completed')
  if (!completed || used <= maxRows) return groups
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

// Pure roster-mutation helpers mirroring roster-store.ts's addSession/removeSession semantics —
// duplicated rather than imported because those do file IO directly; App only persists via the
// `persistRoster` callback and needs the updated object back to update local render state too.
const withMember = (roster: RosterState, worktree: string, id: string, extra: Record<string, unknown> = {}): RosterState =>
  hasSession(roster, worktree, id)
    ? roster
    : { ...roster, sessions: [...roster.sessions, { worktree, id, addedAt: Date.now(), ...extra }] }

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

const withoutMember = (roster: RosterState, worktree: string, id: string): RosterState => ({
  ...roster,
  sessions: roster.sessions.filter((s) => !(s.worktree === worktree && s.id === id)),
})

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
  fetchPullRequestsImpl?: (dir: string) => Promise<{ prs: PullRequest[]; reason: string | null }>
  branchOfImpl?: (dir: string) => string | null
  cwd?: string
  defaultProject?: string
  worktreeSafetyImpl?: (dir: string, parentDir: string | null | undefined) => { removable: boolean; reason?: string | null }
  dirExistsImpl?: (dir: string) => boolean
}
// "The host answered with something it will settle later." `onAction` returns `unknown` because what
// comes back depends on the action, and this is the one question App asks of it: an attach host and
// an editor host both hand over a promise, and a caller that has neither (a test stub, an older
// embedder) hands back nothing — which is exactly the branch that falls through to unmounting.
const isThenable = (value: unknown): value is PromiseLike<unknown> => isRecord(value) && typeof value.then === 'function'

// How long after a resume a bare Escape is treated as handoff residue rather than a quit.
const RESUME_QUIET_MS = 50 // matches the pty host's stdin drain window

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
  const backendFor = (row: AttachTarget) => backendRegistry[backendNameOf(row)] ?? backendRegistry[DEFAULT_BACKEND]
  const capabilitiesOf = (row: AttachTarget): BackendCapabilities => backendFor(row)?.capabilities ?? OPENCODE_CAPABILITIES
  // The two verbs ^x drives, through the row's adapter — the only thing that knows whether stopping
  // means an HTTP abort or signalling a detached CLI's process group.
  const abortRow = (row: AttachTarget) => backendFor(row).abort(row.id, row.projectKey)
  const deleteRow = (row: AttachTarget) => backendFor(row).delete(row.id, row.projectKey)
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
  const [input, setInput] = useState('')
  const [notice, setNotice] = useState<string | null>(null) // transient one-liner above the input (stop-arm, dispatch failure)
  // Ctrl+X is a two-stage destructive action ("Stop the session; press again within two seconds to
  // delete it"), so the arm has to survive re-renders without triggering them — a ref, not state.
  // `held` is where the row sat when it was armed (section key + sort time), so the stop the first
  // press performs doesn't reshuffle the row out from under the second one — see stateGroups.
  const stopArm = useRef<{ key: string; at: number; held?: { group: string | undefined; updatedAt: number } } | null>(null) // the row/group a first ^x armed, and when — a second ^x within 2s of `at` deletes
  // "Pasted text over 800 characters or more than two lines collapses to a [Pasted text #N]
  // placeholder." A wall of pasted text otherwise fills the prompt and pushes the roster off
  // screen; the placeholder keeps the input readable and the real text is restored on dispatch.
  const pastes = useRef<string[]>([])
  const ctrlCArmed = useRef<number | null>(null) // timestamp of a first Ctrl+C on an empty input
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The hold stateGroups applies while a ^x is armed is time-bound, and nothing else necessarily
  // repaints when it lapses — this repaints once, so the row settles into its real section instead
  // of sitting in the old one until some unrelated event happens to render.
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
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
    if (!serverReady) return
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
  }, [client, serverReady])

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
  const parents = rememberSandboxes(knownSandboxes.current, projects)
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
  // The same lookup off the ref rather than the render closure, for the optimistic-delete paths: by
  // the time one of those runs, earlier rows in the same loop have already changed the roster, and
  // the member it is about to remove has to be the one that is actually there.
  const takeMember = (projectKey: string, id: string) => rosterRef.current.sessions.find((m) => m.worktree === projectKey && m.id === id)
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
    backends: Object.keys(backendRegistry),
  }
  const parsed = parseInput(input, vocab)
  const suggestions = suggestFor(input, vocab)
  // "Type in the dispatch input to filter instead of dispatching" — the list narrows as you type,
  // and Enter has nothing to dispatch.
  const activeFilter = parsed.kind === 'filter' ? parsed.filter : null
  const agentOf = (s: RosterSession) => s.agent
  const promptOf = (s: RosterSession): string | undefined =>
    asString(rosterState.sessions.find((m) => m.worktree === s.projectKey && m.id === s.id)?.prompt)

  // Shell jobs clean up after themselves ~5 minutes after finishing, agent view's rule — the
  // session is deleted (a job's output is ephemeral by contract; `fleetview logs` reads it before
  // the window closes) and the row goes with it. In-flight guard: the effect runs per render and
  // a delete takes longer than one.
  const cleaningJobs = useRef(new Set())
  useEffect(() => {
    const sessionsById = new Map([...byProjectSessions.values()].flat().map((s) => [`${s.projectKey}:${s.id}`, s]))
    for (const m of expiredShellJobs(rosterState, sessionsById)) {
      const key = `${m.worktree}:${m.id}`
      if (cleaningJobs.current.has(key)) continue
      cleaningJobs.current.add(key)
      ;(async () => {
        try {
          updateRoster((prev) => withoutMember(prev, m.worktree, m.id))
          await client.deleteSession(m.id, m.worktree)
          store.apply(m.worktree, { type: 'session.deleted', properties: { info: { id: m.id } } })
        } catch {
          // Put it back: a failed delete must not orphan a running server-side session invisibly.
          // The whole member, not a `{ shell: true }` stand-in — same reason as deleteGroup's
          // rollback: a rebuilt member loses the row's pin, rank and prompt.
          updateRoster((prev) => withMember(prev, m.worktree, m.id, m))
        } finally {
          cleaningJobs.current.delete(key)
        }
      })()
    }
  })

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
    const held = stopArm.current?.held && Date.now() - stopArm.current.at < 2000 ? stopArm.current : null
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
          foldCompleted(stateGroups(), maxRows, selectedSessionRef.current)
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

  // Terminal-level signals: the tab title carries the awaiting-input count, and a session that
  // starts needing you (or fails) rings the bell. Staying resident is what makes this useful —
  // it keeps happening while you're attached to some other session.
  const statusSnapshot = useRef<Map<string, any> | null>(null) // null until the first pass, which only records
  const lastTitle = useRef<string | null>(null)
  useEffect(() => {
    if (!serverReady) return
    // Same rule as the tab title: only a server-reported block is worth interrupting for. A row
    // that reads as waiting because its last line happened to end in a question mark must not ring.
    const current = new Map(
      allMembers.map((row) => [`${row.projectKey}:${row.id}`, row.status === 'waiting' && !row.pendingRequest ? 'done' : row.status]),
    )
    // The first pass is discovery, not news: sessions that were already waiting when fleetview
    // started didn't just start needing you, and ringing for them would make every launch chime.
    if (statusSnapshot.current && newlyNotable(statusSnapshot.current, current).length > 0) bell(stdout)
    // The user's notifier command sees every meaningful transition, not just the bell-worthy two.
    if (statusSnapshot.current) {
      const byKey = new Map(allMembers.map((row) => [`${row.projectKey}:${row.id}`, row]))
      for (const t of hookTransitions(statusSnapshot.current, current)) {
        runNotifyHook({ event: t.event, session: byKey.get(t.key) })
      }
    }
    statusSnapshot.current = current
    // Only on change — this effect runs on every render, and re-emitting the title on each
    // keystroke makes some terminals flicker.
    const title = titleFor(allMembers)
    if (title !== lastTitle.current) {
      lastTitle.current = title
      setTitle(stdout, title)
    }
  })
  // Hand the tab title back on the way out rather than leaving a stale count on the terminal.
  useEffect(() => () => setTitle(stdout, ''), [stdout])

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
  useEffect(() => () => { if (armTimer.current) clearTimeout(armTimer.current) }, [])

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
      // resume, and a session that no longer exists is not one.
      siblings: flat
        .filter((s) => !s.ghost)
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

  // Routes whatever is in the input. Everything except `dispatch` and `shell` either changes the
  // view or does nothing, so this is where agent view's overloaded input stops being overloaded.
  const submit = ({ thenAttach = false } = {}) => {
    if (parsed.kind === 'empty') return current ? attach(current) : undefined
    // A filter is not a thing to submit — it is already narrowing the list as you type.
    if (parsed.kind === 'filter') return
    if (parsed.kind === 'view-command') {
      if (parsed.command === 'exit' || parsed.command === 'quit') {
        onAction({ type: 'quit' })
        return exit()
      }
      // "/fork copies the conversation to a new background session" — here it acts on the
      // selected row, and an argument becomes the fork's first new prompt.
      if (parsed.command === 'fork') {
        if (!current) return flash('select a session to fork')
        // Capability gate, driven only by the backend's own flags: claude has --fork-session but the
        // Backend contract has no fork(), and copilot has no fork at all — either way the honest
        // answer is to say so rather than call a client method that would hit the wrong server.
        if (!capabilitiesOf(current).fork) {
          setInput('')
          return flash(`${backendNameOf(current)} can't fork a session`, 4000)
        }
        const row = current
        ;(async () => {
          try {
            const forked = await client.forkSession(row.id, row.projectKey)
            updateRoster((prev) => withMember(prev, row.projectKey, forked.id, parsed.args ? { prompt: parsed.args.slice(0, 2000) } : {}))
            if (parsed.args) await client.promptAsync(forked.id, parsed.args, row.projectKey)
            store.setSessions(row.projectKey, await client.listSessions(row.projectKey), seen)
            flash(`forked → ${forked.id.slice(0, 12)}${parsed.args ? ' (prompt sent)' : ''}`)
          } catch {
            flash("couldn't fork — server refused")
          }
        })()
        setInput('')
        return
      }
      // "/model followed by a model name ... sessions you dispatch afterwards use it."
      if (!parsed.args || parsed.args === 'default') {
        setDispatchModel(null)
        setInput('')
        return flash('dispatch model: server default')
      }
      const [providerID, ...rest] = parsed.args.split('/')
      const modelID = rest.join('/')
      // Leave the text alone so it can be corrected rather than retyped.
      if (!modelID) return flash('use /model <provider>/<model>, or /model default')
      const provider = providers.find((p) => p.id === providerID)
      // Only reject when the list actually loaded; an unreachable /config/providers must not stop
      // someone setting a model they know is fine.
      if (providers.length > 0 && !provider) return flash(`no such provider: ${providerID}`)
      if (provider && !Object.hasOwn(provider.models ?? {}, modelID)) {
        return flash(`${providerID} has no model ${modelID}`)
      }
      setDispatchModel({ providerID, id: modelID })
      setInput('')
      return flash(`dispatch model: ${parsed.args}`)
    }
    if (parsed.kind === 'shell') return void dispatch(parsed.command ?? '', { thenAttach, shell: true })
    // A `/command` fleetview doesn't run itself is sent as the session's first prompt, which is what
    // agent view does with skills and user commands.
    const text = parsed.kind === 'command' ? input.trim() : parsed.prompt
    return void dispatch(text ?? '', { thenAttach, agent: parsed.agent, repo: parsed.repo, backend: parsed.backend })
  }

  // Ctrl+X: stop, then delete on a second press within 2s. Replaces the old y/d/n and y/n modal
  // confirms — agent view has no dialog here, and the arm window is its own confirmation.
  // Deleting an isolated session takes its worktree with it — agent view's "Ctrl+X twice removes
  // the worktree and uncommitted changes (commit first)". The exception is the one it also makes:
  // "neither removes a worktree with unpushed commits", which is kept rather than silently taking
  // work with it. opencode's DELETE enforces none of this — it will remove a worktree holding
  // uncommitted changes, and its branch, without complaint — so the check has to happen here.
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
      await client.removeWorktree?.(projectKey, repo)
    } catch {
      // The session is already gone; a worktree left behind is untidy, not harmful, and `git
      // worktree list` still shows it. Saying so beats a silent failure.
      flash('session deleted, but its worktree could not be removed', 4000)
    }
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
    const armed = stopArm.current && stopArm.current.key === armKey && Date.now() - stopArm.current.at < 2000
    if (!armed) {
      stopArm.current = { key: armKey, at: Date.now() }
      return flash(`^x again to delete ${rows.length} session${rows.length === 1 ? '' : 's'} in ${group?.repoName}`, 2000)
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
      if (!capabilitiesOf(row).delete) {
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
    const armed = stopArm.current && stopArm.current.key === armKey && Date.now() - stopArm.current.at < 2000
    if (armed) {
      stopArm.current = null
      setNotice(null)
      // A backend that can't delete (claude/copilot) must not reach deleteRow: it would throw, read
      // as a generic "delete failed", and — worst — flag the whole project offline, blanking the
      // opencode rows sharing the directory. The first ^x already stopped the run; that stays.
      if (!capabilitiesOf(row).delete) return flash(`${backendNameOf(row)} can't delete a session`, 4000)
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
    armTimer.current = setTimeout(rerender, 2050) // just past the window, so the released row repaints
    // The arm is immediate — the two-press window must not wait on the network — but the notice
    // reports the outcome, not the intention. It used to say `stopped "<title>"` before the abort
    // had even been sent, and never corrected itself when the abort threw: a session that is still
    // running reads as stopped, and the user finds out by watching it keep working.
    flash(`stopping "${row.title}" · ^x again to delete`)
    // What is true once the abort settles. "^x again to delete" is only an offer while the arm is
    // live, so it is repeated only for whatever is left of that window — a notice that outlived the
    // arm would invite a second press that arms again instead of deleting.
    const report = (message: string) => {
      const left = 2000 - (Date.now() - armedAt)
      return left > 0 ? flash(`${message} · ^x again to delete`, left) : flash(message)
    }
    try {
      await abortRow(row)
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

  // Click-to-act, mirroring the keyboard: a click selects a row, a click on the selected row
  // attaches (Enter's empty-input verb), a click on a header toggles its collapse, and the wheel
  // moves the selection like arrows. Mapping y back to a line reuses the exact buildLines +
  // windowLines pair the Roster draws from, so a click can never land on a row that isn't there.
  const handleMouse = (ev: SgrMouseEvent) => {
    if (ev.kind === 'wheel-up' || ev.kind === 'wheel-down') {
      if (!navRows.length) return
      const next = ev.kind === 'wheel-up' ? Math.max(0, navSel - 1) : Math.min(navRows.length - 1, navSel + 1)
      return setSelectedKey(navRows[next].key)
    }
    if (ev.kind !== 'press' || ev.button !== 0) return
    const lines = buildLines(groups, offlineProjects, collapsed)
    const selIdx = Math.max(0, lines.findIndex((l) => l.key === navRow?.key))
    const { slice, above } = windowLines(lines, selIdx, maxRows)
    // Terminal rows are 1-based; the roster starts under the header block, plus the `↑ N more`
    // indicator row when it is drawn, plus the "moved to the background" notice line. The closure
    // still holds this press's notice state (the clear above is an async state update), which is
    // the frame the user actually clicked on.
    const line = slice[ev.y - headerRows(columns) - 1 - (above > 0 ? 1 : 0) - backgroundedNoticeRows]
    if (!line) return
    if (line.type === 'header') {
      setSelectedKey(line.key)
      return toggleCollapsed(line.projectKey)
    }
    if (line.type !== 'session') return
    // One click launches: select and attach in the same press (John's ask; the old
    // select-then-click-again dance made the first click feel dead).
    setSelectedKey(line.key)
    return attach(line.session)
  }

  useInput(
    (ch, key) => {
      // #60: Ink 7 splits one stdin read into several key events and dispatches them all in one
      // synchronous pass, but `isActive: false` only takes effect at the next render — so a `→`
      // and a `^X` arriving in the SAME chunk both reach the roster and the ^X stops the row being
      // attached to. The ref is synchronous, mirroring the same guard in `attach` above.
      if (attachedRef.current) return
      if (mode !== 'roster') return
      // The "moved to the background" state lasts exactly until the next interaction — any key or
      // click dismisses it whole. The Esc branch below still sees this press's value through the
      // render closure, which is what makes Esc-right-after-detach the undo and every later Esc a
      // normal quit.
      //
      // #59: except inside the post-resume quiet window. Dismissing costs nothing when the user
      // typed it, but a stray byte left over from the child's terminal destroys the Esc-undo with
      // no way back — unlike clearing the input, this one is not recoverable.
      if (backgrounded && Date.now() - resumedAt.current >= RESUME_QUIET_MS) setBackgrounded(null)
      const mouse = parseMouseEvents(ch)
      if (mouse.length) {
        for (const ev of mouse) handleMouse(ev)
        return
      }
      const empty = input.length === 0

      if (key.ctrl) {
        if (ch === 'c') {
          // "Clear the input; press twice to exit." Quitting on the first press meant a user
          // reaching for Ctrl+C to dismiss something lost the whole view instead.
          if (!empty) return setInput('')
          if (ctrlCArmed.current && Date.now() - ctrlCArmed.current < 2000) {
            onAction({ type: 'quit' })
            return exit()
          }
          ctrlCArmed.current = Date.now()
          return flash('press ^c again to exit')
        }
        if (ch === 's') return updateRoster((prev) => ({ ...prev, groupBy: prev.groupBy === 'state' ? 'project' : 'state' }))
        // "Ctrl+T pins: the session moves to a pinned group at the top and its name renders bold."
        if (ch === 't' && current) {
          return updateRoster((prev) => ({
            ...prev,
            sessions: prev.sessions.map((m) =>
              m.worktree === current.projectKey && m.id === current.id ? { ...m, pinned: !m.pinned } : m,
            ),
          }))
        }
        if (ch === 'b') {
          setView((v) => (v === 'main' ? 'browse' : 'main'))
          return setSelectedKey(null)
        }
        if (ch === 'a' && current) {
          return updateRoster((prev) =>
            hasSession(prev, current.projectKey, current.id)
              ? withoutMember(prev, current.projectKey, current.id)
              : withMember(prev, current.projectKey, current.id),
          )
        }
        if (ch === 'r' && current) {
          // ^r opens nothing on a backend that cannot rename: the dialog would take a title, send it
          // nowhere, and leave the row unchanged. The status line says which backend and why.
          if (!capabilitiesOf(current).rename) return flash(`${backendNameOf(current)} can't rename a session`, 4000)
          setTarget(current)
          return setMode('rename')
        }
        if (ch === 'x' && selectedHeader) return void deleteGroup(selectedHeader)
        if (ch === 'x' && current) return void stopOrDelete(current)
        // "Ctrl+J inserts a newline in the dispatch input." Terminals that report it as a plain
        // Return are indistinguishable here, which is why agent view documents it as needing
        // extended key reporting too.
        if (ch === 'j') return setInput((t) => t + '\n')
        // "Ctrl+G opens the dispatch prompt in $VISUAL or $EDITOR." The host owns the terminal
        // handover, exactly as it does for attach, so this only asks and applies the result.
        if (ch === 'g') {
          const done = onAction({ type: 'edit', text: input })
          if (isThenable(done)) {
            attachedRef.current = true
            setAttached(true)
            done.then(
              (edited) => {
                resumedAt.current = Date.now()
                attachedRef.current = false
                setAttached(false)
                if (typeof edited === 'string') setInput(edited)
              },
              () => {
                resumedAt.current = Date.now()
                attachedRef.current = false
                setAttached(false)
                flash('could not open an editor')
              },
            )
          } else flash('no $EDITOR configured')
          return
        }
        return
      }

      // Nothing to move between on an empty list; without this the selection key becomes a
      // placeholder built from undefined.
      if (key.shift && (key.upArrow || key.downArrow) && current) {
        // Shift+↑/↓ moves the selected row within its group and materialises the whole group's
        // order as ranks on the memberships — from then on that group's order is manual and
        // persisted; sessions dispatched later arrive unranked below the ranked ones.
        // unfoldedGroups, not groups, for the same reason deleteGroup uses it: the rendered groups are
        // folded and sliced to the screen, so ranking off them writes ranks for the visible subset
        // only and silently promotes it above the rows that were folded away.
        const group = unfoldedGroups.find((g) =>
          g.sessions.some((s) => s.id === current.id && s.projectKey === current.projectKey),
        )
        if (!group) return
        const idx = group.sessions.findIndex((s) => s.id === current.id && s.projectKey === current.projectKey)
        const target = key.upArrow ? idx - 1 : idx + 1
        if (target < 0 || target >= group.sessions.length) return
        const order = [...group.sessions]
        ;[order[idx], order[target]] = [order[target], order[idx]]
        return updateRoster((prev) => ({
          ...prev,
          sessions: prev.sessions.map((m) => {
            const at = order.findIndex((s) => s.projectKey === m.worktree && s.id === m.id)
            return at >= 0 ? { ...m, rank: at } : m
          }),
        }))
      }
      // Arrows live in the roster; the input needs no cursor stop — typing anything, any time,
      // populates it (John's polish pass, reverting the input-as-arrow-stop experiment).
      if (key.upArrow) return navRows.length ? setSelectedKey(navRows[Math.max(0, navSel - 1)].key) : undefined
      if (key.downArrow)
        return navRows.length ? setSelectedKey(navRows[Math.min(navRows.length - 1, navSel + 1)].key) : undefined
      if (key.return) {
        // On a group header Enter collapses instead of dispatching — but only with an empty input,
        // because text in the prompt means the user is dispatching and the highlighted row is
        // incidental.
        if (selectedHeader && empty) return toggleCollapsed(selectedHeader)
        // Shift+Enter is only distinguishable in terminals with extended key reporting; Alt+Enter
        // (reported as meta) is the fallback the majority of terminals do send.
        return submit({ thenAttach: Boolean(key.shift || key.meta) })
      }
      // "Tab: On an empty input, browse all subagents. Otherwise apply the highlighted suggestion"
      if (key.tab && empty) return setInput('@')
      if (key.tab) {
        if (!suggestions) return // nothing to apply — never fall through and type a literal tab
        const first = suggestions.matches[0]
        return setInput((t) => t.slice(0, t.length - suggestions.partial.length) + first.name + ' ')
      }
      if (key.rightArrow && current) return attach(current)
      if (key.escape) {
        // #47: the whole branch is gated, not just the quit. `^G` hands the terminal to $EDITOR
        // via a blocking spawnSync, so Ink never suspends and never drains — the editor's leftover
        // terminal-query bytes arrive as roster keystrokes, and a bare ESC among them hit
        // `setInput('')` below and wiped the prompt that was just edited, after editPrompt's
        // `finally` had already removed the temp file. Ignoring a genuinely-typed Escape within
        // 50ms of a resume costs nothing against a human reaction window.
        if (Date.now() - resumedAt.current < RESUME_QUIET_MS) return
        if (!empty) return setInput('')
        if (view === 'browse') {
          setView('main')
          return setSelectedKey(null)
        }
        // Esc while the "moved to the background" notice is still up undoes the switch and
        // re-opens that conversation (agent view: "Press Esc to undo the switch and return to the
        // conversation"). Attach through the LIVE row, not the remembered ref — if the session was
        // stopped or deleted in between, fall through and let Esc quit as usual. Esc keeps
        // clearing input / closing browse first; only the would-exit press in the undo window is
        // repurposed.
        if (backgrounded?.notice) {
          // The full member set, not the drawn rows: the session the user just left may sit in a
          // collapsed group or behind the `… N more` fold, and an Esc that promised an undo must
          // not quit the app because of how the list happened to be folded. Only a session that
          // is genuinely gone (stopped and removed) falls through to the normal quit.
          const live = allMembers.find((s) => s.id === backgrounded.id && s.projectKey === backgrounded.projectKey)
          if (live) return attach(live)
        }
        // Quitting is the one irreversible thing Esc does — the quiet-window guard that protects
        // it now sits at the top of this branch (#47), because clearing a just-edited prompt is
        // destructive too and the temp file backing it is already gone.
        onAction({ type: 'quit' })
        return exit()
      }
      if (key.backspace || key.delete) return setInput((t) => graphemes(t).slice(0, -1).join(''))
      // #35: a group header has no `current`, so this used to fall through to the text handler and
      // silently type a leading space into the dispatch input — nothing on screen distinguishes
      // that from a peek that failed to open, so the next keystrokes joined a prompt the user
      // never meant to start and Enter dispatched it. On a header, space means what Enter means
      // there: collapse. Only with an empty input — text in the prompt means the user is typing,
      // and a space inside a sentence is a space.
      if (empty && ch === ' ' && selectedHeader) return toggleCollapsed(selectedHeader)
      // #34: peek reads a conversation that isn't there any more.
      if (empty && ch === ' ' && current?.ghost) return flash(`"${current.title}" is gone — ^x removes it from the roster`, 4000)
      if (empty && ch === ' ' && current) return openPeek(current)
      if (empty && ch === '?') return setMode('help')
      // A paste arrives as one chunk, so `ch` can carry newlines and other control bytes. Newlines
      // are kept now that `^j` makes the prompt multi-line; everything else non-printing is
      // dropped rather than embedded in a prompt that gets sent to a model.
      if (ch && !key.meta) {
        // The residue strip runs after the control strip, not before: what makes a focus report or
        // a paste marker read as typed text is exactly that its ESC has just been removed here.
        const text = stripEscapeResidue(ch.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ''))
        if (!text) return
        // "Pasted text over 800 characters or more than two lines collapses to a placeholder."
        if (text.length > 800 || text.split('\n').length > 2) {
          const existing = pastes.current.indexOf(text)
          // "Expands again if the same text is pasted a second time" — the same text is the same
          // attachment, so it keeps its number instead of accumulating duplicates.
          const index = existing >= 0 ? existing : pastes.current.push(text) - 1
          return setInput((t) => t + `[Pasted text #${index + 1}]`)
        }
        setInput((t) => t + text)
      }
    },
    { isActive: mode === 'roster' && serverReady && !attached },
  )

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
        } catch {
          setOfflineProjects((s) => new Set(s).add(target.projectKey))
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
    React.createElement(Header, { sessions: allMembers, model: dispatchModel, cwd, columns }),
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
      : React.createElement(DispatchInput, { value: input, view, notice, kind: parsed.kind, suggestions, columns, focused: mode === 'roster' }),
    serverDown
      ? React.createElement(
          Text,
          { color: theme.danger },
          'opencode server unreachable — will keep retrying; restart fleetview if this persists',
        )
      : null,
  )
}

function RenameInput({ initial, onSubmit, onCancel }: { initial: string; onSubmit: (title: string) => void; onCancel: () => void }): React.ReactElement {
  const [text, setText] = useState(initial)
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) return onCancel()
    if (key.return) return text.trim() && onSubmit(text.trim())
    if (parseMouseEvents(input).length) return // mouse sequences are not text
    if (key.backspace || key.delete) setText((t) => graphemes(t).slice(0, -1).join(''))
    else if (input && !key.ctrl && !key.meta) {
      // #112.3: strip control bytes / escape residue the same way the dispatch input does, so a
      // paste can't land C0 bytes verbatim in the title sent to the server.
      const text = stripEscapeResidue(input.replace(/[\r\n]+/g, ' ').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ''))
      if (text) setText((t) => t + text)
    }
  })
  return React.createElement(Text, null, `Rename: ${text}█ (⏎ save · esc cancel)`)
}
