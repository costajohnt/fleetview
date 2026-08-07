import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { basename } from 'node:path'
import { existsSync } from 'node:fs'
import { Box, Text, useInput, useApp, useStdout, useWindowSize } from 'ink'
import { createStore, FINISHED_STATUSES } from './session-store.ts'
import { graphemes, stripEscapeResidue } from './text-utils.ts'
import { connectEvents } from './backends/opencode/event-mux.ts'
import { createOpencodeBackend } from './backends/opencode/index.ts'
import { DEFAULT_BACKEND } from './backends/index.ts'
import { createNormaliser, normaliseSessions } from './backend-normalise.ts'
import { hasSession, type Roster as RosterType } from './roster-store.ts'
import { Roster, flattenGroups, navigableRows, buildLines, windowLines } from './ui/roster.ts'
import { parseMouseEvents } from './ui/mouse.ts'
import { DispatchInput, inputRows, INPUT_BOX_ROWS } from './ui/dispatch-input.ts'
import { Header, headerRows } from './ui/header.ts'
import { titleFor, setTitle, bell, newlyNotable, hookTransitions, runNotifyHook } from './ui/notify.ts'
import { Help, helpLines, helpPage } from './ui/help.ts'
import { Peek } from './ui/peek.ts'
import { usePeek } from './use-peek.ts'
import { pickTarget, repoChoices } from './dispatch-target.ts'
import { parseInput, suggestFor, applyFilter } from './dispatch-parse.ts'
import { sandboxParents, rememberSandboxes, isRootProject, displayProject, isSandbox, shouldIsolate, worktreeName, worktreeSafety, allProjectDirectories } from './worktree.ts'
import { fetchPullRequests, branchOf, byBranch, hasOpenPr } from './pull-requests.ts'
import { theme } from './ui/theme.ts'
import type { OpencodeEvent } from './types.ts'

// TODO(types): opencode wire data (project rows, session rows) is dynamic; roster shape reused from roster-store.
type RosterState = RosterType

const sortProjects = (list: any[]) => [...list].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))

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
  { key: 'pinned', label: 'pinned', match: (s: any) => Boolean(s.pinned) },
  // `hint` shows under an empty status section, agent view's "description under each" — the skeleton
  // is only worth its rows if it teaches a first-time user what the three sections mean.
  { key: 'waiting', label: 'needs input', hint: 'a session is asking you something', match: (s: any) => s.status === 'waiting' },
  { key: 'running', label: 'working', hint: 'a session is running right now', match: (s: any) => s.status === 'running' },
  // #34: ghost rows (members whose session is gone server-side) land here too. They are finished in
  // every sense the user cares about, and `completed` is the section that already collects rows
  // nothing is going to happen to. `ghost` rather than a status test so FINISHED_STATUSES stays
  // exactly what session-store's `derive` can mint.
  { key: 'completed', label: 'completed', hint: 'finished, failed, or stopped sessions land here', match: (s: any) => FINISHED_STATUSES.has(s.status) || Boolean(s.ghost) },
]

// "Completed sessions that don't fit on screen fold into a `… N more` row. Failures and sessions
// with an open pull request always stay visible." Both halves of that rule are load-bearing and
// only the first was implemented: a completed session with a live pull request was folded away
// like any other success. Protected rows are sorted to the front of the group so the cap can only
// ever eat unprotected ones, and counted here so the cap never cuts into them.
const isProtectedFromFold = (s: any) => s.status === 'error' || hasOpenPr(s.prs)
// #49: the row the user is standing on is protected too, or the fold silently retargets the next
// key at whatever ends up first on screen (`navRows` only sees drawn rows). `sel` is an identity
// ({projectKey, id}), not a key: keys are namespaced by the live grouping and go stale exactly
// when a row changes section, which is one of the moments this has to survive.
export function foldCompleted(groups: any[], maxRows: number, sel?: any) {
  // Each group draws its header (1) plus its sessions; an empty always-shown group draws one
  // "no items" placeholder row in place of sessions. Counting those placeholders keeps the fold
  // honest now that needs-input/working are shown even when empty.
  const used =
    groups.reduce((n: number, g: any) => n + 1 + g.sessions.length + (g.sessions.length === 0 && g.empty ? 1 : 0), 0) +
    Math.max(0, groups.length - 1) // one spacer row between adjacent groups
  const completed = groups.find((g: any) => g.projectKey === 'state:completed')
  if (!completed || used <= maxRows) return groups
  const isSelected = (s: any) => Boolean(sel) && s.id === sel.id && s.projectKey === sel.projectKey
  const protectedCount = completed.sessions.filter((s: any) => isProtectedFromFold(s) || isSelected(s)).length
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
  return groups.map((g: any) =>
    g === completed ? { ...g, sessions: kept, hidden: g.sessions.length - kept.length } : g,
  )
}

// The parity baseline, used only when a row's backend cannot be resolved at all (see
// capabilitiesOf). Deliberately not imported from the opencode adapter: this is a fallback for the
// case where that adapter is absent.
const OPENCODE_CAPABILITIES = { fork: true, rename: true, delete: true, questions: true }

// Pure roster-mutation helpers mirroring roster-store.ts's addSession/removeSession semantics —
// duplicated rather than imported because those do file IO directly; App only persists via the
// `persistRoster` callback and needs the updated object back to update local render state too.
const withMember = (roster: any, worktree: any, id: any, extra: any = {}) =>
  hasSession(roster, worktree, id)
    ? roster
    : { ...roster, sessions: [...roster.sessions, { worktree, id, addedAt: Date.now(), ...extra }] }

// "Cleanup ~5 minutes after completion" — agent view's shell jobs clean up after themselves, and
// a finished `! cmd` row that sits forever is clutter the user has to ^x by hand.
export const SHELL_JOB_TTL_MS = 5 * 60_000

// Pure: the shell-job members whose sessions have settled long enough ago to clean up. A session
// still missing from the store (not yet seeded) is left alone rather than guessed at.
export function expiredShellJobs(roster: any, sessionsById: any, now = Date.now()) {
  return roster.sessions.filter((m: any) => {
    if (!m.shell) return false
    const s = sessionsById.get(`${m.worktree}:${m.id}`)
    return s && FINISHED_STATUSES.has(s.status) && now - (s.updatedAt ?? 0) > SHELL_JOB_TTL_MS
  })
}

const withoutMember = (roster: any, worktree: any, id: any) => ({
  ...roster,
  sessions: roster.sessions.filter((s: any) => !(s.worktree === worktree && s.id === id)),
})

// repoll keeps stale (vanished) projects in place — only union in what's fresh, never drop.
const mergeProjects = (prev: any[], fresh: any[]) => {
  const freshKeys = new Set(fresh.map((p) => p.worktree))
  return sortProjects([...fresh, ...prev.filter((p) => !freshKeys.has(p.worktree))])
}

// TODO(types): host/client wiring and injected impls are large, dynamic shapes; loose props.
type AppProps = {
  server: any
  client: any
  connectEventsImpl?: any
  ensureServerImpl?: any
  serverReady?: boolean
  serverFailReason?: any
  onAction: (action: any) => any
  seen?: any
  persistSeen?: (...args: any[]) => void
  roster?: RosterState
  // `reload` is optional so any caller can pass a bare callback; only makePersistRoster's carries
  // it, and without it the #44 external-member sync is simply off.
  persistRoster?: ((roster: RosterState) => void) & { reload?: () => RosterState | null }
  initialModel?: any
  initialAgent?: any
  backends?: Record<string, any>
  initialBackend?: string
  isolate?: boolean
  projectPollMs?: number
  fetchPullRequestsImpl?: any
  branchOfImpl?: any
  cwd?: string
  worktreeSafetyImpl?: any
  dirExistsImpl?: (dir: string) => boolean
}
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
  // Injected so the branch that decides whether deleting a session destroys committed work can be
  // tested without building a git repository per case. Defaults to the real thing.
  worktreeSafetyImpl = worktreeSafety,
  // Injected for the same reason: dispatch refuses a target directory that is gone (#22), and the
  // test corpus dispatches into paths that never existed on disk.
  dirExistsImpl = existsSync,
}: AppProps): any {
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
  // `${directory}:${id}` → backend name, for every session that isn't opencode's. Kept here rather
  // than in session-store because it is roster wiring, not session state: the store's job is to
  // reduce events into rows, and it does that identically whichever CLI the events came from.
  // Absent means opencode, which is what makes an opencode-only roster carry no extra state at all.
  const sessionBackends = useRef(new Map<string, string>())
  const noteBackend = useCallback(
    (directory: string, id: string, name: string) => {
      const key = `${directory}:${id}`
      if (sessionBackends.current.get(key) === name) return
      sessionBackends.current.set(key, name)
      // The store needs the same fact for one purpose only: its three seeds treat an opencode GET as
      // the full truth for a directory, and these rows are not in it. See session-store.noteOrigin.
      if (name !== DEFAULT_BACKEND) store.noteOrigin(directory, id, name)
      force((n) => n + 1) // the tag and the capability gates read this; a Map mutation renders nothing
    },
    [store],
  )
  const backendNameOf = (row: any) => sessionBackends.current.get(`${row.projectKey}:${row.id}`) ?? DEFAULT_BACKEND
  // The adapter a row's keys and actions have to go through, or null for opencode — null is what the
  // call sites read as "take the original client path", so no opencode call changes shape.
  const backendFor = (row: any) => {
    const name = backendNameOf(row)
    return name === DEFAULT_BACKEND ? null : backendRegistry[name] ?? null
  }
  // Falls back to opencode's flags (every one true) when a row's backend can't be resolved: a
  // missing adapter must not silently hide keys that have always worked.
  const capabilitiesOf = (row: any) =>
    backendFor(row)?.capabilities ?? backendRegistry[DEFAULT_BACKEND]?.capabilities ?? OPENCODE_CAPABILITIES
  // The two verbs ^x drives. An opencode row takes the original client call — same method, same
  // arguments, same order — so the heavily-tested stop/delete paths are untouched; anything else
  // goes through its own adapter, which is the only thing that knows how to signal a detached CLI.
  const abortRow = (row: any) => backendFor(row)?.abort(row.id, row.projectKey) ?? client.abortSession(row.id, row.projectKey)
  const deleteRow = (row: any) => backendFor(row)?.delete(row.id, row.projectKey) ?? client.deleteSession(row.id, row.projectKey)
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
  const [target, setTarget] = useState<any>(null) // {projectKey, id, title} captured when a dialog opens; store churn must not retarget it
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
  const [backgrounded, setBackgrounded] = useState<any>(null) // {id, projectKey, notice: true}
  // A selection request by identity, resolved against the live rows by the effect below.
  const [pendingSelect, setPendingSelect] = useState<any>(null) // {id, projectKey}
  const [helpPageIndex, setHelpPageIndex] = useState(0)
  const [offlineProjects, setOfflineProjects] = useState<Set<string>>(new Set())
  const [serverDown, setServerDown] = useState(false)
  const [projects, setProjects] = useState<any[]>([])
  // Pull requests, keyed the way they are looked up: branch to pull requests, plus the branch each
  // project directory is on. `reasons` maps repository directory to why THAT repository has no
  // data, shown in peek rather than as a notice — scoped per repo so one repo's failure (e.g. no
  // GitHub remote) never gets attributed to an unrelated repo that simply has no PRs.
  const [pullRequests, setPullRequests] = useState<{ byBranch: Map<string, any>; branches: Map<string, any>; reasons: Map<string, any> }>({ byBranch: new Map(), branches: new Map(), reasons: new Map() })
  const [agents, setAgents] = useState<any[]>([])
  const [commands, setCommands] = useState<any[]>([])
  // null = whatever the server would pick. `/model <name>` overrides it for this run only, which
  // is exactly agent view's rule: "This override lasts for the rest of the current run and doesn't
  // write to your settings file."
  const [dispatchModel, setDispatchModel] = useState<any>(initialModel)
  const [providers, setProviders] = useState<any[]>([])
  const rerender = useCallback(() => force((n) => n + 1), [])
  const seededProjectKeys = useRef(new Set<string>()) // worktrees that successfully listSessions'd this process lifetime
  const knownWorktrees = useRef(new Set<string>()) // worktrees already handed to seedAndStream (new-vs-repeat gate for repoll)
  // #43: set once a `client.listProjects()` round has completed successfully. It is the evidence
  // the second ghost arm below needs — an unreachable server never completes one, so F1's offline
  // protection survives untouched.
  const projectsListed = useRef(false)
  const knownSandboxes = useRef(new Map<string, string>()) // every worktree ever listed in a project's `sandboxes` -> its repo (#22)
  const conns = useRef(new Map<string, any>()) // worktree -> stream handle, for unmount cleanup
  // onEvent below is captured once by the mount-only discovery effect, so it can't read fresh
  // rosterState from a render closure — this ref is the escape hatch (F1).
  const reconcileRef = useRef<any>(null) // set by the discovery effect; serializes seeds per worktree
  // Also set by the discovery effect. A worktree created during a dispatch is a brand-new project
  // that nothing is streaming yet, and waiting for the next poll would leave the row static for up
  // to the poll interval right when the user is watching it start.
  const streamProjectRef = useRef<any>(null)
  // Also set by the discovery effect: starts streaming a backend that wasn't active at launch, which
  // is what an `@backend` dispatch needs before its new row can update.
  const activateBackendRef = useRef<((name: string) => Promise<void>) | null>(null)
  const rosterRef = useRef(rosterState)
  useEffect(() => { rosterRef.current = rosterState }, [rosterState])

  useEffect(() => {
    if (!serverReady) return
    let cancelled = false
    Promise.resolve(client.listAgents?.() ?? [])
      .then((list: any) => !cancelled && setAgents((list ?? []).filter((a: any) => !INTERNAL_AGENTS.has(a.name))))
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

  useEffect(() => {
    let cancelled = false
    let polling = false
    let intervalId: ReturnType<typeof setInterval> | undefined

    // Live-state reconciliation: GET /session/status + GET /permission + GET /question catch a
    // session mid-run or a permission/question already pending at fleetview launch/reconnect that a
    // fresh SSE stream wouldn't otherwise report until its next change. Best-effort — failures
    // never block seeding.
    // I2: statuses seed FIRST and are awaited before permissions+questions seed — session.status's
    // idle-clear must land ahead of the fresh pending seed, not race it, or a handler-style
    // clear could wipe an entry the authoritative reseed was about to (re)add. The __seq mark is
    // captured BEFORE issuing the GETs (the very first line) and passed to both seeds — it lets
    // seedPermissions/seedQuestions tell a pre-seed entry (safe to drop if the fresh list lacks it)
    // from one that landed live while these GETs were still in flight (must survive the replace).
    // That watermark is what makes it safe to connect the SSE stream before this seed lands (below).
    // Reports each list separately. A single combined flag conflated three independent requests:
    // a peek path that only cares whether `/question` succeeded would see failure because
    // `/session/status` timed out, and blind-re-add a question the fresh list had correctly
    // dropped — resurrecting a request the server has already accepted an answer for, which is
    // exactly what the fallback exists to avoid.
    // `additive: true` is the periodic pass's form of the pending seed. The default replace is
    // *authoritative* — an entry missing from the response is dropped — which is right when
    // reconnecting after missing events, but wrong to repeat on a timer: if `GET /permission` ever
    // omitted a genuinely pending request, a rare reconnect-only drop would become a recurring one.
    // So the timer used to seed statuses only. That left a real hole: a lost `session.status` frame
    // self-heals within one poll, but a lost `permission.asked`/`question.asked` frame had no
    // recovery path at all, and the row sat rendering "working" with a blocked run behind it and no
    // token spend until the user restarted. Systematic rather than rare, because opencode's event
    // stream is per-directory and a dispatched session runs in its own git worktree — statuses for
    // those still refresh (the poll hits GET /session/status per worktree), permissions and
    // questions had no equivalent. The additive mode only ADDS what the store is missing and never
    // deletes, so the timer can run it without the omission risk, and the authoritative replace
    // stays exactly where it was: mount, reconnect, and the peek reconcile paths.
    const seedLiveState = async (worktree: any, { pending = true, additive = false, closeRuns = false, relist = false }: any = {}) => {
      // Before anything else, because `setSessions` is the only thing that learns which sessions are
      // subagents, and every seed below can otherwise mint a row for one. A subagent spawned since
      // the last listing is unknown, so its first `session.status` creates a record; this is what
      // closes that window on the poll interval instead of leaving it open until the next reconnect
      // or dispatch. It also retires a session that has vanished from the listing — deleted from
      // opencode's own TUI, or by a `session.deleted` the stream was down for — with one exception
      // fleetview cannot close: a record it has never listed, which is indistinguishable from a
      // session created since the last listing (the row a dispatch has this instant created).
      if (relist) {
        try {
          const list = await client.listSessions(worktree)
          if (cancelled) return { permissions: false, questions: false }
          seededProjectKeys.current.add(worktree)
          // The one caller that retires vanished sessions, because it is the one chainSeed
          // serializes per worktree — so a stale listing can never land after a newer one and
          // delete what the newer one just saw. Every other caller refreshes without retiring.
          store.setSessions(worktree, list, seen, { retire: true })
        } catch {
          // A failed relist is not worth flagging the project offline for — the stream is the
          // authority on that, and the next tick tries again.
        }
      }
      const mark = store.seedMark()
      const outcome = { permissions: true, questions: true }
      await client
        .sessionStatus(worktree)
        .then((s: any) => store.seedStatuses(worktree, s, mark, { closeRuns }))
        .catch(() => {})
      if (!pending) return outcome
      // M4: each GET fails independently. If sessionStatus above succeeds but one of these two
      // fails, that half of the reseed silently no-ops — e.g. a session whose status seed just
      // landed idle can still show "waiting" off a pendingPermissions/pendingQuestions entry that
      // never got its authoritative reseed. Stale until the next reconnect's seedLiveState run;
      // self-healing, accepted rather than adding retry/backoff for a best-effort catch-up path.
      await Promise.all([
        client
          .listPermissions(worktree)
          .then((p: any) => store.seedPermissions(worktree, p, mark, { additive }))
          .catch(() => { outcome.permissions = false }),
        client
          .listQuestions(worktree)
          .then((q: any) => store.seedQuestions(worktree, q, mark, { additive }))
          .catch(() => { outcome.questions = false }),
      ])
      return outcome
    }

    // M2: per-worktree promise chain — mount/onOnline/repoll/reconcile all route seedLiveState
    // calls through this, so two seeds for the same worktree never overlap outside the watermark
    // protocol above. Also eliminates the startup double-fetch: mount's initial seed and the first
    // onOnline resync now run sequentially instead of both firing their GETs concurrently.
    const seedChains = new Map<string, Promise<any>>()
    const chainSeed = (w: any, options?: any) => {
      const failed = { permissions: false, questions: false }
      const next = (seedChains.get(w) ?? Promise.resolve()).then(() => seedLiveState(w, options)).catch(() => failed)
      seedChains.set(w, next)
      return next
    }
    // Published so the peek reconcile paths use the same chain. They used to call seedMark() and
    // seedPermissions/seedQuestions directly, which is exactly the overlap the chain prevents: a
    // reconnect's older snapshot could land after a newer one and re-insert a permission the
    // server had already accepted an answer for.
    reconcileRef.current = chainSeed
    streamProjectRef.current = (w: any) => seedAndStream(w)

    const seedAndStream = async (worktree: any) => {
      knownWorktrees.current.add(worktree)
      try {
        const sessions = await client.listSessions(worktree)
        if (cancelled) return
        seededProjectKeys.current.add(worktree)
        store.setSessions(worktree, sessions, seen)
        const conn = connectEventsImpl(
          { ...server, directory: worktree },
          {
            onEvent: (directory: any, e: OpencodeEvent) => {
              store.apply(directory, e)
              // Explicit delete evidence only — never prune members merely absent from a listing;
              // offline projects must keep members (F1).
              const id = e.type === 'session.deleted' ? e.properties?.info?.id : undefined
              if (id && hasSession(rosterRef.current, directory, id)) {
                updateRoster((prev: any) => withoutMember(prev, directory, id))
              }
            },
            onOffline: (directory: any) => setOfflineProjects((s) => new Set(s).add(directory)),
            onOnline: (directory: any) => {
              setOfflineProjects((s) => {
                const next = new Set(s)
                next.delete(directory)
                return next
              })
              // project's stream just came back: re-seed in case we missed events while offline.
              // fire-and-forget — a racing failure re-flags it offline via other paths.
              client
                .listSessions(directory)
                .then((list: any) => {
                  seededProjectKeys.current.add(directory)
                  store.setSessions(directory, list, seen)
                  chainSeed(directory)
                })
                .catch(() => {})
            },
          },
        )
        if (cancelled) return conn.stop()
        conns.current.set(worktree, conn)
        // I2: fire-and-forget, not awaited — the stream is already connecting above, and the
        // seq-watermark inside seedLiveState makes a seed that resolves after live events have
        // already landed safe (event-fresh entries survive the replace instead of being deleted).
        // M2: routed through chainSeed, not called directly — serializes against any other
        // pending seed for this worktree (e.g. a fast onOnline flap right after mount).
        chainSeed(worktree)
      } catch {
        if (!cancelled) {
          setOfflineProjects((s) => new Set(s).add(worktree))
          knownWorktrees.current.delete(worktree) // let the next repoll retry it fully, not skip it forever
        }
      }
    }

    // Backends other than opencode, streamed only once something has asked for them: the launch
    // default (--backend / FLEETVIEW_BACKEND), a roster membership left by a previous run, or an
    // `@backend` dispatch. A pure-opencode user never activates one, so nothing here ever runs for
    // them — no extra polling, and no other tool's sessions in their roster.
    const activeBackends = new Set<string>([DEFAULT_BACKEND, initialBackend])
    for (const m of rosterRef.current.sessions as any[]) {
      if (m.backend && m.backend !== DEFAULT_BACKEND) {
        activeBackends.add(m.backend)
        // Through noteBackend, not a bare map set: the map alone satisfies its dedup guard, which
        // would then suppress store.noteOrigin for this key forever — leaving a restored row
        // untagged in the store, and so swept as opencode's by the three seeds.
        noteBackend(m.worktree, m.id, m.backend)
      }
    }
    const backendConns = new Map<string, any>() // `${name}:${worktree}` → subscription, for unmount

    // Connect (once) and re-list (every call) one backend in one directory. Listing every time is
    // what makes discovery keep up: a process-backed backend has no event for "a session you have
    // never seen exists", so the periodic listing is the only way one started outside fleetview —
    // or by a previous fleetview run — ever appears.
    const streamBackend = async (name: string, worktree: string) => {
      if (name === DEFAULT_BACKEND) return // opencode has its own path above, unchanged
      const backend = backendRegistry[name]
      if (!backend) return
      const key = `${name}:${worktree}`
      if (!backendConns.has(key)) {
        // One normaliser per subscription, because it folds per-session state across events and two
        // directories' runs must never share that fold.
        const normalise = createNormaliser(name)
        const conn = backend.events(
          { directory: worktree },
          {
            onEvent: (directory: string, event: unknown) => {
              for (const store_event of normalise(event)) {
                // Not every union member carries sessionID (session.updated nests an info object),
                // and the ones a normaliser emits all do — the loose read says so once.
                const id = (store_event.properties as { sessionID?: string }).sessionID
                if (id) noteBackend(directory, id, name)
                store.apply(directory, store_event)
              }
            },
          },
        )
        if (cancelled) return conn.stop()
        backendConns.set(key, conn)
      }
      try {
        const list = normaliseSessions(name, await backend.listSessions(worktree))
        if (cancelled) return
        for (const s of list) noteBackend(worktree, s.id, name)
        // Never `retire: true`: that sweep is scoped to a project, not to a backend, so a claude
        // listing armed with it would delete the opencode rows in the same directory. Leaving these
        // records unlisted is also what keeps opencode's own retiring listing from deleting them —
        // it only sweeps records its own listings armed.
        store.setSessions(worktree, list, seen)
      } catch {
        // A CLI that isn't installed, or a state directory that doesn't exist. Both are "no sessions
        // here", and neither is worth flagging the project offline for.
      }
    }
    // Published for the dispatch path: `@claude fix the tests` has to start streaming claude before
    // the row it just created can ever update.
    activateBackendRef.current = async (name: string) => {
      activeBackends.add(name)
      await Promise.all([...knownWorktrees.current].map((w) => streamBackend(name, w)))
    }

    const refreshPullRequests = async (fresh: any[]) => {
      // One call per repository, never per worktree: a worktree shares its repository's remote, so
      // asking it the same question again would double the subprocesses for identical answers.
      const parentsNow = sandboxParents(fresh)
      const repoDirs = fresh.filter((p) => !parentsNow.has(p.worktree)).map((p) => p.worktree)
      const results = await Promise.all(repoDirs.map((dir: any) => fetchPullRequestsImpl(dir)))
      if (cancelled) return
      // Keyed by repository dir + branch, not bare branch: branch names are not unique across
      // repositories (every repo dependabot touches has a `dependabot/github_actions/...` branch),
      // and a bare-branch key let a session wear another repository's pull request label.
      const merged = new Map()
      repoDirs.forEach((dir: any, i: number) => {
        for (const [branch, list] of byBranch(results[i].prs)) merged.set(`${dir} ${branch}`, list)
      })
      // Reasons are scoped per repository, not collapsed to one global string: `repoDirs` and
      // `results` are index-aligned (one `gh` call per repo dir), so zip them into a map and keep
      // only the repos that actually failed. This is what lets peek show a session its OWN repo's
      // reason instead of a different repo's.
      const reasons = new Map()
      repoDirs.forEach((dir: any, i: number) => {
        if (results[i].reason) reasons.set(dir, results[i].reason)
      })
      // Branches are read for every directory including worktrees, because a session's key is the
      // branch of the directory it actually runs in, not of the repository that owns it.
      const branches = new Map()
      for (const p of fresh) {
        const branch = branchOfImpl(p.worktree)
        if (branch) branches.set(p.worktree, branch)
      }
      setPullRequests({ byBranch: merged, branches, reasons })
    }

    // #44: a `fleetview bg` dispatch from another terminal appends to roster.json and the running
    // TUI never noticed — it read the file once at mount and holds membership in React state, so
    // the session streamed fine in browse while its member row stayed invisible until restart.
    // Re-read on the tick that already polls projects and union in what state lacks.
    //
    // Additions only. Removals are deliberately NOT synced: two instances would fight over deletes,
    // and one instance's ^x would silently eat a membership the other is still using.
    //
    // Nothing already in state is ever rewritten from disk — a pin, rank, prompt or collapse this
    // instance just made stays exactly as it is, and groupBy/collapsed are never read at all. And
    // nothing is persisted here: these members are on disk already, and writing back would hand
    // makePersistRoster's `prev` a foreign member to later mistake for one of its own.
    const syncExternalMembers = () => {
      const disk = persistRoster?.reload?.() // null when unchanged, unreadable, or not wired (tests)
      if (!disk) return
      const have = new Set(rosterRef.current.sessions.map((m: any) => `${m.worktree}:${m.id}`))
      const added = disk.sessions.filter((m: any) => !have.has(`${m.worktree}:${m.id}`))
      if (added.length === 0) return
      const next = { ...rosterRef.current, sessions: [...rosterRef.current.sessions, ...added] }
      // The ref leads, as it does everywhere else in this effect (F1): updateRoster writes through
      // rosterRef.current, and a call site that fires before the state flush must see these members.
      rosterRef.current = next
      setRosterState(next)
    }

    const refreshProjects = async () => {
      if (polling) return
      polling = true
      flushSavedReplies.current() // anything queued by a failed peek reply gets another go
      // Before listProjects, not after: #43 ghosts a member whose worktree is in no project record,
      // and the listing is only fair evidence if it ran AFTER the member became known. Reading the
      // roster first makes that ordering unconditional.
      syncExternalMembers()
      try {
        // Sandboxes included: a worktree is not reliably published as a project row of its own, and
        // a session fleetview never streams is a row that never updates.
        const fresh = allProjectDirectories(await client.listProjects())
        if (cancelled) return
        setServerDown(false)
        projectsListed.current = true // #43: a completed round is the ghost arm's only evidence
        setProjects((prev) => mergeProjects(prev, fresh))
        // Pull requests refresh on the tick that already re-lists projects: no second timer and no
        // TTL bookkeeping. A poll is unavoidable rather than a shortcut — the label's colour encodes
        // CI state, and checks go green while the session sits idle, so no session event could ever
        // turn a row green.
        await refreshPullRequests(fresh)
        const newOnes = fresh.filter((p) => !knownWorktrees.current.has(p.worktree))
        await Promise.all(newOnes.map((p) => seedAndStream(p.worktree)))
        // Discovery for the process-backed backends rides the same tick: the directories fleetview
        // already shows are exactly the ones worth asking claude/copilot about, so a session started
        // outside fleetview in one of them joins the roster on the next poll. No-op when no backend
        // beyond opencode is active, which is the default.
        for (const name of activeBackends) {
          if (name === DEFAULT_BACKEND) continue
          await Promise.all(fresh.map((p) => streamBackend(name, p.worktree)))
        }
        // Re-reconcile the projects already streaming. Without this the only reconciliation paths
        // were first sight and a stream that dropped and came back — so a single lost
        // `session.status` frame on a healthy connection left a row animating "working" forever,
        // with no way back short of restarting fleetview. The seed is chained and watermarked, so a
        // periodic pass is safe; it just makes the state self-healing on the poll interval.
        for (const p of fresh) {
          if (!newOnes.includes(p) && seededProjectKeys.current.has(p.worktree)) {
            // A healthy poll: a session that has gone absent finished within the last interval, so
            // its run span can be closed. The reconnect path deliberately does not pass this — the
            // stream may have been down for an hour and the run may have ended at the start of it.
            // `additive`, not the default replace: the pending lists are refreshed by adding what
            // the server reports and the store lacks — a permission.asked/question.asked frame the
            // stream dropped — and never by deleting. See seedLiveState for why the authoritative
            // form must not run on a timer.
            chainSeed(p.worktree, { additive: true, closeRuns: true, relist: true })
          }
        }
      } catch {
        // transient listProjects failure — try to recover the server itself before the next poll tick
        try {
          const r = await ensureServerImpl(server)
          if (cancelled) return
          if (!r.ok) {
            setServerDown(true)
          } else if (r.server.port === server.port) {
            setServerDown(false) // same port came back healthy — streams self-recover
          } else {
            // ensureServer fell back to a different port and already persisted it to server.json —
            // remount on it rather than performing live client/stream surgery here.
            onAction({ type: 'reconnect' })
            exit()
          }
        } catch {
          if (!cancelled) setServerDown(true)
        }
      } finally {
        polling = false
      }
    }

    if (serverReady) {
      ;(async () => {
        await refreshProjects()
        if (cancelled) return
        intervalId = setInterval(refreshProjects, projectPollMs)
      })()
    }

    return () => {
      cancelled = true
      if (intervalId) clearInterval(intervalId)
      conns.current.forEach((c) => c.stop())
      conns.current.clear()
      backendConns.forEach((c) => c.stop())
      backendConns.clear()
    }
  }, [])

  const isMember = (worktree: any, id: any) => hasSession(rosterState, worktree, id)

  // Worktree isolation: every dispatched session lives in its own git worktree, which opencode
  // publishes as a project of its own AND lists in its repository's `sandboxes`. Rows are grouped by
  // the repository throughout — a worktree is machinery for running the session safely, not a place
  // the user chose, and agent view likewise groups by directory while isolating underneath.
  // Sticky, not rebuilt from scratch: a worktree deleted server-side drops out of its repository's
  // `sandboxes` while its stale project record lives on (mergeProjects never drops — that is what
  // keeps an OFFLINE project's rows), and a fresh-only map would promote that record to a repo (#22).
  const parents = rememberSandboxes(knownSandboxes.current, projects)
  const repoOf = (projectKey: any) => displayProject(parents, projectKey)

  // Groups come from the projects list (not the store) so a freshly-discovered,
  // zero-session project is still visible in browse.
  // Every view derives from this map, so decorating here is the one place a session learns about its
  // pull requests — the roster row, the state groups, peek and the `#N` filter all read
  // `session.prs` and none of them knows `gh` exists. `prs` is always an array so no consumer needs
  // a guard.
  const prsFor = (projectKey: any) => {
    const branch = pullRequests.branches.get(projectKey)
    // Same composite key refreshPullRequests wrote: the repository that owns this directory plus
    // the branch it is on, so a matching branch name in another repository can never answer.
    return (branch && pullRequests.byBranch.get(`${repoOf(projectKey)} ${branch}`)) || []
  }
  const memberOf = (projectKey: any, id: any) => rosterState.sessions.find((m) => m.worktree === projectKey && m.id === id)
  // The same lookup off the ref rather than the render closure, for the optimistic-delete paths: by
  // the time one of those runs, earlier rows in the same loop have already changed the roster, and
  // the member it is about to remove has to be the one that is actually there.
  const takeMember = (projectKey: any, id: any) => rosterRef.current.sessions.find((m: any) => m.worktree === projectKey && m.id === id)
  const byProjectSessions = new Map<string, any[]>(
    store.byProject().map((g: any) => [
      g.projectKey,
      g.sessions.map((s: any) => {
        const m = memberOf(s.projectKey, s.id)
        // `backend` is only ever set for a row that isn't opencode's — absent is the default, so an
        // opencode-only roster carries no new field and nothing downstream changes shape.
        const backend = sessionBackends.current.get(`${s.projectKey}:${s.id}`)
        return { ...s, prs: prsFor(s.projectKey), pinned: Boolean(m?.pinned), rank: m?.rank, ...(backend ? { backend } : {}) }
      }),
    ]),
  )
  // The same sessions, gathered under the repository that owns them rather than the worktree they
  // physically run in. Every group view reads this; only dispatch and the API calls use the real
  // per-session projectKey, which never changes.
  const byRepoSessions = new Map<string, any[]>()
  for (const [projectKey, list] of byProjectSessions) {
    const repo = repoOf(projectKey)
    byRepoSessions.set(repo, [...(byRepoSessions.get(repo) ?? []), ...list])
  }
  for (const list of byRepoSessions.values()) list.sort((a: any, b: any) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || b.updatedAt - a.updatedAt)
  // Every roster member's session — the whole fleet, before any filter, fold or view switch narrows
  // it to what is on screen. The notification snapshot and the two counts below read this and never
  // the rendered rows: a row leaving and re-entering the view is not a state change, but read off
  // the rendered set it looks exactly like one. Typing `s:working` in the dispatch input and pressing
  // esc used to re-fire `agent_needs_input` for every already-blocked session — bell and the user's
  // FLEETVIEW_NOTIFY_CMD — and `^b` did the same. It also kept the header honest: the counts used to
  // fall to zero under a filter while the roster beside them still listed the sessions.
  const allMembers = [...byProjectSessions.values()].flat().filter((s: any) => isMember(s.projectKey, s.id))
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
  const projectDirs = new Set(projects.map((p: any) => p.worktree))
  const vanishedProject = (worktree: string) =>
    projectsListed.current && !projectDirs.has(worktree) && !knownWorktrees.current.has(worktree)
  const ghostMembers = rosterState.sessions
    .filter((m: any) => !offlineProjects.has(m.worktree) && (seededProjectKeys.current.has(m.worktree) || vanishedProject(m.worktree)))
    .filter((m: any) => !(byProjectSessions.get(m.worktree) ?? []).some((s: any) => s.id === m.id))
    .map((m: any) => ({
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
    new Set([...byProjectSessions.values()].flat().map((s: any) => s.backend ?? DEFAULT_BACKEND)).size > 1
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
  const repos = useMemo<any[]>(() => repoChoices({ cwd, projects: repoProjects }), [cwd, projectKeys])
  const vocab: any = {
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
  const agentOf = (s: any) => s.agent
  const promptOf = (s: any): string | undefined => rosterState.sessions.find((m) => m.worktree === s.projectKey && m.id === s.id)?.prompt as string | undefined

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
          updateRoster((prev: any) => withoutMember(prev, m.worktree, m.id))
          await client.deleteSession(m.id, m.worktree)
          store.apply(m.worktree, { type: 'session.deleted', properties: { info: { id: m.id } } })
        } catch {
          // Put it back: a failed delete must not orphan a running server-side session invisibly.
          // The whole member, not a `{ shell: true }` stand-in — same reason as deleteGroup's
          // rollback: a rebuilt member loses the row's pin, rank and prompt.
          updateRoster((prev: any) => withMember(prev, m.worktree, m.id, m))
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
    const isHeld = (s: any) => held?.key === `${s.projectKey}:${s.id}`
    const groupFor = (s: any) => (isHeld(s) ? held!.held!.group : STATE_GROUPS.find((g) => g.match(s))?.key)
    const sortTime = (s: any) => (isHeld(s) ? held!.held!.updatedAt : s.updatedAt)
    return STATE_GROUPS.map((g) => ({
      projectKey: `state:${g.key}`,
      repoName: g.label,
      empty: g.key !== 'pinned', // status groups keep their placeholder shape; pinned only exists with members
      hint: g.hint, // shown under the section when it is empty

      sessions: members
        .filter((s: any) => groupFor(s) === g.key)
        // A manual rank (Shift+↑/↓) wins outright — the user placed the row there. Unranked rows
        // keep the old order: fold-protected rows first inside `completed` (the fold cuts from the
        // end, and a failure or a live pull request must survive it), then recency.
        .sort(
          (a: any, b: any) =>
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
          (byRepoSessions.get(p.worktree) ?? []).filter((s: any) => isMember(s.projectKey, s.id)),
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
  const keyOf = (row: any) => `${row.projectKey}:${row.id}`
  const keyedIndex = navRows.findIndex((r) => r.key === selectedKey)
  // The key went stale — either the selected session moved groups (its key is namespaced by the
  // group, so stopping a running session renames its row out from under the selection) or the row
  // is really gone. Re-resolve by identity first: without this the selection silently jumps to the
  // first session in the list, and a second Ctrl+X lands on an unrelated running session (#18).
  const navIndex =
    keyedIndex >= 0
      ? keyedIndex
      : navRows.findIndex(
          (r: any) =>
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
    const match = navRows.find((r: any) => r.type === 'session' && r.session.id === pendingSelect.id && r.session.projectKey === pendingSelect.projectKey)
    if (match) {
      setSelectedKey(match.key)
      return setPendingSelect(null)
    }
    // Not drawn. A row hidden inside a collapsed group gets its group opened, and the request
    // stays alive to resolve on the next render — "with that row already selected" (agent view)
    // means visibly selected. A session in no group at all is gone, and a visible-but-folded row
    // (the `… N more` cap) can't be landed on either way; both drop the request rather than pin
    // this effect forever.
    const holder = groups.find((g: any) => (g.sessions ?? []).some((x: any) => x.id === pendingSelect.id && x.projectKey === pendingSelect.projectKey))
    if (holder && collapsed.has(holder.projectKey)) return toggleCollapsed(holder.projectKey)
    setPendingSelect(null)
  }, [pendingSelect, navRows])
  const selectedHeader = navRow?.type === 'header' ? navRow.projectKey : null
  const found = flat.findIndex((row: any) => keyOf(row) === selectedKey)
  // Falls back to the top row when the selected session is gone (deleted, filtered out by a view
  // switch, or never set), which is also what makes the first ↑/↓ after startup work.
  const sel = found >= 0 ? found : 0
  const current = selectedHeader ? undefined : navRow?.type === 'session' ? navRow.session : flat[sel]
  const memberKeySet = new Set(rosterState.sessions.map((s: any) => `${s.worktree}:${s.id}`))
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
    persistRoster?.(updated)
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
  const attach = (row: any) => {
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
        .filter((s: any) => !s.ghost)
        .map((s: any) => ({ id: s.id, projectKey: s.projectKey, ...(s.backend ? { backend: s.backend } : {}) })),
    })
    if (done && typeof done.then === 'function') {
      attachedRef.current = true
      setAttached(true)
      const back = (result?: any) => {
        resumedAt.current = Date.now()
        attachedRef.current = false
        setAttached(false)
        // A detach (not an exit) leaves a conversation running in the background: remember it,
        // select its row, and show the one-line notice above the list. The host reports which
        // session was current on detach — Alt+N may have switched away from `row`.
        if (result?.detached) {
          const left = { id: result.sessionId ?? row.id, projectKey: result.worktree ?? row.projectKey, notice: true }
          setBackgrounded(left)
          // Selection by identity, not by a precomputed key: row keys are namespaced by whatever
          // grouping is live (`state:waiting` in the default view, the worktree in project view),
          // so a `${worktree}:${id}` template only matches one of the two. The effect below
          // resolves the id against the real rows.
          setPendingSelect({ id: left.id, projectKey: left.projectKey })
        }
        // An attach that failed without drawing anything is otherwise indistinguishable from a
        // keypress that didn't register.
        if (result?.message) flash(result.message, 4000)
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
    const named = repo && repos.find((r: any) => r.name === repo)?.worktree
    // The repository the user asked for. `pickTarget` sees only repoProjects, so a bare dispatch
    // can never land in someone else's worktree.
    return (
      named ??
      pickTarget({ cwd, projects: repoProjects, current: current && { ...current, projectKey: repoOf(current.projectKey) }, groupBy: rosterState.groupBy })
    )
  }

  // A dispatch onto a process-backed CLI. Deliberately a separate path rather than a generalisation
  // of the opencode one below: that path carries worktree isolation, shell jobs, a provisional title
  // written between createSession and promptAsync, and a listSessions refresh — all of it opencode's
  // own machinery, and all of it covered by a test corpus that must keep passing unchanged. What is
  // shared is what is genuinely shared (target resolution, roster membership, the notice).
  const dispatchOnBackend = async (name: string, rawText: string, { thenAttach = false, agent, repo, shell = false }: any = {}) => {
    const backend = backendRegistry[name]
    if (!backend) return flash(`no ${name} backend`)
    // `!` is opencode's shell-job route (POST /session/:id/shell); a process-backed CLI has no
    // equivalent, and quietly sending the command as a prompt would run something else entirely.
    if (shell) return flash(`! shell jobs run on opencode — ${name} has no shell surface`, 4000)
    const text = expandPastes(rawText)
    const target = dispatchTarget(repo)
    if (!target) return flash('no projects discovered yet')
    if (!dirExistsImpl(target)) return flash(`${basename(target) || target} no longer exists`)
    const typed = input
    setInput('')
    try {
      // Streaming starts before the dispatch, not after: the run can finish inside the poll interval
      // and a subscription attached afterwards would miss the whole of it.
      await activateBackendRef.current?.(name)
      const ref = await backend.dispatch({
        prompt: text,
        directory: target,
        agent: agent ?? initialAgent ?? undefined,
        // `--model` on these CLIs takes their own model name (`sonnet`, `gpt-5`), not opencode's
        // provider/model pair, so only the model half travels. A provider that means nothing to the
        // target CLI would be rejected argv rather than a useful default.
        model: dispatchModel?.id ?? undefined,
      })
      noteBackend(target, ref.id, name)
      store.setProvisionalTitle(target, ref.id, text)
      // `backend` rides the membership so a restart knows which CLI this row belongs to before any
      // event has arrived — the same soft-migration shape as every other member field (absent means
      // opencode).
      updateRoster((prev: any) => withMember(prev, target, ref.id, { prompt: text.slice(0, 2000), backend: name }))
      if (thenAttach) attach({ id: ref.id, projectKey: target, backend: name })
      // No worktree isolation: creating one is opencode's `/experimental/worktree`, and there is no
      // equivalent to ask claude or copilot for. Said out loud in the notice rather than left for the
      // user to discover from a dirty checkout.
      else flash(`dispatched into ${basename(target) || target} on ${name} — it edits the checkout`, 5000)
    } catch {
      setInput((current) => (current === '' ? typed : current))
      flash(`${name} dispatch failed`)
    }
  }

  const dispatch = async (rawText: string, { thenAttach = false, agent, repo, shell = false, backend }: { thenAttach?: boolean; agent?: string; repo?: string; shell?: boolean; backend?: string } = {}) => {
    // Everything below this line is the opencode path, untouched. A dispatch is only diverted when
    // something actually named another backend — `@claude`, or a launch default — so the opencode
    // behaviour this whole phase must not change is reached by exactly the code that reached it
    // before.
    const backendName = backend ?? initialBackend
    if (backendName !== DEFAULT_BACKEND) return dispatchOnBackend(backendName, rawText, { thenAttach, agent, repo, shell })
    const text = expandPastes(rawText)
    // A `@agent` prefix on this dispatch wins; otherwise fall back to the launch --agent default.
    // Coalesce to undefined (not null) when neither is set — createSession omits the field entirely.
    const effectiveAgent = agent ?? initialAgent ?? undefined
    const target = dispatchTarget(repo)
    if (!target) return flash('no opencode projects discovered yet')
    // A target can outlive the directory (#22): a project record survives the listing that dropped
    // it, so a deleted session's worktree is still nameable, and dispatching into one is accepted
    // silently — the server creates a session against a path that is gone. Refuse before anything is
    // created, and before `setInput('')`, so the prompt is still in the input to retarget.
    if (!dirExistsImpl(target)) return flash(`${basename(target) || target} no longer exists`)
    const typed = input // put it back if the dispatch fails; retyping a lost prompt is miserable
    let dispatched = false
    setInput('')
    // Where the session will actually run. Isolation happens before the session exists, so there is
    // no window in which it could edit the shared working copy: agent view moves a background
    // session into its own worktree "before editing files", and this is fleetview's version of that.
    let worktree = target
    let isolated = false
    try {
      // isolate=false (FLEETVIEW_NO_ISOLATE) skips the worktree entirely — the session edits the
      // checkout directly, agent view's `bgIsolation: "none"`. Isolation stays the default.
      if (isolate && shouldIsolate(target, projects, parents)) {
        try {
          // GET /experimental/worktree returns objects ({name, directory}), and worktreeName takes
          // directory strings — passing the objects threw a TypeError into the silent catch below,
          // so every dispatch after the repo's first worktree ran unisolated. `?? w.name` because a
          // row without a directory still names a taken slot.
          const existing = ((await client.listWorktrees(target)) ?? []).map((w: any) =>
            typeof w === 'string' ? w : w?.directory ?? w?.name ?? '',
          )
          const created = await client.createWorktree(worktreeName(text, existing), target)
          if (created?.directory) {
            worktree = created.directory
            isolated = true
            // Stream it immediately rather than waiting for the poll to notice a new project —
            // this is the row the user is about to watch start.
            await streamProjectRef.current?.(worktree)
          }
        } catch {
          // Isolation is a safety measure, not a precondition. A server too old for
          // /experimental/worktree, or one that refuses, must not cost the user their dispatch —
          // it runs in the repository itself, exactly as it did before isolation existed. Said in
          // the dispatch confirmation rather than as its own notice, which the confirmation would
          // overwrite a few milliseconds later — a warning nobody can read is not a warning.
        }
      }
      const session = await client.createSession({ agent: effectiveAgent, model: dispatchModel }, worktree)
      // opencode names the session itself once the first turn lands; until then the row would read
      // "New session - <timestamp>", so show what was asked for.
      store.setProvisionalTitle(worktree, session.id, shell ? `! ${text}` : text)
      // membership added immediately after createSession succeeds, before promptAsync —
      // dispatch counts as "backgrounded" even if the prompt itself later fails.
      // The prompt rides the membership (capped — a pasted wall of text is not a lookup key) so
      // a pasted URL can find this session later, agent view's any-URL filter.
      updateRoster((prev: any) =>
        withMember(prev, worktree, session.id, { ...(shell ? { shell: true } : {}), prompt: text.slice(0, 2000) }),
      )
      if (shell) await client.runShell(session.id, text, worktree, agent ?? 'build')
      else await client.promptAsync(session.id, text, worktree)
      // Past this point the session exists and is running. Anything that fails from here is a
      // refresh problem, not a dispatch problem — handing the prompt back would invite the user
      // to dispatch a second identical session.
      dispatched = true
      seededProjectKeys.current.add(worktree)
      store.setSessions(worktree, await client.listSessions(worktree), seen)
      setOfflineProjects((s) => {
        const next = new Set(s)
        next.delete(worktree)
        return next
      })
      // Say where it went. An `@name` that matches no repository stays in the prompt and the
      // dispatch falls back to another project, which is otherwise invisible until you notice the
      // row is in the wrong place.
      if (thenAttach) attach({ id: session.id, projectKey: worktree })
      // Names the repository: the worktree path is a hashed cache directory that means nothing to
      // the user, and the repository is what they actually chose. When isolation was expected and
      // did not happen, the row is editing the shared checkout — worth knowing before a second
      // dispatch lands in the same place.
      else if (!isolated && shouldIsolate(target, projects, parents)) {
        // A worktree was wanted but the row edits the checkout — either isolation is off
        // (FLEETVIEW_NO_ISOLATE, a deliberate choice) or the server couldn't make one (a warning).
        const why = isolate ? 'not isolated, it edits the checkout' : 'isolation off, it edits the checkout'
        flash(`dispatched into ${basename(target) || target} — ${why}`, 5000)
      } else flash(`dispatched into ${basename(target) || target}`)
    } catch {
      setOfflineProjects((s) => new Set(s).add(worktree))
      if (dispatched) return flash('session started, but the project list is stale')
      // Only restore into an input the user hasn't started refilling: a dispatch can be in flight
      // for up to the client's 10s timeout, and overwriting a half-typed prompt with the failed
      // one is worse than losing it.
      setInput((current) => (current === '' ? typed : current))
      flash('dispatch failed — project marked offline')
    }
  }

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
            updateRoster((prev: any) => withMember(prev, row.projectKey, forked.id, parsed.args ? { prompt: parsed.args.slice(0, 2000) } : {}))
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
      const provider = providers.find((p: any) => p.id === providerID)
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
  const removeWorktreeFor = async (projectKey: any, deletedId: any) => {
    if (!isSandbox(parents, projectKey)) return
    const repo = parents.get(projectKey)
    // Only when it was the last session in that worktree. Adopting a second session into one is
    // unusual, but removing the directory out from under it would not be recoverable.
    //
    // Counted by excluding the id just deleted rather than by trusting the count to have gone
    // down. `byProjectSessions` belongs to the render this keypress came from, so whether it has
    // already dropped the deleted row depends on whether React re-rendered during the await — and
    // a guard whose correctness turns on that is a guard waiting to break.
    const remaining = (byProjectSessions.get(projectKey) ?? []).filter((s: any) => s.id !== deletedId).length
    if (remaining > 0) return
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
  const toggleCollapsed = (projectKey: any) =>
    updateRoster((prev) => {
      const list = prev.collapsed ?? []
      return {
        ...prev,
        collapsed: list.includes(projectKey) ? list.filter((k: any) => k !== projectKey) : [...list, projectKey],
      }
    })

  // "Ctrl+X on a group header deletes every session in the group (confirmation required)." The
  // confirmation is the same two-press arm the per-session form uses, keyed on the group — one
  // deliberate mechanism rather than a modal for one case and an arm for the other.
  const deleteGroup = async (projectKey: any) => {
    // unfoldedGroups, not groups: the rendered groups are folded/sliced to the screen, so this used
    // to delete (and count) only the visible subset — folded completed rows and browse rows past the
    // cap survived, contradicting "every session in the group".
    const group = unfoldedGroups.find((g: any) => g.projectKey === projectKey)
    const rows: any[] = group?.sessions ?? []
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
        updateRoster((prev: any) => withoutMember(prev, row.projectKey, row.id))
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
      updateRoster((prev: any) => withoutMember(prev, row.projectKey, row.id))
      try {
        await deleteRow(row)
        store.apply(row.projectKey, { type: 'session.deleted', properties: { info: { id: row.id } } })
        await removeWorktreeFor(row.projectKey, row.id)
      } catch {
        updateRoster((prev: any) => withMember(prev, row.projectKey, row.id, member))
        setOfflineProjects((s) => new Set(s).add(row.projectKey))
        flash('delete failed')
      }
    }
  }

  const stopOrDelete = async (row: any) => {
    // #34: nothing exists server-side, so there is nothing to abort, nothing to delete and no
    // worktree the session still owns — the only thing ^x can mean on a ghost is "drop the
    // membership". It takes effect on the first press rather than arming a confirmation: the
    // two-press gate exists to guard a destructive server call, and there is no server call.
    if (row.ghost) {
      updateRoster((prev: any) => withoutMember(prev, row.projectKey, row.id))
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
      updateRoster((prev: any) => withoutMember(prev, row.projectKey, row.id))
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
        updateRoster((prev: any) => withMember(prev, row.projectKey, row.id, member))
        setOfflineProjects((s) => new Set(s).add(row.projectKey))
        flash('delete failed')
      }
      return
    }
    const armedAt = Date.now()
    // Where the row is right now, before the abort marks it stopped — stateGroups holds it here
    // until the arm lapses so the confirming press targets a row that hasn't moved (#15).
    stopArm.current = { key: armKey, at: armedAt, held: { group: STATE_GROUPS.find((g) => g.match(row))?.key, updatedAt: row.updatedAt } }
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
  const handleMouse = (ev: any) => {
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
            sessions: prev.sessions.map((m: any) =>
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
          if (done && typeof done.then === 'function') {
            attachedRef.current = true
            setAttached(true)
            done.then(
              (edited: any) => {
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
        const group = unfoldedGroups.find((g: any) =>
          g.sessions.some((s: any) => s.id === current.id && s.projectKey === current.projectKey),
        )
        if (!group) return
        const idx = group.sessions.findIndex((s: any) => s.id === current.id && s.projectKey === current.projectKey)
        const target = key.upArrow ? idx - 1 : idx + 1
        if (target < 0 || target >= group.sessions.length) return
        const order = [...group.sessions]
        ;[order[idx], order[target]] = [order[target], order[idx]]
        return updateRoster((prev) => ({
          ...prev,
          sessions: prev.sessions.map((m: any) => {
            const at = order.findIndex((s: any) => s.projectKey === m.worktree && s.id === m.id)
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
          const live = allMembers.find((s: any) => s.id === backgrounded.id && s.projectKey === backgrounded.projectKey)
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
      initial: target.title,
      onCancel: () => {
        setMode('roster')
        setTarget(null)
      },
      onSubmit: async (title) => {
        setMode('roster')
        try {
          await client.renameSession(target.id, title, target.projectKey)
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

function RenameInput({ initial, onSubmit, onCancel }: { initial: string; onSubmit: (title: string) => void; onCancel: () => void }): any {
  const [text, setText] = useState(initial)
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) return onCancel()
    if (key.return) return text.trim() && onSubmit(text.trim())
    if (parseMouseEvents(input).length) return // mouse sequences are not text
    if (key.backspace || key.delete) setText((t) => graphemes(t).slice(0, -1).join(''))
    else if (input && !key.ctrl && !key.meta) setText((t) => t + input)
  })
  return React.createElement(Text, null, `Rename: ${text}█ (⏎ save · esc cancel)`)
}
