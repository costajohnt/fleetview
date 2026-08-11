import { test, expect } from 'vitest'
import { appendFileSync, mkdtempSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newTailCursor, tailFile } from '../src/backends/tail.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'fleetview-tail-'))

test('reads only what was appended since the last call', () => {
  const file = join(tmp(), 'log.jsonl')
  writeFileSync(file, 'one\n')
  const cursor = newTailCursor()
  expect(tailFile(cursor, file)).toEqual({ text: 'one\n', reset: false })
  appendFileSync(file, 'two\n')
  expect(tailFile(cursor, file)).toEqual({ text: 'two\n', reset: false })
  // Nothing appended: no read, no reset, and the cursor stays where it was.
  expect(tailFile(cursor, file)).toEqual({ text: '', reset: false })
})

test('a missing file is null and leaves the cursor untouched, so the next call just tries again', () => {
  const dir = tmp()
  const cursor = newTailCursor()
  expect(tailFile(cursor, join(dir, 'not-yet.jsonl'))).toBeNull()
  expect(cursor).toMatchObject({ offset: 0, rest: '', ino: 0 })
})

// The reader hands back raw text; the partial trailing line lives in cursor.rest, written by the
// caller's parser. tailFile must not clobber it between reads — only a reset may clear it.
test('a partial line held in cursor.rest survives to be completed by the next read', () => {
  const file = join(tmp(), 'log.jsonl')
  writeFileSync(file, 'par')
  const cursor = newTailCursor()
  expect(tailFile(cursor, file)?.text).toBe('par')
  cursor.rest = 'par' // what a line parser would buffer
  appendFileSync(file, 'tial\n')
  const r = tailFile(cursor, file)
  expect(cursor.rest + r?.text).toBe('partial\n')
})

// A positional read ends wherever the file did, which is happily mid-character. The cursor's
// streaming decoder holds the head bytes across the boundary instead of minting U+FFFD.
test('a multi-byte character split across two reads survives', () => {
  const file = join(tmp(), 'log.jsonl')
  const line = Buffer.from('done — 3 tests → green\n', 'utf8')
  const split = line.indexOf(Buffer.from('—', 'utf8')) + 1 // mid em dash
  writeFileSync(file, line.subarray(0, split))
  const cursor = newTailCursor()
  const first = tailFile(cursor, file)
  appendFileSync(file, line.subarray(split))
  const second = tailFile(cursor, file)
  const text = (first?.text ?? '') + (second?.text ?? '')
  expect(text).toBe('done — 3 tests → green\n')
  expect(text).not.toContain('�')
})

test('a file rewritten shorter resets: re-read from zero, partial line and decoder dropped', () => {
  const file = join(tmp(), 'log.jsonl')
  writeFileSync(file, 'a long first line that the rewrite replaces\n')
  const cursor = newTailCursor()
  tailFile(cursor, file)
  cursor.rest = 'held-over partial'
  writeFileSync(file, 'short\n')
  expect(tailFile(cursor, file)).toEqual({ text: 'short\n', reset: true })
  expect(cursor.rest).toBe('') // a partial line held over belongs to a file that no longer exists
})

// A rewrite delivered by rename-over lands at whatever size it likes; only the inode betrays it.
test('a LARGER rename-over rewrite resets rather than reading mid-line from the stale offset', () => {
  const dir = tmp()
  const file = join(dir, 'log.jsonl')
  writeFileSync(file, 'first\n')
  const cursor = newTailCursor()
  tailFile(cursor, file)
  writeFileSync(join(dir, 'log.jsonl.new'), `rewritten ${'x'.repeat(200)}\n`)
  renameSync(join(dir, 'log.jsonl.new'), file)
  expect(tailFile(cursor, file)).toEqual({ text: `rewritten ${'x'.repeat(200)}\n`, reset: true })
})

// Some Windows filesystems report ino 0, which is no signal at all: it must never trigger a reset,
// so those hosts keep the size heuristic they had. Exercised through the caller-supplied stat.
test('ino 0 never triggers an inode reset', () => {
  const file = join(tmp(), 'log.jsonl')
  writeFileSync(file, 'one\n')
  const cursor = newTailCursor()
  const size = () => statSync(file).size
  expect(tailFile(cursor, file, { size: size(), ino: 0 })).toEqual({ text: 'one\n', reset: false })
  appendFileSync(file, 'two\n')
  expect(tailFile(cursor, file, { size: size(), ino: 0 })).toEqual({ text: 'two\n', reset: false })
})
