import { test, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, readdirSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadServer, saveServer } from '../src/registry.ts'

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'fleetview-')), 'server.json')

test('loadServer returns null when file missing', () => {
  expect(loadServer(tmpFile())).toBeNull()
})

test('saveServer persists the record and loadServer reads it back', () => {
  const file = tmpFile()
  saveServer(file, { host: '127.0.0.1', port: 4900, pid: 12345 })
  expect(loadServer(file)).toEqual({ host: '127.0.0.1', port: 4900, pid: 12345 })
})

test('saveServer overwrites the single record', () => {
  const file = tmpFile()
  saveServer(file, { host: '127.0.0.1', port: 4900, pid: 111 })
  saveServer(file, { host: '127.0.0.1', port: 4900, pid: 222 })
  expect(loadServer(file)!.pid).toBe(222)
})



test('saveServer normalizes an undefined pid to null (spawn ENOENT case)', () => {
  const file = tmpFile()
  saveServer(file, { host: '127.0.0.1', port: 4900, pid: undefined })
  expect(loadServer(file)).toEqual({ host: '127.0.0.1', port: 4900, pid: null })
})

test('loadServer throws (not silently null) on non-ENOENT read errors', () => {
  const file = tmpFile()
  mkdirSync(file) // a directory at the server path → EISDIR on read, not ENOENT
  expect(() => loadServer(file)).toThrow()
})

test('saveServer writes atomically: no leftover .tmp, content roundtrips (F6)', () => {
  const file = tmpFile()
  saveServer(file, { host: '127.0.0.1', port: 4900, pid: 1 })
  expect(loadServer(file)).toEqual({ host: '127.0.0.1', port: 4900, pid: 1 })
  const leftovers = readdirSync(join(file, '..')).filter((f) => f.endsWith('.tmp'))
  expect(leftovers).toEqual([])
})

test('saveServer fixes permissions on a pre-existing file written with looser perms (F6)', () => {
  const file = tmpFile()
  writeFileSync(file, '{}', { mode: 0o644 }) // simulate a stale file from before the atomic-write fix
  saveServer(file, { host: '127.0.0.1', port: 4900, pid: 1 })
  const mode = statSync(file).mode & 0o777
  expect(mode).toBe(0o600)
})

// mkdirSync's mode only applies when it creates the dir, so a config dir that already exists — one
// an older fleetview made under a loose umask, or the user's own mkdir — kept its perms and left the
// spawned server's generated password in a world-readable directory.
test('saveServer re-tightens a pre-existing config dir to 0700 (F6)', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'fleetview-')), 'config')
  mkdirSync(dir)
  chmodSync(dir, 0o755) // not mkdirSync's mode, which umask can already have narrowed to 0700
  saveServer(join(dir, 'server.json'), { host: '127.0.0.1', port: 4900, pid: 1 })
  expect(statSync(dir).mode & 0o777).toBe(0o700)
})

// server.json is a pointer fleetview writes and can always rebuild: cli.ts falls back to the default
// host/port and re-spawns. Refusing to start over a damaged pointer was a self-inflicted outage.
test('unreadable server.json falls back to discovery instead of refusing to start', () => {
  const file = tmpFile()
  writeFileSync(file, 'not json at all')
  expect(loadServer(file)).toBe(null)
  // set aside, not deleted: nothing is lost silently
  expect(existsSync(`${file}.corrupt`)).toBe(true)

  const second = tmpFile()
  writeFileSync(second, '{"host": 42}')
  expect(loadServer(second)).toBe(null)
  expect(existsSync(`${second}.corrupt`)).toBe(true)
})

test('a non-loopback host is rejected so the RCE-capable server never binds to the network', () => {
  const file = tmpFile()
  writeFileSync(file, JSON.stringify({ host: '0.0.0.0', port: 4900, pid: 1 }))
  expect(loadServer(file)).toBe(null)
  expect(existsSync(`${file}.corrupt`)).toBe(true) // set aside, not trusted
})

test('loopback hosts still load', () => {
  for (const host of ['127.0.0.1', '::1', 'localhost']) {
    const file = tmpFile()
    saveServer(file, { host, port: 4900, pid: 1 })
    expect(loadServer(file)?.host).toBe(host)
  }
})
