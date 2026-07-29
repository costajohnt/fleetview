import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseStreamChunk, applyEvent, reduceRun, emptyRunState } from '../src/backends/claude/stream.ts'

// Real streams captured from claude 2.1.220 during the spike (see the wire notes), sanitised. The
// point of driving the reducer from files rather than from hand-written objects is that a shape
// nobody predicted — the hook and thinking_tokens noise, `result` repeating the final text — is in
// them whether or not this file thought to write it.
const fixture = (name: string) => parseStreamChunk(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')).events

test('a successful run ends completed, with the final assistant text as its output', () => {
  const state = reduceRun(fixture('claude-run-success.jsonl'))
  expect(state.status).toBe('completed')
  expect(state.lastOutput).toBe('hello')
  expect(state.sessionId).toBe('a54d9303-c663-4683-b1e8-3d432b999388')
  expect(state.denials).toEqual([])
  expect(state.error).toBeUndefined()
  expect(state.costUsd).toBeCloseTo(0.0419703)
  expect(state.durationMs).toBe(5366)
})

// The case the roster has to distinguish from a plain completion: the run is over and reports
// success, but it stopped short of the work and only a person can unblock it.
test('a run blocked by a denied tool ends needs-input, carrying what was denied', () => {
  const state = reduceRun(fixture('claude-run-permission-denied.jsonl'))
  expect(state.status).toBe('needs-input')
  expect(state.denials).toEqual([
    {
      tool_name: 'Bash',
      tool_use_id: 'toolu_01473WX2trqhr6hhtEhQfNiG',
      tool_input: {
        command: 'curl -s https://example.com -o /dev/null; echo "Exit status: $?"',
        description: 'Run curl command and report exit status',
      },
    },
  ])
  expect(state.lastOutput).toContain('Need permission to run the curl command')
  expect(state.error).toBeUndefined() // it did not fail; it was refused
})

// The child exits 0 here too, which is why status can only come off the result event.
test('a resume against an unknown session ends failed, with the CLI error as the reason', () => {
  const state = reduceRun(fixture('claude-run-resume-error.jsonl'))
  expect(state.status).toBe('failed')
  expect(state.error).toBe('No conversation found with session ID: a54d9303-c663-4683-b1e8-3d432b999388')
})

test('a run with no result event yet is still working', () => {
  const events = fixture('claude-run-success.jsonl').filter((e: any) => e.type !== 'result')
  expect(reduceRun(events).status).toBe('working')
})

// The whole reason for folding rather than scanning: a follow-up prompt appends a second run's
// events to the same log, and the row has to go back to working instead of staying completed.
test('a second init reopens a finished run as working', () => {
  const finished = reduceRun(fixture('claude-run-success.jsonl'))
  const resumed = applyEvent(finished, { type: 'system', subtype: 'init', session_id: 'a54d9303-c663-4683-b1e8-3d432b999388' })
  expect(resumed.status).toBe('working')
  expect(resumed.denials).toEqual([])
  expect(resumed.lastOutput).toBe('hello') // kept, so the row doesn't blank out until the reply lands
})

// A turn that thinks, calls a tool, then answers emits all three through message.content.
test('thinking and tool_use blocks are not mistaken for the session output', () => {
  let state = emptyRunState()
  state = applyEvent(state, { type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } })
  state = applyEvent(state, { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } })
  state = applyEvent(state, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: {} }] } })
  expect(state.lastOutput).toBe('first')
})

test('parseStreamChunk buffers a partial line and skips non-JSON output', () => {
  const first = parseStreamChunk('{"type":"a"}\nclaude: command not found\n{"type":"b"}\n{"ty')
  expect(first.events).toEqual([{ type: 'a' }, { type: 'b' }])
  expect(first.rest).toBe('{"ty')
  expect(parseStreamChunk(first.rest + 'pe":"c"}\n').events).toEqual([{ type: 'c' }])
})

test('events the stream carries but fleetview does not read leave the state alone', () => {
  const before = reduceRun(fixture('claude-run-success.jsonl'))
  const after = applyEvent(before, { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 42 })
  expect(after).toEqual(before)
})
