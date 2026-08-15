import { test, expect } from 'vitest'
import { parseArgs, sessionJson, filterForList, underCwd, formatRow, parseModel, sessionIdProblem, MIN_SESSION_ID_CHARS, USAGE } from '../src/cli-args.ts'

test('parseModel splits provider/model and rejects a bare word', () => {
  expect(parseModel('anthropic/claude-opus-5')).toEqual({ providerID: 'anthropic', id: 'claude-opus-5' })
  // a slash in the model id is kept (some ids contain one)
  expect(parseModel('openrouter/deepseek/v3')).toEqual({ providerID: 'openrouter', id: 'deepseek/v3' })
  expect(parseModel('opus')).toBe(null)
  expect(parseModel('anthropic/')).toBe(null)
})

test('the bare-command help lists --model and --agent', () => {
  expect(USAGE).toMatch(/fleetview\s+open the roster/)
  expect(USAGE).toContain('default model for every session dispatched this run')
  expect(USAGE).toContain('default subagent for an unprefixed dispatch')
})

test('no arguments still just opens the roster', () => {
  expect(parseArgs([])).toEqual({ command: 'ui', all: false, json: false })
})

test('--cwd scopes the roster, in both spellings', () => {
  expect(parseArgs(['--cwd', '/x/alpha'])).toMatchObject({ command: 'ui', cwd: '/x/alpha' })
  expect(parseArgs(['--cwd=/x/alpha'])).toMatchObject({ command: 'ui', cwd: '/x/alpha' })
  expect(parseArgs(['--cwd'])).toEqual({ error: '--cwd needs a path' })
  expect(parseArgs(['--cwd='])).toEqual({ error: '--cwd needs a path' })
})

// `claude agents --json` prints the list rather than opening anything.
test('--json on its own means the listing', () => {
  expect(parseArgs(['--json'])).toMatchObject({ command: 'ls', json: true })
  expect(parseArgs(['--json', '--all'])).toMatchObject({ command: 'ls', json: true, all: true })
  expect(parseArgs(['--json', '--cwd', '/x'])).toMatchObject({ command: 'ls', json: true, cwd: '/x' })
})

test('logs accepts --all alongside its id', () => {
  expect(parseArgs(['logs', 'ses_1', '--all'])).toMatchObject({ command: 'logs', id: 'ses_1', all: true })
})

test('the subcommands each take exactly one session id', () => {
  expect(parseArgs(['attach', 'ses_1'])).toMatchObject({ command: 'attach', id: 'ses_1' })
  expect(parseArgs(['logs', 'ses_1'])).toMatchObject({ command: 'logs', id: 'ses_1' })
  expect(parseArgs(['stop', 'ses_1'])).toMatchObject({ command: 'stop', id: 'ses_1' })
  expect(parseArgs(['rm', 'ses_1'])).toMatchObject({ command: 'rm', id: 'ses_1' })
  expect(parseArgs(['stop'])).toEqual({ error: 'stop needs a session id' })
  expect(parseArgs(['stop', 'a', 'b'])).toEqual({ error: 'stop takes one session id' })
})

test('ls takes no id, and accepts the same flags', () => {
  expect(parseArgs(['ls'])).toMatchObject({ command: 'ls', all: false })
  expect(parseArgs(['ls', '--all'])).toMatchObject({ command: 'ls', all: true })
})

test('help, version, and anything unrecognised', () => {
  expect(parseArgs(['--help'])).toEqual({ command: 'help' })
  expect(parseArgs(['-h'])).toEqual({ command: 'help' })
  expect(parseArgs(['--version'])).toEqual({ command: 'version' })
  expect(parseArgs(['--nope'])).toEqual({ error: 'unknown option: --nope' })
  expect(parseArgs(['frobnicate'])).toEqual({ error: 'unknown command: frobnicate' })
  expect(USAGE).toContain('fleetview --cwd <path>')
})

// fleetview's state names are internal; the shell should see agent view's words, so a script written
// against one works against the other.
test('sessionJson translates state to agent view vocabulary', () => {
  const base = { id: 's1', title: 'fix tests', projectKey: '/x/alpha', createdAt: 5, updatedAt: 9 }
  expect(sessionJson({ ...base, status: 'running' }).state).toBe('working')
  expect(sessionJson({ ...base, status: 'waiting' }).state).toBe('blocked')
  expect(sessionJson({ ...base, status: 'error' }).state).toBe('failed')
  expect(sessionJson({ ...base, status: 'idle' }).state).toBe('idle')
  expect(sessionJson({ ...base, status: 'done' })).toMatchObject({
    id: 's1',
    name: 'fix tests',
    cwd: '/x/alpha',
    startedAt: 5,
    updatedAt: 9,
  })
})

// `cwd` is the repository, because that is what the rows say and what the user chose. The worktree
// rides along separately for anything that wants to inspect the work itself.
test('sessionJson reports the repository as cwd and the worktree beside it', () => {
  const row = { id: 's1', title: 't', status: 'running', projectKey: '/wt/one' }
  expect(sessionJson(row, { repo: '/x/alpha', worktree: '/wt/one' })).toMatchObject({
    cwd: '/x/alpha',
    worktree: '/wt/one',
  })
  // an unisolated session has no separate worktree to report
  expect(sessionJson(row, { repo: '/x/alpha', worktree: '/x/alpha' }).worktree).toBe(undefined)
})

test('optional fields are omitted rather than reported as null', () => {
  const row = { id: 's1', title: 't', status: 'idle', projectKey: '/x', createdAt: 0, updatedAt: 0, ranForMs: null }
  const json = sessionJson(row)
  expect('ranForMs' in json).toBe(false)
  expect('waitingSince' in json).toBe(false)
  expect('waitingFor' in json).toBe(false)
  expect('summary' in json).toBe(false)
  expect(json.startedAt).toBe(undefined)
})

test('sessionJson reports kind=background always, and waitingFor only when blocked (#86)', () => {
  const base = { id: 's1', title: 't', projectKey: '/x' }
  expect(sessionJson({ ...base, status: 'idle' }).kind).toBe('background')
  // waitingFor rides through from the public view when the session is blocked on a reported request
  expect(sessionJson({ ...base, status: 'waiting', waitingFor: 'permission prompt' }).waitingFor).toBe('permission prompt')
  expect(sessionJson({ ...base, status: 'waiting', waitingFor: 'input needed' }).waitingFor).toBe('input needed')
})

// Without --all the list is what is still live — the question you ask before closing the laptop.
test('filterForList hides finished sessions unless --all', () => {
  const rows = [
    { id: '1', state: 'working' },
    { id: '2', state: 'blocked' },
    { id: '3', state: 'done' },
    { id: '4', state: 'failed' },
    { id: '5', state: 'stopped' },
    { id: '6', state: 'idle' },
  ]
  expect(filterForList(rows).map((r) => r.id)).toEqual(['1', '2', '6'])
  expect(filterForList(rows, { all: true })).toHaveLength(6)
})

// Segment-wise, or --cwd /x/alpha would also match /x/alphabet.
test('underCwd matches a directory and everything below it, not a string prefix', () => {
  expect(underCwd('/x/alpha', '/x/alpha')).toBe(true)
  expect(underCwd('/x/alpha/sub', '/x/alpha')).toBe(true)
  expect(underCwd('/x/alphabet', '/x/alpha')).toBe(false)
  expect(underCwd('/x/beta', '/x/alpha')).toBe(false)
  expect(underCwd('/x/alpha', '/x/alpha/')).toBe(true)
  expect(underCwd('/anything', undefined)).toBe(true) // no scope means everything
})

test('formatRow is one readable line per session', () => {
  expect(formatRow({ id: 'ses_1', state: 'working', name: 'fix tests', summary: 'running the suite' })).toBe(
    'ses_1  working   fix tests  — running the suite',
  )
  expect(formatRow({ id: 'ses_2', state: 'idle', name: 'x' })).toBe('ses_2  idle      x')
})

test('server takes exactly one action: status or stop', () => {
  expect(parseArgs(['server', 'status'])).toMatchObject({ command: 'server', serverAction: 'status' })
  expect(parseArgs(['server', 'stop'])).toMatchObject({ command: 'server', serverAction: 'stop' })
  expect(parseArgs(['server'])).toMatchObject({ error: 'server needs an action: status or stop' })
  expect(parseArgs(['server', 'restart'])).toMatchObject({ error: 'server takes one action: status or stop' })
  expect(parseArgs(['server', 'status', 'extra'])).toMatchObject({ error: 'server takes one action: status or stop' })
})

test('--backend takes a name and rides the same value branch as --model', () => {
  expect(parseArgs(['--backend', 'claude'])).toMatchObject({ command: 'ui', backend: 'claude' })
  expect(parseArgs(['--backend'])).toEqual({ error: '--backend needs a value' })
})

test('the help names the backend flag and its default', () => {
  expect(USAGE).toContain('--backend <name>')
  expect(USAGE).toContain('$FLEETVIEW_BACKEND')
})

// #112.1: a flag a command ignores used to parse clean and silently vanish (`fleetview ls --exec`).
test('#112.1: a flag the command ignores is an error, not silently dropped', () => {
  expect(parseArgs(['ls', '--exec'])).toEqual({ error: '--exec is not valid for ls' })
  expect(parseArgs(['ls', '--model', 'a/b'])).toEqual({ error: '--model is not valid for ls' })
  expect(parseArgs(['attach', 'ses_1', '--name', 'x'])).toEqual({ error: '--name is not valid for attach' })
  expect(parseArgs(['bg', 'ship', '--backend', 'claude'])).toEqual({ error: '--backend is not valid for bg' })
  expect(parseArgs(['--json', '--exec'])).toEqual({ error: '--exec is not valid for ls' })
})

test('#112.1: valid flag/command combos still parse', () => {
  expect(parseArgs(['bg', 'ship', '--exec'])).toMatchObject({ command: 'bg', exec: true })
  expect(parseArgs(['bg', 'ship', '--name', 'x', '--agent', 'plan', '--model', 'a/b'])).toMatchObject({ command: 'bg' })
  expect(parseArgs(['--model', 'a/b', '--agent', 'plan', '--backend', 'claude'])).toMatchObject({ command: 'ui', backend: 'claude' })
})

// --- #33: a degenerate session id must not prefix-match every session ---

test('#33: an empty or whitespace id is rejected, naming the unset-variable case that produces it', () => {
  expect(sessionIdProblem('')).toMatch(/empty/)
  expect(sessionIdProblem('   ')).toMatch(/empty/)
  expect(sessionIdProblem(undefined)).toMatch(/empty/)
})

test('#33: an id too short to resolve is rejected with the length it needs', () => {
  expect(sessionIdProblem('s')).toContain('too short')
  expect(sessionIdProblem('ses')).toContain('too short')
  expect(sessionIdProblem('ses')).toContain(String(MIN_SESSION_ID_CHARS))
})

test('#33: a usable prefix and a whole id both pass', () => {
  expect(sessionIdProblem('ses_')).toBe(null)
  expect(sessionIdProblem('ses_abc1')).toBe(null)
  expect(sessionIdProblem('  ses_abc1  ')).toBe(null) // trimmed before measuring, not after
})
