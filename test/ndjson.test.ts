import { test, expect } from 'vitest'
import { parseNdjsonChunk } from '../src/backends/ndjson.ts'

test('parseNdjsonChunk parses complete lines and buffers the partial tail', () => {
  const { events, rest } = parseNdjsonChunk('{"a":1}\n{"b":2}\n{"c":')
  expect(events).toEqual([{ a: 1 }, { b: 2 }])
  expect(rest).toBe('{"c":')
  // The buffered tail plus the next read parses as one line.
  const next = parseNdjsonChunk(rest + '3}\n')
  expect(next.events).toEqual([{ c: 3 }])
  expect(next.rest).toBe('')
})

test('parseNdjsonChunk skips blank and non-JSON lines instead of failing the chunk', () => {
  const { events, rest } = parseNdjsonChunk('\nnode: warning something\n{"ok":true}\n  \n')
  expect(events).toEqual([{ ok: true }])
  expect(rest).toBe('')
})
