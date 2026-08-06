import { test, expect } from 'vitest'
import { createStore, memberTitle, messageBody, errorLabel } from '../src/session-store.ts'

const seed = (store: any) =>
  store.setSessions('repoA', [
    { id: 's1', title: 'fix tests' },
    { id: 's2', title: 'write docs' },
  ])

test('setSessions seeds idle sessions grouped by repo', () => {
  const store: any = createStore()
  seed(store)
  const rows = store.byProject()
  expect(rows).toEqual([
    {
      projectKey: 'repoA',
      sessions: [
        { projectKey: 'repoA', id: 's1', title: 'fix tests', status: 'idle', updatedAt: 0, createdAt: 0, agent: undefined, pendingRequest: false,
        waitingSince: 0, ranForMs: null, snippet: '' },
        { projectKey: 'repoA', id: 's2', title: 'write docs', status: 'idle', updatedAt: 0, createdAt: 0, agent: undefined, pendingRequest: false,
        waitingSince: 0, ranForMs: null, snippet: '' },
      ],
    },
  ])
})

test('setSessions with time.updated sorts byProject most-recent first', () => {
  const store: any = createStore()
  store.setSessions('repoA', [
    { id: 's1', title: 'old', time: { updated: 100 } },
    { id: 's2', title: 'new', time: { updated: 300 } },
    { id: 's3', title: 'mid', time: { updated: 200 } },
  ])
  expect(store.byProject()[0].sessions.map((s: any) => s.id)).toEqual(['s2', 's3', 's1'])
})

test('session.updated event bumps updatedAt and reorders', () => {
  const store: any = createStore()
  store.setSessions('repoA', [
    { id: 's1', title: 'a', time: { updated: 100 } },
    { id: 's2', title: 'b', time: { updated: 200 } },
  ])
  store.apply('repoA', {
    type: 'session.updated',
    properties: { info: { id: 's1', title: 'a', time: { updated: 300 } } },
  })
  expect(store.byProject()[0].sessions.map((s: any) => s.id)).toEqual(['s1', 's2'])
})

test('session.status busy bumps recency ahead of a more recently-updated idle session', () => {
  const store: any = createStore()
  store.setSessions('repoA', [
    { id: 's1', title: 'a', time: { updated: 100 } },
    { id: 's2', title: 'b', time: { updated: 200 } },
  ])
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  expect(store.byProject()[0].sessions.map((s: any) => s.id)).toEqual(['s1', 's2'])
})

test('busy → running; idle after busy → done; idle without run stays idle', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  expect(store.get('repoA', 's1').status).toBe('running')
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  expect(store.get('repoA', 's1').status).toBe('done')
  expect(store.get('repoA', 's2').status).toBe('idle')
})

test('retry counts as running', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'retry', attempt: 1 } } })
  expect(store.get('repoA', 's1').status).toBe('running')
})

test('M4: pending permission (permission.asked) → waiting; survives a busy status, cleared only by idle', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'permission.asked', properties: { sessionID: 's1', id: 'perm1', permission: 'bash' } })
  expect(store.get('repoA', 's1').status).toBe('waiting')
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  expect(store.get('repoA', 's1').status).toBe('waiting') // busy no longer wipes a still-pending permission
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  expect(store.get('repoA', 's1').status).toBe('done') // the busy transition already flipped hasRun
})

test('waitingFor distinguishes a permission prompt from an input request, undefined otherwise (#86)', () => {
  const store: any = createStore()
  seed(store)
  expect(store.get('repoA', 's1').waitingFor).toBe(undefined) // idle, nothing pending
  store.apply('repoA', { type: 'permission.asked', properties: { sessionID: 's1', id: 'perm1', permission: 'bash' } })
  expect(store.get('repoA', 's1').waitingFor).toBe('permission prompt')
  store.apply('repoA', { type: 'question.asked', properties: { sessionID: 's2', id: 'q1', questions: [{ text: 'proceed?' }], tool: 'ask' } })
  expect(store.get('repoA', 's2').waitingFor).toBe('input needed')
})

test('a handled-type frame missing properties is skipped, not thrown (malformed/foreign SSE)', () => {
  const store: any = createStore()
  seed(store)
  // The SSE frame is cast unchecked at the transport boundary; a version-skewed or foreign server
  // could send a handled type with no properties. It must no-op, not throw a TypeError the event
  // loop would swallow into a spurious offline+reconnect.
  expect(() => store.apply('repoA', { type: 'session.status' })).not.toThrow()
  expect(() => store.apply('repoA', { type: 'session.deleted' })).not.toThrow()
  expect(store.get('repoA', 's1').status).toBe('idle') // unchanged
})

test('session.updated renames; session.deleted removes; unknown events ignored', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.updated', properties: { info: { id: 's1', title: 'renamed' } } })
  expect(store.get('repoA', 's1').title).toBe('renamed')
  store.apply('repoA', { type: 'session.deleted', properties: { info: { id: 's2' } } })
  expect(store.get('repoA', 's2')).toBeUndefined()
  store.apply('repoA', { type: 'some.unknown.event', properties: {} }) // no throw
})

test('subscribers notified on every applied change', () => {
  const store: any = createStore()
  let calls = 0
  store.subscribe(() => calls++)
  seed(store)
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  expect(calls).toBe(2)
})

test('session.status for unknown session upserts placeholder; later seed enriches title, keeps status', () => {
  const store: any = createStore()
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 'sX', status: { type: 'busy' } } })
  expect(store.get('repoA', 'sX').status).toBe('running')
  store.setSessions('repoA', [{ id: 'sX', title: 'real title' }])
  expect(store.get('repoA', 'sX').title).toBe('real title')
  expect(store.get('repoA', 'sX').status).toBe('running')
})

test('permission.asked for unknown session upserts and shows waiting', () => {
  const store: any = createStore()
  store.apply('repoA', { type: 'permission.asked', properties: { sessionID: 'sY', id: 'p1', permission: 'bash' } })
  expect(store.get('repoA', 'sY').status).toBe('waiting')
})

test('setSessions infers hasRun from seen entry when incoming updated is newer', () => {
  const store: any = createStore()
  store.setSessions('repoA', [{ id: 's1', title: 'a', time: { updated: 9 } }], {
    'repoA:s1': { updated: 5, hasRun: false },
  })
  expect(store.get('repoA', 's1').status).toBe('done')
})

test('setSessions honors persisted hasRun flag even without newer activity', () => {
  const store: any = createStore()
  store.setSessions('repoA', [{ id: 's1', title: 'a', time: { updated: 9 } }], {
    'repoA:s1': { updated: 9, hasRun: true },
  })
  expect(store.get('repoA', 's1').status).toBe('done')
})

test('setSessions with no seen entry stays idle', () => {
  const store: any = createStore()
  store.setSessions('repoA', [{ id: 's1', title: 'a', time: { updated: 9 } }], {})
  expect(store.get('repoA', 's1').status).toBe('idle')
})

test('snapshot returns updated+hasRun+stopped per key for round-tripping to seen-store', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  expect(store.snapshot()).toEqual({
    'repoA:s1': { updated: expect.any(Number), hasRun: true, stopped: false },
    'repoA:s2': { updated: 0, hasRun: false, stopped: false },
  })
})

// --- Wave A: permission payloads ---

test('permission.asked stores full payload; still derives waiting like the old id-only Set did', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', {
    type: 'permission.asked',
    properties: { sessionID: 's1', id: 'perm1', permission: 'bash', patterns: ['*'], metadata: {}, always: [] },
  })
  expect(store.get('repoA', 's1').status).toBe('waiting')
})

test('permission.replied clears the matching pendingPermissions entry by requestID', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'permission.asked', properties: { sessionID: 's1', id: 'perm1', permission: 'bash' } })
  expect(store.get('repoA', 's1').status).toBe('waiting')
  store.apply('repoA', { type: 'permission.replied', properties: { sessionID: 's1', requestID: 'perm1', reply: 'once' } })
  expect(store.get('repoA', 's1').status).toBe('idle')
})

test('permission.replied for a different requestID leaves other pending permissions intact', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'permission.asked', properties: { sessionID: 's1', id: 'perm1', permission: 'bash' } })
  store.apply('repoA', { type: 'permission.asked', properties: { sessionID: 's1', id: 'perm2', permission: 'edit' } })
  store.apply('repoA', { type: 'permission.replied', properties: { sessionID: 's1', requestID: 'perm1', reply: 'once' } })
  expect(store.get('repoA', 's1').status).toBe('waiting')
})

// --- Wave A: question-aware waiting ---

test('idle assistant text ending in "?" derives waiting instead of done', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.apply('repoA', { type: 'message.updated', properties: { sessionID: 's1', info: { id: 'm1', role: 'assistant' } } })
  store.apply('repoA', {
    type: 'message.part.updated',
    properties: { sessionID: 's1', part: { type: 'text', messageID: 'm1', text: 'Should I proceed?' } },
  })
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  expect(store.get('repoA', 's1').status).toBe('waiting')
})

test('idle assistant text ending in "?" with trailing whitespace and markdown emphasis still derives waiting', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.apply('repoA', { type: 'message.updated', properties: { sessionID: 's1', info: { id: 'm1', role: 'assistant' } } })
  store.apply('repoA', {
    type: 'message.part.updated',
    properties: { sessionID: 's1', part: { type: 'text', messageID: 'm1', text: 'Should I proceed?**  ' } },
  })
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  expect(store.get('repoA', 's1').status).toBe('waiting')
})

test('idle assistant text NOT ending in "?" derives done as before', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.apply('repoA', { type: 'message.updated', properties: { sessionID: 's1', info: { id: 'm1', role: 'assistant' } } })
  store.apply('repoA', {
    type: 'message.part.updated',
    properties: { sessionID: 's1', part: { type: 'text', messageID: 'm1', text: 'Done, all tests pass.' } },
  })
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  expect(store.get('repoA', 's1').status).toBe('done')
})

test('reasoning parts are ignored for lastAssistantText', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.apply('repoA', { type: 'message.updated', properties: { sessionID: 's1', info: { id: 'm1', role: 'assistant' } } })
  store.apply('repoA', {
    type: 'message.part.updated',
    properties: { sessionID: 's1', part: { type: 'reasoning', messageID: 'm1', text: 'thinking about the question?' } },
  })
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  expect(store.get('repoA', 's1').status).toBe('done')
})

test('user text parts do not count toward lastAssistantText', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'message.updated', properties: { sessionID: 's1', info: { id: 'm0', role: 'user' } } })
  store.apply('repoA', {
    type: 'message.part.updated',
    properties: { sessionID: 's1', part: { type: 'text', messageID: 'm0', text: 'what should I do?' } },
  })
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  expect(store.get('repoA', 's1').status).toBe('done')
})

// --- Wave A: failed state ---

test('session.error marks lastError and derives error status once the session goes idle', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.apply('repoA', { type: 'session.error', properties: { sessionID: 's1', error: { name: 'UnknownError' } } })
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  expect(store.get('repoA', 's1').status).toBe('error')
})

// --- #24: a failed row says why ---

test('errorLabel: the live shape — name plus data.message', () => {
  // Verbatim from the failure that motivated #24 (an OpenRouter model without tool support).
  const err = { name: 'APIError', data: { message: 'No endpoints found that support tool use. Try disabling "bash".' } }
  expect(errorLabel(err)).toBe('APIError: No endpoints found that support tool use. Try disabling "bash".')
})

test('errorLabel: thinner shapes — name only, message only, a bare string', () => {
  expect(errorLabel({ name: 'UnknownError' })).toBe('UnknownError')
  expect(errorLabel({ data: { message: 'boom' } })).toBe('boom')
  expect(errorLabel({ message: 'boom' })).toBe('boom')
  expect(errorLabel('boom')).toBe('boom')
})

test('errorLabel: no text worth showing is null, not a fabricated line', () => {
  expect(errorLabel(true)).toBeNull() // session.error's sentinel: a failure happened, nothing said about it
  expect(errorLabel(undefined)).toBeNull()
  expect(errorLabel({})).toBeNull()
  expect(errorLabel('')).toBeNull()
})

test('errorLabel: strips escapes — the error text is model/server output bound for raw stdout', () => {
  expect(errorLabel({ name: 'APIError', data: { message: 'a\u001B]0;spoofed\u0007b' } })).toBe('APIError: a]0;spoofedb')
})

test('a failed row previews the error message instead of the assistant text it did not get', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.apply('repoA', {
    type: 'session.error',
    properties: { sessionID: 's1', error: { name: 'APIError', data: { message: 'No endpoints found that support tool use.' } } },
  })
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  const row = store.get('repoA', 's1')
  expect(row.status).toBe('error')
  expect(row.snippet).toBe('APIError: No endpoints found that support tool use.')
})

test('a session that did not fail keeps its ordinary snippet', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.apply('repoA', { type: 'message.updated', properties: { sessionID: 's1', info: { id: 'm0', role: 'assistant' } } })
  store.apply('repoA', {
    type: 'message.part.updated',
    properties: { sessionID: 's1', part: { type: 'text', messageID: 'm0', text: 'all done' } },
  })
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  expect(store.get('repoA', 's1').snippet).toBe('all done')
})

test('a failed row with a text-less error keeps the snippet it did have', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.apply('repoA', { type: 'message.updated', properties: { sessionID: 's1', info: { id: 'm0', role: 'assistant' } } })
  store.apply('repoA', {
    type: 'message.part.updated',
    properties: { sessionID: 's1', part: { type: 'text', messageID: 'm0', text: 'running tests' } },
  })
  store.apply('repoA', { type: 'session.error', properties: { sessionID: 's1' } }) // the `true` sentinel path
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  const row = store.get('repoA', 's1')
  expect(row.status).toBe('error')
  expect(row.snippet).toBe('running tests')
})

test('a pending request still outranks the error message in the snippet', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.error', properties: { sessionID: 's1', error: { name: 'APIError', data: { message: 'boom' } } } })
  store.apply('repoA', { type: 'permission.asked', properties: { id: 'p1', sessionID: 's1', permission: 'bash', patterns: ['git push'] } })
  expect(store.get('repoA', 's1').snippet).toBe('permission: bash git push')
})

test('a subsequent busy status clears lastError', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.apply('repoA', { type: 'session.error', properties: { sessionID: 's1', error: { name: 'UnknownError' } } })
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  expect(store.get('repoA', 's1').status).toBe('error')
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  expect(store.get('repoA', 's1').status).toBe('running')
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  expect(store.get('repoA', 's1').status).toBe('done')
})

// #21: aborting a run makes opencode emit a session.error carrying MessageAbortedError. Recording
// that as a failure rendered every Ctrl+X as `failed` and inflated the header's failed count, while
// `ls` (reading the persisted stopped flag) said `stopped`.
test('an abort error renders stopped, not error, when the user stopped the session', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.markStopped('repoA', 's1')
  store.apply('repoA', {
    type: 'session.error',
    properties: { sessionID: 's1', error: { name: 'MessageAbortedError', data: { message: 'aborted' } } },
  })
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  expect(store.get('repoA', 's1').status).toBe('stopped')
})

// The abort name is unambiguous, so a stop fleetview didn't issue itself — another instance, or
// opencode's own TUI — is still a stop, and must render the same way the local one does. That also
// keeps the persisted flag (and therefore `ls`) in step with what the live roster showed.
test('an abort error alone marks the session stopped even without a local markStopped', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.apply('repoA', {
    type: 'session.error',
    properties: { sessionID: 's1', error: { name: 'MessageAbortedError', data: { message: 'aborted' } } },
  })
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  expect(store.get('repoA', 's1').status).toBe('stopped')
  expect(store.snapshot()['repoA:s1'].stopped).toBe(true)
})

// The other half of #21: only the abort name is exempt. A genuine failure still outranks the stop,
// including one the user then aborted out of — the failure is the news.
test('a non-abort error still renders error, even on a stopped session', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.apply('repoA', { type: 'session.error', properties: { sessionID: 's1', error: { name: 'UnknownError' } } })
  store.markStopped('repoA', 's1')
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  expect(store.get('repoA', 's1').status).toBe('error')
})

test('error takes priority over done but not over waiting/running', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.apply('repoA', { type: 'session.error', properties: { sessionID: 's1', error: { name: 'X' } } })
  store.apply('repoA', { type: 'permission.asked', properties: { sessionID: 's1', id: 'p1', permission: 'bash' } })
  expect(store.get('repoA', 's1').status).toBe('waiting')
})

// --- Wave A: snippet ---

test('snippet truncates lastAssistantText to ~80 chars and collapses to a single line', () => {
  const store: any = createStore()
  seed(store)
  const long = 'a'.repeat(50) + '\nline two ' + 'b'.repeat(50)
  store.apply('repoA', { type: 'message.updated', properties: { sessionID: 's1', info: { id: 'm1', role: 'assistant' } } })
  store.apply('repoA', { type: 'message.part.updated', properties: { sessionID: 's1', part: { type: 'text', messageID: 'm1', text: long } } })
  const { snippet } = store.get('repoA', 's1')
  expect(snippet.length).toBe(80)
  expect(snippet).not.toMatch(/\n/)
  expect(snippet.startsWith('a'.repeat(50))).toBe(true)
})

test('snippet is empty string when no assistant text yet', () => {
  const store: any = createStore()
  seed(store)
  expect(store.get('repoA', 's1').snippet).toBe('')
})

// --- Wave A: seeding ---

test('seedStatuses maps live GET /session/status shape into lastStatus, notifies once', () => {
  const store: any = createStore()
  seed(store)
  let calls = 0
  store.subscribe(() => calls++)
  store.seedStatuses('repoA', { s1: { type: 'busy' }, s2: { type: 'idle' } })
  expect(store.get('repoA', 's1').status).toBe('running')
  expect(store.get('repoA', 's2').status).toBe('idle')
  expect(calls).toBe(1)
})

// M4: seedStatuses' busy path must bump updatedAt exactly like the SSE session.status apply path
// does, or a session revived by a mount/reconnect seed sorts as stale until its next live event.
test('M4: seedStatuses busy path bumps updatedAt, matching the event path\'s recency bump', () => {
  const store: any = createStore()
  seed(store) // s1 seeded with updatedAt: 0
  store.seedStatuses('repoA', { s1: { type: 'busy' } })
  expect(store.get('repoA', 's1').updatedAt).toBeGreaterThan(0)
})

test('seedStatuses busy entries mark hasRun so a later idle transition reads done', () => {
  const store: any = createStore()
  seed(store)
  store.seedStatuses('repoA', { s1: { type: 'busy' } })
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  expect(store.get('repoA', 's1').status).toBe('done')
})

test('seedStatuses upserts sessions not yet known to the store', () => {
  const store: any = createStore()
  store.seedStatuses('repoA', { sZ: { type: 'busy' } })
  expect(store.get('repoA', 'sZ').status).toBe('running')
})

test('seedPermissions maps live GET /permission list into pendingPermissions, notifies once', () => {
  const store: any = createStore()
  seed(store)
  let calls = 0
  store.subscribe(() => calls++)
  store.seedPermissions('repoA', [
    { id: 'per1', sessionID: 's1', permission: 'bash', patterns: ['*'], metadata: {}, always: [] },
  ])
  expect(store.get('repoA', 's1').status).toBe('waiting')
  expect(calls).toBe(1)
})

test('seedPermissions upserts sessions not yet known to the store', () => {
  const store: any = createStore()
  store.seedPermissions('repoA', [{ id: 'per1', sessionID: 'sZ', permission: 'bash' }])
  expect(store.get('repoA', 'sZ').status).toBe('waiting')
})

// --- Wave B: pendingFor (peek's inline permission answer needs the raw payloads) ---

test('pendingFor returns full payloads for a session, oldest-first', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'permission.asked', properties: { sessionID: 's1', id: 'p1', permission: 'bash' } })
  store.apply('repoA', { type: 'permission.asked', properties: { sessionID: 's1', id: 'p2', permission: 'edit' } })
  expect(store.pendingFor('repoA', 's1').map((p: any) => p.id)).toEqual(['p1', 'p2'])
})

test('pendingFor returns empty array for a session with no pending permissions or unknown session', () => {
  const store: any = createStore()
  seed(store)
  expect(store.pendingFor('repoA', 's1')).toEqual([])
  expect(store.pendingFor('repoA', 'ghost')).toEqual([])
})

// --- I1: native question channel — question.asked/replied/rejected ---

test('I1: question.asked during busy → waiting (a busy session with a pending question is not "running")', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.apply('repoA', { type: 'question.asked', properties: { sessionID: 's1', id: 'q1', questions: [{ text: 'proceed?' }], tool: 'ask' } })
  expect(store.get('repoA', 's1').status).toBe('waiting')
})

test('I1: question.replied clears the pending question; a still-busy session returns to running', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.apply('repoA', { type: 'question.asked', properties: { sessionID: 's1', id: 'q1', questions: [], tool: 'ask' } })
  expect(store.get('repoA', 's1').status).toBe('waiting')
  store.apply('repoA', { type: 'question.replied', properties: { sessionID: 's1', requestID: 'q1' } })
  expect(store.get('repoA', 's1').status).toBe('running')
})

test('I1: question.rejected clears the pending question same as replied', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.apply('repoA', { type: 'question.asked', properties: { sessionID: 's1', id: 'q1', questions: [], tool: 'ask' } })
  store.apply('repoA', { type: 'question.rejected', properties: { sessionID: 's1', requestID: 'q1' } })
  expect(store.get('repoA', 's1').status).toBe('running')
})

test('I1: question.replied tolerates an `id` field in place of `requestID` (unverified reply schema)', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.apply('repoA', { type: 'question.asked', properties: { sessionID: 's1', id: 'q1', questions: [], tool: 'ask' } })
  store.apply('repoA', { type: 'question.replied', properties: { sessionID: 's1', id: 'q1' } })
  expect(store.get('repoA', 's1').status).toBe('running')
})

test('I1: idle transition clears any leftover pendingQuestions, not stuck waiting', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.apply('repoA', { type: 'question.asked', properties: { sessionID: 's1', id: 'q1', questions: [], tool: 'ask' } })
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  expect(store.get('repoA', 's1').status).toBe('done')
})

// --- I2: stale lastAssistantText resurrects answered questions; error outranks question ---

test('I2: ask → user reply → abort → idle renders done, not waiting (answered question does not resurrect)', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.apply('repoA', { type: 'message.updated', properties: { sessionID: 's1', info: { id: 'm1', role: 'assistant' } } })
  store.apply('repoA', {
    type: 'message.part.updated',
    properties: { sessionID: 's1', part: { type: 'text', messageID: 'm1', text: 'Should I proceed?' } },
  })
  store.apply('repoA', { type: 'message.updated', properties: { sessionID: 's1', info: { id: 'm2', role: 'user' } } })
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  expect(store.get('repoA', 's1').status).toBe('done')
})

test('I2: an error after a question renders error, not waiting', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.apply('repoA', { type: 'message.updated', properties: { sessionID: 's1', info: { id: 'm1', role: 'assistant' } } })
  store.apply('repoA', {
    type: 'message.part.updated',
    properties: { sessionID: 's1', part: { type: 'text', messageID: 'm1', text: 'Should I proceed?' } },
  })
  store.apply('repoA', { type: 'session.error', properties: { sessionID: 's1', error: { name: 'X' } } })
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  expect(store.get('repoA', 's1').status).toBe('error')
})

// --- M7: part attribution by messageID, not lastRole ---

test('M7: an interleaved user message.updated does not drop the assistant part (matched by messageID)', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'message.updated', properties: { sessionID: 's1', info: { id: 'm1', role: 'assistant' } } })
  store.apply('repoA', { type: 'message.updated', properties: { sessionID: 's1', info: { id: 'm2', role: 'user' } } })
  store.apply('repoA', {
    type: 'message.part.updated',
    properties: { sessionID: 's1', part: { type: 'text', messageID: 'm1', text: 'assistant reply' } },
  })
  expect(store.get('repoA', 's1').snippet).toBe('assistant reply')
})

test('M7: a user part under a stale assistant lastRole does not corrupt the assistant snippet', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'message.updated', properties: { sessionID: 's1', info: { id: 'm1', role: 'assistant' } } })
  store.apply('repoA', {
    type: 'message.part.updated',
    properties: { sessionID: 's1', part: { type: 'text', messageID: 'm1', text: 'assistant reply' } },
  })
  // user's own part arrives before its message.updated is processed (race) — must not overwrite
  store.apply('repoA', {
    type: 'message.part.updated',
    properties: { sessionID: 's1', part: { type: 'text', messageID: 'm2', text: 'user text' } },
  })
  expect(store.get('repoA', 's1').snippet).toBe('assistant reply')
})

// --- I1: seedQuestions (GET /question mount seed) ---

test('I1: seedQuestions maps live GET /question list into pendingQuestions, notifies once', () => {
  const store: any = createStore()
  seed(store)
  let calls = 0
  store.subscribe(() => calls++)
  store.seedQuestions('repoA', [{ id: 'q1', sessionID: 's1', questions: [{ text: 'proceed?' }], tool: 'ask' }])
  expect(store.get('repoA', 's1').status).toBe('waiting')
  expect(calls).toBe(1)
})

test('I1: seedQuestions upserts sessions not yet known to the store', () => {
  const store: any = createStore()
  store.seedQuestions('repoA', [{ id: 'q1', sessionID: 'sZ' }])
  expect(store.get('repoA', 'sZ').status).toBe('waiting')
})

// --- I2: reseeds are authoritative — a stale pending entry absent from the fresh list is dropped ---

test('I2: seedPermissions with an empty fresh list clears a stale pending permission for that project', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'permission.asked', properties: { sessionID: 's1', id: 'perm1', permission: 'bash' } })
  expect(store.get('repoA', 's1').status).toBe('waiting')
  store.seedPermissions('repoA', [])
  expect(store.get('repoA', 's1').status).toBe('idle')
})

test('I2: seedPermissions keeps an entry that is still present in the fresh list', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'permission.asked', properties: { sessionID: 's1', id: 'perm1', permission: 'bash' } })
  store.seedPermissions('repoA', [{ id: 'perm1', sessionID: 's1', permission: 'bash' }])
  expect(store.get('repoA', 's1').status).toBe('waiting')
  expect(store.pendingFor('repoA', 's1').map((p: any) => p.id)).toEqual(['perm1'])
})

test('I2: seedQuestions with an empty fresh list clears a stale pending question for that project', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'question.asked', properties: { sessionID: 's1', id: 'q1', questions: [] } })
  expect(store.get('repoA', 's1').status).toBe('waiting')
  store.seedQuestions('repoA', [])
  expect(store.get('repoA', 's1').status).toBe('idle')
})

test('I2: seedQuestions keeps an entry that is still present in the fresh list', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'question.asked', properties: { sessionID: 's1', id: 'q1', questions: [] } })
  store.seedQuestions('repoA', [{ id: 'q1', sessionID: 's1', questions: [] }])
  expect(store.get('repoA', 's1').status).toBe('waiting')
})

// --- M5: rollback ordering — a failed-answer re-insert returns to its original position ---

test('M5: re-asking a permission after a rollback (same payload) preserves its original oldest-first position', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'permission.asked', properties: { sessionID: 's1', id: 'p1', permission: 'bash' } })
  store.apply('repoA', { type: 'permission.asked', properties: { sessionID: 's1', id: 'p2', permission: 'edit' } })
  const [p1] = store.pendingFor('repoA', 's1')
  // optimistic clear + rollback, exactly as app.ts's peek 'y' handler does on respondPermission failure
  store.apply('repoA', { type: 'permission.replied', properties: { sessionID: 's1', requestID: 'p1', reply: 'once' } })
  store.apply('repoA', { type: 'permission.asked', properties: p1 })
  expect(store.pendingFor('repoA', 's1').map((p: any) => p.id)).toEqual(['p1', 'p2'])
})

// --- I2: seq watermark — a seed that resolves after live events have landed must not delete them ---

test('I2: an entry applied live AFTER the mark survives a reseed whose fresh list lacks it', () => {
  const store: any = createStore()
  seed(store)
  const mark = store.seedMark() // captured "before issuing the GET", as app.ts's seedLiveState does
  store.apply('repoA', { type: 'permission.asked', properties: { sessionID: 's1', id: 'p1', permission: 'bash' } })
  store.seedPermissions('repoA', [], mark) // the seed's stale snapshot predates the live event
  expect(store.pendingFor('repoA', 's1').map((p: any) => p.id)).toEqual(['p1']) // event-fresh — survives
})

test('I2: an entry that existed BEFORE the mark and is absent from the fresh list is deleted (stale)', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'permission.asked', properties: { sessionID: 's1', id: 'p1', permission: 'bash' } })
  const mark = store.seedMark() // captured after p1 already exists
  store.seedPermissions('repoA', [], mark)
  expect(store.pendingFor('repoA', 's1')).toEqual([])
})

test('I2: seedQuestions — an entry applied live after the mark survives a reseed whose fresh list lacks it', () => {
  const store: any = createStore()
  seed(store)
  const mark = store.seedMark()
  store.apply('repoA', { type: 'question.asked', properties: { sessionID: 's1', id: 'q1', questions: [] } })
  store.seedQuestions('repoA', [], mark)
  expect(store.pendingQuestionsFor('repoA', 's1').map((q: any) => q.id)).toEqual(['q1'])
})

test('I2: new-from-seed permissions are stamped below the mark, oldest-first ahead of a later live-applied entry (M3)', () => {
  const store: any = createStore()
  seed(store)
  const mark = store.seedMark()
  // a live event lands after the mark but resolves before the seed does
  store.apply('repoA', { type: 'permission.asked', properties: { sessionID: 's1', id: 'live', permission: 'bash' } })
  // the seed itself reflects two permissions that were pending while fleetview was offline
  store.seedPermissions('repoA', [
    { id: 'old1', sessionID: 's1', permission: 'edit' },
    { id: 'old2', sessionID: 's1', permission: 'write' },
  ], mark)
  expect(store.pendingFor('repoA', 's1').map((p: any) => p.id)).toEqual(['old1', 'old2', 'live'])
})

// --- M6: GET /session/status is a partial map (verified live) — idle sessions are absent from it ---

test('M6: seedStatuses treats a member session absent from the live status map as idle, not "whatever it was before"', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  expect(store.get('repoA', 's1').status).toBe('running')
  store.seedStatuses('repoA', {}) // live map omits s1 entirely, as verified against the real server
  expect(store.get('repoA', 's1').status).toBe('done') // forced idle; hasRun still true from the busy run
})

test('M6: seedStatuses leaves a session present in the map exactly as the map says', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.seedStatuses('repoA', { s1: { type: 'busy' } })
  expect(store.get('repoA', 's1').status).toBe('running')
})

// --- I2: seedStatuses watermark — a live status applied after the mark must not be clobbered by a stale seed ---

test('I2: a live busy status applied after the mark survives a stale seed where the session is absent from the map (no force-idle)', () => {
  const store: any = createStore()
  seed(store)
  const mark = store.seedMark() // captured "before issuing the GET", as app.ts's seedLiveState does
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  expect(store.get('repoA', 's1').status).toBe('running')
  store.seedStatuses('repoA', {}, mark) // the seed's stale snapshot predates the live busy event, and omits s1 entirely
  expect(store.get('repoA', 's1').status).toBe('running') // must NOT be force-idled — event-fresh
})

test('I2: a live idle status applied after the mark is not overwritten by a stale busy entry in the seed map', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  const mark = store.seedMark() // captured after busy, before the live idle transition
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  expect(store.get('repoA', 's1').status).toBe('done')
  store.seedStatuses('repoA', { s1: { type: 'busy' } }, mark) // stale snapshot still shows busy
  expect(store.get('repoA', 's1').status).toBe('done') // must NOT be reverted to running
})

test('I2: a session untouched since before the mark still seeds normally', () => {
  const store: any = createStore()
  seed(store)
  const mark = store.seedMark()
  store.seedStatuses('repoA', { s1: { type: 'busy' } }, mark)
  expect(store.get('repoA', 's1').status).toBe('running')
  store.seedStatuses('repoA', {}, mark) // now absent from the map — s1 has no live activity since the mark
  expect(store.get('repoA', 's1').status).toBe('done') // ordinary force-idle applies
})

// --- M4: clearHeuristicWaiting ---

test('M4: clearHeuristicWaiting retires a "?"-heuristic waiting session to done', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.apply('repoA', { type: 'message.updated', properties: { sessionID: 's1', info: { id: 'm1', role: 'assistant' } } })
  store.apply('repoA', {
    type: 'message.part.updated',
    properties: { sessionID: 's1', part: { type: 'text', messageID: 'm1', text: 'Should I proceed?' } },
  })
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  expect(store.get('repoA', 's1').status).toBe('waiting')
  store.clearHeuristicWaiting('repoA', 's1')
  expect(store.get('repoA', 's1').status).toBe('done')
})

test('M4: clearHeuristicWaiting is a no-op when a real pending permission is what makes the session wait', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'permission.asked', properties: { sessionID: 's1', id: 'p1', permission: 'bash' } })
  store.clearHeuristicWaiting('repoA', 's1')
  expect(store.get('repoA', 's1').status).toBe('waiting') // untouched — this isn't heuristic waiting
})

// --- M5: grapheme-safe snippet truncation ---

test('M5: snippet truncation at the 80-boundary keeps a boundary emoji whole, not split into a lone surrogate', () => {
  const store: any = createStore()
  seed(store)
  const text = 'a'.repeat(79) + '\u{1F600}' + 'b'.repeat(10) // 😀 is a surrogate pair (2 UTF-16 units)
  store.apply('repoA', { type: 'message.updated', properties: { sessionID: 's1', info: { id: 'm1', role: 'assistant' } } })
  store.apply('repoA', { type: 'message.part.updated', properties: { sessionID: 's1', part: { type: 'text', messageID: 'm1', text } } })
  const { snippet } = store.get('repoA', 's1')
  expect(snippet).toBe('a'.repeat(79) + '\u{1F600}')
  expect(snippet.endsWith('\u{1F600}')).toBe(true) // whole emoji, not a corrupted lone surrogate half
})

// --- I1: snippet computed at write time from a pre-sliced, lazily-truncated input ---

test('I1: a 200KB lastAssistantText still yields the correct 80-char snippet', () => {
  const store: any = createStore()
  seed(store)
  const long = 'a'.repeat(200_000)
  store.apply('repoA', { type: 'message.updated', properties: { sessionID: 's1', info: { id: 'm1', role: 'assistant' } } })
  store.apply('repoA', { type: 'message.part.updated', properties: { sessionID: 's1', part: { type: 'text', messageID: 'm1', text: long } } })
  const { snippet } = store.get('repoA', 's1')
  expect(snippet).toBe('a'.repeat(80))
})

// Coarse perf guard, not a benchmark: publicView must read a cached value, not re-segment the
// full 200KB text on every call — 1000 calls on the same record finishing in well under a second
// catches an O(text.length) regression without flaking on ordinary CI variance.
test('I1: publicView on a 200KB-snippet record is cheap — 1000 calls stay well under the O(full-text) bound', () => {
  const store: any = createStore()
  seed(store)
  const long = 'a'.repeat(200_000)
  store.apply('repoA', { type: 'message.updated', properties: { sessionID: 's1', info: { id: 'm1', role: 'assistant' } } })
  store.apply('repoA', { type: 'message.part.updated', properties: { sessionID: 's1', part: { type: 'text', messageID: 'm1', text: long } } })
  const start = Date.now()
  for (let i = 0; i < 1000; i++) store.get('repoA', 's1')
  expect(Date.now() - start).toBeLessThan(200)
})


// Agent view's sixth state. The server can't report it — an aborted session looks idle over the
// wire — so the store has to remember the stop, and forget it the moment the session runs again.
test('markStopped derives the stopped state, and a later run retires it', () => {
  const store: any = createStore()
  store.setSessions('repoA', [{ id: 's1', title: 'x', time: { created: 1000, updated: 1000 } }])
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  expect(store.get('repoA', 's1').status).toBe('done')
  store.markStopped('repoA', 's1')
  expect(store.get('repoA', 's1').status).toBe('stopped')
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  expect(store.get('repoA', 's1').status).toBe('running')
})

test('a stop never hides a pending permission — the session still needs the user', () => {
  const store: any = createStore()
  store.setSessions('repoA', [{ id: 's1', title: 'x', time: { created: 1000, updated: 1000 } }])
  store.apply('repoA', { type: 'permission.asked', properties: { sessionID: 's1', id: 'p1' } })
  store.markStopped('repoA', 's1')
  expect(store.get('repoA', 's1').status).toBe('waiting')
})

test('ranForMs measures the run fleetview watched, on one clock', () => {
  const store: any = createStore()
  store.setSessions('repoA', [{ id: 's1', title: 'x', time: { created: 1000, updated: 1000 } }])
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  expect(store.get('repoA', 's1').ranForMs).toBe(null) // still running: the age is a live clock
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  const span = store.get('repoA', 's1').ranForMs
  expect(span).toBeGreaterThanOrEqual(0)
  expect(span).toBeLessThan(5_000) // the run just happened; not the session's whole lifetime
})

// A session created an hour ago and stopped in seconds used to report a one-hour run, because the
// span was creation-to-last-activity rather than the run itself.
test('a session fleetview never saw start reports no duration rather than its lifetime', () => {
  const store: any = createStore()
  const hourAgo = Date.now() - 60 * 60_000
  store.setSessions('repoA', [{ id: 's1', title: 'adopted', time: { created: hourAgo, updated: hourAgo } }])
  store.markStopped('repoA', 's1')
  const row = store.get('repoA', 's1')
  expect(row.status).toBe('stopped')
  expect(row.ranForMs).toBe(null) // honest unknown, not a fabricated 1h
})

// Only an observed `busy` used to clear an error, so a session that succeeded from opencode's own
// TUI while fleetview's stream was down stayed red forever.
test('activity after an error retires it', () => {
  const store: any = createStore()
  store.setSessions('repoA', [{ id: 's1', title: 'x', time: { created: 1, updated: 1 } }])
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.apply('repoA', { type: 'session.error', properties: { sessionID: 's1', error: { name: 'X' } } })
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  expect(store.get('repoA', 's1').status).toBe('error')
  // The first refresh only establishes the baseline — it carries the error's own bump, whichever
  // order the frames arrived in, so it is not evidence the session did anything since.
  store.setSessions('repoA', [{ id: 's1', title: 'x', time: { created: 1, updated: 500 } }])
  expect(store.get('repoA', 's1').status).toBe('error')
  // A bump beyond that baseline is.
  store.setSessions('repoA', [{ id: 's1', title: 'x', time: { created: 1, updated: 900 } }])
  expect(store.get('repoA', 's1').status).toBe('done')
})

// Measured against opencode 1.18.4: recording an error bumps the session's time.updated, and the
// session.updated frame carrying it arrives before session.error. Anchoring on the last known
// value therefore works — until that one frame is dropped, at which point the error's own bump
// reads as activity after itself and a real failure disappears.
test('a dropped session.updated cannot retire an error by its own timestamp', () => {
  const store: any = createStore()
  store.setSessions('repoA', [{ id: 's1', title: 'x', time: { created: 1, updated: 100 } }])
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  // the session.updated carrying the error's new timestamp (200) never arrives
  store.apply('repoA', { type: 'session.error', properties: { sessionID: 's1', error: { name: 'X' } } })
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  expect(store.get('repoA', 's1').status).toBe('error')
  store.setSessions('repoA', [{ id: 's1', title: 'x', time: { created: 1, updated: 200 } }]) // the error's own bump
  expect(store.get('repoA', 's1').status).toBe('error') // still failed
})

// A shape fleetview doesn't recognise is not information: the sweep would otherwise mark every session
// in the project idle, rendering the whole roster as completed.
test('an unrecognised status payload shape applies nothing', () => {
  const store: any = createStore()
  store.setSessions('repoA', [{ id: 's1', title: 'x', time: { created: 1, updated: 1 } }])
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.seedStatuses('repoA', [{ s1: { type: 'idle' } }]) // an array, not the expected map
  expect(store.get('repoA', 's1').status).toBe('running')
})

// The watermark's entire purpose: a stale seed must not overwrite a live status. Rebuilding the
// record without statusSeq made both guards fail open.
test('a listSessions refresh does not disarm the seed watermark', () => {
  const store: any = createStore()
  store.setSessions('repoA', [{ id: 's1', title: 'x', time: { created: 1, updated: 1 } }])
  const mark = store.seedMark()
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.setSessions('repoA', [{ id: 's1', title: 'x', time: { created: 1, updated: 2 } }]) // reconnect refresh
  store.seedStatuses('repoA', {}, mark) // the older in-flight seed finally lands, session absent
  expect(store.get('repoA', 's1').status).toBe('running') // not "completed"
})

// A 200 with an empty body is "no information", not "nobody is running".
test('an empty status payload applies nothing', () => {
  const store: any = createStore()
  store.setSessions('repoA', [{ id: 's1', title: 'x', time: { created: 1, updated: 1 } }])
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.seedStatuses('repoA', null)
  expect(store.get('repoA', 's1').status).toBe('running')
  store.seedStatuses('repoA', {}) // a real, genuinely empty map is still authoritative
  expect(store.get('repoA', 's1').status).toBe('done')
})

// opencode names a session ~20s after its first prompt, and until then the title is a timestamp
// placeholder. The dispatch prompt fills that gap without ever competing with the real name.
test('the dispatch prompt shows until opencode names the session, then the real name wins', () => {
  const store: any = createStore()
  store.setSessions('repoA', [{ id: 's1', title: 'New session - 2026-07-22T19:51:37.625Z' }])
  store.setProvisionalTitle('repoA', 's1', 'count the vowels in banana')
  expect(store.get('repoA', 's1').title).toBe('count the vowels in banana')
  store.apply('repoA', { type: 'session.updated', properties: { info: { id: 's1', title: 'Count vowels in banana' } } })
  expect(store.get('repoA', 's1').title).toBe('Count vowels in banana')
})

test('a user-set name is never overridden by the dispatch prompt', () => {
  const store: any = createStore()
  store.setSessions('repoA', [{ id: 's1', title: 'my own name' }])
  store.setProvisionalTitle('repoA', 's1', 'whatever was typed')
  expect(store.get('repoA', 's1').title).toBe('my own name')
})

// "Subagents and teammates a session spawns aren't listed as separate rows."
test('child sessions are not rows', () => {
  const store: any = createStore()
  store.setSessions('repoA', [
    { id: 's1', title: 'real' },
    { id: 's2', title: 'a subagent', parentID: 's1' },
  ])
  expect(store.byProject()[0].sessions.map((s: any) => s.id)).toEqual(['s1'])
})

// The server reports an aborted session as plain idle, so if the stop isn't persisted a restart
// renders it as "completed" — claiming a result the user never received.
test('a stopped session is still stopped after a restart', () => {
  const first: any = createStore()
  first.setSessions('repoA', [{ id: 's1', title: 'x', time: { created: 1, updated: 2 } }])
  first.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  first.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  first.markStopped('repoA', 's1')
  expect(first.get('repoA', 's1').status).toBe('stopped')

  const persisted = first.snapshot()
  const restarted: any = createStore()
  restarted.setSessions('repoA', [{ id: 's1', title: 'x', time: { created: 1, updated: 2 } }], persisted)
  expect(restarted.get('repoA', 's1').status).toBe('stopped')
})

test('a session that merely ran comes back as completed, not stopped', () => {
  const first: any = createStore()
  first.setSessions('repoA', [{ id: 's1', title: 'x', time: { created: 1, updated: 2 } }])
  first.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  first.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  const restarted: any = createStore()
  restarted.setSessions('repoA', [{ id: 's1', title: 'x', time: { created: 1, updated: 2 } }], first.snapshot())
  expect(restarted.get('repoA', 's1').status).toBe('done')
})

// The heuristic must not fire on code. A reply ending in a fenced block used to be reduced to the
// block's last line, so a trailing regex or ternary read as a question.
test('a reply ending in code is not mistaken for a question', () => {
  const run = (text: string) => {
    const s: any = createStore()
    s.setSessions('r', [{ id: 's1', title: 'x' }])
    s.apply('r', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
    s.apply('r', { type: 'message.updated', properties: { sessionID: 's1', info: { id: 'm1', role: 'assistant' } } })
    s.apply('r', { type: 'message.part.updated', properties: { sessionID: 's1', part: { type: 'text', messageID: 'm1', text } } })
    s.apply('r', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
    return s.get('r', 's1').status
  }
  expect(run('Here it is:\n```\nconst re = /^\\d+?$/\n```')).toBe('done')
  expect(run('Use `x ? a : b`')).toBe('done')
  expect(run('Which branch should I use?')).toBe('waiting') // a real question still counts
})

// A guess is fine for grouping a row and not for interrupting the user, so the two have to be
// distinguishable downstream.
test('publicView says whether waiting rests on a real request or the heuristic', () => {
  const s: any = createStore()
  s.setSessions('r', [{ id: 's1', title: 'x' }, { id: 's2', title: 'y' }])
  s.apply('r', { type: 'permission.asked', properties: { sessionID: 's1', id: 'p1' } })
  s.apply('r', { type: 'session.status', properties: { sessionID: 's2', status: { type: 'busy' } } })
  s.apply('r', { type: 'message.updated', properties: { sessionID: 's2', info: { id: 'm1', role: 'assistant' } } })
  s.apply('r', { type: 'message.part.updated', properties: { sessionID: 's2', part: { type: 'text', messageID: 'm1', text: 'shall I?' } } })
  s.apply('r', { type: 'session.status', properties: { sessionID: 's2', status: { type: 'idle' } } })
  expect(s.get('r', 's1')).toMatchObject({ status: 'waiting', pendingRequest: true })
  expect(s.get('r', 's2')).toMatchObject({ status: 'waiting', pendingRequest: false })
})


// opencode emits several `busy` frames per turn, and restamping the run start on each one made the
// duration measure from the last frame rather than the start of the run.
test('repeated busy frames do not restart the run clock', async () => {
  const store: any = createStore()
  store.setSessions('r', [{ id: 's1', title: 'x', time: { created: 1, updated: 1 } }])
  const busy = { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } }
  store.apply('r', busy)
  await new Promise((r) => setTimeout(r, 30))
  store.apply('r', busy) // opencode sends these repeatedly during one turn
  store.apply('r', busy)
  store.apply('r', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  expect(store.get('r', 's1').ranForMs).toBeGreaterThanOrEqual(25) // the whole run, not the last frame
})

test('a second run measures itself, not the gap since the first', async () => {
  const store: any = createStore()
  store.setSessions('r', [{ id: 's1', title: 'x', time: { created: 1, updated: 1 } }])
  const busy = { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } }
  const idle = { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } }
  store.apply('r', busy)
  store.apply('r', idle)
  await new Promise((r) => setTimeout(r, 40))
  store.apply('r', busy)
  store.apply('r', idle)
  expect(store.get('r', 's1').ranForMs).toBeLessThan(30) // not 40+, which would include the idle gap
})

// Retiring a stale error used to compare a local Date.now() against a server timestamp; skew in
// either direction meant errors that never cleared, or cleared immediately.
test('an error retires on the server clock, not a mix of two', () => {
  const store: any = createStore()
  store.setSessions('r', [{ id: 's1', title: 'x', time: { created: 1000, updated: 5000 } }])
  store.apply('r', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.apply('r', { type: 'session.error', properties: { sessionID: 's1', error: { name: 'X' } } })
  store.apply('r', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  expect(store.get('r', 's1').status).toBe('error')

  // a refresh with the same server timestamp is not evidence of new activity
  store.setSessions('r', [{ id: 's1', title: 'x', time: { created: 1000, updated: 5000 } }])
  expect(store.get('r', 's1').status).toBe('error')

  // a newer server timestamp is
  store.setSessions('r', [{ id: 's1', title: 'x', time: { created: 1000, updated: 6000 } }])
  expect(store.get('r', 's1').status).toBe('done')
})

// "runStartedAt is non-zero" means a run was once seen, not that this run's start is known.
// Reusing it across runs restates an old start as the current one.
test('a seed observing a new run does not reuse the previous run start', async () => {
  const store: any = createStore()
  store.setSessions('r', [{ id: 's1', title: 'x', time: { created: 1, updated: 1 } }])
  store.apply('r', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.apply('r', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  await new Promise((r) => setTimeout(r, 40)) // time passes with the session idle

  // a reconnect finds it busy again — a different run
  store.seedStatuses('r', { s1: { type: 'busy' } })
  store.apply('r', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  expect(store.get('r', 's1').ranForMs).toBeLessThan(30) // this run, not the idle gap before it
})

test('the authoritative idle sweep marks the session idle', () => {
  const store: any = createStore()
  store.setSessions('r', [{ id: 's1', title: 'x', time: { created: 1, updated: 1 } }])
  store.apply('r', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.seedStatuses('r', {}) // absent from an authoritative map = idle
  expect(store.get('r', 's1').status).toBe('done')
})

// The indent guard was tested after .trim(), which removes the indentation it looks for.
test('a reply ending in an indented code block is not a question', () => {
  const s: any = createStore()
  s.setSessions('r', [{ id: 's1', title: 'x' }])
  s.apply('r', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  s.apply('r', { type: 'message.updated', properties: { sessionID: 's1', info: { id: 'm1', role: 'assistant' } } })
  s.apply('r', {
    type: 'message.part.updated',
    properties: { sessionID: 's1', part: { type: 'text', messageID: 'm1', text: 'Declare it like this:\n\n    var name: String?' } },
  })
  s.apply('r', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  expect(s.get('r', 's1').status).toBe('done')
})

// Closing a run because the session went absent is only fair when the seed's timing means
// something. After a reconnect it does not: the stream may have been down for an hour.
test('a reconnect sweep leaves an open run unmeasured rather than reporting the outage', () => {
  const store: any = createStore()
  store.setSessions('r', [{ id: 's1', title: 'x', time: { created: 1, updated: 1 } }])
  store.apply('r', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.seedStatuses('r', {}) // reconnect: absent, but we have no idea when it ended
  const row = store.get('r', 's1')
  expect(row.status).toBe('done')
  expect(row.ranForMs).toBe(null) // honest unknown, not the length of the outage
})

test('a healthy-poll sweep does close the run, since it is at most an interval late', () => {
  const store: any = createStore()
  store.setSessions('r', [{ id: 's1', title: 'x', time: { created: 1, updated: 1 } }])
  store.apply('r', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.seedStatuses('r', {}, Infinity, { closeRuns: true })
  expect(store.get('r', 's1').ranForMs).not.toBe(null)
})

// Subagents arrive through eight paths and only one of them filtered. Live-verified inputs: a
// child appears in GET /session, in GET /session/status while running, and its events land on the
// parent project's stream — so browse displayed them, ^a could adopt them permanently, and the
// bell and tab title counted them.
test('a subagent never becomes a row, whichever path first mentions it', () => {
  const store: any = createStore()
  store.setSessions('r', [
    { id: 'ses_parent', title: 'real work' },
    { id: 'ses_child', title: 'a subagent', parentID: 'ses_parent' },
  ])
  // every event path that calls upsert
  store.apply('r', { type: 'session.status', properties: { sessionID: 'ses_child', status: { type: 'busy' } } })
  store.apply('r', { type: 'permission.asked', properties: { sessionID: 'ses_child', id: 'p1' } })
  store.apply('r', { type: 'question.asked', properties: { sessionID: 'ses_child', id: 'q1' } })
  store.apply('r', { type: 'session.error', properties: { sessionID: 'ses_child', error: { name: 'X' } } })
  store.seedStatuses('r', { ses_child: { type: 'busy' } })
  store.seedPermissions('r', [{ id: 'p2', sessionID: 'ses_child' }])
  store.seedQuestions('r', [{ id: 'q2', sessionID: 'ses_child' }])

  expect(store.byProject()[0].sessions.map((s: any) => s.id)).toEqual(['ses_parent'])
  expect(store.get('r', 'ses_child')).toBe(undefined)
  expect(Object.keys(store.snapshot())).toEqual(['r:ses_parent']) // and never persisted
})

// A child fleetview hasn't listed yet can still create a record; the next listSessions must prune it
// rather than leaving it on screen permanently.
test('a ghost row created before the child was known is pruned on the next listing', () => {
  const store: any = createStore()
  store.setSessions('r', [{ id: 'ses_parent', title: 'real work' }])
  store.apply('r', { type: 'session.status', properties: { sessionID: 'ses_new_child', status: { type: 'busy' } } })
  expect(store.byProject()[0].sessions).toHaveLength(2) // not yet known to be a child

  store.setSessions('r', [
    { id: 'ses_parent', title: 'real work' },
    { id: 'ses_new_child', title: 'sub', parentID: 'ses_parent' },
  ])
  expect(store.byProject()[0].sessions.map((s: any) => s.id)).toEqual(['ses_parent'])
})

// Pruning alone was not enough. The status map that named the child is still live, so the very
// next seed re-created the record setSessions had just deleted, and the ghost came straight back.
test('a pruned child stays pruned when the same seed and events mention it again', () => {
  const store: any = createStore()
  store.setSessions('r', [
    { id: 'ses_parent', title: 'real work' },
    { id: 'ses_child', title: 'sub', parentID: 'ses_parent' },
  ])
  // every path that can mint a record, replayed with the payload shapes opencode really sends
  store.seedStatuses('r', { ses_child: { type: 'busy' }, ses_parent: { type: 'busy' } })
  store.apply('r', { type: 'session.status', properties: { sessionID: 'ses_child', status: { type: 'busy' } } })
  store.apply('r', {
    type: 'question.asked',
    properties: { id: 'q1', sessionID: 'ses_child', questions: [{ question: 'go?', header: 'go', options: [] }] },
  })
  store.apply('r', { type: 'permission.asked', properties: { id: 'p1', sessionID: 'ses_child' } })
  store.apply('r', { type: 'session.error', properties: { sessionID: 'ses_child', error: 'boom' } })
  store.seedPermissions('r', [{ id: 'p2', sessionID: 'ses_child' }])
  store.seedQuestions('r', [{ id: 'q2', sessionID: 'ses_child', questions: [] }])

  expect(store.byProject()[0].sessions.map((s: any) => s.id)).toEqual(['ses_parent'])
  expect(store.get('r', 'ses_child')).toBe(undefined)
  expect(Object.keys(store.snapshot())).toEqual(['r:ses_parent'])
  // The views were already filtered, so they pass either way. These are the accessors that are
  // not filtered, and they are what proves no record was re-created rather than merely hidden:
  // a hidden record still accumulates pending state for every subagent that ever runs.
  expect(store.pendingQuestionsFor('r', 'ses_child')).toEqual([])
  expect(store.pendingFor('r', 'ses_child')).toEqual([])
  // and the parent's own seeded status still applied — the guard must not swallow real sessions
  expect(store.get('r', 'ses_parent').status).toBe('running')
})

// A `session.deleted` is an event, and events go missing — a stream outage is the very case the
// reconnect relist exists to cover, and a delete from opencode's own TUI while fleetview watched
// another project reads the same. Without this the row survived until the process restarted.
test('a session absent from a fresh listing is retired', () => {
  const store: any = createStore()
  store.setSessions('r', [
    { id: 's1', title: 'still here' },
    { id: 's2', title: 'deleted elsewhere' },
  ], undefined, { retire: true })
  store.setSessions('r', [{ id: 's1', title: 'still here' }], undefined, { retire: true })
  expect(store.get('r', 's2')).toBe(undefined)
  expect(store.byProject()[0].sessions.map((s: any) => s.id)).toEqual(['s1'])
  expect(Object.keys(store.snapshot())).toEqual(['r:s1']) // and it stops being persisted
})

// The regression a blanket sweep would cause: `dispatch` calls setProvisionalTitle and then
// relists, so the row the user created this instant is missing from a server listing that is even
// slightly behind. Deleting it there would delete the session they are watching.
test('a just-dispatched session never in a listing survives a listing without it', () => {
  const store: any = createStore()
  store.setSessions('r', [{ id: 's1', title: 'old' }], undefined, { retire: true })
  store.setProvisionalTitle('r', 's_new', 'fix the flaky test')
  store.setSessions('r', [{ id: 's1', title: 'old' }], undefined, { retire: true }) // server hasn't caught up yet
  expect(store.byProject()[0].sessions.map((s: any) => s.id)).toEqual(['s_new', 's1'])
  // and the row it survived as is still the dispatch's: the provisional title shows through
  // opencode's own placeholder name when the session finally appears in a listing
  store.setSessions('r', [
    { id: 's1', title: 'old' },
    { id: 's_new', title: 'New session - 2026-07-22T19:51:37.625Z' },
  ], undefined, { retire: true })
  expect(store.get('r', 's_new').title).toBe('fix the flaky test')
})

// Same rule for the other way a record is minted ahead of any listing: a live event for a session
// created since the last GET /session.
test('a record minted by a live event and never listed survives a listing without it', () => {
  const store: any = createStore()
  store.setSessions('r', [{ id: 's1', title: 'old' }], undefined, { retire: true })
  store.apply('r', { type: 'session.status', properties: { sessionID: 's_live', status: { type: 'busy' } } })
  store.setSessions('r', [{ id: 's1', title: 'old' }], undefined, { retire: true })
  expect(store.get('r', 's_live').status).toBe('running')
})

// Once listed, absence is evidence — the exemption is for records fleetview has never listed, not a
// permanent pass for anything that arrived by an event first.
test('a record first minted by an event is retired once it has been listed and then vanishes', () => {
  const store: any = createStore()
  store.apply('r', { type: 'session.status', properties: { sessionID: 's_live', status: { type: 'busy' } } })
  store.setSessions('r', [{ id: 's_live', title: 'now listed' }], undefined, { retire: true })
  store.setSessions('r', [], undefined, { retire: true })
  expect(store.get('r', 's_live')).toBe(undefined)
})

// The sweep is per project. A listing only speaks for the project it was fetched from, and every
// other project's rows — including projects whose own listing is failing right now — are untouched.
test('retiring is scoped to the listed project', () => {
  const store: any = createStore()
  store.setSessions('repoA', [{ id: 'a1', title: 'in A' }], undefined, { retire: true })
  store.setSessions('repoB', [{ id: 'b1', title: 'in B' }], undefined, { retire: true })
  store.setSessions('repoB', [], undefined, { retire: true })
  expect(store.get('repoB', 'b1')).toBe(undefined)
  expect(store.get('repoA', 'a1').title).toBe('in A')
})

// The retire sweep runs alongside parentID pruning and must not disturb it: a child is deleted for
// being a child, and stays deleted by way of childIds, whether or not it is in the fresh list.
test('subagent pruning is unchanged by the retire sweep', () => {
  const store: any = createStore()
  store.setSessions('r', [
    { id: 'ses_parent', title: 'real work' },
    { id: 'ses_child', title: 'sub', parentID: 'ses_parent' },
  ], undefined, { retire: true })
  expect(store.byProject()[0].sessions.map((s: any) => s.id)).toEqual(['ses_parent'])
  // the child drops out of the listing entirely — still not a row, and the parent is untouched
  store.setSessions('r', [{ id: 'ses_parent', title: 'real work' }], undefined, { retire: true })
  expect(store.get('r', 'ses_child')).toBe(undefined)
  expect(store.byProject()[0].sessions.map((s: any) => s.id)).toEqual(['ses_parent'])
  // and a child that reappears in a later listing is still refused a row
  store.setSessions('r', [
    { id: 'ses_parent', title: 'real work' },
    { id: 'ses_child', title: 'sub', parentID: 'ses_parent' },
  ], undefined, { retire: true })
  expect(store.byProject()[0].sessions.map((s: any) => s.id)).toEqual(['ses_parent'])
})

// The regression the `listed` flag alone did not prevent, and which cost a live session row in
// review. Five callers reach setSessions and only seedLiveState's relist is serialized, so a slow
// poll listing can land *after* a dispatch's own listing. The dispatch listing contains the new
// session — so if it armed `listed`, the stale poll response that pre-dates the session would
// retire a session that is live and running.
test('a stale retiring listing cannot delete a session a later refresh listing introduced', () => {
  const store: any = createStore()
  const pollListing = [{ id: 's1', title: 'already there' }] // captured at T0, before the dispatch
  store.setSessions('r', pollListing, undefined, { retire: true })

  // the dispatch path: a provisional row, then its own (non-retiring) listing that does contain it
  store.setProvisionalTitle('r', 's_new', 'make it faster')
  store.setSessions('r', [{ id: 's1', title: 'already there' }, { id: 's_new', title: 'New session - 2026-07-25T00:00:00.000Z' }], undefined)

  // now the T0 response finally lands. It pre-dates s_new and must not take it with it.
  store.setSessions('r', pollListing, undefined, { retire: true })
  expect(store.get('r', 's_new')).toBeDefined()
  // and its provisional title survived, so the row does not fall back to opencode's placeholder
  expect(store.get('r', 's_new').title).toBe('make it faster')
})

// The other half of the same rule: a refresh listing is not evidence of anything's absence.
test('a non-retiring listing never retires, however complete it looks', () => {
  const store: any = createStore()
  store.setSessions('r', [{ id: 's1', title: 'one' }, { id: 's2', title: 'two' }], undefined, { retire: true })
  store.setSessions('r', [{ id: 's1', title: 'one' }], undefined) // a dispatch/fork refresh
  expect(store.get('r', 's2')).toBeDefined()
  // ...and the retiring caller still does its job
  store.setSessions('r', [{ id: 's1', title: 'one' }], undefined, { retire: true })
  expect(store.get('r', 's2')).toBe(undefined)
})

// --- backend origin: an opencode seed is the full truth for a directory only about opencode's own
// sessions. A claude/copilot row shares the projectKey and never appears in those payloads. ---

test('a claude row survives the seedStatuses sweep that force-idles opencode rows', () => {
  const store: any = createStore()
  seed(store)
  store.noteOrigin('repoA', 'c1', 'claude')
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 'c1', status: { type: 'busy' } } })
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  // the periodic poll: opencode's status map knows nothing about c1, and closeRuns ends run spans
  store.seedStatuses('repoA', {}, store.seedMark(), { closeRuns: true })
  expect(store.get('repoA', 'c1').status).toBe('running')
  expect(store.get('repoA', 'c1').ranForMs).toBe(null) // its run span was not closed either
  expect(store.get('repoA', 's1').status).toBe('done') // opencode's own row still sweeps
})

test('a backend re-listing does not erase the origin tag the sweep reads', () => {
  const store: any = createStore()
  store.noteOrigin('repoA', 'c1', 'claude')
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 'c1', status: { type: 'busy' } } })
  // streamBackend re-lists every poll, and that path rebuilds the record wholesale
  store.setSessions('repoA', [{ id: 'c1', title: 'a claude run' }], undefined)
  store.seedStatuses('repoA', {}, store.seedMark(), { closeRuns: true })
  expect(store.get('repoA', 'c1').status).toBe('running')
})

test('the synthetic "needs input" permission survives an authoritative pending seed', () => {
  const store: any = createStore()
  seed(store)
  store.noteOrigin('repoA', 'c1', 'claude')
  // what backend-normalise emits for a run that ended having been refused a tool
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 'c1', status: { type: 'idle' } } })
  store.apply('repoA', {
    type: 'permission.asked',
    properties: { sessionID: 'c1', id: 'c1:denied', permission: 'Bash — attach to approve' },
  })
  expect(store.get('repoA', 'c1').status).toBe('waiting')
  store.seedPermissions('repoA', [], store.seedMark()) // opencode's GET /permission cannot know about it
  store.seedQuestions('repoA', [], store.seedMark())
  expect(store.get('repoA', 'c1').status).toBe('waiting')
})

// --- The dropped-frame recovery path: the periodic pass reseeds pending lists ADDITIVELY ---
//
// Field report: three sessions dispatched against opencode, two sat rendering "working" for many
// minutes with no token spend. They were blocked on a permission prompt whose `permission.asked`
// frame never reached the store, so `derive` was right to say running — `pendingPermissions` was
// genuinely empty. Nothing on a healthy stream ever re-read the server's pending lists, so there
// was no way back short of interrupting the session or restarting fleetview.

test('a dropped permission.asked is recovered by an additive seed — the row reaches waiting', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  expect(store.get('repoA', 's1').status).toBe('running') // the symptom: "working", forever
  // s2 is blocked on a permission the store knows about and this GET happens not to list — the
  // omission the authoritative replace would act on, and the reason it cannot run on a timer.
  store.apply('repoA', { type: 'permission.asked', properties: { sessionID: 's2', id: 'p2', permission: 'edit' } })
  // the server has had this pending the whole time; its event was never delivered
  store.seedPermissions('repoA', [{ id: 'p1', sessionID: 's1', permission: 'bash' }], store.seedMark(), { additive: true })
  const row = store.get('repoA', 's1')
  expect(row.status).toBe('waiting')
  expect(row.pendingRequest).toBe(true)
  expect(row.waitingFor).toBe('permission prompt')
  expect(store.pendingFor('repoA', 's2').map((p: any) => p.id)).toEqual(['p2']) // added, never swept
})

test('a dropped question.asked is recovered by an additive seed — the row reaches waiting', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  expect(store.get('repoA', 's1').status).toBe('running')
  store.apply('repoA', { type: 'question.asked', properties: { sessionID: 's2', id: 'q2', questions: [] } })
  store.seedQuestions('repoA', [{ id: 'q1', sessionID: 's1', questions: [] }], store.seedMark(), { additive: true })
  const row = store.get('repoA', 's1')
  expect(row.status).toBe('waiting')
  expect(row.pendingRequest).toBe(true)
  expect(row.waitingFor).toBe('input needed')
  expect(store.pendingQuestionsFor('repoA', 's2').map((q: any) => q.id)).toEqual(['q2']) // added, never swept
})

// The answered-race. The additive seed's snapshot is taken at `mark`; a reply that lands while the
// GET is in flight removes the entry, and a naive re-add would resurrect a request the server has
// already accepted an answer for — the peek UI would re-open a prompt the user just dismissed.
test('an additive seed does not resurrect a permission answered while its GET was in flight', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'permission.asked', properties: { sessionID: 's1', id: 'p1', permission: 'bash' } })
  const mark = store.seedMark() // the poll issues GET /permission here; the response will still list p1
  store.apply('repoA', { type: 'permission.replied', properties: { sessionID: 's1', requestID: 'p1', reply: 'once' } })
  store.seedPermissions('repoA', [{ id: 'p1', sessionID: 's1', permission: 'bash' }], mark, { additive: true })
  expect(store.pendingFor('repoA', 's1')).toEqual([])
  expect(store.get('repoA', 's1').status).not.toBe('waiting')
})

test('an additive seed does not resurrect a question answered while its GET was in flight', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'question.asked', properties: { sessionID: 's1', id: 'q1', questions: [] } })
  const mark = store.seedMark()
  store.apply('repoA', { type: 'question.replied', properties: { sessionID: 's1', requestID: 'q1' } })
  store.seedQuestions('repoA', [{ id: 'q1', sessionID: 's1', questions: [] }], mark, { additive: true })
  expect(store.pendingQuestionsFor('repoA', 's1')).toEqual([])
})

// The property the mount/reconnect path must keep: there fleetview may have missed the answers as
// well as the asks, so the fresh list is the whole truth and an absent entry is a dropped one.
test('the mount/reconnect path still replaces authoritatively — an absent entry is still dropped', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'permission.asked', properties: { sessionID: 's1', id: 'p1', permission: 'bash' } })
  store.apply('repoA', { type: 'question.asked', properties: { sessionID: 's1', id: 'q1', questions: [] } })
  const mark = store.seedMark()
  store.seedPermissions('repoA', [], mark) // no options — the default is the replace
  store.seedQuestions('repoA', [], mark)
  expect(store.pendingFor('repoA', 's1')).toEqual([])
  expect(store.pendingQuestionsFor('repoA', 's1')).toEqual([])
  expect(store.get('repoA', 's1').status).toBe('idle')
})

// The additive seed inherits the sweep's rule about foreign rows: a claude/copilot row shares the
// projectKey but is never in opencode's payloads, and its synthetic `<id>:denied` permission is
// fleetview's own. opencode has no business writing pending state onto one.
test('an additive seed leaves a non-opencode row alone', () => {
  const store: any = createStore()
  seed(store)
  store.noteOrigin('repoA', 'c1', 'claude')
  store.seedPermissions('repoA', [{ id: 'p1', sessionID: 'c1', permission: 'bash' }], store.seedMark(), { additive: true })
  expect(store.pendingFor('repoA', 'c1')).toEqual([])
})

// An entry the store already has keeps its own stamps: __askedAt drives the "waiting Nm" clock, and
// re-reading the list every poll must not restart that clock at each read.
test('an additive seed does not restamp an entry the store already has', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', {
    type: 'permission.asked',
    properties: { sessionID: 's1', id: 'p1', permission: 'bash', __askedAt: 1000 },
  })
  store.seedPermissions('repoA', [{ id: 'p1', sessionID: 's1', permission: 'bash' }], store.seedMark(), { additive: true })
  expect(store.get('repoA', 's1').waitingSince).toBe(1000)
})

// --- #7: a pending request preempts the assistant snippet in the row preview ---
//
// The field bug: the header counted the session as "awaiting input" while its row previewed
// "Updating opencode agent context with copilot-instructions.md", the last tool-progress line the
// model had printed. The reporter read the row and concluded the session had frozen mid-work.

// Puts a session in the exact state the report describes: an assistant text part landed, and then
// the session asked for something.
const withAssistantText = (store: any, text: string) => {
  store.apply('repoA', { type: 'message.updated', properties: { sessionID: 's1', info: { id: 'm1', role: 'assistant' } } })
  store.apply('repoA', { type: 'message.part.updated', properties: { sessionID: 's1', part: { type: 'text', messageID: 'm1', text } } })
}

test('#7: a pending question previews the question, not the last assistant output', () => {
  const store: any = createStore()
  seed(store)
  withAssistantText(store, 'Updating opencode agent context with copilot-instructions.md')
  store.apply('repoA', {
    type: 'question.asked',
    properties: { sessionID: 's1', id: 'q1', questions: [{ question: 'Which framework should I use?' }] },
  })
  const row = store.get('repoA', 's1')
  expect(row.status).toBe('waiting')
  expect(row.snippet).toBe('question: Which framework should I use?')
})

test('#7: a pending permission previews the permission and its patterns', () => {
  const store: any = createStore()
  seed(store)
  withAssistantText(store, 'Updating opencode agent context with copilot-instructions.md')
  store.apply('repoA', {
    type: 'permission.asked',
    properties: { sessionID: 's1', id: 'p1', permission: 'bash', patterns: ['git push', 'rm -rf'] },
  })
  expect(store.get('repoA', 's1').snippet).toBe('permission: bash git push, rm -rf')
})

test('#7: a permission outranks a question in the preview, matching waitingFor', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'question.asked', properties: { sessionID: 's1', id: 'q1', questions: [{ question: 'Which one?' }] } })
  store.apply('repoA', { type: 'permission.asked', properties: { sessionID: 's1', id: 'p1', permission: 'bash' } })
  const row = store.get('repoA', 's1')
  expect(row.waitingFor).toBe('permission prompt')
  expect(row.snippet).toBe('permission: bash')
})

test('#7: answering the question hands the preview back to the assistant snippet', () => {
  const store: any = createStore()
  seed(store)
  withAssistantText(store, 'assistant reply')
  store.apply('repoA', { type: 'question.asked', properties: { sessionID: 's1', id: 'q1', questions: [{ question: 'Which one?' }] } })
  expect(store.get('repoA', 's1').snippet).toBe('question: Which one?')
  store.apply('repoA', { type: 'question.replied', properties: { sessionID: 's1', requestID: 'q1' } })
  expect(store.get('repoA', 's1').snippet).toBe('assistant reply')
})

test('#7 regression: with no pending request the row still previews the assistant snippet', () => {
  const store: any = createStore()
  seed(store)
  withAssistantText(store, 'assistant reply')
  const row = store.get('repoA', 's1')
  expect(row.pendingRequest).toBe(false)
  expect(row.snippet).toBe('assistant reply')
})

test('#7 regression: the prose-heuristic waiting case keeps previewing the assistant text', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  withAssistantText(store, 'Should I use React or Vue?')
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  const row = store.get('repoA', 's1')
  expect(row.status).toBe('waiting') // the "?" heuristic
  expect(row.pendingRequest).toBe(false) // ...with no server-reported request behind it
  expect(row.snippet).toBe('Should I use React or Vue?') // so there is no request text to invent
})

test('#7: control bytes in the question text are stripped from the preview', () => {
  const store: any = createStore()
  seed(store)
  // An OSC 0 title spoof embedded in the question: ESC ] 0 ; ... BEL. The preview reaches raw
  // stdout via `fleetview ls`, so the escape has to be gone before it can drive the terminal.
  const esc = String.fromCharCode(27)
  const bel = String.fromCharCode(7)
  store.apply('repoA', {
    type: 'question.asked',
    properties: { sessionID: 's1', id: 'q1', questions: [{ question: `pick ${esc}]0;pwned${bel} one?` }] },
  })
  const { snippet } = store.get('repoA', 's1')
  expect(snippet).toBe('question: pick ]0;pwned one?')
  expect(snippet).not.toContain(esc)
})

test('#7: a long question truncates through the same 80-grapheme cap the assistant snippet uses', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', {
    type: 'question.asked',
    properties: { sessionID: 's1', id: 'q1', questions: [{ question: 'x'.repeat(500) }] },
  })
  const { snippet } = store.get('repoA', 's1')
  expect(snippet.length).toBe(80)
  expect(snippet.startsWith('question: xxx')).toBe(true)
})

// --- #32: messageBody / memberTitle ---

test('#32: a message with text parts renders its text, and its tool output stays out of the way', () => {
  const m = {
    parts: [
      { type: 'text', text: 'here is the answer' },
      { type: 'tool', state: { output: 'ls: a\nb\nc' } },
    ],
  }
  expect(messageBody(m)).toBe('here is the answer')
})

test('#32: a shell job — no text parts at all — renders its tool output instead of nothing', () => {
  const m = { info: { role: 'assistant' }, parts: [{ type: 'tool', state: { output: 'shell-job-done\n' } }] }
  expect(messageBody(m)).toBe('shell-job-done\n')
})

test('#32: several tool parts join one per line, and a tool part with no output contributes nothing', () => {
  const m = {
    parts: [
      { type: 'tool', state: { output: 'first' } },
      { type: 'tool', state: {} },
      { type: 'tool', state: { output: 'second' } },
    ],
  }
  expect(messageBody(m)).toBe('first\nsecond')
})

test('#32: tool output is stripped of control sequences like every other body (M12)', () => {
  const esc = String.fromCharCode(27)
  const m = { parts: [{ type: 'tool', state: { output: `${esc}]0;pwned${String.fromCharCode(7)}done` } }] }
  expect(messageBody(m)).not.toContain(esc)
  expect(messageBody(m)).toContain('done')
})

test('#32: a message with neither text nor tool parts, or no parts at all, is empty rather than a throw', () => {
  expect(messageBody({ parts: [] })).toBe('')
  expect(messageBody({})).toBe('')
  expect(messageBody(null)).toBe('')
  expect(messageBody({ parts: [{ type: 'reasoning', text: 'thinking out loud' }] })).toBe('')
})

test('#32: a real server title always wins over the roster member prompt', () => {
  expect(memberTitle('fix the flaky test', { prompt: 'sleep 5', shell: true })).toBe('fix the flaky test')
})

test('#32: the placeholder title falls back to a shell member prompt, rendered as the `! cmd` the roster shows', () => {
  expect(memberTitle('New session - 2026-07-22T19:51:37.625Z', { prompt: 'sleep 5 && echo shell-job-done', shell: true })).toBe(
    '! sleep 5 && echo shell-job-done',
  )
})

test('#32: a non-shell member falls back to its bare prompt, with no `!` invented', () => {
  expect(memberTitle('New session - 2026-07-22T19:51:37.625Z', { prompt: 'write the docs' })).toBe('write the docs')
})

test('#32: no member, no prompt, or a blank prompt leaves the placeholder alone rather than blanking the row', () => {
  const placeholder = 'New session - 2026-07-22T19:51:37.625Z'
  expect(memberTitle(placeholder, undefined)).toBe(placeholder)
  expect(memberTitle(placeholder, {})).toBe(placeholder)
  expect(memberTitle(placeholder, { prompt: '   ' })).toBe(placeholder)
  expect(memberTitle(placeholder, { prompt: 42 as any })).toBe(placeholder)
})

test('#32: a 2000-character member prompt is truncated to one row, not printed whole into `ls`', () => {
  const title = memberTitle('New session - 2026-07-22T19:51:37.625Z', { prompt: 'x'.repeat(2000) })
  expect(title.length).toBe(80)
})

test('#48: the seed path\'s explicit idle clears a permission answered off-stream, so 10 healthy polls heal the row', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'permission.asked', properties: { sessionID: 's1', id: 'perm1', permission: 'bash' } })
  store.apply('repoA', { type: 'question.asked', properties: { sessionID: 's2', id: 'q1', questions: [{ question: 'proceed?' }] } })
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's2', status: { type: 'busy' } } })
  expect(store.get('repoA', 's1').status).toBe('waiting')
  for (let i = 0; i < 10; i++) {
    // exactly the periodic seedLiveState pass: explicit idle + the additive-only pending seeds
    const mark = store.seedMark()
    store.seedStatuses('repoA', { s1: { type: 'idle' }, s2: { type: 'idle' } }, mark, { closeRuns: true })
    store.seedPermissions('repoA', [], mark, { additive: true })
    store.seedQuestions('repoA', [], mark, { additive: true })
  }
  const perm = store.get('repoA', 's1')
  expect(perm.pendingRequest).toBe(false)
  expect(perm.status).toBe('done') // was 'waiting' forever: no poll-path channel could remove a pending entry
  expect(perm.waitingFor).toBe(undefined)
  expect(perm.waitingSince).toBe(0) // the climbing "waiting Nm" clock stops too
  expect(store.get('repoA', 's2').pendingRequest).toBe(false) // same hole for questions
})

test('#48: pendingClearedSeq >= mark, so the same poll\'s additive seed cannot re-insert what the explicit idle just cleared', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'permission.asked', properties: { sessionID: 's1', id: 'perm1', permission: 'bash' } })
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  const mark = store.seedMark()
  store.seedStatuses('repoA', { s1: { type: 'idle' } }, mark, { closeRuns: true })
  // The GET /permission snapshot in hand still lists the answered request — the clear has to outrank it.
  store.seedPermissions('repoA', [{ sessionID: 's1', id: 'perm1', permission: 'bash' }], mark, { additive: true })
  store.seedQuestions('repoA', [], mark, { additive: true })
  expect(store.get('repoA', 's1').pendingRequest).toBe(false)
  expect(store.get('repoA', 's1').status).toBe('done')
})

test('#48 control: the ABSENCE sweep still does NOT clear pending state — absence is the low-confidence signal', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'permission.asked', properties: { sessionID: 's1', id: 'perm1', permission: 'bash' } })
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  const mark = store.seedMark()
  store.seedStatuses('repoA', {}, mark, { closeRuns: true }) // s1 merely absent, never named idle
  expect(store.get('repoA', 's1').pendingRequest).toBe(true)
  expect(store.get('repoA', 's1').status).toBe('waiting')
})

test('#52: a run first seen as `retry` is recorded as a run — retry → idle renders done with a real duration', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'retry', attempt: 1, message: 'overloaded', next: 0 } } })
  expect(store.get('repoA', 's1').status).toBe('running')
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  const row = store.get('repoA', 's1')
  expect(row.status).toBe('done') // was 'idle': the bookkeeping gate tested `busy` alone, so no run was ever recorded
  expect(row.ranForMs).not.toBeNull()
})

test('#52: seedStatuses records a run for a session it first sees as `retry`', () => {
  const store: any = createStore()
  seed(store)
  const mark = store.seedMark()
  store.seedStatuses('repoA', { s1: { type: 'retry', attempt: 1 } }, mark, { closeRuns: true })
  expect(store.get('repoA', 's1').status).toBe('running')
  store.seedStatuses('repoA', {}, store.seedMark(), { closeRuns: true }) // the retry finished; s1 drops off the map
  const row = store.get('repoA', 's1')
  expect(row.status).toBe('done')
  expect(row.ranForMs).not.toBeNull()
})

test('#52: a retry-first run clears the previous run\'s error instead of printing it as the row snippet (#24)', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'session.error', properties: { sessionID: 's1', error: { name: 'APIError', data: { message: 'OLD boom' } } } })
  expect(store.get('repoA', 's1').status).toBe('error')
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'retry', attempt: 1 } } })
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  const row = store.get('repoA', 's1')
  expect(row.status).toBe('done') // was 'error', on the previous run's failure
  expect(row.snippet).not.toContain('OLD boom')
})

test('#52: a retry-first run also retires a stale persisted stop', () => {
  const store: any = createStore()
  store.setSessions('repoA', [{ id: 's1', title: 'a', time: { updated: 100 } }], { 'repoA:s1': { updated: 100, hasRun: true, stopped: true } })
  expect(store.get('repoA', 's1').status).toBe('stopped')
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'retry', attempt: 1 } } })
  store.apply('repoA', { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })
  expect(store.get('repoA', 's1').status).toBe('done')
})

test('#53: a persisted stop is retired when the server reports activity after it (session completed elsewhere)', () => {
  const store: any = createStore()
  store.setSessions('repoA', [{ id: 's1', title: 'a', time: { updated: 500 } }], { 'repoA:s1': { updated: 100, hasRun: false, stopped: true } })
  expect(store.get('repoA', 's1').status).toBe('done') // was 'stopped', permanently and self-reinforcingly
  // and the lie is no longer written back to seen.json on every save
  expect(store.snapshot()['repoA:s1']).toEqual({ updated: 500, hasRun: true, stopped: false })
})

test('#53 control: a persisted stop with no server activity since it still renders stopped', () => {
  const store: any = createStore()
  store.setSessions('repoA', [{ id: 's1', title: 'a', time: { updated: 100 } }], { 'repoA:s1': { updated: 100, hasRun: true, stopped: true } })
  expect(store.get('repoA', 's1').status).toBe('stopped')
  expect(store.snapshot()['repoA:s1'].stopped).toBe(true)
})

test('#55: seeded pending stamps sort above every pre-mark live entry and below one applied during the seed\'s flight', () => {
  const store: any = createStore()
  seed(store)
  // p1 is live and genuinely the oldest outstanding request
  store.apply('repoA', { type: 'permission.asked', properties: { sessionID: 's1', id: 'p1', permission: 'bash live-oldest' } })
  const mark = store.seedMark()
  // p2 arrives live while the seed GET is in flight — it must stay last
  store.apply('repoA', { type: 'permission.asked', properties: { sessionID: 's1', id: 'p2', permission: 'bash live-newest' } })
  // the server's snapshot: p1 plus two asks the stream dropped
  store.seedPermissions(
    'repoA',
    [
      { sessionID: 's1', id: 'pA', permission: 'bash missed-A' },
      { sessionID: 's1', id: 'p1', permission: 'bash live-oldest' },
      { sessionID: 's1', id: 'pB', permission: 'bash missed-B' },
    ],
    mark,
    { additive: true },
  )
  const stamps = store.pendingFor('repoA', 's1')
  expect(stamps.map((p: any) => p.id)).toEqual(['p1', 'pA', 'pB', 'p2']) // was ['pA','p1','pB','p2'], pA at -2
  for (const p of stamps.filter((p: any) => p.id === 'pA' || p.id === 'pB')) {
    expect(p.__seq).toBeGreaterThan(mark - 1) // above every already-issued integer stamp, never negative
    expect(p.__seq).toBeLessThan(mark) // below anything applied live during the flight
  }
  // and peek/the row preview offer the genuinely oldest request, not the newer missed one
  expect(store.get('repoA', 's1').snippet).toBe('permission: bash live-oldest')
})

test('#55: seedQuestions stamps the same interval, preserving the server\'s oldest-first order', () => {
  const store: any = createStore()
  seed(store)
  store.apply('repoA', { type: 'question.asked', properties: { sessionID: 's1', id: 'q1', questions: [{ question: 'live-oldest?' }] } })
  const mark = store.seedMark()
  store.apply('repoA', { type: 'question.asked', properties: { sessionID: 's1', id: 'q2', questions: [{ question: 'live-newest?' }] } })
  store.seedQuestions(
    'repoA',
    [
      { sessionID: 's1', id: 'qA', questions: [{ question: 'missed-A?' }] },
      { sessionID: 's1', id: 'q1', questions: [{ question: 'live-oldest?' }] },
      { sessionID: 's1', id: 'qB', questions: [{ question: 'missed-B?' }] },
    ],
    mark,
    { additive: true },
  )
  expect(store.pendingQuestionsFor('repoA', 's1').map((q: any) => q.id)).toEqual(['q1', 'qA', 'qB', 'q2'])
})
