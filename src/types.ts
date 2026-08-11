// Shared domain shapes that cross module boundaries. opencode's wire payloads are genuinely
// dynamic — the server can add fields between versions — so these describe only the fields fleetview
// actually reads, and stay permissive (index signatures / optional) rather than claiming a closed
// shape. Anything looser than this lives inline with a // TODO(types) note where it is used.

// The one narrowing gate every read of a dynamic payload goes through. `unknown` is the honest type
// for a value the server chose the shape of, and this is what turns one into something a field can
// be named on — the convention the header above describes, in one place rather than re-typed at each
// read site. Arrays satisfy it too, which is what the callers that reach for `.length` rely on.
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

// The two field-level companions to `isRecord`: "this key is there and it is the right kind, or it
// is not there at all". Shared rather than re-declared per module, because every reader of a dynamic
// payload in this codebase asks exactly these two questions.
export const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
export const asNumber = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined)

// A project row from GET /project. `sandboxes` are the worktree directories opencode made for it.
export type Project = {
  id?: string
  worktree: string
  sandboxes?: string[]
  vcs?: string
  time?: unknown
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// opencode wire shapes — grounded in opencode's OpenAPI 3.1 spec (GET /doc,
// verified against 1.18.4) and cross-checked against live GET /project,
// /session, /session/status and /session/:id/message payloads. Only the fields
// fleetview actually reads are named; opencode can add more between versions, so
// reads stay defensive rather than claiming a closed shape.
// ---------------------------------------------------------------------------

// One row of a backend's session listing, as session-store's `setSessions` consumes it — the
// vocabulary a normaliser hands over, not a wire shape. Deliberately weaker than `Session` below:
// opencode's listing rows ARE Sessions and flow straight in, but a normalised claude/copilot row
// carries no `directory` (there is no server that scoped it), so requiring one would make every
// process backend lie. Only `id` is named — it is the one field a row cannot be a row without;
// everything else the store reads is narrowed off the index signature at the point it is read,
// which is the same treatment every other payload in this file gets.
export type ListedSession = { id: string; [key: string]: unknown }

// The gate between a raw listing and the rows above: a payload the server chose the shape of, and a
// row that cannot even name itself is not a session anyone could act on.
export const isListedSession = (row: unknown): row is ListedSession => isRecord(row) && typeof row.id === 'string'

// GET /session item (schema: Session). Required per spec: id, slug, projectID,
// directory, title, version, time — fleetview reads the subset below.
export type Session = {
  id: string
  title: string
  directory: string
  parentID?: string
  agent?: string
  time: { created: number; updated: number }
  [key: string]: unknown
}

// GET /session/status value (schema: SessionStatus). Discriminated on `type`;
// fleetview reads only `.type`, so the retry payload is named for documentation
// and the string member covers status kinds opencode may add.
export type OpencodeSessionStatus =
  | { type: 'idle' }
  | { type: 'busy' }
  | { type: 'retry'; attempt: number; message: string; next: number; action?: { reason: string; provider: string; title: string; message: string; label: string; link?: string } }
  | { type: string }

// A message part (schemas: Part / TextPart). Any part may carry `text`; a text
// part always does. Modelled flat rather than as a discriminated union so `.text`
// reads after a `type === 'text'` check without a catch-all member poisoning the
// narrowing of the other members.
export type Part = { type: string; text?: string; messageID?: string; [key: string]: unknown }

// GET /session/:id/message item — the {info, parts} envelope peek renders
// (schemas: Message + Part). fleetview reads info.role and text parts' .text.
// `error` is opencode's error union (NamedError: {name, data}) recorded on the assistant message
// whose turn failed — #24's `{name: 'APIError', data: {message: '…'}}`. Left `unknown`: the union
// has a dozen members and fleetview only ever hands it to errorLabel, which narrows defensively.
export type MessageInfo = { id?: string; role?: string; error?: unknown }
export type OpencodeMessage = { info?: MessageInfo; parts?: Part[] }

// permission.asked payload (schema: EventPermissionAsked.properties).
export type PermissionAsked = {
  id: string
  sessionID: string
  permission: string
  patterns?: string[]
  metadata?: Record<string, unknown>
  always?: string[]
  tool?: { messageID: string; callID: string }
}

// question.asked payload (schema: EventQuestionAsked.properties) and its parts
// (schemas: QuestionInfo, QuestionOption).
export type QuestionOption = { label: string; description: string }
export type QuestionInfo = { question: string; header: string; options: QuestionOption[]; multiple?: boolean; custom?: boolean }
export type QuestionAsked = {
  id: string
  sessionID: string
  questions: QuestionInfo[]
  tool?: unknown
}

// fleetview stamps every pending permission/question entry with these on the way
// into the store; opencode never sends them, so they are optional on the wire.
export type PendingMeta = { __seq?: number; __askedAt?: number }

// POST/GET /experimental/worktree item (schema: Worktree).
export type Worktree = { name: string; directory: string; branch?: string }

// The 11 SSE bus events the session store handles, as a discriminated union
// keyed on `type`. Each `properties` names only the fields the handler reads.
// Other event types ride the same stream and the handler ignores them, so the
// transport casts each parsed frame to this union at the boundary (event-mux).
export type OpencodeEvent =
  | { type: 'session.status'; properties: { sessionID: string; status?: OpencodeSessionStatus } }
  | { type: 'session.updated'; properties: { info: { id: string; title?: string; time?: { updated?: number } } } }
  | { type: 'session.deleted'; properties: { info: { id: string } } }
  | { type: 'session.error'; properties: { sessionID?: string; error?: unknown } }
  | { type: 'message.updated'; properties: { sessionID: string; info?: MessageInfo } }
  | { type: 'message.part.updated'; properties: { sessionID: string; part?: Part } }
  | { type: 'permission.asked'; properties: PermissionAsked & PendingMeta }
  | { type: 'permission.replied'; properties: { sessionID: string; requestID: string; reply?: 'once' | 'always' | 'reject' } }
  | { type: 'question.asked'; properties: QuestionAsked & PendingMeta }
  // id? is retained deliberately: opencode's reply/reject event schema was unverified, so fleetview
  // tolerates an `id` in place of `requestID` (see the `?? p.id` fallback and its test). Keep it
  // even though 1.18.4's OpenAPI omits it — it is a hedge, not a mistake.
  | { type: 'question.replied'; properties: { sessionID: string; requestID: string; id?: string; answers?: unknown[] } }
  | { type: 'question.rejected'; properties: { sessionID: string; requestID: string; id?: string } }

// A pull request as `gh pr list --json` returns it. Only the fields the badge/colour logic reads are
// named; the rest of gh's JSON rides along untyped.
export type PullRequest = {
  number: number // gh always returns it, and the #N badge cannot render without it
  url?: string
  state?: string
  isDraft?: boolean
  headRefName?: string
  statusCheckRollup?: unknown
  reviewDecision?: string
  [key: string]: unknown
}

export type PrStatus = 'merged' | 'closed' | 'draft' | 'failing' | 'pending' | 'passing'

// The provider/model pair `--model` and `/model` set, as cli-args' parseModel mints it. Both halves
// are required here — a half-parsed pair is rejected at the flag, and what survives is complete.
export type ModelPair = { providerID: string; id: string }

// What `attach` needs off a row: the identity to hand the host, plus the two fields the ghost guard
// reads before it hands anything over. Deliberately not a whole roster row — the dispatch paths
// attach to a session created moments ago, which has no status, snippet or age yet.
export type AttachTarget = { id: string; projectKey: string; backend?: string; ghost?: boolean; title?: string }

// What the roster asks its host to do. App never touches a terminal itself — it raises one of these
// and the host (cli.ts's rosterLoop, or a test's stub) answers — so this union is the whole contract
// between the two, and the reason `onAction` is one function rather than four props.
export type AttachSibling = { id: string; projectKey: string; backend?: string }
export type AppAction =
  // Attach to a session in this terminal. `siblings` is what Alt+1..9 switches between, in the
  // order they are drawn.
  | { type: 'enter'; sessionId: string; worktree: string; backend?: string; siblings: AttachSibling[] }
  // Open the dispatch prompt in $VISUAL/$EDITOR and hand back whatever was saved.
  | { type: 'edit'; text: string }
  | { type: 'quit' }
  // The server moved to another port; the host remounts on it rather than doing live surgery.
  | { type: 'reconnect' }

// What the host reports back when an attachment ends. Every field is optional because every one of
// them is news the host may not have: a plain exit reports nothing, a detach names the session that
// was left running, and a failure to launch carries only a message.
export type AttachOutcome = {
  detached?: boolean
  sessionId?: string
  worktree?: string
  backend?: string
  message?: string
}

// The per-worktree live-state seed use-discovery publishes back through App's refs, and which the
// peek failure paths reconcile through. Named here rather than in the hook because App holds the ref
// and use-peek calls it — three modules, so the shape belongs to none of them.
export type SeedOptions = { pending?: boolean; additive?: boolean; closeRuns?: boolean; relist?: boolean }
// Reported per list, not as one flag: a peek path that only cares whether `/question` succeeded must
// not read a `/session/status` timeout as its own failure.
export type SeedOutcome = { permissions: boolean; questions: boolean }
export type SeedChain = (worktree: string, options?: SeedOptions) => Promise<SeedOutcome>
// Starts streaming a worktree that nothing was watching yet — the project a dispatch just created.
export type StreamProject = (worktree: string) => Promise<void>

// A parsed SGR mouse event (see ui/mouse.ts).
export type MouseEvent = {
  button: number
  x: number
  y: number
  kind: 'wheel-up' | 'wheel-down' | 'press' | 'release'
}

// The pointer fleetview persists to server.json and reads back to reach the opencode server.
export type ServerRef = {
  host: string
  port: number
  pid?: number | null
  // Only set for a server fleetview spawned itself and generated a password for (M11): the server
  // is detached, so the next run needs the credential to reach it. Never a user-set
  // OPENCODE_SERVER_PASSWORD — that one is not copied to disk.
  password?: string
}

// What a backend can actually do, so the UI can degrade honestly instead of offering a key that
// silently does nothing. Every flag is required — a new backend has to state its answer rather than
// inherit opencode's by omission, which is how a "supported" fork button would end up on a CLI that
// has no fork.
export type BackendCapabilities = {
  fork: boolean
  rename: boolean
  delete: boolean // the CLI can remove a stored session; false means ^x^x can only stop, not delete
  questions: boolean // server-side questions/permissions fleetview can answer from the roster
  messages: boolean // a transcript readable over the wire; false means peek says "attach to read it"
}

// Where a session lives. `directory` is the project/worktree every opencode call is scoped by
// (`?directory=`), and the cwd a process-backed CLI would be resumed in — both backend families
// need it alongside the id, so it travels with the id rather than being passed separately.
export type SessionRef = {
  id: string
  directory: string
}

// What a backend reports while a session runs. The events themselves stay `unknown`: opencode's are
// its SSE payloads, a process-backed backend's are lines of its own stream-json, and only that
// backend's normalisation knows the difference.
export type BackendEventHandlers = {
  onEvent: (directory: string, event: unknown) => void
  onOffline?: (directory: string) => void
  onOnline?: (directory: string) => void
}

export type EventSubscription = {
  done: Promise<void>
  stop: () => void
}

// `directory` is required on every method below, even though opencode's own client defaults it to
// the server's idea of the current project. Every fleetview call site already knows which project
// row it is acting on, and a process-backed backend has no server to fall back on — so the one
// place the default could be used is the one place it would be wrong.
//
// One backend adapter = one agent CLI fleetview can drive. Three implementations exist today
// (src/backends/opencode, src/backends/claude, src/backends/copilot); each lands as a file rather
// than as branches through the roster.
//
// Deliberately narrow: only what every backend family can plausibly do. opencode's extra surface
// (worktrees, permissions, shell, providers, agent/command lists) stays on OpencodeClient, because
// promoting it here would mean inventing a no-op for it on three CLIs that have no equivalent.
// Return types stay deliberately weak, for the same reason the wire types above stay permissive —
// each backend's payloads are its own shape, and the roster reads them through per-backend
// normalisation, not through this type. The four verbs whose result nothing reads say exactly that
// by returning `unknown`. The one result that IS read is a listing, and it returns `ListedSession[]`
// rather than `unknown`: every adapter already knows its own rows, `normaliseSessions` is the seam
// where they become the store's vocabulary, and opencode's normaliser is identity — it hands back
// the very array it was given, which a laundering pass through `unknown` could not do.
export type Backend = {
  readonly name: string
  readonly capabilities: BackendCapabilities
  listSessions(directory: string): Promise<ListedSession[]>
  // create-then-prompt as one call: no backend exposes a session that exists but was never asked
  // anything, and splitting it would leave every caller repeating the two-step.
  dispatch(input: { prompt: string; directory: string; agent?: string; model?: string }): Promise<SessionRef>
  prompt(id: string, text: string, directory: string): Promise<unknown>
  // Long-lived subscription, not a one-shot read: `stop` is what unmounting has to call, and `done`
  // is how a caller waits for the reader to actually finish. Backends without a real event stream
  // satisfy this by polling and calling onEvent themselves.
  events(target: { directory: string }, handlers: BackendEventHandlers): EventSubscription
  // argv, command included — `opencode attach …` and `claude --resume …` don't share a program, so
  // handing back only the arguments would leave the caller deciding what to run.
  attach(session: SessionRef): string[]
  abort(id: string, directory: string): Promise<unknown>
  rename(id: string, title: string, directory: string): Promise<unknown>
  delete(id: string, directory: string): Promise<unknown>
  // Normalisation is part of the contract (H3), not a string-keyed chain beside it: each adapter
  // states how its listings and events become the store's vocabulary (backend-normalise.ts is the
  // vocabulary's home and documents the rules). opencode's are identity — its payloads ARE the
  // vocabulary — and a new backend cannot silently pass its wire format through unnormalised.
  normaliseSessions(rows: ListedSession[] | null | undefined): ListedSession[]
  // A fresh normaliser per events() subscription: it folds per-session state across events, and two
  // directories' runs must never share that fold.
  createNormaliser(): (event: unknown) => OpencodeEvent[]
}
