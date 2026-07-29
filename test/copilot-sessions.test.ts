import { test, expect } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listSessions, parseWorkspace, runningPid } from '../src/backends/copilot/sessions.ts'

const workspaceFixture = readFileSync(join(import.meta.dirname, 'fixtures', 'copilot-workspace.yaml'), 'utf8')

const tmp = () => mkdtempSync(join(tmpdir(), 'fleetview-copilot-'))

// One session directory the way copilot lays it out: workspace.yaml plus, while a process holds it,
// an inuse.<pid>.lock.
function writeSession(stateDir: string, id: string, yaml: string, pid?: number) {
  const dir = join(stateDir, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'workspace.yaml'), yaml)
  if (pid !== undefined) writeFileSync(join(dir, `inuse.${pid}.lock`), String(pid))
  return dir
}

const yaml = ({ id, cwd, name = 'a session', created = '2026-07-25T20:00:00.000Z', updated = '2026-07-25T20:01:00.000Z' }: { id: string; cwd: string; name?: string; created?: string; updated?: string }) =>
  `id: ${id}\ncwd: ${cwd}\nclient_name: github/cli\nname: '${name}'\nuser_named: false\nsummary_count: 0\ncreated_at: ${created}\nupdated_at: ${updated}\n`

test('the recorded workspace.yaml parses to the fields the roster needs', () => {
  expect(parseWorkspace(workspaceFixture)).toEqual({
    id: '11111111-1111-4111-8111-111111111111',
    cwd: '/repo/alpha',
    // Single-quoted by copilot because the name it took from the first prompt contains a colon —
    // the case a naive split-on-colon parser gets wrong.
    name: 'reply with only the word: beta',
    created_at: '2026-07-25T20:46:29.801Z',
    updated_at: '2026-07-25T20:46:40.246Z',
  })
})

test("a doubled single quote is YAML's escape, not two quotes", () => {
  expect(parseWorkspace("id: x\ncwd: /repo\nname: 'don''t stop'\n")?.name).toBe("don't stop")
})

test('a workspace without an id or cwd is unusable rather than half-parsed', () => {
  expect(parseWorkspace('client_name: github/cli\n')).toBeNull()
  expect(parseWorkspace('id: x\n')).toBeNull()
})

test('an id with a path separator is rejected (it becomes a path segment)', () => {
  expect(parseWorkspace('id: ../../etc\ncwd: /repo\n')).toBeNull()
  expect(parseWorkspace('id: a/b\ncwd: /repo\n')).toBeNull()
  expect(parseWorkspace('id: ..\ncwd: /repo\n')).toBeNull()
  // an ordinary opaque id still parses
  expect(parseWorkspace('id: 01JABCDEF\ncwd: /repo\n')?.id).toBe('01JABCDEF')
})

test('the lock file names the pid holding the session, and its absence means nothing is running', () => {
  const stateDir = tmp()
  expect(runningPid(writeSession(stateDir, 'idle', yaml({ id: 'idle', cwd: '/repo/alpha' })))).toBeNull()
  expect(runningPid(writeSession(stateDir, 'busy', yaml({ id: 'busy', cwd: '/repo/alpha' }), 4242))).toBe(4242)
})

test('a missing state directory is an empty roster, not an error', () => {
  expect(listSessions('/repo/alpha', join(tmp(), 'copilot-never-ran'))).toEqual([])
})

test('sessions are filtered to the directory and returned newest first', () => {
  const stateDir = tmp()
  writeSession(stateDir, 'older', yaml({ id: 'older', cwd: '/repo/alpha', updated: '2026-07-25T20:01:00.000Z' }))
  writeSession(stateDir, 'newer', yaml({ id: 'newer', cwd: '/repo/alpha', updated: '2026-07-25T20:09:00.000Z' }), 99)
  writeSession(stateDir, 'elsewhere', yaml({ id: 'elsewhere', cwd: '/repo/beta' }))
  const sessions = listSessions('/repo/alpha', stateDir)
  expect(sessions.map((s) => s.id)).toEqual(['newer', 'older'])
  expect(sessions[0]).toMatchObject({ directory: '/repo/alpha', title: 'a session', running: true })
  expect(sessions[1].running).toBe(false)
})

// Copilot stores a resolved real path. On macOS /tmp is a symlink to /private/tmp, so a caller
// asking about the path it dispatched into finds nothing unless the comparison resolves too.
test('a symlinked directory still matches the real path copilot recorded', () => {
  const stateDir = tmp()
  const project = tmp()
  const real = realpathSync(project)
  writeSession(stateDir, 'resolved', yaml({ id: 'resolved', cwd: real }))
  expect(listSessions(project, stateDir).map((s) => s.id)).toEqual(['resolved'])
  // The row reports the directory the caller asked about, so the roster groups it where the user
  // expects rather than under a /private/… path they never typed.
  expect(listSessions(project, stateDir)[0].directory).toBe(project)
})

test('a session directory without metadata is skipped rather than crashing the listing', () => {
  const stateDir = tmp()
  mkdirSync(join(stateDir, 'half-created'))
  writeFileSync(join(stateDir, 'stray-file'), 'not a session')
  writeSession(stateDir, 'good', yaml({ id: 'good', cwd: '/repo/alpha' }))
  expect(listSessions('/repo/alpha', stateDir).map((s) => s.id)).toEqual(['good'])
})

test('a session copilot never named falls back to its id', () => {
  const stateDir = tmp()
  writeSession(stateDir, 'unnamed', 'id: unnamed\ncwd: /repo/alpha\nname:\n')
  expect(listSessions('/repo/alpha', stateDir)[0].title).toBe('unnamed')
})
