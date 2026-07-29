import { test, expect } from 'vitest'
import { parseInput, suggestFor, applyFilter } from '../src/dispatch-parse.ts'

const vocab = { agents: ['reviewer', 'build'], repos: ['fleetview', 'sandbox'] }

test('plain text is a dispatch', () => {
  expect(parseInput('fix the parser', vocab)).toEqual({ kind: 'dispatch', prompt: 'fix the parser', agent: undefined, repo: undefined })
})

test('@repo targets a directory and leaves the prompt clean', () => {
  expect(parseInput('@sandbox investigate the flaky test', vocab)).toMatchObject({
    kind: 'dispatch',
    prompt: 'investigate the flaky test',
    repo: 'sandbox',
  })
})

test('@agent runs the session as that subagent, mentioned anywhere', () => {
  expect(parseInput('address the review comments @reviewer', vocab)).toMatchObject({
    kind: 'dispatch',
    prompt: 'address the review comments',
    agent: 'reviewer',
  })
})

test('a bare first word matching a subagent selects it', () => {
  expect(parseInput('reviewer look at PR 12', vocab)).toMatchObject({ agent: 'reviewer', prompt: 'look at PR 12' })
})

test('a matching word later in the prompt is just a word', () => {
  expect(parseInput('ask the reviewer about it', vocab)).toMatchObject({ agent: undefined, prompt: 'ask the reviewer about it' })
})

// "When the same @name matches both a subagent and a sibling repository, the subagent takes
// precedence."
test('a subagent beats a repository of the same name', () => {
  const clash = { agents: ['fleetview'], repos: ['fleetview'] }
  expect(parseInput('@fleetview do a thing', clash)).toMatchObject({ agent: 'fleetview', repo: undefined })
})

test('an @name matching nothing stays in the prompt rather than vanishing', () => {
  expect(parseInput('tell @someone about it', vocab)).toMatchObject({ prompt: 'tell @someone about it' })
})

test('! runs a shell job instead of starting a session', () => {
  expect(parseInput('!pytest -x', vocab)).toEqual({ kind: 'shell', command: 'pytest -x' })
  expect(parseInput('!  ', vocab)).toEqual({ kind: 'empty' })
})

test('filters are recognised instead of dispatching', () => {
  expect(parseInput('s:working', vocab)).toEqual({ kind: 'filter', filter: { state: 'working' } })
  expect(parseInput('a:reviewer', vocab)).toEqual({ kind: 'filter', filter: { agent: 'reviewer' } })
  expect(parseInput('s:', vocab)).toEqual({ kind: 'filter', filter: { state: '' } })
})

test('a filter-looking phrase with a space is a prompt, not a filter', () => {
  expect(parseInput('s:working on the parser', vocab).kind).toBe('dispatch')
})

test('view commands are separated from ones that dispatch', () => {
  expect(parseInput('/exit', vocab)).toEqual({ kind: 'view-command', command: 'exit', args: '' })
  expect(parseInput('/model opus', vocab)).toEqual({ kind: 'view-command', command: 'model', args: 'opus' })
  expect(parseInput('/review the diff', vocab)).toEqual({ kind: 'command', command: 'review', args: 'the diff' })
})

test('whitespace alone is nothing', () => {
  expect(parseInput('   ', vocab)).toEqual({ kind: 'empty' })
})

test('suggestions offer agents and repos for @, commands for /', () => {
  const v = { ...vocab, commands: ['review', 'release'] }
  expect(suggestFor('do it @re', v)!.matches).toEqual([{ name: 'reviewer', kind: 'agent' }])
  expect(suggestFor('/re', v)!.matches.map((m) => m.name)).toEqual(['review', 'release'])
  expect(suggestFor('@', v)!.matches).toHaveLength(4)
})

test('suggestions are silent when the caret is not in a token', () => {
  expect(suggestFor('fix the parser', vocab)).toBe(null)
  expect(suggestFor('@nomatch', vocab)).toBe(null)
  expect(suggestFor('mid@word', vocab)).toBe(null) // an email-ish token is not a mention
})

const rows = [
  { id: 'a', status: 'running' },
  { id: 'b', status: 'waiting' },
  { id: 'c', status: 'done' },
]

test('state filters accept both fleetview keys and agent-view words', () => {
  expect(applyFilter(rows, { state: 'working' }).map((r) => r.id)).toEqual(['a'])
  expect(applyFilter(rows, { state: 'running' }).map((r) => r.id)).toEqual(['a'])
  expect(applyFilter(rows, { state: 'completed' }).map((r) => r.id)).toEqual(['c'])
})

// "Also accepts `s:blocked` for everything waiting on you"
test('s:blocked means everything waiting on you', () => {
  expect(applyFilter(rows, { state: 'blocked' }).map((r) => r.id)).toEqual(['b'])
})

test('agent filters match on the session agent by prefix', () => {
  const agentOf = (s: any) => ({ a: 'reviewer', b: 'build', c: 'build' } as Record<string, string>)[s.id]
  expect(applyFilter(rows, { agent: 'rev' }, agentOf).map((r) => r.id)).toEqual(['a'])
  expect(applyFilter(rows, { agent: '' }, agentOf)).toHaveLength(3)
})

test('no filter leaves the rows alone', () => {
  expect(applyFilter(rows, null)).toBe(rows)
})

test('a bare slash is nothing, not a session whose prompt is "/"', () => {
  expect(parseInput('/', vocab)).toEqual({ kind: 'empty' })
  expect(parseInput('/  ', vocab)).toEqual({ kind: 'empty' })
})

test('#1234 and a pull request URL both filter to that pull request', () => {
  expect(parseInput('#1234')).toEqual({ kind: 'filter', filter: { pr: 1234 } })
  // A URL names its repository, and the filter keeps it — two repositories both having a #1234
  // must not answer for each other.
  expect(parseInput('https://github.com/costajohnt/roost/pull/1234')).toEqual({
    kind: 'filter',
    filter: { pr: 1234, repo: 'costajohnt/roost' },
  })
  // The trailing path GitHub adds on a files or checks tab still names the same pull request.
  expect(parseInput('https://github.com/costajohnt/roost/pull/1234/files')).toEqual({
    kind: 'filter',
    filter: { pr: 1234, repo: 'costajohnt/roost' },
  })
})

test('a URL on a github lookalike host is a generic URL filter, never a pull request filter', () => {
  expect(parseInput('https://notgithub.evil.com/o/r/pull/12')).toEqual({
    kind: 'filter',
    filter: { url: 'https://notgithub.evil.com/o/r/pull/12' },
  })
})

test('a URL filter matches only the pull request in its own repository', () => {
  const at = (repo: string, number: number) => ({ number, url: `https://github.com/${repo}/pull/${number}` })
  const sessions = [
    { id: 'a', prs: [at('o/alpha', 5)] },
    { id: 'b', prs: [at('o/beta', 5)] },
  ]
  const urlFilter = parseInput('https://github.com/o/alpha/pull/5').filter
  expect(applyFilter(sessions, urlFilter).map((s) => s.id)).toEqual(['a'])
  // A bare #5 names no repository, so both remain.
  expect(applyFilter(sessions, parseInput('#5').filter).map((s) => s.id)).toEqual(['a', 'b'])
})

test('a bare # and a hash inside a prompt are not filters', () => {
  // "#" alone names no pull request, and a prompt is the far commoner thing to type.
  expect(parseInput('#').kind).toBe('dispatch')
  expect(parseInput('fix issue #12 in the parser').kind).toBe('dispatch')
  expect(parseInput('#12a').kind).toBe('dispatch')
})

test('applyFilter keeps only the session working on that pull request', () => {
  const withPr = (id: string, numbers: number[]) => ({ id, status: 'idle', prs: numbers.map((number) => ({ number })) })
  const sessions = [withPr('a', [1234]), withPr('b', [7]), withPr('c', [])]
  expect(applyFilter(sessions, { pr: 1234 }).map((s) => s.id)).toEqual(['a'])
  expect(applyFilter(sessions, { pr: 999 })).toEqual([])
})

test('a non-pull-request URL filters by the first prompt that contained it', () => {
  expect(parseInput('https://linear.app/team/ISSUE-42')).toEqual({
    kind: 'filter',
    filter: { url: 'https://linear.app/team/ISSUE-42' },
  })
  // Mentioned inside a prompt it still dispatches.
  expect(parseInput('look at https://linear.app/team/ISSUE-42 and fix it').kind).toBe('dispatch')
  const sessions = [{ id: 'a' }, { id: 'b' }]
  const prompts = { a: 'fix https://linear.app/team/ISSUE-42 today', b: 'unrelated' }
  const out = applyFilter(sessions, { url: 'https://linear.app/team/ISSUE-42' }, undefined, (s: any) => (prompts as Record<string, string>)[s.id])
  expect(out.map((s) => s.id)).toEqual(['a'])
})

test('/fork is a view command, with the optional prompt as its args', () => {
  expect(parseInput('/fork', vocab)).toEqual({ kind: 'view-command', command: 'fork', args: '' })
  expect(parseInput('/fork try the other approach', vocab)).toEqual({
    kind: 'view-command',
    command: 'fork',
    args: 'try the other approach',
  })
})

// The `@backend` token: same shape as `@repo`, ranked below both existing vocabularies.
const withBackends = { ...vocab, backends: ['opencode', 'claude', 'copilot'] }

test('@backend selects the backend and leaves the prompt clean', () => {
  expect(parseInput('@claude fix the tests', withBackends)).toMatchObject({
    kind: 'dispatch',
    prompt: 'fix the tests',
    backend: 'claude',
  })
  expect(parseInput('@copilot fix the tests', withBackends)).toMatchObject({ backend: 'copilot' })
})

test('@backend composes with @repo and @agent in one input', () => {
  expect(parseInput('@sandbox @claude @reviewer look at it', withBackends)).toMatchObject({
    prompt: 'look at it',
    repo: 'sandbox',
    backend: 'claude',
    agent: 'reviewer',
  })
})

// The documented precedence: agent, then repository, then backend. A project called `claude` keeps
// `@claude` — the token that used to pick a directory must not start picking a CLI.
test('a repository beats a backend of the same name', () => {
  const clash = { agents: [], repos: ['claude'], backends: ['claude'] }
  expect(parseInput('@claude do a thing', clash)).toMatchObject({ repo: 'claude', backend: undefined })
})

test('a subagent beats a backend of the same name', () => {
  const clash = { agents: ['claude'], repos: [], backends: ['claude'] }
  expect(parseInput('@claude do a thing', clash)).toMatchObject({ agent: 'claude', backend: undefined })
})

test('a backend name is only a token behind @, never as a bare first word', () => {
  // The bare-first-word form is the subagent shortcut and nothing else; `claude fix it` is a prompt.
  expect(parseInput('claude fix it', withBackends)).toMatchObject({ prompt: 'claude fix it', backend: undefined })
})

test('only the first @backend wins; a second stays in the prompt', () => {
  expect(parseInput('@claude @copilot do it', withBackends)).toMatchObject({ backend: 'claude', prompt: '@copilot do it' })
})

test('no backend vocabulary means no backend token, as before', () => {
  expect(parseInput('@claude fix it', vocab)).toMatchObject({ prompt: '@claude fix it', backend: undefined })
})

test('suggestions offer backends after agents and repositories', () => {
  const s = suggestFor('@c', { agents: ['cleanup'], repos: ['core'], backends: ['claude', 'copilot'] })
  expect(s?.matches).toEqual([
    { name: 'cleanup', kind: 'agent' },
    { name: 'core', kind: 'repo' },
    { name: 'claude', kind: 'backend' },
    { name: 'copilot', kind: 'backend' },
  ])
})
