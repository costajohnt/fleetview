// opencode 2.x's server API, spoken in 1.x's vocabulary. 2.x replaced the API outright (routes under
// /api, results wrapped in `{data}`, questions became forms, a new message model), and everything
// above the client — session store, peek, the commands — reads 1.x shapes. Translating here, at the
// one boundary, keeps the rest of fleetview single-version.
//
// Shapes are from opencode v2.3.2's source (packages/schema, packages/protocol); see #166. Only
// what fleetview reads is mapped, and reads stay defensive, as in types.ts.
import { basename } from 'node:path'
import type { ListedSession, OpencodeMessage, OpencodeSessionStatus, PermissionAsked, Project, QuestionAsked, Worktree } from '../../types.ts'
import { asString, isRecord } from '../../types.ts'
import { stripControl } from '../../text-utils.ts'
import type { AgentInfo, CommandInfo, ModelSelection, ProvidersResponse } from './client.ts'

type Auth = () => string | undefined

const records = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : [])
// Most 2.x results are `{data: ...}`; a few (project, location, worktree list) are bare.
const unwrap = (body: unknown) => (isRecord(body) && 'data' in body ? body.data : body)

// 2.x errors are {type, message}; 1.x's were NamedError {name, data: {message}}, which is what
// errorLabel and isAbortError read.
export function v1Error(error: unknown) {
  if (!isRecord(error)) return error
  return { name: asString(error.type) ?? 'Error', data: { message: asString(error.message) ?? '' } }
}

export function v1Session(s: Record<string, unknown>, directory?: string): ListedSession {
  const time = isRecord(s.time) ? s.time : {}
  const location = isRecord(s.location) ? s.location : {}
  return {
    ...s,
    id: String(s.id),
    title: asString(s.title) ?? '',
    directory: asString(location.directory) ?? directory ?? '',
    time: { created: time.created, updated: time.updated },
  }
}

export function v1Permission(p: Record<string, unknown>): PermissionAsked {
  const source = isRecord(p.source) ? p.source : undefined
  return {
    id: String(p.id),
    sessionID: String(p.sessionID),
    permission: asString(p.action) ?? '',
    patterns: Array.isArray(p.resources) ? p.resources.map(String) : [],
    metadata: isRecord(p.metadata) ? p.metadata : undefined,
    ...(source ? { tool: { messageID: String(source.messageID), callID: String(source.id) } } : {}),
  }
}

// A 2.x form is a list of fields; opencode's question tool builds one field per question, keyed
// q0, q1, …, a `string` field with options for single choice and `multiselect` for several.
export function v1Question(form: Record<string, unknown>): QuestionAsked {
  return {
    id: String(form.id),
    sessionID: String(form.sessionID),
    questions: records(form.fields).map((f) => ({
      question: asString(f.description) ?? asString(f.title) ?? asString(form.title) ?? '',
      header: asString(f.title) ?? asString(form.title) ?? '',
      options: records(f.options).map((o) => ({ label: asString(o.label) ?? String(o.value), description: asString(o.description) ?? '' })),
      multiple: f.type === 'multiselect',
      custom: f.custom === true,
    })),
  }
}

// MCP servers can raise forms owned by no session (sessionID "global", opencode v2.3.2
// schema/form.ts); there is no row to put them on.
export const isSessionForm = (form: Record<string, unknown>) => typeof form.sessionID === 'string' && form.sessionID !== 'global'

// 1.x answers are positional, one array of option labels per question. 2.x wants a map keyed by
// field, holding option values: a string for single choice, an array for multiselect. A label
// that matches no option is a custom answer and goes as typed.
export function v2Answer(form: Record<string, unknown>, answers: unknown) {
  const rows = Array.isArray(answers) ? answers : []
  const answer: Record<string, string | string[] | number | boolean> = {}
  records(form.fields).forEach((f, i) => {
    const picked = (Array.isArray(rows[i]) ? rows[i] : []).map(String)
    const options = records(f.options)
    const values = picked.map((label) => asString(options.find((o) => o.label === label)?.value) ?? label)
    const first = values[0] ?? ''
    answer[String(f.key)] =
      f.type === 'multiselect' ? values : f.type === 'boolean' ? first === 'true' : f.type === 'number' || f.type === 'integer' ? Number(first) : first
  })
  return answer
}

// 2.x messages are a `type`-discriminated union; peek reads 1.x's {info: {role, error}, parts}.
// User text is top level, assistant text is in `content`, and a failed turn can also end in an
// `idle` record with the error. Everything else (shell, compaction, switches) has no 1.x row.
export function v1Messages(rows: Record<string, unknown>[]): OpencodeMessage[] {
  const out: OpencodeMessage[] = []
  for (const m of rows) {
    const id = asString(m.id)
    if (m.type === 'user') out.push({ info: { id, role: 'user' }, parts: [{ type: 'text', text: asString(m.text) ?? '', messageID: id }] })
    else if (m.type === 'assistant') {
      const parts = records(m.content)
        .filter((c) => c.type === 'text')
        .map((c) => ({ type: 'text', text: asString(c.text) ?? '', messageID: id }))
      out.push({ info: { id, role: 'assistant', ...(m.error ? { error: v1Error(m.error) } : {}) }, parts })
    } else if (m.type === 'idle' && m.outcome === 'failed' && m.error) out.push({ info: { id, role: 'assistant', error: v1Error(m.error) }, parts: [] })
  }
  return out
}

// `provider/model` (the CLI form fleetview's dispatch carries) or the pair /model sets; 2.x takes
// only the object.
function v2Model(model: ModelSelection | undefined) {
  if (!model) return undefined
  if (typeof model !== 'string') return { providerID: model.providerID, id: model.id }
  const slash = model.indexOf('/')
  return slash > 0 ? { providerID: model.slice(0, slash), id: model.slice(slash + 1) } : undefined
}

export class OpencodeV2Client {
  baseUrl: string
  fetch: typeof fetch
  auth: Auth

  constructor(baseUrl: string, fetchImpl: typeof fetch, auth: Auth) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.fetch = fetchImpl
    this.auth = auth
  }

  // Location-scoped routes read the directory from this header (2.x ignores 1.x's ?directory=);
  // session-id routes resolve it from the session, and the header is harmless there.
  async req(method: string, path: string, body?: unknown, directory?: string): Promise<unknown> {
    const auth = this.auth()
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(auth ? { authorization: auth } : {}),
        ...(directory ? { 'x-opencode-directory': encodeURIComponent(directory) } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    })
    // Same treatment as the 1.x client: the body is an untrusted server's words.
    if (!res.ok) throw Object.assign(new Error(`${method} ${path} → ${res.status}: ${stripControl(await res.text()).slice(0, 500)}`), { status: res.status })
    const text = await res.text()
    return text.trim() ? JSON.parse(text) : null
  }

  async listProjects(): Promise<Project[]> {
    // 2.x names the repository root `canonical`; 1.x called it `worktree`. 1.x also listed a
    // project's worktrees in `sandboxes`, which is how the roster finds worktree sessions after a
    // restart; 2.3.2 leaves it empty (verified live), so it is filled from the worktree list.
    const projects = records(unwrap(await this.req('GET', '/api/project')))
    return Promise.all(
      projects.map(async (p) => {
        const worktree = String(p.canonical ?? p.directory ?? '')
        const listed = await this.#worktreesOf(String(p.id)).catch(() => [])
        const sandboxes = [...new Set([...(Array.isArray(p.sandboxes) ? p.sandboxes.map(String) : []), ...listed.map((w) => w.directory)])].filter((d) => d !== worktree)
        return { ...p, worktree, sandboxes }
      }),
    )
  }

  // 2.x pages its listing (50 newest per page); 1.x returned every session. Follow the cursor.
  // ponytail: capped at 20 default pages (1000 sessions) per directory; raise it if anyone has more.
  async listSessions(directory?: string): Promise<ListedSession[]> {
    const out: ListedSession[] = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams()
      if (directory) query.set('directory', directory)
      if (cursor) query.set('cursor', cursor)
      const body = await this.req('GET', `/api/session?${query}`)
      out.push(...records(unwrap(body)).map((s) => v1Session(s, directory)))
      const next = isRecord(body) && isRecord(body.cursor) ? asString(body.cursor.next) : undefined
      if (!next || next === cursor) break
      cursor = next
    }
    return out
  }

  // 2.x's active map is server-wide and says only "running"; the status seed upserts every id it
  // is given, so it is cut down to this directory's sessions. Absent means idle, as in 1.x.
  async sessionStatus(directory?: string): Promise<Record<string, OpencodeSessionStatus>> {
    const active = unwrap(await this.req('GET', '/api/session/active'))
    if (!isRecord(active)) return {}
    const mine = directory ? new Set((await this.listSessions(directory)).map((s) => s.id)) : null
    const out: Record<string, OpencodeSessionStatus> = {}
    for (const id of Object.keys(active)) if (!mine || mine.has(id)) out[id] = { type: 'busy' }
    return out
  }

  async listPermissions(directory?: string) {
    return records(unwrap(await this.req('GET', '/api/permission/request', undefined, directory))).map(v1Permission)
  }

  async listQuestions(directory?: string) {
    return records(unwrap(await this.req('GET', '/api/form', undefined, directory))).filter(isSessionForm).map(v1Question)
  }

  async listMessages(id: string): Promise<OpencodeMessage[]> {
    // Newest first by default; 1.x listed oldest first, which is what peek reads.
    const rows = records(unwrap(await this.req('GET', `/api/session/${encodeURIComponent(id)}/message?limit=200`)))
    return v1Messages(rows.reverse())
  }

  async createSession({ agent, model }: { agent?: string; model?: ModelSelection } = {}, directory?: string) {
    const ref = v2Model(model)
    const body = { ...(agent ? { agent } : {}), ...(ref ? { model: ref } : {}), ...(directory ? { location: { directory } } : {}) }
    const created = unwrap(await this.req('POST', '/api/session', body, directory))
    return v1Session(isRecord(created) ? created : {}, directory)
  }

  async forkSession(id: string, directory?: string) {
    const forked = unwrap(await this.req('POST', `/api/session/${encodeURIComponent(id)}/fork`, {}, directory))
    return v1Session(isRecord(forked) ? forked : {}, directory)
  }

  promptAsync(id: string, text: string, directory?: string) {
    return this.req('POST', `/api/session/${encodeURIComponent(id)}/prompt`, { text }, directory)
  }
  renameSession(id: string, title: string, directory?: string) {
    return this.req('PATCH', `/api/session/${encodeURIComponent(id)}`, { title }, directory)
  }
  deleteSession(id: string, directory?: string) {
    return this.req('DELETE', `/api/session/${encodeURIComponent(id)}`, undefined, directory)
  }
  abortSession(id: string, directory?: string) {
    return this.req('POST', `/api/session/${encodeURIComponent(id)}/interrupt`, undefined, directory)
  }
  // 2.x has no agent on the shell call.
  runShell(id: string, command: string, directory?: string) {
    return this.req('POST', `/api/session/${encodeURIComponent(id)}/shell`, { command }, directory)
  }

  // Replies are routed by session in 2.x, and fleetview only holds the request id, so the pending
  // request is looked up first. One extra GET per answer.
  async respondPermission(requestID: string, reply: unknown, directory?: string) {
    const request = (await this.listPermissions(directory)).find((p) => p.id === requestID)
    if (!request) throw Object.assign(new Error(`permission ${requestID} is no longer pending`), { status: 404 })
    return this.req('POST', `/api/session/${encodeURIComponent(request.sessionID)}/permission/${encodeURIComponent(requestID)}/reply`, { decision: reply }, directory)
  }

  async respondQuestion(requestID: string, answers: unknown, directory?: string) {
    const form = records(unwrap(await this.req('GET', '/api/form', undefined, directory))).find((f) => f.id === requestID)
    if (!form) throw Object.assign(new Error(`question ${requestID} is no longer pending`), { status: 404 })
    const path = `/api/session/${encodeURIComponent(String(form.sessionID))}/form/${encodeURIComponent(requestID)}/reply`
    return this.req('POST', path, { answer: v2Answer(form, answers) }, directory)
  }

  // Worktrees are keyed by project in 2.x, not by directory.
  async #projectID(directory?: string) {
    const location = await this.req('GET', '/api/location', undefined, directory)
    const id = isRecord(location) && isRecord(location.project) ? asString(location.project.id) : undefined
    if (!id) throw new Error(`no opencode project for ${directory ?? 'the server directory'}`)
    return id
  }

  async listWorktrees(directory?: string): Promise<Worktree[]> {
    return this.#worktreesOf(await this.#projectID(directory))
  }

  // Includes the main checkout itself (verified live against 2.3.2).
  async #worktreesOf(projectID: string): Promise<Worktree[]> {
    const rows = records(unwrap(await this.req('GET', `/api/worktree?projectID=${encodeURIComponent(projectID)}`)))
    return rows.map((w) => ({ name: basename(String(w.directory)), directory: String(w.directory) }))
  }

  async createWorktree(name: string, directory?: string) {
    const projectID = await this.#projectID(directory)
    const created = unwrap(await this.req('POST', '/api/worktree', { projectID, name }, directory))
    const dir = isRecord(created) ? asString(created.directory) : undefined
    return dir ? { name: basename(dir), directory: dir } : null
  }

  // `force` matches 1.x, which removed without checks of its own: callers run worktreeSafety first.
  async removeWorktree(worktreeDirectory: string, directory?: string) {
    const projectID = await this.#projectID(directory)
    return this.req('DELETE', '/api/worktree', { projectID, directory: worktreeDirectory, force: true }, directory)
  }

  // 2.x's `name` is a display name ("Build"); the id is what a session runs as and what `@build`
  // matches, and `hidden` replaces 1.x's convention of internal agent names.
  async listAgents() {
    return records(unwrap(await this.req('GET', '/api/agent')))
      .filter((a) => a.hidden !== true)
      .map((a) => ({ ...a, name: String(a.id ?? a.name) })) as AgentInfo[]
  }
  async listCommands() {
    return records(unwrap(await this.req('GET', '/api/command'))) as CommandInfo[]
  }
  // 1.x served providers with their models nested; 2.x lists models separately. Regrouped so the
  // /model picker reads the same {providers: [{id, models: {id: …}}]}.
  async providers(): Promise<ProvidersResponse> {
    const models = records(unwrap(await this.req('GET', '/api/model')))
    const byProvider = new Map<string, Record<string, unknown>>()
    for (const m of models) {
      const provider = asString(m.providerID)
      const id = asString(m.id)
      if (!provider || !id) continue
      if (!byProvider.has(provider)) byProvider.set(provider, {})
      byProvider.get(provider)![id] = m
    }
    return { providers: [...byProvider].map(([id, models]) => ({ id, models })) }
  }
}
