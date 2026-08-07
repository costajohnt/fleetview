import { test, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, statSync, readdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWrite, reapRunLogs, parseNdjsonChunk, KEEP_RUNS_MS } from '../src/backends/shared.ts'
import { sameRun, PID_MATCH_SLACK_MS } from '../src/backends/ps.ts'

// ── atomicWrite ─────────────────────────────────────────────────────────────

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'fleetview-shared-')), 'out.json')

test('atomicWrite creates the file with 0o600 mode', () => {
  const file = tmpFile()
  atomicWrite(file, 'hello')
  expect(statSync(file).mode & 0o777).toBe(0o600)
})

test('atomicWrite creates missing parent dirs with 0o700 mode', () => {
  const base = mkdtempSync(join(tmpdir(), 'fleetview-shared-'))
  const dir = join(base, 'nested', 'dir')
  const file = join(dir, 'out.json')
  atomicWrite(file, 'data')
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(statSync(dir).mode & 0o777).toBe(0o700)
})

test('atomicWrite tightens a pre-existing directory to 0o700', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleetview-shared-'))
  chmodSync(dir, 0o755)
  atomicWrite(join(dir, 'out.json'), 'data')
  expect(statSync(dir).mode & 0o777).toBe(0o700)
})

test('atomicWrite overwrites an existing file and fixes its permissions', () => {
  const file = tmpFile()
  writeFileSync(file, 'old', { mode: 0o644 })
  atomicWrite(file, 'new')
  expect(statSync(file).mode & 0o777).toBe(0o600)
})

test('atomicWrite leaves no .tmp file behind', () => {
  const file = tmpFile()
  atomicWrite(file, '{}')
  const dir = join(file, '..')
  const leftovers = readdirSync(dir).filter((f) => f.endsWith('.tmp'))
  expect(leftovers).toEqual([])
})

test('atomicWrite accepts a Buffer', () => {
  const file = tmpFile()
  atomicWrite(file, Buffer.from('buf'))
  expect(statSync(file).mode & 0o777).toBe(0o600)
})

// ── reapRunLogs ──────────────────────────────────────────────────────────────

const tmpDir = () => mkdtempSync(join(tmpdir(), 'fleetview-reap-'))
const day = 24 * 60 * 60 * 1000

// Writes a .jsonl file with the given mtime (seconds since epoch).
function touch(dir: string, name: string, mtimeSec: number) {
  const file = join(dir, name)
  writeFileSync(file, '')
  utimesSync(file, mtimeSec, mtimeSec)
  return file
}

test('reapRunLogs removes .jsonl files whose mtime is before the retention window', () => {
  const dir = tmpDir()
  const now = Date.now()
  const old = (now - 31 * day) / 1000
  touch(dir, 'stale.jsonl', old)
  reapRunLogs(dir, now)
  expect(readdirSync(dir)).toEqual([])
})

test('reapRunLogs leaves .jsonl files that are still within the retention window', () => {
  const dir = tmpDir()
  const now = Date.now()
  const recent = (now - 1 * day) / 1000
  touch(dir, 'fresh.jsonl', recent)
  reapRunLogs(dir, now)
  expect(readdirSync(dir)).toEqual(['fresh.jsonl'])
})

test('reapRunLogs ignores non-.jsonl files', () => {
  const dir = tmpDir()
  const now = Date.now()
  const old = (now - 31 * day) / 1000
  touch(dir, 'meta.json', old) // companion meta — not removed by reapRunLogs itself
  reapRunLogs(dir, now)
  expect(readdirSync(dir)).toEqual(['meta.json'])
})

test('reapRunLogs calls onExpired with the id (filename without .jsonl) for each removed file', () => {
  const dir = tmpDir()
  const now = Date.now()
  const old = (now - 31 * day) / 1000
  touch(dir, 'abc-123.jsonl', old)
  touch(dir, 'def-456.jsonl', old)
  const expired: string[] = []
  reapRunLogs(dir, now, (id) => expired.push(id))
  expect(expired.sort()).toEqual(['abc-123', 'def-456'])
})

test('reapRunLogs is a no-op when the directory does not exist', () => {
  expect(() => reapRunLogs(join(tmpDir(), 'no-such-dir'), Date.now())).not.toThrow()
})

test('KEEP_RUNS_MS is 30 days', () => {
  expect(KEEP_RUNS_MS).toBe(30 * 24 * 60 * 60 * 1000)
})

// ── parseNdjsonChunk ─────────────────────────────────────────────────────────

test('parseNdjsonChunk parses complete JSON lines and returns empty rest', () => {
  const { items, rest } = parseNdjsonChunk('{"a":1}\n{"b":2}\n')
  expect(items).toEqual([{ a: 1 }, { b: 2 }])
  expect(rest).toBe('')
})

test('parseNdjsonChunk buffers a partial trailing line as rest', () => {
  const { items, rest } = parseNdjsonChunk('{"a":1}\n{"b":2')
  expect(items).toEqual([{ a: 1 }])
  expect(rest).toBe('{"b":2')
})

test('parseNdjsonChunk skips blank lines without error', () => {
  const { items } = parseNdjsonChunk('\n\n{"a":1}\n\n')
  expect(items).toEqual([{ a: 1 }])
})

test('parseNdjsonChunk skips non-JSON lines without error', () => {
  const { items } = parseNdjsonChunk('not json\n{"a":1}\n')
  expect(items).toEqual([{ a: 1 }])
})

test('parseNdjsonChunk on an empty string returns no items and empty rest', () => {
  const { items, rest } = parseNdjsonChunk('')
  expect(items).toEqual([])
  expect(rest).toBe('')
})

test('parseNdjsonChunk concatenation of rest and next chunk parses correctly', () => {
  const first = parseNdjsonChunk('{"a":1}\n{"b":')
  const second = parseNdjsonChunk(first.rest + '2}\n')
  expect(second.items).toEqual([{ b: 2 }])
  expect(second.rest).toBe('')
})

// ── sameRun ──────────────────────────────────────────────────────────────────

const info = (command: string, startedAt = 1_000_000) => ({ command, startedAt })

test('sameRun returns true when the session id appears in the command', () => {
  expect(sameRun(info('claude --session-id my-uuid'), 'my-uuid', 999_000, () => false)).toBe(true)
})

test('sameRun returns true when the command looks right and is within the time slack', () => {
  const base = 1_000_000
  expect(sameRun(info('claude -p ...', base + 1000), 'no-id', base, (cmd) => cmd.includes('claude'))).toBe(true)
})

test('sameRun returns false when the command looks right but is too far after recordedAt', () => {
  const base = 1_000_000
  const farLater = base + PID_MATCH_SLACK_MS + 1
  expect(sameRun(info('claude -p ...', farLater), 'no-id', base, (cmd) => cmd.includes('claude'))).toBe(false)
})

test('sameRun returns false when the command does not match and looksLike returns false', () => {
  expect(sameRun(info('python some-other-process', 1_000_000), 'no-id', 999_000, () => false)).toBe(false)
})

test('sameRun returns false when recordedAt is not finite', () => {
  expect(sameRun(info('claude -p ...', 1_000_000), 'no-id', NaN, (cmd) => cmd.includes('claude'))).toBe(false)
})
