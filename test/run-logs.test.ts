import { test, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KEEP_RUNS_MS, reapRunLogs } from '../src/backends/run-logs.ts'

test('reapRunLogs removes only stale .jsonl logs and returns their ids', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleetview-runlogs-'))
  const now = Date.now()
  const stale = (now - KEEP_RUNS_MS - 1000) / 1000
  writeFileSync(join(dir, 'old.jsonl'), '')
  utimesSync(join(dir, 'old.jsonl'), stale, stale)
  writeFileSync(join(dir, 'fresh.jsonl'), '') // mtime now: live work stays
  writeFileSync(join(dir, 'old.json'), '') // not a log; not this helper's to remove
  utimesSync(join(dir, 'old.json'), stale, stale)
  expect(reapRunLogs(dir, now)).toEqual(['old'])
  expect(existsSync(join(dir, 'old.jsonl'))).toBe(false)
  expect(existsSync(join(dir, 'fresh.jsonl'))).toBe(true)
  expect(existsSync(join(dir, 'old.json'))).toBe(true)
})

test('reapRunLogs is a no-op on a dir that does not exist yet', () => {
  expect(reapRunLogs(join(tmpdir(), 'fleetview-runlogs-never-made'), Date.now())).toEqual([])
})

test('reapRunLogs skips a log it cannot remove instead of throwing out of dispatch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleetview-runlogs-'))
  const now = Date.now()
  const stale = (now - KEEP_RUNS_MS - 1000) / 1000
  // A non-empty directory named `*.jsonl`: rmSync (no recursive) throws on it, standing in for an
  // EACCES/EPERM on a real log. It must be skipped, not abort the reap.
  mkdirSync(join(dir, 'stuck.jsonl'))
  writeFileSync(join(dir, 'stuck.jsonl', 'child'), '')
  utimesSync(join(dir, 'stuck.jsonl'), stale, stale)
  writeFileSync(join(dir, 'ok.jsonl'), '')
  utimesSync(join(dir, 'ok.jsonl'), stale, stale)
  expect(reapRunLogs(dir, now)).toEqual(['ok']) // stuck is skipped, not fatal
  expect(existsSync(join(dir, 'stuck.jsonl'))).toBe(true)
})
