// The README demo: the real App, driven by real keystrokes, against a scripted fake opencode.
//
// Why fake the server rather than record a live session: a recording has to show the "needs input"
// transition, and provoking one on demand from a real agent is neither quick nor repeatable. Every
// component, key handler and state transition here is the shipped code — only the client and the
// event stream are fixtures, exactly as test/app.test.ts wires them. So the GIF can be regenerated
// on any machine, with no API key, no repository and no tokens spent.
//
// Set BEFORE imports — chalk reads the environment once at load, same as scripts/preview.ts.
process.env.FORCE_COLOR = '3'

const React = (await import('react')).default
const { render } = await import('ink')
const { App } = (await import('../src/app.ts')) as any

const REPO = '/work/fleetview'

type Row = { id: string; dir: string; title: string; updated: number; messages: any[] }

const text = (role: string, body: string) => ({ info: { role }, parts: [{ type: 'text', text: body }] })

// The roster as it looks the moment the recording starts: one of each state, so the three groups
// are populated before a single key is pressed.
const rows = new Map<string, Row>([
  ['s1', { id: 's1', dir: REPO, title: 'port the tokenizer to the new parser', updated: Date.now() - 90_000, messages: [] }],
  ['s2', { id: 's2', dir: REPO, title: 'fix the flaky reconnect test', updated: Date.now() - 240_000, messages: [] }],
  ['s3', { id: 's3', dir: REPO, title: 'update the install docs', updated: Date.now() - 600_000, messages: [] }],
])

// One sink per directory, captured from connectEventsImpl. A dispatch isolates into its own git
// worktree, which opencode reports as a separate project with its own /event stream — so the
// scripted events for a dispatched session have to be delivered to *that* directory, not the repo.
const sinks = new Map<string, (event: unknown) => void>()
const emit = (dir: string, event: unknown) => sinks.get(dir)?.(event)

const client = {
  listProjects: async () => [...new Set([...rows.values()].map((r) => r.dir))].map((worktree, i) => ({
    id: `p-${i}`,
    worktree,
    vcs: 'git',
    time: { created: 1, updated: 1000 },
  })),
  listSessions: async (dir: string) =>
    [...rows.values()].filter((r) => r.dir === dir).map((r) => ({ id: r.id, title: r.title, time: { updated: r.updated } })),
  // Isolation is the default and it is a selling point, so the demo takes the isolated path for
  // real: the app asks for a worktree, gets a directory back, and streams it as a new project.
  listWorktrees: async () => [],
  createWorktree: async (name: string, target: string) => ({ name, directory: `${target}/.worktrees/${name}` }),
  createSession: async (_opts: any, dir: string) => {
    const id = `s${rows.size + 1}`
    rows.set(id, { id, dir, title: 'New session', updated: Date.now(), messages: [] })
    return { id }
  },
  // Resolving immediately is what a real promptAsync does — the work itself only ever shows up as
  // events, which is what `script` plays.
  promptAsync: async (id: string, prompt: string, dir: string) => {
    const row = rows.get(id)
    if (row) row.messages.push(text('user', prompt))
    script(id, dir)
    return {}
  },
  listMessages: async (id: string) => rows.get(id)?.messages ?? [],
  // Answering from the roster is the point of the whole view, so the demo actually does it: the
  // reply clears the question and the session goes back to work and finishes, on camera.
  respondQuestion: async (requestID: string, answers: any[], dir: string) => {
    const id = [...rows.values()].find((r) => r.dir === dir)?.id
    if (!id) return {}
    const choice = answers?.[0]?.[0] ?? 'per-request'
    emit(dir, { type: 'question.replied', properties: { sessionID: id, requestID, id: requestID } })
    rows.get(id)?.messages.push(text('user', choice))
    at(700, () => speak(dir, id, `going with ${choice}; wiring the budget through the retry loop`))
    at(2600, () => {
      speak(dir, id, 'done — the budget caps the total wait at 30s')
      emit(dir, { type: 'session.status', properties: { id, sessionID: id, status: { type: 'idle' } } })
    })
    return {}
  },
  renameSession: async () => ({}),
  deleteSession: async () => ({}),
  sessionStatus: async () => ({}),
  listPermissions: async () => [],
  listQuestions: async () => [],
  abortSession: async () => ({}),
  respondPermission: async () => ({}),
}

const at = (ms: number, fn: () => void) => setTimeout(fn, ms)

// A part only counts as assistant text once a message.updated has registered the message it belongs
// to — session-store attributes by messageID, not by role order. Real opencode sends the pair, so
// the fixture has to as well or every row streams with an empty snippet.
const speak = (dir: string, sessionID: string, body: string) => {
  const messageID = `m-${sessionID}`
  emit(dir, { type: 'message.updated', properties: { sessionID, info: { id: messageID, role: 'assistant' } } })
  emit(dir, { type: 'message.part.updated', properties: { sessionID, part: { type: 'text', messageID, text: body } } })
}

const QUESTION = 'Should the retry budget be per-request or per-session?'

// What a dispatched session does on camera: name itself, stream a little progress, then block on a
// question — the state the whole roster exists to surface.
function script(id: string, dir: string) {
  const say = (ms: number, body: string) =>
    at(ms, () => {
      rows.get(id)?.messages.push(text('assistant', body))
      speak(dir, id, body)
    })

  at(250, () => emit(dir, { type: 'session.status', properties: { id, sessionID: id, status: { type: 'busy' } } }))
  at(500, () => {
    const row = rows.get(id)
    if (row) row.title = 'add a retry budget to the opencode client'
    emit(dir, {
      type: 'session.updated',
      properties: { info: { id, title: 'add a retry budget to the opencode client', time: { updated: Date.now() } } },
    })
  })
  say(1300, 'reading src/backends/opencode/client.ts')
  say(3000, 'the client retries on 429 but nothing bounds the total wait')
  say(4600, 'adding a budget to the request options')
  at(6000, () => {
    emit(dir, {
      type: 'question.asked',
      properties: {
        id: 'q-1',
        requestID: 'q-1',
        sessionID: id,
        questions: [
          {
            question: QUESTION,
            header: 'retry budget scope',
            options: [
              { label: 'per-request', description: 'each call gets its own budget' },
              { label: 'per-session', description: 'one budget shared across the session' },
            ],
          },
        ],
      },
    })
  })
}

// The pre-seeded rows, placed into their groups a beat after mount so the first frame is a settled
// roster rather than three empty headers.
at(150, () => {
  emit(REPO, { type: 'session.status', properties: { id: 's1', sessionID: 's1', status: { type: 'busy' } } })
  speak(REPO, 's1', 'rewriting the tokenizer edge cases')
  emit(REPO, {
    type: 'permission.asked',
    properties: {
      id: 'perm-1',
      requestID: 'perm-1',
      sessionID: 's2',
      permission: 'bash',
      patterns: ['git push'],
      metadata: { command: 'git push --force-with-lease' },
    },
  })
  emit(REPO, { type: 'session.status', properties: { id: 's3', sessionID: 's3', status: { type: 'idle' } } })
})
at(400, () => speak(REPO, 's1', 'rewriting the tokenizer edge cases'))

render(
  React.createElement(App, {
    server: { host: '127.0.0.1', port: 4096 },
    client,
    connectEventsImpl: (target: any, handlers: any) => {
      sinks.set(target.directory, (event) => handlers.onEvent(target.directory, event))
      return { done: new Promise(() => {}), stop: () => {} }
    },
    ensureServerImpl: async () => ({ ok: true, server: { host: '127.0.0.1', port: 4096 } }),
    serverReady: true,
    roster: {
      groupBy: 'state',
      sessions: [...rows.values()].map((r) => ({ worktree: r.dir, id: r.id, addedAt: 1 })),
      collapsed: [],
    },
    persistRoster: () => {},
    cwd: REPO,
    // The PR and branch lookups must not shell out to gh and git — the recording runs in a sandbox
    // with no repository and no network.
    fetchPullRequestsImpl: async () => [],
    branchOfImpl: () => 'main',
    projectPollMs: 3_600_000,
    onAction: () => {},
  }),
)
