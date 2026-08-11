import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createStore } from '../src/session-store.ts'
import { BACKEND_NAMES, DEFAULT_BACKEND, defaultBackendName, isBackendName } from '../src/backends/index.ts'
import { createOpencodeBackend } from '../src/backends/opencode/index.ts'
import { createClaudeBackend } from '../src/backends/claude/index.ts'
import { createCopilotBackend } from '../src/backends/copilot/index.ts'

// The normalisers live on each adapter now (Backend contract, #83), so the fixtures reach them the
// way the roster does: through the adapter. Neither the server nor the client is ever touched by a
// normaliser, so stubs are enough to build opencode's.
const adapters: Record<string, any> = {
  opencode: createOpencodeBackend({ server: { host: '127.0.0.1', port: 0 } as any, client: {} as any }),
  claude: createClaudeBackend(),
  copilot: createCopilotBackend(),
}
const createNormaliser = (backend: string) => adapters[backend].createNormaliser()
const normaliseSessions = (backend: string, rows: any[] | null | undefined) => adapters[backend].normaliseSessions(rows)

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))

// The whole point of normalisation is that the store's rules apply unchanged, so the assertions run
// against a real store rather than against the event objects.
const rowsFrom = (backend: string, directory: string, events: unknown[]) => {
  const store = createStore()
  const normalise = createNormaliser(backend)
  for (const e of events) for (const store_event of normalise(e)) store.apply(directory, store_event)
  return store.byProject().find((g) => g.projectKey === directory)?.sessions ?? []
}

test('the backend registry names opencode as the default and validates the rest', () => {
  expect(BACKEND_NAMES).toEqual(['opencode', 'claude', 'copilot'])
  expect(DEFAULT_BACKEND).toBe('opencode')
  expect(isBackendName('claude')).toBe(true)
  expect(isBackendName('codex')).toBe(false)
})

test('FLEETVIEW_BACKEND sets the default and an unknown value falls back quietly', () => {
  expect(defaultBackendName({} as any)).toBe('opencode')
  expect(defaultBackendName({ FLEETVIEW_BACKEND: 'copilot' } as any)).toBe('copilot')
  expect(defaultBackendName({ ROOST_BACKEND: 'claude' } as any)).toBe('claude') // pre-rename spelling still read
  // A typo in a shell profile must not make the roster unopenable — `--backend` is the loud form.
  expect(defaultBackendName({ FLEETVIEW_BACKEND: 'nonsense' } as any)).toBe('opencode')
})

test('opencode events pass through untouched', () => {
  const normalise = createNormaliser('opencode')
  const event = { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } }
  expect(normalise(event)).toEqual([event])
  const list = [{ id: 's1', title: 'x', time: { updated: 5 } }]
  expect(normaliseSessions('opencode', list)).toBe(list)
})

test('a successful claude run reads as running and then done, with its reply as the snippet', () => {
  const events = fixture('claude-run-success.jsonl')
  // Mid-run: the init and the assistant text have landed, the result has not.
  const midRun = rowsFrom('claude', '/x/alpha', events.slice(0, 2))
  expect(midRun[0]).toMatchObject({ status: 'running', snippet: 'hello' })
  const finished = rowsFrom('claude', '/x/alpha', events)
  expect(finished[0]).toMatchObject({ id: 'a54d9303-c663-4683-b1e8-3d432b999388', status: 'done', snippet: 'hello' })
})

test("a claude run refused a tool lands in needs-input, naming the tool it wanted", () => {
  const rows = rowsFrom('claude', '/x/alpha', fixture('claude-run-permission-denied.jsonl'))
  expect(rows[0]).toMatchObject({ status: 'waiting', pendingRequest: true, waitingFor: 'permission prompt' })
})

test('a failed claude run reads as an error', () => {
  const rows = rowsFrom('claude', '/x/alpha', fixture('claude-run-resume-error.jsonl'))
  expect(rows[0].status).toBe('error')
})

test('claude lines without a session id are dropped rather than guessed at', () => {
  expect(createNormaliser('claude')({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })).toEqual([])
})

// The run stream keys the id `session_id`; the on-disk transcript keys it `sessionId`. Reading only
// `session_id` dropped every discovered transcript line at the guard above — the whole discovery
// feature produced nothing.
test('a discovered transcript is read via sessionId and seeds idle, not stuck working', () => {
  const line = { type: 'assistant', sessionId: 's1', __source: 'transcript', message: { content: [{ type: 'text', text: '17 passed' }] } }
  expect(rowsFrom('claude', '/x/alpha', [line])[0]).toMatchObject({ id: 's1', status: 'idle', snippet: '17 passed' })
})

// The compounding half: without a source tag a transcript seeded 'working' and stuck there forever,
// because a transcript carries no `result` to move it off. A run (session_id, untagged) still seeds
// 'working' via its init line and reaches 'done' on its result.
test('a run still seeds working then done, untagged', () => {
  const init = { type: 'system', subtype: 'init', session_id: 's2' }
  const result = { type: 'result', subtype: 'success', session_id: 's2', result: 'done' }
  expect(rowsFrom('claude', '/x/alpha', [init])[0].status).toBe('running')
  expect(rowsFrom('claude', '/x/alpha', [init, result])[0].status).toBe('done')
})

// The synthetic line the backend writes on a spawn failure: is_error with no prior run events at
// all, which is what an ENOENT'd `claude` leaves behind. It must read as an error, not stay working.
test('a spawn-failure result line reads as an error with no prior events', () => {
  const rows = rowsFrom('claude', '/x/alpha', [{ type: 'result', is_error: true, subtype: 'error_during_execution', session_id: 's3' }])
  expect(rows[0].status).toBe('error')
})

test('two claude sessions in one directory fold independently', () => {
  const a = fixture('claude-run-success.jsonl')
  // The recorded failure is a resume of the same session, so the second session is that run's events
  // re-stamped with an id of their own — which is what a directory with two live runs delivers.
  const b = fixture('claude-run-resume-error.jsonl').map((e: any) => ({ ...e, session_id: 'other-session' }))
  // Interleaved, so a fold that leaked between sessions would show up as one row or the wrong status.
  const rows = rowsFrom('claude', '/x/alpha', [a[0], b[0], a[1], a[2]])
  expect(rows).toHaveLength(2)
  expect(rows.find((r: any) => r.id === a[0].session_id)?.status).toBe('done')
  expect(rows.find((r: any) => r.id === 'other-session')?.status).toBe('error')
})

test('claude transcripts normalise into rows the store can list', () => {
  // `created` is the session's own first-record timestamp, `updated` the transcript's mtime: the age
  // column would otherwise read time-since-last-activity for claude rows and time-since-creation for
  // every other kind.
  expect(normaliseSessions('claude', [{ id: 'c1', title: 'fix tests', createdAt: 1000, updatedAt: 1234, directory: '/x/alpha' }])).toEqual([
    { id: 'c1', title: 'fix tests', time: { created: 1000, updated: 1234 } },
  ])
  // No parseable timestamp anywhere in the transcript: `created` is 0 and ageLabel's
  // `createdAt || updatedAt` falls back to the mtime, which is what this row rendered before.
  expect(normaliseSessions('claude', [{ id: 'c3', title: 'no timestamp', createdAt: 0, updatedAt: 1234 }])[0].time).toEqual({ created: 0, updated: 1234 })
  // #46: an untitled transcript reports an empty title, NOT its id. The id used to be the fallback
  // here, and a UUID is not a placeholder to the store, so it overwrote the dispatch prompt below.
  expect(normaliseSessions('claude', [{ id: 'c2', title: '', updatedAt: 0 }])[0].title).toBe('')
})

// #46: the row read as `f1e5ddfa-e8e3-45ff-…` while peek on the same row showed the prompt — peek
// re-reads the record, where the provisional was still sitting behind the id the relist had written.
test('#46 a dispatched claude session keeps its prompt as the title until claude names the session', () => {
  const store = createStore()
  const row = { id: 'f1e5ddfa-e8e3-45ff', title: '', createdAt: 1000, updatedAt: 1234 }
  store.setSessions('/x/alpha', normaliseSessions('claude', [row]) as any, undefined)
  store.setProvisionalTitle('/x/alpha', row.id, 'fix the flaky roster test')
  // The relist is the moment the bug appeared: every 500ms poll re-reports the same untitled session.
  store.setSessions('/x/alpha', normaliseSessions('claude', [row]) as any, undefined)
  expect(store.get('/x/alpha', row.id)?.title).toBe('fix the flaky roster test')
  // And a real title, once claude writes one, still outranks what was dispatched.
  store.setSessions('/x/alpha', normaliseSessions('claude', [{ ...row, title: 'Fix the flaky roster test' }]) as any, undefined)
  expect(store.get('/x/alpha', row.id)?.title).toBe('Fix the flaky roster test')
})

// The other half of #46: nothing dispatched this session, so there is no provisional to fall back on
// and the row must still say something. projects.ts supplies the transcript's opening prompt as the
// title (claude-projects.test.ts covers the read); an id-titled row is only what is left when the
// listing itself has no idea, which is what `?? s.id` in setSessions is for.
test('#46 a discovered claude session the roster never dispatched still renders a title', () => {
  const store = createStore()
  const discovered = { id: 'bbbb-2222', title: 'research the mesh setup', createdAt: 1000, updatedAt: 1234 }
  store.setSessions('/x/alpha', normaliseSessions('claude', [discovered]) as any, undefined)
  expect(store.get('/x/alpha', discovered.id)?.title).toBe('research the mesh setup')
})

test('copilot session events fold into running, done and failed', () => {
  const ev = (status: string, lastOutput = '') => ({ type: 'copilot.session', sessionId: 'k1', status, lastOutput, deniedTools: 0, running: true })
  expect(rowsFrom('copilot', '/x/alpha', [ev('working')])[0].status).toBe('running')
  expect(rowsFrom('copilot', '/x/alpha', [ev('working'), ev('completed', 'done it')])[0]).toMatchObject({
    status: 'done',
    snippet: 'done it',
  })
  expect(rowsFrom('copilot', '/x/alpha', [ev('working'), ev('failed')])[0].status).toBe('error')
})

test('a repeated copilot report emits nothing new', () => {
  const normalise = createNormaliser('copilot')
  const event = { type: 'copilot.session', sessionId: 'k1', status: 'working', lastOutput: 'x', deniedTools: 0, running: true }
  expect(normalise(event).length).toBeGreaterThan(0)
  expect(normalise({ ...event })).toEqual([])
})

test('a resumed copilot session goes back to running from a finished state', () => {
  const ev = (status: string) => ({ type: 'copilot.session', sessionId: 'k1', status, lastOutput: 'x', deniedTools: 0, running: true })
  expect(rowsFrom('copilot', '/x/alpha', [ev('working'), ev('completed'), ev('working')])[0].status).toBe('running')
})

// M12 parity with claude: a copilot run refused a tool exits 0 and reports `completed`, but tools
// it needed were silently withheld — the honest end state is the same synthetic needs-input.
test('a tool-denied copilot run ends as needs-input, not green, and a resume clears it', () => {
  const ev = (status: string, deniedTools: number) => ({ type: 'copilot.session', sessionId: 'k1', status, lastOutput: 'partway', deniedTools, running: false })
  const denied = rowsFrom('copilot', '/x/alpha', [ev('working', 0), ev('completed', 2)])[0]
  expect(denied).toMatchObject({ status: 'waiting', pendingRequest: true })
  expect(denied.snippet).toContain('refused a tool') // copilot denials carry no tool names
  const resumed = rowsFrom('copilot', '/x/alpha', [ev('working', 0), ev('completed', 2), ev('working', 0)])[0]
  expect(resumed).toMatchObject({ status: 'running', pendingRequest: false })
})

test('a failed copilot run with denials still reads as failed, not needs-input', () => {
  const ev = (status: string, deniedTools: number) => ({ type: 'copilot.session', sessionId: 'k1', status, lastOutput: '', deniedTools, running: false })
  expect(rowsFrom('copilot', '/x/alpha', [ev('working', 2), ev('failed', 2)])[0].status).toBe('error')
})

test('a non-copilot event on the copilot stream is ignored', () => {
  expect(createNormaliser('copilot')({ type: 'something.else', sessionId: 'k1' })).toEqual([])
})

test('copilot listings project onto the row shape and drop the liveness flag', () => {
  expect(
    normaliseSessions('copilot', [{ id: 'k1', title: 'fix', directory: '/x/alpha', running: true, time: { created: 1, updated: 2 } }]),
  ).toEqual([{ id: 'k1', title: 'fix', time: { created: 1, updated: 2 } }])
})

// The regression this test exists for: `busy` does not clear pending state in the store, and a
// pending entry outranks `running`, so the synthetic denial has to be retired explicitly or an
// unblocked session reads `needs input` while it is visibly working.
test('resuming a denied claude session clears the denial and reads as running again', () => {
  const denied = fixture('claude-run-permission-denied.jsonl')
  const id = denied[0].session_id
  const resume = { type: 'system', subtype: 'init', session_id: id }
  expect(rowsFrom('claude', '/x/alpha', denied)[0].status).toBe('waiting')
  const resumed = rowsFrom('claude', '/x/alpha', [...denied, resume])[0]
  expect(resumed).toMatchObject({ status: 'running', pendingRequest: false })
})
