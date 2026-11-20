import type { Session, ListedSession, OpencodeMessage, Project, PermissionAsked, QuestionAsked, OpencodeSessionStatus, StatusSnapshot, Worktree } from '../../types.ts'
import { opencodeRequest } from './request.ts'
import { isRecord } from '../../types.ts'
import { OpencodeV2Client } from './client-v2.ts'

// The three catalogue endpoints, named for the one field each caller reads off them (an agent's or
// command's name, a provider's id and its model map). Same convention as types.ts: only what
// fleetview reads, permissive about the rest, because opencode may add fields between versions.
// `#req` returns null for a 2xx with an empty body, which is why each of these is nullable.
export type AgentInfo = { name: string; [key: string]: unknown }
export type CommandInfo = { name: string; [key: string]: unknown }
export type ProviderInfo = { id: string; models?: Record<string, unknown>; [key: string]: unknown }
export type ProvidersResponse = { providers?: ProviderInfo[]; [key: string]: unknown }

// What POST /session accepts as a model. Both forms are real: the roster's `/model` sets the
// provider/model pair the header renders (cli-args' parseModel mints it), while the Backend
// contract's `dispatch` carries the CLI-shaped single string. `null` is "the server's default",
// which is what an unset dispatch model is.
export type ModelSelection = string | { providerID: string; id: string } | null

// opencode's server takes HTTP basic auth when OPENCODE_SERVER_PASSWORD is set — the same
// variable `opencode attach -p` defaults to, so a spawned server, fleetview's own requests and the
// attach child all pick it up from one place.
//
// This matters more than it looks: the server has POST /session/:id/shell, which runs an arbitrary
// shell command, and fleetview spawns it detached and unref'd so it outlives fleetview on a fixed port.
// Unauthenticated, anything that can reach 127.0.0.1 as this user has code execution, so
// ensureServer (server-manager.ts) mints a password for every server fleetview spawns. A server fleetview
// merely adopts keeps whatever auth it already has; locking that one would lock fleetview out of it.
export function authHeader(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const password = env.OPENCODE_SERVER_PASSWORD
  if (!password) return undefined
  const user = env.OPENCODE_SERVER_USERNAME || 'opencode'
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
}

// Which server API is on the other end. opencode 2.x replaced 1.x's API outright (JSON lives under
// /api, everything else is its web app), so the client and the event stream ask once per server
// and speak whichever it is. 2.x answers GET /api/info with its UnauthorizedError when asked
// without a credential, and with {version, pid, ...} otherwise (200, 503 booting, 500 boot failed).
// 1.x has no such route.
//
// Asked WITHOUT a credential: a 1.x server whose web UI isn't embedded proxies unknown paths,
// authorization header included, to app.opencode.ai (opencode v1.19.6 shared/ui.ts). Judged by
// body, not status, for the same reason: whatever that site answers must not read as 2.x.
// ponytail: memoized per base URL for the process lifetime; an opencode upgraded in place while
// fleetview runs is picked up when fleetview restarts.
//
// One detector: server-manager's probeServer records what a healthy probe found with
// noteOpencodeApi (its 1.x-first order decides), so this only goes to the network for a URL no
// healthy probe saw, such as a server that answered the probe 401.
const apiByUrl = new Map<string, Promise<1 | 2>>()
// The answer once it is in, for the one synchronous caller (attach argv): from a healthy probe, or
// from the client's own ask, which settles before anything on the server can be listed.
const settledApi = new Map<string, 1 | 2>()
export function opencodeApi(baseUrl: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<1 | 2> {
  const known = apiByUrl.get(baseUrl)
  if (known) return known
  const asked = fetchImpl(`${baseUrl}/api/info`, { signal: AbortSignal.timeout(10_000) }).then(async (res): Promise<1 | 2> => {
    let body: unknown
    try {
      body = typeof res.json === 'function' ? await res.json() : null
    } catch {
      return 1 // answered, but not with JSON: not 2.x. (No answer at all rejects, and is not cached.)
    }
    return isV2Unauthorized(body) || isV2Info(body) ? 2 : 1
  })
  apiByUrl.set(baseUrl, asked)
  // Unreachable is not an answer; ask again next time. Guarded so an ask still in flight when a
  // probe recorded its answer can't overwrite or drop that answer.
  const current = () => apiByUrl.get(baseUrl) === asked
  asked.then(
    (api) => current() && settledApi.set(baseUrl, api),
    () => current() && apiByUrl.delete(baseUrl),
  )
  return asked
}
export function noteOpencodeApi(baseUrl: string, api: 1 | 2) {
  apiByUrl.set(baseUrl, Promise.resolve(api))
  settledApi.set(baseUrl, api)
}
export const knownOpencodeApi = (baseUrl: string) => settledApi.get(baseUrl)
// The two 2.x answers on GET /api/info (opencode v2.3.2 packages/server/src/handlers/server.ts):
// its UnauthorizedError when asked without a credential, else {version, pid, urls, paths, ...}.
// Required fields rather than "any JSON", so a bare `{}` from some other listener isn't 2.x.
export const isV2Unauthorized = (body: unknown) => isRecord(body) && body._tag === 'UnauthorizedError'
export const isV2Info = (body: unknown) => isRecord(body) && typeof body.version === 'string' && body.version !== '' && typeof body.pid === 'number'
// Test-only: both memos are module-wide, so without this one test's answer for a URL leaks into the next.
export const resetOpencodeApiMemo = () => {
  apiByUrl.clear()
  settledApi.clear()
}

// What the roster and its hooks actually call on a client, and the type App takes rather than the
// class itself: a class with a private field can only ever be satisfied by an instance of it, which
// would leave the fixture clients (scripts/demo.ts, the test corpus) with nowhere to stand.
//
// Three details are deliberate. Method syntax throughout, because TypeScript checks method
// parameters bivariantly — that is what lets a fixture declare `answers: string[][]` where the real
// client says `unknown`. Return types are the weakest thing every caller can live with (a listing is
// `ListedSession[]`, since that is what session-store consumes; a create is just the id the roster
// reads off it), so a fixture need not reproduce a whole wire payload. And the last four are
// optional because they are opencode's own extras — the call sites already reach for them with `?.`
// or inside a try, and a client without them degrades rather than breaks.
export type RosterClient = {
  listProjects(): Promise<Project[]>
  listSessions(directory?: string): Promise<ListedSession[]>
  sessionStatus(directory?: string): Promise<Record<string, OpencodeSessionStatus> | null>
  // Several directories' statuses off one server-wide answer, where the server has one (2.x); null
  // where it doesn't, and each directory is asked with sessionStatus as before.
  statusSnapshot?(): Promise<StatusSnapshot | null>
  listPermissions(directory?: string): Promise<PermissionAsked[]>
  listQuestions(directory?: string): Promise<QuestionAsked[]>
  listMessages(id: string, directory?: string): Promise<OpencodeMessage[]>
  createSession(options?: { agent?: string; model?: ModelSelection }, directory?: string): Promise<{ id: string }>
  forkSession(id: string, directory?: string): Promise<{ id: string }>
  promptAsync(id: string, text: string, directory?: string): Promise<unknown>
  runShell(id: string, command: string, directory?: string, agent?: string): Promise<unknown>
  renameSession(id: string, title: string, directory?: string): Promise<unknown>
  deleteSession(id: string, directory?: string): Promise<unknown>
  abortSession(id: string, directory?: string): Promise<unknown>
  respondPermission(requestID: string, reply: unknown, directory?: string): Promise<unknown>
  respondQuestion(requestID: string, answers: unknown, directory?: string): Promise<unknown>
  listWorktrees(directory?: string): Promise<Worktree[] | null>
  createWorktree(name: string, directory?: string): Promise<{ name?: string; directory?: string } | null>
  removeWorktree?(worktreeDirectory: string, directory?: string): Promise<unknown>
  listAgents?(): Promise<AgentInfo[] | null>
  listCommands?(): Promise<CommandInfo[] | null>
  providers?(): Promise<ProvidersResponse | null>
}

// opencode 1.x's server API, which is also the vocabulary the rest of fleetview reads, so it is
// passed through as it comes. OpencodeV2Client (client-v2.ts) speaks 2.x into the same shapes.
export class OpencodeV1Client {
  baseUrl: string
  fetch: typeof fetch

  constructor(baseUrl: string, fetchImpl: typeof fetch) {
    this.baseUrl = baseUrl
    this.fetch = fetchImpl
  }

  // The typed methods below pin T to the opencode wire shape each endpoint returns (see types.ts).
  #req<T = unknown>(method: string, path: string, body?: unknown, directory?: string) {
    const query = directory ? `?directory=${encodeURIComponent(directory)}` : ''
    return opencodeRequest<T>(this.fetch, this.baseUrl, method, path, { body, auth: authHeader(), query })
  }

  listSessions(directory?: string) {
    return this.#req<Session[]>('GET', '/session', undefined, directory)
  }
  // Deliberately sends no title: opencode names a session itself from its first prompt, using its
  // own small model, about 20 seconds in — but only when the session was created without one.
  // Verified live against opencode 1.18.4: a session created with `{}` became "Reply with single
  // word ok", while an identical session created with an explicit title kept it for 48s+.
  // Sending the raw prompt as the title, which fleetview used to do, is what suppressed the good name.
  // `agent` and `model` are accepted by POST /session and set what the session runs as.
  createSession({ agent, model }: { agent?: string; model?: ModelSelection } = {}, directory?: string) {
    return this.#req<Session>('POST', '/session', { ...(agent ? { agent } : {}), ...(model ? { model } : {}) }, directory)
  }
  // POST /session/:id/fork copies the conversation into a new session — agent view's /fork.
  forkSession(id: string, directory?: string) {
    return this.#req<Session>('POST', `/session/${encodeURIComponent(id)}/fork`, undefined, directory)
  }
  promptAsync(id: string, text: string, directory?: string) {
    return this.#req('POST', `/session/${encodeURIComponent(id)}/prompt_async`, { parts: [{ type: 'text', text }] }, directory)
  }
  renameSession(id: string, title: string, directory?: string) {
    return this.#req('PATCH', `/session/${encodeURIComponent(id)}`, { title }, directory)
  }
  deleteSession(id: string, directory?: string) {
    return this.#req('DELETE', `/session/${encodeURIComponent(id)}`, undefined, directory)
  }
  listMessages(id: string, directory?: string) {
    return this.#req<OpencodeMessage[]>('GET', `/session/${encodeURIComponent(id)}/message`, undefined, directory)
  }
  listProjects() {
    return this.#req<Project[]>('GET', '/project')
  }
  abortSession(id: string, directory?: string) {
    return this.#req('POST', `/session/${encodeURIComponent(id)}/abort`, undefined, directory)
  }
  listPermissions(directory?: string) {
    return this.#req<PermissionAsked[]>('GET', '/permission', undefined, directory)
  }
  listQuestions(directory?: string) {
    return this.#req<QuestionAsked[]>('GET', '/question', undefined, directory)
  }
  respondPermission(requestID: string, reply: unknown, directory?: string) {
    return this.#req('POST', `/permission/${encodeURIComponent(requestID)}/reply`, { reply }, directory)
  }
  // POST /question/:id/reply takes one answer array per question, each holding the selected
  // option labels — so a single-choice answer to a single question is [[label]].
  respondQuestion(requestID: string, answers: unknown, directory?: string) {
    return this.#req('POST', `/question/${encodeURIComponent(requestID)}/reply`, { answers }, directory)
  }
  // Agent view's `!` prefix: "Prefix a reply with `!` to send a Bash command instead." opencode
  // requires an agent for the shell call; `build` is its default primary agent.
  runShell(id: string, command: string, directory?: string, agent: string = 'build') {
    return this.#req('POST', `/session/${encodeURIComponent(id)}/shell`, { command, agent }, directory)
  }
  // Worktree isolation. `directory` is the repository the worktree belongs to; the response carries
  // the new worktree's own directory, which is what every later call for that session uses.
  // Verified live against opencode 1.18.4: POST returns {name, branch:'opencode/<name>', directory},
  // the directory becomes a project of its own, and the repository's project row gains it in
  // `sandboxes`.
  createWorktree(name: string, directory?: string) {
    return this.#req<Worktree>('POST', '/experimental/worktree', { name }, directory)
  }
  listWorktrees(directory?: string) {
    return this.#req<Worktree[]>('GET', '/experimental/worktree', undefined, directory)
  }
  // Removes the worktree AND its branch, with no checks of its own — it will delete uncommitted
  // changes without complaint. Callers must consult worktree.ts's worktreeSafety first.
  removeWorktree(worktreeDirectory: string, directory?: string) {
    return this.#req('DELETE', '/experimental/worktree', { directory: worktreeDirectory }, directory)
  }
  sessionStatus(directory?: string) {
    return this.#req<Record<string, OpencodeSessionStatus>>('GET', '/session/status', undefined, directory)
  }
  listAgents() {
    return this.#req<AgentInfo[] | null>('GET', '/agent')
  }
  listCommands() {
    return this.#req<CommandInfo[] | null>('GET', '/command')
  }
  providers() {
    return this.#req<ProvidersResponse | null>('GET', '/config/providers')
  }
}

// The client fleetview holds per server: asks once which API the server speaks (opencodeApi), then
// hands every call to that version's client. The choice lives here and nowhere else.
export class OpencodeClient {
  baseUrl: string
  fetch: typeof fetch

  #client: OpencodeV1Client | OpencodeV2Client | undefined

  constructor(baseUrl: string, fetchImpl: typeof fetch = globalThis.fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.fetch = fetchImpl
  }

  // Not memoised until the server has answered: an unreachable one is asked again on the next call.
  async #wire() {
    this.#client ??= (await opencodeApi(this.baseUrl, this.fetch)) === 2 ? new OpencodeV2Client(this.baseUrl, this.fetch, () => authHeader()) : new OpencodeV1Client(this.baseUrl, this.fetch)
    return this.#client
  }

  async listSessions(directory?: string) {
    return (await this.#wire()).listSessions(directory)
  }
  async createSession(options: { agent?: string; model?: ModelSelection } = {}, directory?: string) {
    return (await this.#wire()).createSession(options, directory)
  }
  async forkSession(id: string, directory?: string) {
    return (await this.#wire()).forkSession(id, directory)
  }
  async promptAsync(id: string, text: string, directory?: string) {
    return (await this.#wire()).promptAsync(id, text, directory)
  }
  async renameSession(id: string, title: string, directory?: string) {
    return (await this.#wire()).renameSession(id, title, directory)
  }
  async deleteSession(id: string, directory?: string) {
    return (await this.#wire()).deleteSession(id, directory)
  }
  async listMessages(id: string, directory?: string) {
    return (await this.#wire()).listMessages(id, directory)
  }
  async listProjects() {
    return (await this.#wire()).listProjects()
  }
  async abortSession(id: string, directory?: string) {
    return (await this.#wire()).abortSession(id, directory)
  }
  async listPermissions(directory?: string) {
    return (await this.#wire()).listPermissions(directory)
  }
  async listQuestions(directory?: string) {
    return (await this.#wire()).listQuestions(directory)
  }
  async respondPermission(requestID: string, reply: unknown, directory?: string) {
    return (await this.#wire()).respondPermission(requestID, reply, directory)
  }
  async respondQuestion(requestID: string, answers: unknown, directory?: string) {
    return (await this.#wire()).respondQuestion(requestID, answers, directory)
  }
  async runShell(id: string, command: string, directory?: string, agent?: string) {
    return (await this.#wire()).runShell(id, command, directory, agent)
  }
  async createWorktree(name: string, directory?: string) {
    return (await this.#wire()).createWorktree(name, directory)
  }
  async listWorktrees(directory?: string) {
    return (await this.#wire()).listWorktrees(directory)
  }
  async removeWorktree(worktreeDirectory: string, directory?: string) {
    return (await this.#wire()).removeWorktree(worktreeDirectory, directory)
  }
  async sessionStatus(directory?: string) {
    return (await this.#wire()).sessionStatus(directory)
  }
  async statusSnapshot(): Promise<StatusSnapshot | null> {
    const wire = await this.#wire()
    return wire instanceof OpencodeV2Client ? wire.statusSnapshot() : null
  }
  async listAgents() {
    return (await this.#wire()).listAgents()
  }
  async listCommands() {
    return (await this.#wire()).listCommands()
  }
  async providers() {
    return (await this.#wire()).providers()
  }
}
