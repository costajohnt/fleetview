import { truncateGraphemes, stripControl } from './text-utils.ts'
import type { OpencodeEvent, OpencodeSessionStatus, PermissionAsked, QuestionAsked, PendingMeta, Session } from './types.ts'

// A pending request as the store keeps it: the wire payload plus the monotonic stamps fleetview
// adds on the way in (always set at insert time, hence required here — see apply/seed* below).
type Pending<T> = T & { __seq: number; __askedAt: number }

export type SessionStatus = 'waiting' | 'running' | 'error' | 'stopped' | 'done' | 'idle'

// The row shape publicView emits — what the roster/header/--json actually read.
export type SessionRow = {
  projectKey: string
  id: string
  title: string
  status: SessionStatus
  updatedAt: number
  createdAt: number
  agent: string | undefined
  pendingRequest: boolean
  waitingFor: 'permission prompt' | 'input needed' | undefined
  waitingSince: number
  ranForMs: number | null
  snippet: string
}

// The internal record kept per session. Pinned where we set concrete primitives; loose where the
// value is an opencode wire payload we deliberately don't pin.
type SessionRecord = {
  projectKey: string
  id: string
  title: string
  agent: string | undefined
  provisionalTitle: string
  lastStatus: string
  hasRun: boolean
  pendingPermissions: Map<string, Pending<PermissionAsked>>
  pendingQuestions: Map<string, Pending<QuestionAsked>>
  lastAssistantText: string
  snippetCache: string
  lastQuestionText: string
  lastRole: string | undefined
  currentAssistantMessageID: string | undefined
  lastError: unknown // session.error's `error` (a union of opencode error schemas) or the sentinel `true`; only tested for truthiness
  updatedAt: number
  createdAt: number
  runStartedAt: number
  runEndedAt: number
  errorAtServerUpdated: number
  serverUpdatedAt: number
  listed: boolean
  stopped: boolean
  statusSeq?: number
  // The `seq` at which something last REMOVED pending entries from this record — a
  // permission.replied, a question.replied/rejected, or the idle transition that clears both maps.
  // Only the additive seed reads it, and it is the answer to the resurrection race: an additive
  // seed carries a snapshot taken at `mark`, and any removal stamped >= mark happened after that
  // snapshot was taken, so re-adding from it would resurrect a request the user has already
  // answered. The plain `__seq` watermark cannot cover this on its own — it stamps entries that
  // EXIST, and the whole problem here is an entry that no longer does, so there is nothing left to
  // read a stamp off of. Hence one number on the record instead. Deliberately per-record rather
  // than per-id: a tombstone map per answered id would grow without bound for the sake of letting
  // one record take an additive add in the same tick another of its requests was answered. Coarse
  // costs one poll interval of delay in that rare overlap; unbounded memory costs forever.
  pendingClearedSeq: number
  // Which backend's facts this record is made of, for records that aren't opencode's (absent means
  // opencode). The store stays backend-blind about *meaning* — every rule below is still opencode's
  // semantics — but the three seeds treat one opencode GET as the full truth for a projectKey, and a
  // claude/copilot row shares that key while never appearing in those payloads. Without the tag the
  // seeds sweep a running `@claude` row to idle and delete its synthetic "needs input" permission.
  origin?: string
}

// The statuses `derive` below can mint that mean "this session is not going to do anything else on
// its own". Exported and shared because the same question is asked in four places — the roster's
// `completed` group, the header's count, the shell-job auto-clean, and whether a run duration is
// meaningful — and four private copies is four chances for one to drift and quietly disagree with
// the row next to it. `idle` belongs here: a session that isn't blocked and isn't running is, for
// the user's purposes, finished — it just never started.
export const FINISHED_STATUSES = new Set(['done', 'error', 'stopped', 'idle'])

// "Did the agent end by asking something?" — a guess, not a signal. Two things it must not do:
// mistake code for a question, and mistake a rhetorical sign-off for a blocked session.
//
// Stripping backticks used to reduce a reply ending in a fenced code block to that block's last
// line, so a trailing regex or ternary read as a question. Now a reply whose tail is code is not
// treated as one at all, and the mark has to end a plain-prose line.
const isQuestion = (text: string) => {
  if (!text) return false
  const trimmed = text.replace(/[\s*_]+$/, '')
  if (!trimmed.endsWith('?')) return false
  const rawLastLine = trimmed.slice(trimmed.lastIndexOf('\n') + 1)
  // Tested before trimming: markdown's other code form is four spaces or a tab of indent, and
  // trimming first removed exactly the evidence. `var name: String?` at the end of an indented
  // block is ordinary prose about optionals, not a question.
  if (/^(\s{4,}|\t)/.test(rawLastLine)) return false
  return !rawLastLine.trim().startsWith('```')
}

// opencode's placeholder name for a session it hasn't titled yet, e.g.
// "New session - 2026-07-22T19:51:37.625Z". Its real name arrives ~20s later via session.updated,
// written by its own small model. Until then fleetview shows the dispatch prompt, so a fresh row says
// something useful instead of a timestamp — the same trade agent view makes by naming from the
// prompt immediately and letting a better name replace it.
// Sentinel for "an error was recorded but its server timestamp isn't known yet". The first
// refresh after the error adopts whatever the server reports; only a later bump retires it.
const ERROR_ANCHOR_UNKNOWN = -1

const isPlaceholderTitle = (title: string) => !title || /^New session - \d{4}-/.test(title)

// M5: grapheme-safe — a raw slice(0, 80) can chop a surrogate pair in half at the boundary.
// I1: pre-slice to 640 code units BEFORE the whitespace collapse + grapheme truncation — a 200KB
// streamed reply must never have its full text regex-replaced or segmented just to keep 80 chars.
// 640 is a generous 8x the 80-grapheme output cap, covering any run of whitespace collapsing away.
const snippet = (text: string) => (text ? truncateGraphemes(stripControl(text.slice(0, 641).replace(/\s+/g, ' ').trim()), 80) : '') // 641: an odd cut mid-surrogate is absorbed by grapheme truncation. stripControl: this string reaches the CLI stdout raw (`ls`), so escape bytes must go before it can drive the terminal

// permission.asked's verified shape is {id, sessionID, permission, patterns, metadata, always,
// tool?} — there is no title/description field, so build the label from `permission` (+ patterns
// when present) and only fall back to the id when `permission` itself is missing.
// stripControl for the same reason `snippet` strips: permission names and patterns are the agent's
// own strings off the wire, they reach raw stdout via `fleetview ls`, and Ink passes OSC 8 and DCS
// straight through to the terminal in the TUI.
//
// Lives here rather than in ui/peek.ts (where it was born) because the roster row now previews the
// same request the peek banner does, and the store is the module that owns these payloads —
// pendingFor/pendingQuestionsFor hand out exactly this shape. ui importing core is the right
// direction; core importing ui would drag React and Ink into `fleetview ls`.
export const permissionLabel = (p: any) => stripControl(p.permission ? `${p.permission}${p.patterns?.length ? ` ${p.patterns.join(', ')}` : ''}` : p.id)

// Verified against opencode 1.18.4's OpenAPI: question.asked is {id, sessionID, questions:
// [{question, header, options: [{label, description}], multiple, custom}], tool?}. Earlier code
// guessed `text`/`label` for the prompt; the field is `question`. Only the first sub-question of
// the oldest request is shown, and its options are what the number keys pick.
export const questionLabel = (q: any) => {
  const first = q.questions?.[0]
  return stripControl(first?.question ?? first?.header ?? q.tool ?? q.id)
}

// The entry with the lowest __seq — the one the user has actually been waiting on longest, and the
// one peek offers to answer. Not `values().next()`: I3's rollback path deletes and reinserts, so
// Map order alone can't be trusted (same reason pendingFor sorts).
const oldestPending = <T>(m: Map<string, Pending<T>>): Pending<T> | undefined => {
  let best: Pending<T> | undefined
  for (const e of m.values()) if (!best || e.__seq < best.__seq) best = e
  return best
}

// #7: what the row previews while the server has actually reported a pending request. The bug this
// fixes: `snippetCache` is the last assistant *text*, and question.asked/permission.asked never
// touch it — so a session blocked on a question kept previewing whatever tool-progress line the
// model printed last, and the row read as working while the header correctly counted it as
// awaiting input. Both signals were right about the state and the row still said the opposite.
//
// Permissions rank above questions, the same precedence `waitingFor` uses, so the two can never
// disagree about which request is the one blocking the session.
//
// Prefixed with the same words peek's banners use (`permission:` / `question:`) but WITHOUT peek's
// `⚠` / `?` glyphs: the row already carries a status marker in its badge, so a second glyph is
// redundant, while the word is not — "bash git push --force" previews as a statement unless
// something says it is a permission being requested.
//
// Run through `snippet` like the assistant text is: same whitespace collapse (a multi-line question
// has to render as one row), same 80-grapheme cap, same stripControl. The row then truncates it
// through the ordinary `snippetBudget` path, so a long question can't break the layout.
// Returns null — not '' — so publicView can tell "no pending request" from "a request that labelled
// to nothing" and fall back to the snippet only in the first case.
const pendingSnippet = (r: SessionRecord): string | null => {
  const perm = oldestPending(r.pendingPermissions)
  if (perm) return snippet(`permission: ${permissionLabel(perm)}`)
  const q = oldestPending(r.pendingQuestions)
  if (q) return snippet(`question: ${questionLabel(q)}`)
  return null
}

export function createStore() {
  const sessions = new Map<string, SessionRecord>() // `${projectKey}:${id}` → record
  // Sessions opencode reports as children of another session — the `task` tool's subagents. Agent
  // view does not list them ("subagents and teammates a session spawns aren't listed as separate
  // rows"), and `setSessions` skips them, but that is only one of eight ways a record gets created:
  // session.status, permission.asked, question.asked, session.error and all three seeds go through
  // `upsert`, which sees an id and nothing else. Verified live: a child appears in GET /session,
  // in GET /session/status while it runs, and its events arrive on the parent project's stream —
  // so every one of those paths was minting ghost rows that browse displayed, `^a` could adopt
  // permanently, and the bell and tab title counted.
  //
  // Learning ids here covers every path at once, including any added later: `upsert` refuses a
  // known child outright, so no event or seed can re-create the record `setSessions` just pruned.
  //
  // The one remaining window is a child fleetview has never listed — a subagent spawned since the last
  // `GET /session`, whose first event arrives before fleetview has any way to know what it is. That
  // record is pruned by the next listSessions, which App now runs on the project poll rather than
  // only at first sight and on reconnect, so the window really is one poll interval wide.
  const childIds = new Set<string>()
  const listeners = new Set<() => void>()
  const key = (projectKey: string, id: string) => `${projectKey}:${id}`
  const notify = () => listeners.forEach((fn) => fn())
  // M5/I2: monotonic stamp on pendingPermissions/pendingQuestions entries. pendingFor uses it to
  // return the true asked order even after a delete+reinsert (I3's rollback path) — Map
  // re-insertion order alone can't survive that round trip. I2 also uses it as a watermark: a
  // seed reseed can tell "existed before this seed started" (safe to drop if the fresh list
  // doesn't have it) from "arrived live while the seed GET was in flight" (must survive).
  let seq = 0

  // Returns undefined for a session already known to be a subagent, so no path can re-create a
  // record for one. Filtering only the derived views was not enough: `setSessions` prunes the ghost,
  // and then the very next `seedStatuses` over a status map that still lists the running child put
  // it straight back. Every caller has to handle undefined — that is the point, it is the one place
  // the rule can be enforced for paths that don't exist yet.
  const upsert = (projectKey: string, id: string): SessionRecord | undefined => {
    if (childIds.has(id)) return undefined
    const k = key(projectKey, id)
    if (!sessions.has(k)) {
      sessions.set(k, {
        projectKey,
        id,
        title: id,
        agent: undefined,
        provisionalTitle: '', // the dispatch prompt, shown until opencode names the session
        lastStatus: 'idle',
        hasRun: false,
        pendingPermissions: new Map(),
        pendingQuestions: new Map(),
        lastAssistantText: '',
        snippetCache: '', // I1: computed at write time (message.part.updated), publicView just reads it
        lastQuestionText: '', // I2: mirrors lastAssistantText but cleared on a user reply, so an
        // answered question can't resurrect the "?" heuristic once a fresher user message lands.
        lastRole: undefined,
        currentAssistantMessageID: undefined, // M7: part attribution keys on this, not lastRole
        lastError: null,
        updatedAt: Date.now(),
        createdAt: 0, // 0 = unknown; only listSessions carries session.time.created
        runStartedAt: 0, // when the current/last run began; 0 when fleetview never saw it start
        runEndedAt: 0, // when it stopped running; paired with runStartedAt on one clock
        // The server's `time.updated` as of the moment the error was recorded. Comparing the
        // server's later value against this keeps the staleness test on one clock; comparing a
        // local Date.now() against a server timestamp would retire errors early or never.
        errorAtServerUpdated: 0,
        serverUpdatedAt: 0, // last `time.updated` the server actually gave us
        // Whether this record has ever come out of a GET /session listing. Only those are eligible
        // for setSessions' retire sweep — see there for why a never-listed record must survive.
        listed: false,
        // Agent view's sixth state: "The session was stopped with Ctrl+X or claude stop". The
        // server reports a stopped session as plain idle, so this is fleetview-side memory of the
        // abort — cleared the moment the session runs again.
        stopped: false,
        pendingClearedSeq: 0, // nothing has been answered on a record that has just been created
      })
    }
    return sessions.get(k)
  }

  // When the oldest still-outstanding request arrived, or 0 when nothing is outstanding. Seeded
  // entries are stamped when fleetview first saw them, which is the most it can honestly claim about a
  // request that was already pending before it connected.
  const oldestAskedAt = (r: SessionRecord) => {
    let oldest = 0
    for (const entry of [...r.pendingPermissions.values(), ...r.pendingQuestions.values()]) {
      const at = entry.__askedAt ?? 0
      if (at > 0 && (oldest === 0 || at < oldest)) oldest = at
    }
    return oldest
  }

  // A run is open when it has a recorded start that nothing has closed yet. `runEndedAt` is reset
  // to 0 at each new start, so a stale end from a previous run can never make this look closed.
  const isRunOpen = (r: SessionRecord) => r.runStartedAt > 0 && r.runEndedAt < r.runStartedAt

  const derive = (r: SessionRecord): SessionStatus => {
    if (r.pendingPermissions.size > 0 || r.pendingQuestions.size > 0) return 'waiting'
    // `running` deliberately outranks `error`: while the server still reports the session busy, it
    // is working, and saying so is the honest answer. An error raised mid-turn surfaces the moment
    // the turn ends. The alternative — error winning — would freeze a row as `failed` while work
    // is visibly continuing, which is the worse lie.
    if (r.lastStatus === 'busy' || r.lastStatus === 'retry') return 'running'
    if (r.lastError) return 'error' // I2: error outranks a stale "?" heuristic
    // Ranks below error but above done: a stopped session did run, and "stopped" is the more
    // specific truth about why it isn't running now. It never outranks a live pending request,
    // because a stop that left a permission outstanding still needs the user.
    if (r.stopped) return 'stopped'
    if (r.hasRun && isQuestion(r.lastQuestionText)) return 'waiting'
    if (r.hasRun) return 'done'
    return 'idle'
  }

  // Agent view's age "counts from when the session was created; a finished session's age freezes
  // at how long the run took". Both numbers are derived here so the row component stays dumb.
  const publicView = (r: SessionRecord): SessionRow => {
    const status = derive(r)
    return {
      projectKey: r.projectKey,
      id: r.id,
      // stripControl: the title comes from the model (opencode names sessions from the first prompt)
      // and reaches the CLI stdout raw via `ls`, so escape bytes must go before it can drive the terminal.
      title: stripControl(isPlaceholderTitle(r.title) && r.provisionalTitle ? r.provisionalTitle : r.title),
      status,
      updatedAt: r.updatedAt,
      createdAt: r.createdAt,
      agent: r.agent, // what `a:<name>` filters on; absent on sessions created before opencode tracked it
      // Whether `waiting` rests on a request the server actually reported, or on the question
      // heuristic. A guess is fine for sorting a row; it is not fine for ringing a bell or putting
      // a number in the terminal's tab title, so the difference has to survive to the caller.
      // Named for what it is rather than `blocked`, which is also the name of agent view's
      // `s:blocked` filter — and that one deliberately includes the heuristic.
      pendingRequest: r.pendingPermissions.size > 0 || r.pendingQuestions.size > 0,
      // What the session is blocked on, when it is blocked on a request the server actually reported:
      // a permission prompt or an input request. Undefined otherwise (including the prose-heuristic
      // waiting). Feeds `--json`'s waitingFor, agent view's `permission prompt` / `input needed`.
      waitingFor: r.pendingPermissions.size > 0 ? 'permission prompt' : r.pendingQuestions.size > 0 ? 'input needed' : undefined,
      // Agent view's peek shows a `waiting Nm` line, "different from the row's age" — the row's age
      // is how long the session has existed, this is how long it has been sitting on your answer.
      // Zero unless it is actually blocked on a request the server reported: the prose heuristic
      // has no moment it started, and inventing one would put a confident clock on a guess.
      // Derived from the entries themselves rather than kept as a field: a field would need
      // maintaining at nine separate mutation sites — set, delete, clear, and three seeds — and the
      // one that got missed would show a confident wrong number. The oldest outstanding request is
      // what the user is actually waiting on.
      waitingSince: oldestAskedAt(r),
      // How long the run took — measured from the run fleetview actually watched, not from the
      // session's creation. Those differ wildly for a session adopted from opencode's own TUI, or
      // one created an hour ago and stopped in seconds, where creation-to-last-activity would
      // report a one-hour "run". Both ends come from the same local clock, since subtracting a
      // server timestamp from a locally-stamped start mixes two clocks and the clamp that used to
      // hide that would silently render "0s". `>=` because a run inside one millisecond is a real
      // zero-length duration. When fleetview never saw the run begin this is null and the row falls
      // back to an age, rather than stating a duration it does not know.
      ranForMs: FINISHED_STATUSES.has(status) && r.runStartedAt > 0 && r.runEndedAt >= r.runStartedAt
        ? r.runEndedAt - r.runStartedAt
        : null,
      // A live pending request wins over the last assistant text (#7). Computed here rather than
      // cached in a field, which is the opposite of I1's treatment of `snippetCache` — and
      // deliberately so, for the same reason `waitingSince` is derived here: the pending maps are
      // mutated at nine sites (set, delete, clear, and three seeds), and a cached field is only as
      // good as the one mutation site nobody remembered to update. What I1 is protecting against is
      // re-collapsing and re-segmenting a 200KB streamed reply on every render; a pending label is
      // one short wire string, bounded by the same 80 graphemes this call already spends on
      // `stripControl(title)` and the loop in `oldestAskedAt`.
      snippet: pendingSnippet(r) ?? r.snippetCache, // I1: the fallback is computed once at write time, not recomputed on every render
    }
  }

  return {
    // `retire` opts a listing into being authoritative about what no longer exists: only then is a
    // record marked `listed`, and only then are vanished records swept. It is off by default because
    // `setSessions` has five callers and only one of them is serialized. See the sweep below.
    // `seen` is the persisted seen.json watermark map (fleetview's own shape, kept loose — out of
    // scope for wire typing); `list` is the opencode GET /session payload.
    setSessions(projectKey: string, list: Session[], seen: Record<string, any> | undefined, { retire = false }: { retire?: boolean } = {}) {
      for (const s of list) {
        // "Subagents and teammates a session spawns aren't listed as separate rows." opencode
        // models those as child sessions with a parentID, and GET /session returns them alongside
        // the real ones, so they have to be dropped here or one dispatch can litter the roster
        // with a row per subagent.
        if (s.parentID) {
          childIds.add(s.id)
          sessions.delete(key(projectKey, s.id)) // prune one an event path already created
          continue
        }
        const k = key(projectKey, s.id)
        const prev = sessions.get(k)
        const updatedAt = s.time?.updated ?? prev?.updatedAt ?? 0
        const persisted = seen?.[k]
        // Ran-while-away inference: persisted activity (flag or newer timestamp) means done, even
        // if this store instance has never seen the session before (post-restart). Known limit: any
        // server-side touch counts, so renaming a never-run session from opencode's TUI while fleetview
        // is closed will show it as completed. Treating a bump as "no run" instead would lose the
        // far more common genuine case, so the inference stays — it is stated here rather than
        // being a surprise.
        const hasRun = prev?.hasRun || Boolean(persisted && (persisted.hasRun || updatedAt > persisted.updated))
        // An error is the last word only until the session does something else. Activity recorded
        // after the error — a turn run from opencode's own TUI, or one fleetview missed while its
        // stream was down — retires it, instead of showing red forever for a session that
        // succeeded. Without this nothing but an observed `busy` ever cleared it.
        const incoming = s.time?.updated
        const anchorUnknown = prev?.errorAtServerUpdated === ERROR_ANCHOR_UNKNOWN
        // One step of patience: the first refresh after an error establishes the baseline (which
        // includes the error's own bump, however it was ordered), and only a bump beyond that
        // baseline counts as the session having done something since.
        const staleError =
          !anchorUnknown &&
          (prev?.errorAtServerUpdated as number) > 0 &&
          incoming !== undefined &&
          incoming > prev!.errorAtServerUpdated
        sessions.set(k, {
          projectKey,
          id: s.id,
          title: s.title ?? s.id,
          agent: s.agent ?? prev?.agent,
          provisionalTitle: prev?.provisionalTitle ?? '',
          lastStatus: prev?.lastStatus ?? 'idle',
          hasRun,
          pendingPermissions: prev?.pendingPermissions ?? new Map(),
          pendingQuestions: prev?.pendingQuestions ?? new Map(),
          lastAssistantText: prev?.lastAssistantText ?? '',
          snippetCache: prev?.snippetCache ?? '',
          lastQuestionText: prev?.lastQuestionText ?? '',
          lastRole: prev?.lastRole,
          currentAssistantMessageID: prev?.currentAssistantMessageID,
          lastError: staleError ? null : prev?.lastError ?? null,
          updatedAt,
          // Carried, not dropped: seedStatuses' two guards compare `statusSeq >= mark`, and an
          // undefined stamp fails both open. Losing it here let a stale seed mark a genuinely
          // running session idle, which renders as `completed` — the exact outcome the __seq
          // protocol exists to prevent, with no indication anything was stale.
          statusSeq: prev?.statusSeq,
          // Carried for the same reason as statusSeq: this path rebuilds the record wholesale, and
          // resetting it to 0 would fail the additive seed's guard open — re-arming exactly the
          // resurrection that guard exists to prevent, on any tick where a relist and a reply race.
          pendingClearedSeq: prev?.pendingClearedSeq ?? 0,
          runStartedAt: prev?.runStartedAt ?? 0,
          runEndedAt: prev?.runEndedAt ?? 0,
          errorAtServerUpdated: anchorUnknown && incoming !== undefined ? incoming : prev?.errorAtServerUpdated ?? 0,
          serverUpdatedAt: s.time?.updated ?? prev?.serverUpdatedAt ?? 0,
          createdAt: s.time?.created ?? prev?.createdAt ?? 0,
          // Only a retiring listing confers this. A refresh listing (dispatch, /fork) must not, or it
          // would arm the very record the sweep below must not touch — see there.
          listed: retire || (prev?.listed ?? false),
          stopped: prev?.stopped ?? Boolean(persisted?.stopped),
          // Carried like statusSeq: this path rebuilds the record wholesale, and a backend listing
          // (streamBackend re-lists every poll) would otherwise erase the tag the seeds check.
          origin: prev?.origin,
        })
      }
      // Retire records for sessions that have vanished from the listing. `session.deleted` is the
      // normal way a row goes away, but it is an event: miss it — a stream outage, exactly the
      // window this relist exists to cover — or delete the session from opencode's own TUI, and
      // the row is a ghost that survives until the process restarts.
      //
      // Only records that have themselves come out of a *retiring* listing are eligible. A blanket
      // "delete everything absent from the fresh list" deletes the row the user just created:
      // `dispatch` calls setProvisionalTitle and then relists, and a server listing a beat behind
      // omits the session that was created milliseconds ago. Same for any record minted by a live
      // event (session.status, permission.asked) since the last listing.
      //
      // The `listed` flag alone is not enough, and getting that wrong cost a session row. Five
      // callers reach setSessions and only one — seedLiveState's relist — is serialized (chainSeed
      // serializes it against itself, per worktree). So: a poll issues GET /session at T0; the user
      // dispatches at T0+ε and that path runs its own listing, which DOES contain the new session;
      // the stale T0 response then lands, lacks the session, and if its own listing had armed
      // `listed` the sweep would delete a session that is live and running. Restricting both the
      // arming and the sweep to the one serialized caller closes it: a refresh listing can neither
      // arm a record nor retire one, and two retiring listings for a project cannot overlap.
      //
      // Residual gap, stated rather than hidden: a session created and deleted entirely between two
      // retiring listings, known to fleetview only from its events, is never retired — the price of
      // never deleting a row that is genuinely live.
      //
      // After the upsert loop, so a payload that isn't a list throws above having deleted nothing.
      // An empty array is a real answer ("this project has no sessions"); `null` is not one.
      if (retire) {
        const listedIds = new Set(list.map((s) => s.id))
        for (const [k, r] of sessions) {
          if (r.projectKey === projectKey && r.listed && !listedIds.has(r.id)) sessions.delete(k)
        }
      }
      notify()
    },

    // `event` is one of the SSE bus events fleetview handles (OpencodeEvent). Each branch reads
    // `event.properties` after the `event.type` guard narrows the union, so the reads are typed.
    apply(projectKey: string, event: OpencodeEvent) {
      // The wire type says every event carries `properties`, but the SSE frame is cast unchecked at
      // the transport boundary (event-mux) — a version-skewed or foreign frame of a handled type
      // could arrive without it. Skip it rather than throw a TypeError the event loop would swallow
      // into a spurious offline+reconnect, restoring the pre-typing `properties ?? {}` robustness.
      if (!event.properties) return
      if (event.type === 'session.status') {
        const p = event.properties
        if (!p.sessionID) return
        const r = upsert(projectKey, p.sessionID)
        if (!r) return // a subagent's status is not a row
        // I2: stamped with the same monotonic counter as pendingPermissions/pendingQuestions so
        // seedStatuses' watermark can tell a live status applied after the seed's GET was issued
        // (must win) from one that's merely stale (safe to overwrite with the fresh snapshot).
        r.statusSeq = seq++
        const wasRunning = r.lastStatus === 'busy' || r.lastStatus === 'retry'
        r.lastStatus = p.status?.type ?? 'idle'
        if (r.lastStatus === 'busy') {
          r.hasRun = true
          r.lastError = null
          r.errorAtServerUpdated = 0
          r.stopped = false // running again retires the stop, however it was restarted
          // Only on the transition into running. opencode emits several `busy` frames per turn —
          // three in a captured trace — so restamping on each one made the duration measure from
          // the last frame instead of the start of the run.
          if (!wasRunning) {
            r.runStartedAt = Date.now()
            r.runEndedAt = 0
          }
          r.updatedAt = Date.now()
        }
        // M4: only an idle transition clears stale pending state — a session stays busy/retrying
        // while blocked on a still-outstanding permission or question, so busy must not wipe it.
        if (r.lastStatus === 'idle') {
          if (isRunOpen(r)) r.runEndedAt = Date.now() // closes the span ranForMs reports
          r.pendingPermissions.clear()
          r.pendingQuestions.clear()
          r.pendingClearedSeq = r.statusSeq as number // this clear is a removal; reuse the stamp taken above
        }
        notify()
      } else if (event.type === 'permission.asked') {
        const p = event.properties
        if (!p.sessionID) return
        const r = upsert(projectKey, p.sessionID)
        if (!r) return // a subagent's permission is answered in the parent's session, not on a row of its own
        r.pendingPermissions.set(p.id, { ...p, __seq: p.__seq ?? seq++, __askedAt: p.__askedAt ?? Date.now() })
        notify()
      } else if (event.type === 'permission.replied') {
        const p = event.properties
        if (!p.sessionID) return
        const r = sessions.get(key(projectKey, p.sessionID))
        if (!r) return
        r.pendingPermissions.delete(p.requestID)
        r.pendingClearedSeq = seq++ // an additive seed holding a snapshot older than this must not re-add
        notify()
      } else if (event.type === 'question.asked') {
        const p = event.properties
        if (!p.sessionID) return
        const r = upsert(projectKey, p.sessionID)
        if (!r) return // likewise for a subagent's question
        // I2: stamped with the same __seq counter as permissions so seedQuestions' watermark can
        // tell a pre-seed entry from one that arrived live while the seed GET was in flight.
        r.pendingQuestions.set(p.id, { ...p, __seq: p.__seq ?? seq++, __askedAt: p.__askedAt ?? Date.now() })
        notify()
      } else if (event.type === 'question.replied' || event.type === 'question.rejected') {
        const p = event.properties
        if (!p.sessionID) return
        const r = sessions.get(key(projectKey, p.sessionID))
        if (!r) return
        // Verified against opencode 1.18.4: question.replied carries {sessionID, requestID, answers}
        // per the OpenAPI document, and a live reply emitted exactly that. The `?? p.id` fallback
        // stays as cheap insurance against older servers, but it is no longer covering an unknown.
        r.pendingQuestions.delete(p.requestID ?? p.id)
        r.pendingClearedSeq = seq++ // as permission.replied above
        notify()
      } else if (event.type === 'session.error') {
        const p = event.properties
        if (!p.sessionID) return
        const r = upsert(projectKey, p.sessionID)
        if (!r) return // a subagent's failure surfaces through its parent
        r.lastError = p.error ?? true
        // UNKNOWN, not "the last value we happened to hear". Recording an error bumps the
        // session's server-side time.updated, and fleetview learns that value from a separate
        // session.updated frame. Measured against opencode 1.18.4 that frame arrives *before* the
        // error, so anchoring on the last known value works — but only by luck of ordering. Miss
        // that one frame and the anchor sits below the error's own timestamp, so the next refresh
        // reads the error's own bump as activity after itself and silently retires a real failure.
        // Adopting the first value observed after the error removes the dependency on ordering.
        r.errorAtServerUpdated = ERROR_ANCHOR_UNKNOWN
        notify()
      } else if (event.type === 'message.updated') {
        const p = event.properties
        const r = sessions.get(key(projectKey, p.sessionID))
        if (!r) return
        r.lastRole = p.info?.role
        if (p.info?.role === 'assistant') r.currentAssistantMessageID = p.info?.id
        else if (p.info?.role === 'user') r.lastQuestionText = '' // I2: retire a stale question on user reply
        notify()
      } else if (event.type === 'message.part.updated') {
        const p = event.properties
        const r = sessions.get(key(projectKey, p.sessionID))
        // M7: attribute by messageID against the tracked assistant message, not lastRole — a
        // role flip from an interleaved message.updated must not drop or misattribute a part.
        if (!r || p.part?.type !== 'text' || !r.currentAssistantMessageID || p.part?.messageID !== r.currentAssistantMessageID) return
        r.lastAssistantText = p.part?.text ?? ''
        r.snippetCache = snippet(r.lastAssistantText) // I1: computed once here, not per publicView call
        r.lastQuestionText = r.lastAssistantText
        notify()
      } else if (event.type === 'session.updated') {
        const p = event.properties
        const r = sessions.get(key(projectKey, p.info?.id))
        if (!r) return
        r.title = p.info.title ?? r.title
        if (p.info.time?.updated !== undefined) r.serverUpdatedAt = p.info.time.updated
        r.updatedAt = p.info.time?.updated ?? r.updatedAt
        notify()
      } else if (event.type === 'session.deleted') {
        const p = event.properties
        if (sessions.delete(key(projectKey, p.info?.id))) notify()
      }
      // all other bus events: ignore
    },

    get(projectKey: string, id: string) {
      if (childIds.has(id)) return undefined
      const r = sessions.get(key(projectKey, id))
      return r ? publicView(r) : undefined
    },

    // Tags a record as belonging to a backend other than opencode, so the seeds below — each of
    // which treats one opencode GET as the full truth for a projectKey — leave it alone. Called
    // from the same place App learns the fact (noteBackend), which covers every way a foreign row
    // arrives: its events, its listing, and the dispatch that created it.
    noteOrigin(projectKey: string, id: string, origin: string) {
      const r = upsert(projectKey, id)
      if (r) r.origin = origin
    },

    // The text fleetview shows on a freshly dispatched row until opencode's own name arrives. Kept
    // separate from `title` so the real name always wins the moment it lands, with no comparison
    // against whatever the user happened to type.
    setProvisionalTitle(projectKey: string, id: string, text: string) {
      const r = upsert(projectKey, id)
      if (!r) return
      r.provisionalTitle = text
      notify()
    },

    // Called after a successful abort. The server reports the result as plain idle, which is
    // indistinguishable from "finished normally", so fleetview has to remember that the user stopped
    // it — otherwise a stopped session renders as completed and reads like a result.
    markStopped(projectKey: string, id: string) {
      const r = sessions.get(key(projectKey, id))
      if (!r) return
      r.stopped = true
      if (isRunOpen(r)) r.runEndedAt = Date.now()
      r.updatedAt = Date.now()
      notify()
    },

    // M4: retires the "?"-heuristic waiting state after a successful abort — same effect as the
    // user-reply clear in apply('message.updated'), without needing a synthetic user message. A
    // no-op when the session still has a real pending permission/question (those aren't heuristic
    // and must survive the abort until the server actually clears them).
    clearHeuristicWaiting(projectKey: string, id: string) {
      const r = sessions.get(key(projectKey, id))
      if (!r || r.pendingPermissions.size > 0 || r.pendingQuestions.size > 0) return
      r.lastQuestionText = ''
      notify()
    },

    // Full pendingPermissions payloads for one session, oldest-first (Map preserves insertion
    // order; permission.replied deletes by key without reordering) — peek's inline answer UI
    // needs the raw payloads (title/description/id), which publicView omits.
    pendingFor(projectKey: string, id: string) {
      const r = sessions.get(key(projectKey, id))
      return r ? [...r.pendingPermissions.values()].sort((a, b) => a.__seq - b.__seq) : []
    },

    // M8/I2: raw pendingQuestions payloads for one session, oldest-first by __seq — mirrors
    // pendingFor. Sorted rather than left in Map insertion order because seedQuestions can stamp
    // a newly-seeded entry with a __seq below an already-live entry's, out of insertion order.
    pendingQuestionsFor(projectKey: string, id: string) {
      const r = sessions.get(key(projectKey, id))
      return r ? [...r.pendingQuestions.values()].sort((a, b) => a.__seq - b.__seq) : []
    },

    byProject() {
      const groups = new Map<string, SessionRow[]>()
      for (const r of sessions.values()) {
        if (childIds.has(r.id)) continue // subagents are not rows
        if (!groups.has(r.projectKey)) groups.set(r.projectKey, [])
        groups.get(r.projectKey)!.push(publicView(r))
      }
      return [...groups.entries()].map(([projectKey, list]) => ({
        projectKey,
        sessions: list.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      }))
    },

    subscribe(fn: () => void) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },

    snapshot() {
      const out: Record<string, any> = {}
      // `stopped` rides along because the server can't tell us: an aborted session comes back as
      // plain idle, so without persisting it a restart re-renders every stopped session as
      // "completed" — a result the user never got.
      for (const [k, r] of sessions) {
        if (childIds.has(r.id)) continue // never persist a subagent into seen.json
        out[k] = { updated: r.updatedAt, hasRun: r.hasRun, stopped: r.stopped }
      }
      return out
    },

    // I2: current value of the monotonic seq counter — callers capture this BEFORE issuing a
    // live-state GET, then pass it back in as `mark` to seedPermissions/seedQuestions so the
    // reseed can tell "existed before the GET was issued" from "arrived live while it was in
    // flight" (see those methods).
    seedMark() {
      return seq
    },

    // Live-state seeding (GET /session/status) for reconnect/startup reconciliation.
    // M6: verified live against the real opencode server — GET /session/status is a PARTIAL map,
    // idle sessions are simply absent from it (only busy/retry sessions are listed). A member
    // session already known to the store but absent from the payload is authoritatively idle, not
    // "whatever it was before" — otherwise a session that went busy→idle while fleetview was
    // disconnected stays stuck rendering "running" until its next SSE event.
    // `closeRuns` says whether this seed's timing means anything. On the periodic poll of a healthy
    // stream, a session that has gone absent finished at most one interval ago, so closing its span
    // is a fair inference. After a reconnect it is not: the stream may have been down for an hour,
    // and the run may have ended in the first second of it. Closing there would report the outage
    // as the duration — the same fabricated hour this number has now been wrong by three times.
    // Reporting null and falling back to an age is the honest answer when the gap is unknown.
    // `statusPayload` is opencode GET /session/status: a partial map of session id → status (idle
    // sessions absent). null/undefined and unrecognised shapes are guarded below before use.
    seedStatuses(projectKey: string, statusPayload: Record<string, OpencodeSessionStatus> | null | undefined, mark = Infinity, { closeRuns = false }: { closeRuns?: boolean } = {}) {
      // A successful-but-empty response is not the same claim as "nobody is running". client.#req
      // returns null for any 2xx with an empty body, and treating that as an authoritative empty
      // map marked every session in the project idle — so two busy sessions would both render as
      // completed after one hiccup. No payload means no information: apply nothing.
      if (statusPayload === null || statusPayload === undefined) return
      // A shape fleetview doesn't recognise is not information either. If a future opencode returned
      // an array or wrapped the map, Object.entries would match no session id and the sweep below
      // would mark every session in the project idle — the whole roster silently rendering as
      // completed. A 404 is already safe (the GET throws and the seed no-ops); a shape change is
      // the dangerous case.
      if (typeof statusPayload !== 'object' || Array.isArray(statusPayload)) return
      const map: Record<string, OpencodeSessionStatus> = statusPayload
      for (const [sessionID, status] of Object.entries(map)) {
        const r = upsert(projectKey, sessionID)
        // GET /session/status lists running subagents alongside real sessions — verified live.
        if (!r) continue
        if ((r.statusSeq as number) >= mark) continue // I2: a live status applied after the mark wins over this stale seed
        r.lastStatus = status?.type ?? 'idle'
        if (r.lastStatus === 'busy') {
          r.hasRun = true
          r.lastError = null
          r.errorAtServerUpdated = 0
          r.stopped = false // match the event path: running again retires the stop
          // Restamp unless a run is genuinely still open. The previous guard only asked whether a
          // start had ever been recorded, so a session that ran an hour ago and is running again
          // now kept the hour-old start and reported an hour-long run.
          if (!isRunOpen(r)) {
            r.runStartedAt = Date.now()
            r.runEndedAt = 0
          }
          r.updatedAt = Date.now() // M4: match the event path's recency bump
        }
      }
      for (const r of sessions.values()) {
        // `!r.origin`: a claude/copilot row shares the projectKey but is never in opencode's status
        // payload, and its statusSeq was stamped when it went busy — long before this seed's mark —
        // so without the tag the sweep marks a running run idle and closeRuns ends its span.
        if (!r.origin && r.projectKey === projectKey && !(r.id in map) && !((r.statusSeq as number) >= mark)) {
          if (closeRuns && isRunOpen(r)) r.runEndedAt = Date.now()
          r.lastStatus = 'idle'
        }
      }
      notify()
    },

    // I2: authoritative — a fresh seed is the full truth for this project, so any pending entry
    // for a projectKey session that ISN'T in the fresh list must be dropped (it was answered or
    // expired while fleetview wasn't watching) UNLESS it was stamped __seq >= mark, meaning it was
    // applied live (e.g. via SSE) after this seed's GET was issued — that entry is event-fresh and
    // must survive even though the (now-stale) snapshot doesn't know about it yet.
    //
    // `additive` turns the replace off and leaves only the add half: entries the server reports and
    // the store doesn't have are inserted, and nothing is ever deleted. That is what makes the
    // method safe to run on a timer. The periodic pass could not use the authoritative form — an
    // omission from one GET /permission would delete a genuinely pending request, turning a rare
    // reconnect-only drop into a recurring one — so before this it ran statuses only, and a lost
    // `permission.asked`/`question.asked` frame had no recovery path at all short of a reconnect or
    // a restart. A dropped `session.status` self-healed within a poll; a dropped permission sat
    // there rendering "working" with the run blocked behind it. The additive pass closes that,
    // while the authoritative replace stays exclusively on the mount/reconnect path, which is the
    // only place fleetview has actually missed the answers as well as the asks.
    seedPermissions(projectKey: string, permissionList: Array<PermissionAsked & PendingMeta>, mark = Infinity, { additive = false }: { additive?: boolean } = {}) {
      const fresh = permissionList ?? []
      const freshIds = new Set(fresh.map((perm) => perm.id))
      if (!additive) {
        for (const r of sessions.values()) {
          // `r.origin`: opencode's GET /permission never carries the synthetic `<id>:denied` entry a
          // process backend's "needs input" row rests on, so an authoritative delete here would drop
          // the one thing saying a human still has to unblock that run.
          if (r.projectKey !== projectKey || r.origin) continue
          for (const [id, entry] of r.pendingPermissions) {
            if (!freshIds.has(id) && entry.__seq < mark) r.pendingPermissions.delete(id)
          }
        }
      }
      fresh.forEach((perm, i) => {
        if (!perm.sessionID) return
        const r = upsert(projectKey, perm.sessionID)
        if (!r) return
        // Additive adds only what is missing, and only where it has the right to. `r.origin`: the
        // same rule the sweep above follows — a claude/copilot row is not opencode's to write.
        // `pendingClearedSeq >= mark`: see the field's comment — the snapshot in hand predates an
        // answer, so anything it still lists may already be answered. Skipping the record entirely
        // for one interval is the honest response; the next poll re-reads the server.
        // Not touching an entry already present is the third rule: it carries live `__seq`/
        // `__askedAt` stamps that order the queue and drive the "waiting Nm" clock, and a seed
        // overwrite would reset them to the moment fleetview happened to re-read the list.
        if (additive && (r.origin || r.pendingClearedSeq >= mark || r.pendingPermissions.has(perm.id))) return
        const existing = r.pendingPermissions.get(perm.id)
        // New-from-seed entries stamp BELOW mark, preserving list (oldest-first) order — M3 — so
        // they sort ahead of anything applied live during the seed's flight (seq >= mark).
        const seedSeq = mark - fresh.length + i
        r.pendingPermissions.set(perm.id, {
          ...perm,
          __seq: existing?.__seq ?? perm.__seq ?? seedSeq,
          // An entry fleetview already knew keeps the time it first saw it; a new one starts now.
          __askedAt: existing?.__askedAt ?? perm.__askedAt ?? Date.now(),
        })
      })
      notify()
    },

    // I1/I2: same authoritative-replace + watermark contract as seedPermissions, and the same
    // `additive` mode for the periodic pass — see there for both, including the answered-race.
    seedQuestions(projectKey: string, questionList: Array<QuestionAsked & PendingMeta>, mark = Infinity, { additive = false }: { additive?: boolean } = {}) {
      const fresh = questionList ?? []
      const freshIds = new Set(fresh.map((q) => q.id))
      if (!additive) {
        for (const r of sessions.values()) {
          if (r.projectKey !== projectKey || r.origin) continue // same as seedPermissions: not opencode's to sweep
          for (const [id, entry] of r.pendingQuestions) {
            if (!freshIds.has(id) && entry.__seq < mark) r.pendingQuestions.delete(id)
          }
        }
      }
      fresh.forEach((q, i) => {
        if (!q.sessionID) return
        const r = upsert(projectKey, q.sessionID)
        if (!r) return
        if (additive && (r.origin || r.pendingClearedSeq >= mark || r.pendingQuestions.has(q.id))) return
        const existing = r.pendingQuestions.get(q.id)
        const seedSeq = mark - fresh.length + i
        r.pendingQuestions.set(q.id, {
          ...q,
          __seq: existing?.__seq ?? q.__seq ?? seedSeq,
          __askedAt: existing?.__askedAt ?? q.__askedAt ?? Date.now(),
        })
      })
      notify()
    },
  }
}
