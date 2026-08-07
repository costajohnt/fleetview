import { test, expect } from 'vitest'
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
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
