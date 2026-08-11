// Shared domain shapes that cross module boundaries. opencode's wire payloads are genuinely
// dynamic — the server can add fields between versions — so these describe only the fields fleetview
// actually reads, and stay permissive (index signatures / optional) rather than claiming a closed
// shape. Anything looser than this lives inline with a // TODO(types) note where it is used.

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
// Return types stay `any` for the same reason the wire types above do — each backend's payloads are
// its own shape, and the roster reads them through per-backend normalisation, not through this type.
export type Backend = {
  readonly name: string
  readonly capabilities: BackendCapabilities
  listSessions(directory: string): Promise<any>
  // create-then-prompt as one call: no backend exposes a session that exists but was never asked
  // anything, and splitting it would leave every caller repeating the two-step.
  dispatch(input: { prompt: string; directory: string; agent?: string; model?: string }): Promise<SessionRef>
  prompt(id: string, text: string, directory: string): Promise<any>
  // Long-lived subscription, not a one-shot read: `stop` is what unmounting has to call, and `done`
  // is how a caller waits for the reader to actually finish. Backends without a real event stream
  // satisfy this by polling and calling onEvent themselves.
  events(target: { directory: string }, handlers: BackendEventHandlers): EventSubscription
  // argv, command included — `opencode attach …` and `claude --resume …` don't share a program, so
  // handing back only the arguments would leave the caller deciding what to run.
  attach(session: SessionRef): string[]
  abort(id: string, directory: string): Promise<any>
  rename(id: string, title: string, directory: string): Promise<any>
  delete(id: string, directory: string): Promise<any>
  // Normalisation is part of the contract (H3), not a string-keyed chain beside it: each adapter
  // states how its listings and events become the store's vocabulary (backend-normalise.ts is the
  // vocabulary's home and documents the rules). opencode's are identity — its payloads ARE the
  // vocabulary — and a new backend cannot silently pass its wire format through unnormalised.
  normaliseSessions(rows: any[] | null | undefined): any[]
  // A fresh normaliser per events() subscription: it folds per-session state across events, and two
  // directories' runs must never share that fold.
  createNormaliser(): (event: unknown) => OpencodeEvent[]
}
