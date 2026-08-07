// Per-backend normalisation: turning what a backend reports into the two shapes session-store
// already reduces — the rows `setSessions` takes, and the events `apply` takes.
//
// The alternative was teaching session-store three vocabularies. That store is the most heavily
// tested module in the repo (statuses, run spans, error staleness, the seq watermark) and every one
// of those rules is about opencode's semantics, so the cheaper and safer seam is here: a backend's
// facts get expressed in opencode's event vocabulary once, and the store keeps its single meaning of
// `busy`, `session.error`, `permission.asked`.
//
// Pure and stateful-per-subscription, not per-call: a process-backed backend reports a folded run
// state, so "what changed" only exists relative to what was reported last. One normaliser instance
// belongs to one events() subscription (one backend, one directory).
import { applyEvent as applyClaudeEvent, emptyRunState, emptyTranscriptState, type ClaudeRunState } from './backends/claude/stream.ts'
import type { OpencodeEvent } from './types.ts'

// An opencode-shaped bus event, which is what session-store.apply switches on.
// The store's own wire vocabulary, since #99 typed it: everything a normaliser emits must be one
// of the shapes session-store already accepts, and saying so here is what keeps a backend from
// inventing a fourth vocabulary the store silently drops.
export type StoreEvent = OpencodeEvent

// A session row in the shape session-store.setSessions reads: id, title, and opencode's `time`
// envelope. Nothing else in a listing survives normalisation, because nothing else is read.
export type StoreSessionRow = { id: string; title?: string; time?: { created?: number; updated?: number } }

// Rows for `setSessions`. opencode's own listings pass through untouched — this must never become a
// place opencode's payloads get rewritten, because that is the one path where behaviour is fixed.
export function normaliseSessions(backend: string, rows: any[] | null | undefined): any[] {
  const list = rows ?? []
  if (backend === 'opencode') return list
  if (backend === 'claude') {
    // `created` is the transcript's first record timestamp (projects.ts reads it out during the
    // scan it already runs), not its mtime: the age column means time-since-creation on every other
    // row, and using the mtime made a nine-day-old claude session that had just replied render
    // `now`. 0 when no record carried a parseable timestamp — ageLabel's `createdAt || updatedAt`
    // then falls back to the mtime, which is the behaviour this row had before.
    // #46: the title passes through empty rather than falling back to the id. Claude Code does not
    // name a session on creation, so `|| s.id` put a UUID in the title of every session it had not
    // titled yet — and a UUID is not `isPlaceholderTitle`, so the first relist after a dispatch
    // overwrote the provisional prompt the store was showing and the row read as its own id while
    // peek showed the prompt. An empty title is the honest report of "this backend has not named it",
    // which is exactly what the store's placeholder test is looking for. What a never-dispatched
    // session shows instead is projects.ts's job: it falls back to the transcript's opening prompt.
    return list.map((s: any) => ({ id: s.id, title: s.title ?? '', time: { created: s.createdAt ?? 0, updated: s.updatedAt ?? 0 } }))
  }
  if (backend === 'copilot') {
    // Already carries id/title/time in milliseconds (sessions.ts converts them deliberately), so
    // this is a projection rather than a conversion — `running` is dropped because liveness reaches
    // the store through the event path, where it can be told apart from a finished run.
    return list.map((s: any) => ({ id: s.id, title: s.title || s.id, time: s.time }))
  }
  return list
}

// The status half of a backend's state, in store events. Order matters and is load-bearing:
//   - `session.status busy` is what sets hasRun/clears a previous error, so it leads.
//   - `session.error` after an idle, because the store lets `busy` outrank an error and an idle is
//     what lets the error surface.
//   - `permission.asked` after the idle that clears the previous run's pending entries, or the idle
//     would wipe the very entry that says why the row is waiting.
// One synthetic id per session, so a second denied run replaces the banner rather than stacking a
// duplicate, and so the resume path above can retire it by name.
const deniedRequestId = (sessionID: string) => `${sessionID}:denied`

function statusEvents(sessionID: string, status: string, error: string | undefined, denials: unknown[]): StoreEvent[] {
  const idle: StoreEvent = { type: 'session.status', properties: { sessionID, status: { type: 'idle' } } }
  if (status === 'working') {
    return [
      { type: 'session.status', properties: { sessionID, status: { type: 'busy' } } },
      // Retires the synthetic denial below. `busy` deliberately does NOT clear pending state in the
      // store (a session stays busy while blocked on a real opencode permission), and a pending
      // entry outranks `running` in the row's status — so without this a session unblocked by
      // attaching and approving would read `needs input` forever while it visibly worked. A delete
      // of a key that isn't there is a no-op, so this costs nothing on every other resume.
      { type: 'permission.replied', properties: { sessionID, requestID: deniedRequestId(sessionID) } },
    ]
  }
  if (status === 'failed') return [idle, { type: 'session.error', properties: { sessionID, error: error ?? true } }]
  if (status === 'needs-input') {
    return [
      idle,
      // A synthetic permission, not a real one: the run is over and there is nothing on the wire to
      // answer. It exists so the row lands in `needs input` — which is the truth, a person has to
      // attach and approve — and the capability gate (capabilities.questions false) is what stops
      // the roster offering to answer it from here. Keyed per session so a second denied run
      // replaces the entry rather than stacking a second identical banner.
      {
        type: 'permission.asked',
        properties: {
          sessionID,
          id: deniedRequestId(sessionID),
          // The union's PermissionAsked names the field `permission`, and it is what the peek
          // banner prints — title/description are not part of the store's vocabulary.
          permission: denialLabel(denials),
        },
      },
    ]
  }
  // 'completed' and 'idle' are the same event: the store decides between `done` and `idle` from
  // whether it ever saw the session run, which is more than this function knows.
  return [idle]
}

// What the run asked for and did not get. The payload shape is the CLI's own (`tool_name` on claude's
// permission_denials), so only the field that names the tool is read.
function denialLabel(denials: unknown[]): string {
  const names = denials.map((d: any) => (typeof d?.tool_name === 'string' ? d.tool_name : null)).filter(Boolean)
  if (names.length === 0) return 'the run was refused a tool it needed'
  return `${[...new Set(names)].join(', ')} — attach to approve`
}

// The last-output half. Two events because that is what the store's part-attribution requires: a
// `message.updated` naming an assistant message, then the text part carrying the same messageID.
// The id is derived from the session rather than the backend's own message ids, which the folded
// state does not keep — the store only uses it to tie a part to the message it belongs to.
const outputEvents = (sessionID: string, text: string): StoreEvent[] => [
  { type: 'message.updated', properties: { sessionID, info: { id: `${sessionID}:assistant`, role: 'assistant' } } },
  { type: 'message.part.updated', properties: { sessionID, part: { type: 'text', messageID: `${sessionID}:assistant`, text } } },
]

// Claude Code: raw `--output-format=stream-json` lines, one session's run interleaved with any other
// session's in the same directory. Every line carries `session_id` (verified against 2.1.220 — see
// the wire doc), which is what makes the per-session fold possible from a shared stream.
function claudeNormaliser(): (event: unknown) => StoreEvent[] {
  const states = new Map<string, ClaudeRunState>()
  return (event: unknown) => {
    const e = event as any
    // A run's stream keys the id `session_id`; a discovered transcript keys it `sessionId` (both
    // verified against 2.1.220 — see the wire doc). Reading only `session_id` dropped every
    // transcript line at the guard below, so the whole discovery feature produced nothing.
    const sessionID = (typeof e?.session_id === 'string' ? e.session_id : undefined) ?? (typeof e?.sessionId === 'string' ? e.sessionId : undefined)
    if (!sessionID) return [] // a line fleetview cannot attribute is a line it cannot act on
    const first = !states.has(sessionID)
    // A transcript carries no `result` record, so its status can never move off the seed — it must
    // start 'idle', or a hand-started session reads 'working' forever. The tail loop tags transcript
    // lines with `__source`; a run's lines are untagged and seed 'working' (its `init` keeps it there).
    const before = states.get(sessionID) ?? (e?.__source === 'transcript' ? emptyTranscriptState() : emptyRunState())
    const after = applyClaudeEvent(before, event)
    states.set(sessionID, after)
    const out: StoreEvent[] = []
    // First sight always emits its status, changed or not: that event is what creates the record,
    // and the output events below are dropped by the store for a session it has never heard of.
    if (first || after.status !== before.status) out.push(...statusEvents(sessionID, after.status, after.error, after.denials))
    if (after.lastOutput && after.lastOutput !== before.lastOutput) out.push(...outputEvents(sessionID, after.lastOutput))
    return out
  }
}

// Copilot CLI: index.ts already folds the JSONL and emits one `copilot.session` per change, so the
// state arrives whole and this only has to diff it against what was reported last.
function copilotNormaliser(): (event: unknown) => StoreEvent[] {
  const last = new Map<string, { status: string; lastOutput: string }>()
  return (event: unknown) => {
    const e = event as any
    if (e?.type !== 'copilot.session' || typeof e.sessionId !== 'string') return []
    const sessionID: string = e.sessionId
    const status: string = typeof e.status === 'string' ? e.status : 'working'
    const lastOutput: string = typeof e.lastOutput === 'string' ? e.lastOutput : ''
    const before = last.get(sessionID)
    last.set(sessionID, { status, lastOutput })
    const out: StoreEvent[] = []
    if (!before || before.status !== status) {
      // A failed copilot run has no error text of its own: the CLI reports failure as an exit code
      // (or as a run that produced nothing), so the message is fleetview's own words rather than a
      // quoted one it does not have.
      out.push(...statusEvents(sessionID, status, status === 'failed' ? 'the copilot run ended without a result' : undefined, []))
    }
    if (lastOutput && lastOutput !== before?.lastOutput) out.push(...outputEvents(sessionID, lastOutput))
    return out
  }
}

// One normaliser per events() subscription. opencode's payloads are already the store's vocabulary —
// they ARE the vocabulary — so its normaliser is identity, which is what keeps the opencode path
// free of any normalisation cost or behaviour change at all.
export function createNormaliser(backend: string): (event: unknown) => StoreEvent[] {
  if (backend === 'claude') return claudeNormaliser()
  if (backend === 'copilot') return copilotNormaliser()
  return (event: unknown) => [event as StoreEvent]
}
