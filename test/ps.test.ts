import { test, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { psInfo } from '../src/backends/ps.ts'

// The one place the real `ps` invocation runs in the suite: every backend abort test injects a fake
// psImpl, so without this the lstart parse and the format string would ship with zero runnable
// check. CI runs on ubuntu and macos, which are the two ps dialects fleetview supports.
test('psInfo reads the live start time and command of a real process', () => {
  const info = psInfo(process.pid)
  expect(info).not.toBe('unavailable')
  expect(info).not.toBeNull()
  const { startedAt, command } = info as Exclude<typeof info, 'unavailable' | null>
  // This very node process: it started when it started, give or take lstart's one-second
  // resolution against however long the suite has been running.
  expect(command).toContain('node')
  expect(Math.abs(startedAt - (Date.now() - process.uptime() * 1000))).toBeLessThan(5_000)
})

// A ps that exists but rejects the option string (busybox has neither -o nor lstart) exits
// non-zero exactly like one reporting a dead pid — the tiebreak is signal 0 against the pid, and a
// live pid must come back 'unavailable' (kill anyway), never null (refuse forever).
test('psInfo reports unavailable, not dead, when ps cannot answer about a live pid', () => {
  const stubDir = mkdtempSync(join(tmpdir(), 'fleetview-ps-stub-'))
  writeFileSync(join(stubDir, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const path = process.env.PATH
  process.env.PATH = stubDir
  try {
    expect(psInfo(process.pid)).toBe('unavailable')
    // The same broken ps asked about a pid that is genuinely gone: the tiebreak fails too → dead.
    expect(psInfo(2 ** 22 + 7)).toBeNull()
  } finally {
    process.env.PATH = path
  }
})

// kill(2) wildcards: 0 signals the caller's own process group and -1 everything signalable — a
// corrupt meta or planted lock must read as dead, never reach the tiebreak probe or a SIGTERM.
test('psInfo refuses non-positive pids as dead', () => {
  expect(psInfo(0)).toBeNull()
  expect(psInfo(-1)).toBeNull()
  expect(psInfo(1.5)).toBeNull()
})

test('psInfo reports a dead pid as null, not unavailable', () => {
  // pid 1 always exists but is never ours to see fail; an absurdly high pid never exists. macOS ps
  // rejects it loudly (to the stderr psInfo drops), Linux ps just finds nothing — both exit
  // non-zero, which is the "no such process" answer.
  expect(psInfo(2 ** 22 + 7)).toBeNull()
})
