import type { Session, OpencodeMessage, Project, PermissionAsked, QuestionAsked, OpencodeSessionStatus, Worktree } from '../../types.ts'

// opencode's server takes HTTP basic auth when OPENCODE_SERVER_PASSWORD is set — the same
// variable `opencode attach -p` defaults to, so a spawned server, fleetview's own requests and the
// attach child all pick it up from one place.
//
// This matters more than it looks: the server has POST /session/:id/shell, which runs an arbitrary
// shell command, and fleetview spawns it detached and unref'd so it outlives fleetview on a fixed port.
// Unauthenticated, anything that can reach 127.0.0.1 as this user has code execution. Opt-in
// because turning it on unilaterally would lock fleetview out of a server the user already had running.
export function authHeader(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const password = env.OPENCODE_SERVER_PASSWORD
  if (!password) return undefined
  const user = env.OPENCODE_SERVER_USERNAME || 'opencode'
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
}

export class OpencodeClient {
  baseUrl: string
  fetch: typeof fetch

  constructor(baseUrl: string, fetchImpl: typeof fetch = globalThis.fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.fetch = fetchImpl
  }

  // Parsed JSON is cast to the caller-declared T; the typed methods below pin T
  // to the opencode wire shape each endpoint returns (see types.ts).
  async #req<T = unknown>(method: string, path: string, body?: unknown, directory?: string): Promise<T> {
    const query = directory ? `?directory=${encodeURIComponent(directory)}` : ''
    const auth = authHeader()
    const res = await this.fetch(`${this.baseUrl}${path}${query}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(auth ? { authorization: auth } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`)
    const text = await res.text()
    return (text.trim() ? JSON.parse(text) : null) as T
  }

  listSessions(directory?: string) { return this.#req<Session[]>('GET', '/session', undefined, directory) }
  // Deliberately sends no title: opencode names a session itself from its first prompt, using its
  // own small model, about 20 seconds in — but only when the session was created without one.
  // Verified live against opencode 1.18.4: a session created with `{}` became "Reply with single
  // word ok", while an identical session created with an explicit title kept it for 48s+.
  // Sending the raw prompt as the title, which fleetview used to do, is what suppressed the good name.
  // `agent` and `model` are accepted by POST /session and set what the session runs as.
  createSession({ agent, model }: { agent?: string; model?: string } = {}, directory?: string) {
    return this.#req<Session>('POST', '/session', { ...(agent ? { agent } : {}), ...(model ? { model } : {}) }, directory)
  }
  // POST /session/:id/fork copies the conversation into a new session — agent view's /fork.
  forkSession(id: string, directory?: string) { return this.#req<Session>('POST', `/session/${encodeURIComponent(id)}/fork`, undefined, directory) }
  promptAsync(id: string, text: string, directory?: string) {
    return this.#req('POST', `/session/${encodeURIComponent(id)}/prompt_async`, { parts: [{ type: 'text', text }] }, directory)
  }
  renameSession(id: string, title: string, directory?: string) { return this.#req('PATCH', `/session/${encodeURIComponent(id)}`, { title }, directory) }
  deleteSession(id: string, directory?: string) { return this.#req('DELETE', `/session/${encodeURIComponent(id)}`, undefined, directory) }
  listMessages(id: string, directory?: string) { return this.#req<OpencodeMessage[]>('GET', `/session/${encodeURIComponent(id)}/message`, undefined, directory) }
  listProjects() { return this.#req<Project[]>('GET', '/project') }
  abortSession(id: string, directory?: string) { return this.#req('POST', `/session/${encodeURIComponent(id)}/abort`, undefined, directory) }
  listPermissions(directory?: string) { return this.#req<PermissionAsked[]>('GET', '/permission', undefined, directory) }
  listQuestions(directory?: string) { return this.#req<QuestionAsked[]>('GET', '/question', undefined, directory) }
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
  listWorktrees(directory?: string) { return this.#req<Worktree[]>('GET', '/experimental/worktree', undefined, directory) }
  // Removes the worktree AND its branch, with no checks of its own — it will delete uncommitted
  // changes without complaint. Callers must consult worktree.ts's worktreeSafety first.
  removeWorktree(worktreeDirectory: string, directory?: string) {
    return this.#req('DELETE', '/experimental/worktree', { directory: worktreeDirectory }, directory)
  }
  sessionStatus(directory?: string) { return this.#req<Record<string, OpencodeSessionStatus>>('GET', '/session/status', undefined, directory) }
  listAgents() { return this.#req('GET', '/agent') }
  listCommands() { return this.#req('GET', '/command') }
  providers() { return this.#req('GET', '/config/providers') }
}
