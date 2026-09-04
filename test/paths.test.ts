import { test, expect } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWrite, fleetviewDir, noteExit } from '../src/paths.ts'

test('atomicWrite creates the dir 0700, the file 0600, and leaves no tmp behind', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'fleetview-paths-')), 'state')
  const file = join(dir, 'thing.json')
  atomicWrite(file, '{"a":1}')
  expect(readFileSync(file, 'utf8')).toBe('{"a":1}')
  expect(statSync(dir).mode & 0o777).toBe(0o700)
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
})

// The whole point of tmp+rename over write-in-place: a pre-existing file's perms are fixed on every
// write, because the rename replaces the inode rather than reusing it.
test('atomicWrite re-tightens a pre-existing world-readable file and dir', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'fleetview-paths-')), 'state')
  const file = join(dir, 'thing.json')
  mkdirSync(dir, { recursive: true, mode: 0o755 })
  writeFileSync(file, 'old')
  chmodSync(file, 0o644)
  atomicWrite(file, 'new')
  expect(readFileSync(file, 'utf8')).toBe('new')
  expect(statSync(dir).mode & 0o777).toBe(0o700)
  expect(statSync(file).mode & 0o777).toBe(0o600)
})

test('fleetviewDir prefers the fresh dir, falls back to an existing legacy one', () => {
  const parent = mkdtempSync(join(tmpdir(), 'fleetview-paths-'))
  // Neither exists: fresh wins (a new install must not mint a roost dir).
  expect(fleetviewDir(parent)).toBe(join(parent, 'fleetview'))
  // Only legacy exists: keep reading it — a rename must not orphan anyone's state.
  mkdirSync(join(parent, 'roost'))
  expect(fleetviewDir(parent)).toBe(join(parent, 'roost'))
  // Both exist: fresh wins.
  mkdirSync(join(parent, 'fleetview'))
  expect(fleetviewDir(parent)).toBe(join(parent, 'fleetview'))
})

// A crash or a signal is exactly when nobody is reading stderr — the tty may already be gone. The
// line on disk is what says which of the two happened.
test('noteExit appends one 0600 line per call, dir 0700', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fleetview-paths-')), 'state', 'exit.log')
  noteExit('exited on SIGHUP', file, () => new Date('2026-08-28T12:00:00.000Z'))
  noteExit('uncaughtException: boom', file, () => new Date('2026-08-28T12:00:01.000Z'))
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  expect(lines).toHaveLength(2)
  expect(lines[0]).toBe(`2026-08-28T12:00:00.000Z pid ${process.pid} exited on SIGHUP`)
  expect(lines[1]).toContain('uncaughtException: boom')
  expect(statSync(file).mode & 0o777).toBe(0o600)
})

// Best effort: reporting a crash must never become a second crash.
test('noteExit swallows an unwritable path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleetview-paths-'))
  writeFileSync(join(dir, 'blocker'), '')
  expect(() => noteExit('exited on SIGTERM', join(dir, 'blocker', 'exit.log'))).not.toThrow()
})
