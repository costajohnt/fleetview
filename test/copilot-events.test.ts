import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyEvent, foldEvents, initialRun, parseJsonlChunk } from '../src/backends/copilot/events.ts'

// Recorded from real `copilot -p … --output-format json` runs against 1.0.75 and sanitized (see
// docs/specs/2026-07-25-copilot-backend-wire.md). Reading them rather than hand-writing the shapes
// is the point: a hand-written fixture only ever proves the parser agrees with its author.
const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')
const fold = (name: string) => foldEvents(initialRun(), parseJsonlChunk(fixture(name)).events)

test('a partial trailing line stays buffered instead of being dropped', () => {
  const first = parseJsonlChunk('{"type":"a"}\n{"type":"b"}\n{"ty')
  expect(first.events.map((e) => e.type)).toEqual(['a', 'b'])
  expect(first.rest).toBe('{"ty')
  const second = parseJsonlChunk(`${first.rest}pe":"c"}\n`)
  expect(second.events.map((e) => e.type)).toEqual(['c'])
})

// stderr shares the log fd, so plain-text CLI errors land in the same stream as the JSONL.
test('non-JSON lines are skipped rather than ending the parse', () => {
  const { events } = parseJsonlChunk('error: cannot change working directory\n{"type":"result","exitCode":1}\n')
  expect(events).toEqual([{ type: 'result', exitCode: 1 }])
})

test('a completed run reports the last assistant message and exit code', () => {
  expect(fold('copilot-completed.jsonl')).toEqual({ status: 'completed', lastOutput: 'alpha', deniedTools: 0, exitCode: 0, aborted: false })
})

// The whole reason capabilities.questions is false: five tools denied, nothing written, exit 0.
test('a run whose tools were all denied still exits 0, and the denials are counted', () => {
  const run = fold('copilot-denied.jsonl')
  expect(run.exitCode).toBe(0)
  expect(run.deniedTools).toBe(5)
  expect(run.lastOutput).toContain('unable to create the file')
  // Honestly `completed`: the model recovered and answered. The denial count is what tells the
  // difference, which is why it is carried rather than folded into the status.
  expect(run.status).toBe('completed')
})

// message_delta repeats the text of the assistant.message that follows it.
test('ephemeral events are ignored so streamed text is not counted twice', () => {
  const run = foldEvents(initialRun(), [
    { type: 'assistant.message_delta', ephemeral: true, data: { deltaContent: 'alp' } },
    { type: 'assistant.message', ephemeral: true, data: { content: 'alpha' } },
    { type: 'assistant.message', data: { content: 'alpha' } },
  ])
  expect(run.lastOutput).toBe('alpha')
})

// A message carrying only toolRequests has content: "" — keeping it would blank the roster's last
// line every time a session picked up a tool.
test('an empty assistant message does not erase the last real output', () => {
  const run = foldEvents(initialRun(), [
    { type: 'assistant.message', data: { content: 'on it' } },
    { type: 'assistant.message', data: { content: '', toolRequests: [{ name: 'bash' }] } },
  ])
  expect(run.lastOutput).toBe('on it')
})

// A resumed session appends to the same transcript, so the previous run's `result` has to stop
// counting or the roster would show `completed` for the whole of the new run.
test('a new user message clears the previous run terminal state', () => {
  const finished = foldEvents(initialRun(), [
    { type: 'assistant.message', data: { content: 'first answer' } },
    { type: 'tool.execution_complete', data: { error: { code: 'denied' } } },
    { type: 'result', exitCode: 0 },
  ])
  expect(finished).toMatchObject({ status: 'completed', deniedTools: 1, exitCode: 0 })
  const resumed = applyEvent(finished, { type: 'user.message', data: { content: 'and now the tests' } })
  // lastOutput survives: it is still the most recent thing the session said until it says more.
  expect(resumed).toEqual({ status: 'working', lastOutput: 'first answer', deniedTools: 0, exitCode: null, aborted: false })
})

test('a non-zero exit is failed', () => {
  const run = applyEvent({ status: 'working', lastOutput: 'partway', deniedTools: 0, exitCode: null, aborted: false }, { type: 'result', exitCode: 127 })
  expect(run).toMatchObject({ status: 'failed', exitCode: 127 })
})

// exitCode 0 is not evidence on its own — a fully denied run exits 0 too. A run that reached its end
// having said nothing at all did not complete anything.
test('an exit-0 run that produced no output is failed, not completed', () => {
  expect(applyEvent(initialRun(), { type: 'result', exitCode: 0 }).status).toBe('failed')
})

// `result` never reaches the on-disk transcript — it goes to stdout, which only a run fleetview
// itself spawned captures. A discovered session's events.jsonl ends with session.shutdown instead
// (verified against real interactive, headless and aborted sessions on 1.0.75), and before this was
// handled every discovered session went red the moment its lock disappeared.
test('a discovered transcript ending in session.shutdown is completed, not failed', () => {
  const run = foldEvents(initialRun(), [
    { type: 'user.message', data: { content: 'count to three' } },
    { type: 'assistant.message', data: { content: 'one two three' } },
    { type: 'session.shutdown', data: { shutdownType: 'routine' } },
  ])
  expect(run).toMatchObject({ status: 'completed', exitCode: 0, lastOutput: 'one two three' })
})

// Same reasoning as the exit-0-no-output result: a session that shut down having said nothing
// completed nothing.
test('a shutdown with no assistant output is failed', () => {
  const run = foldEvents(initialRun(), [{ type: 'session.shutdown', data: { shutdownType: 'routine' } }])
  expect(run).toMatchObject({ status: 'failed', exitCode: 0 })
})

// SIGTERM writes abort events and then a shutdown whose shutdownType still says "routine"
// (verified) — the abort mark is the only thing separating interrupted from finished.
test('an aborted run is failed even though its shutdown looks routine', () => {
  const run = foldEvents(initialRun(), [
    { type: 'assistant.message', data: { content: 'partway there' } },
    { type: 'abort', data: { reason: 'user_initiated' } },
    { type: 'session.shutdown', data: { shutdownType: 'routine' } },
  ])
  expect(run).toMatchObject({ status: 'failed', aborted: true })
})

// The captured-stream flavour of the same interruption: abort events then a result with exitCode 0.
test('an aborted run with a result is failed despite exit 0 and earlier output', () => {
  const run = foldEvents(initialRun(), [
    { type: 'assistant.message', data: { content: 'partway there' } },
    { type: 'abort', data: { reason: 'user_initiated' } },
    { type: 'result', exitCode: 0 },
  ])
  expect(run).toMatchObject({ status: 'failed', exitCode: 0 })
})

// A result that already settled the run wins over the shutdown that follows in a captured stream.
test('a shutdown after a result changes nothing', () => {
  const finished = foldEvents(initialRun(), [
    { type: 'assistant.message', data: { content: 'alpha' } },
    { type: 'result', exitCode: 0 },
  ])
  expect(applyEvent(finished, { type: 'session.shutdown', data: { shutdownType: 'routine' } })).toEqual(finished)
})

// A resumed session appends a second run after the first one's shutdown; the abort mark belongs to
// the run it interrupted, not to the session.
test('a new user message clears the abort mark along with the rest of the terminal state', () => {
  const aborted = foldEvents(initialRun(), [
    { type: 'abort', data: { reason: 'user_initiated' } },
    { type: 'session.shutdown', data: { shutdownType: 'routine' } },
  ])
  const resumed = applyEvent(aborted, { type: 'user.message', data: { content: 'try again' } })
  expect(resumed).toMatchObject({ status: 'working', exitCode: null, aborted: false })
})

// Defensive against a shape change rather than a shape we have seen: `result` is the only event with
// its fields at the top level, so a missing exitCode is a wire change, and guessing success would
// mark unfinished work green.
test('a result without an exit code is failed', () => {
  expect(applyEvent(initialRun(), { type: 'result', sessionId: 'x' }).status).toBe('failed')
})
