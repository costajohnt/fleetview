import { test, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSeen, saveSeen } from '../src/seen-store.ts'

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'fleetview-seen-')), 'seen.json')

test('loadSeen returns {} when file missing', () => {
  expect(loadSeen(tmpFile())).toEqual({})
})

test('saveSeen + loadSeen roundtrip', () => {
  const file = tmpFile()
  const map = { 'repoA:s1': { updated: 100, hasRun: true } }
  saveSeen(file, map)
  expect(loadSeen(file)).toEqual(map)
})


test('saveSeen writes atomically: no leftover .tmp, content roundtrips', () => {
  const file = tmpFile()
  const map = { 'repoA:s1': { updated: 100, hasRun: true } }
  saveSeen(file, map)
  expect(loadSeen(file)).toEqual(map)
  const leftovers = readdirSync(join(file, '..')).filter((f) => f.endsWith('.tmp'))
  expect(leftovers).toEqual([])
})

test.each([
  ['null', 'null'],
  ['an array', '[]'],
  ['a string', '"x"'],
])('loadSeen of %s parses to {}', (_label, contents) => {
  const file = tmpFile()
  writeFileSync(file, contents)
  expect(loadSeen(file)).toEqual({})
})

// This file is watermarks fleetview rebuilds by watching, not user data. Refusing to start over a
// damaged cache made the user hand-delete a file to recover something fleetview fixes itself.
test('unreadable seen.json is treated as nothing-seen, not as a fatal error', () => {
  const file = tmpFile()
  writeFileSync(file, '{"half": ')
  expect(loadSeen(file)).toEqual({})
  expect(existsSync(`${file}.corrupt`)).toBe(true) // set aside, not discarded
})
