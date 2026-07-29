import { test, expect } from 'vitest'
import {
  prStatus,
  prColor,
  byBranch,
  fetchPullRequests,
  branchOf,
  prLabel,
  mostUrgentPr,
} from '../src/pull-requests.ts'

// The shape `gh pr list --json` really returns. `statusCheckRollup` is heterogeneous: GitHub
// Actions produce CheckRun rows keyed on `status`/`conclusion`, while older integrations produce
// StatusContext rows keyed on `state`. Both appear in the same array on the same pull request, so
// every check-reading path has to understand both.
const pr = (over = {}) => ({
  number: 1234,
  url: 'https://github.com/o/r/pull/1234',
  state: 'OPEN',
  isDraft: false,
  headRefName: 'opencode/fix-tests',
  statusCheckRollup: [],
  reviewDecision: '',
  ...over,
})

const check = (over = {}) => ({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS', ...over })
const context = (over = {}) => ({ __typename: 'StatusContext', state: 'SUCCESS', ...over })

test('prLabel: #N for one badgeable PR, N PRs for several, null for none (#89)', () => {
  expect(prLabel([])).toBe(null)
  expect(prLabel([pr({ number: 42 })])).toBe('#42')
  expect(prLabel([pr({ number: 42 }), pr({ number: 7, state: 'MERGED' })])).toBe('2 PRs')
  // a closed PR is not worth a badge
  expect(prLabel([pr({ state: 'CLOSED' })])).toBe(null)
})

test('mostUrgentPr picks the one most needing attention (failing over passing over merged) (#89)', () => {
  const failing = pr({ number: 1, statusCheckRollup: [check({ conclusion: 'FAILURE' })] })
  const passing = pr({ number: 2 })
  const merged = pr({ number: 3, state: 'MERGED' })
  expect(mostUrgentPr([passing, merged, failing])?.number).toBe(1) // failing wins
  expect(mostUrgentPr([merged, passing])?.number).toBe(2) // passing over merged
  expect(mostUrgentPr([])).toBe(null)
})

test('a merged pull request is purple whatever its checks said', () => {
  const merged = pr({ state: 'MERGED', statusCheckRollup: [check({ conclusion: 'FAILURE' })] })
  expect(prStatus(merged)).toBe('merged')
  expect(prColor(merged)).toBe('magenta')
})

test('closed and draft are both grey', () => {
  expect(prStatus(pr({ state: 'CLOSED' }))).toBe('closed')
  expect(prColor(pr({ state: 'CLOSED' }))).toBe('gray')
  expect(prStatus(pr({ isDraft: true }))).toBe('draft')
  expect(prColor(pr({ isDraft: true }))).toBe('gray')
})

test('failed checks are yellow, not red — agent view has no red for pull requests', () => {
  const failed = pr({ statusCheckRollup: [check({ conclusion: 'SUCCESS' }), check({ conclusion: 'FAILURE' })] })
  expect(prStatus(failed)).toBe('failing')
  expect(prColor(failed)).toBe('yellow')
})

test('a StatusContext failure counts the same as a CheckRun failure', () => {
  const failed = pr({ statusCheckRollup: [context({ state: 'FAILURE' })] })
  expect(prStatus(failed)).toBe('failing')
})

test('checks still running are pending, in both row shapes', () => {
  expect(prStatus(pr({ statusCheckRollup: [check({ status: 'IN_PROGRESS', conclusion: null })] }))).toBe('pending')
  expect(prStatus(pr({ statusCheckRollup: [context({ state: 'PENDING' })] }))).toBe('pending')
  expect(prColor(pr({ statusCheckRollup: [context({ state: 'PENDING' })] }))).toBe('yellow')
})

test('waiting on review is yellow even when every check passed', () => {
  // "Yellow: waiting on checks or review, or checks failed."
  const awaiting = pr({ statusCheckRollup: [check()], reviewDecision: 'REVIEW_REQUIRED' })
  expect(prStatus(awaiting)).toBe('pending')
  expect(prColor(awaiting)).toBe('yellow')
  expect(prColor(pr({ statusCheckRollup: [check()], reviewDecision: 'CHANGES_REQUESTED' }))).toBe('yellow')
})

test('green needs passing checks and nothing blocking in review', () => {
  // "Green: checks passed and no review is blocking." An empty reviewDecision means the repository
  // requires no review at all, which is not the same as a review being outstanding.
  expect(prColor(pr({ statusCheckRollup: [check()] }))).toBe('green')
  expect(prColor(pr({ statusCheckRollup: [check()], reviewDecision: 'APPROVED' }))).toBe('green')
  // A pull request with no checks configured has nothing to wait for.
  expect(prStatus(pr())).toBe('passing')
})

test('byBranch groups several pull requests onto one branch', () => {
  const a = pr({ number: 1, headRefName: 'opencode/one' })
  const b = pr({ number: 2, headRefName: 'opencode/one' })
  const c = pr({ number: 3, headRefName: 'opencode/two' })
  const map = byBranch([a, b, c])
  expect(map.get('opencode/one')!.map((p) => p.number)).toEqual([1, 2])
  expect(map.get('opencode/two')!.map((p) => p.number)).toEqual([3])
})

test('fetchPullRequests parses gh output and asks the right question', async () => {
  const calls: any[] = []
  const run = async (cmd: any, args: any, opts: any) => {
    calls.push({ cmd, args, opts })
    return { stdout: JSON.stringify([pr()]) }
  }
  const { prs, reason } = await fetchPullRequests('/repo', run as any)
  expect(reason).toBe(null)
  expect(prs).toHaveLength(1)
  expect(calls[0].cmd).toBe('gh')
  // --state all because merged and closed pull requests have colours of their own, so asking only
  // for open ones would make a merged label impossible.
  expect(calls[0].args).toContain('--state')
  expect(calls[0].args).toContain('all')
  expect(calls[0].opts.cwd).toBe('/repo')
})

test('a missing gh, an unauthenticated gh, and a repo with no remote each give a reason', async () => {
  const fail = (err: any) => (async () => { throw err }) as any
  // ENOENT only means "gh is not installed" when the directory actually exists — an existing dir
  // rules out the cwd-is-gone reading. `.` (the test's own cwd) is always present.
  expect((await fetchPullRequests('.', fail(Object.assign(new Error('x'), { code: 'ENOENT' })))).reason)
    .toMatch(/not installed/)
  expect((await fetchPullRequests('.', fail(Object.assign(new Error('x'), { stderr: 'gh auth login required: not logged into any GitHub hosts' })))).reason)
    .toMatch(/not authenticated/)
  expect((await fetchPullRequests('.', fail(Object.assign(new Error('x'), { stderr: 'none of the git remotes configured for this repository point to a known GitHub host' })))).reason)
    .toMatch(/no GitHub remote/)
  // Anything else still has to resolve to no data rather than throwing into the poll.
  const other = await fetchPullRequests('.', fail(Object.assign(new Error('x'), { stderr: 'boom' })))
  expect(other.prs).toEqual([])
  expect(other.reason).toBeTruthy()
})

test('a removed worktree directory reports no reason, not a false "gh is not installed"', async () => {
  // Found live 2026-07-23: opencode keeps listing worktrees after their directories are cleaned up,
  // and `execFile` throws ENOENT for a missing cwd exactly as it does for a missing gh binary. A
  // gone directory simply has no pull requests — reporting a gh problem for it is a lie that peek
  // would show a user whose gh works fine.
  const fail = (err: any) => (async () => { throw err }) as any
  const gone = '/no/such/dir/at/all/roost-pr-test'
  const { prs, reason } = await fetchPullRequests(gone, fail(Object.assign(new Error('x'), { code: 'ENOENT' })))
  expect(prs).toEqual([])
  expect(reason).toBe(null)
})

test('output that is not a JSON array is data roost must not trust', async () => {
  const garbage = await fetchPullRequests('/repo', (async () => ({ stdout: 'not json' })) as any)
  expect(garbage.prs).toEqual([])
  expect(garbage.reason).toMatch(/could not read/)
  const wrongShape = await fetchPullRequests('/repo', (async () => ({ stdout: '{"prs":[]}' })) as any)
  expect(wrongShape.prs).toEqual([])
  expect(wrongShape.reason).toBeTruthy()
})

test('branchOf reads the checked-out branch, and refuses a detached HEAD', () => {
  expect(branchOf('/repo', (() => 'opencode/fix-tests\n') as any)).toBe('opencode/fix-tests')
  // A detached HEAD reports the literal string "HEAD", which is not a branch and would collide
  // across every detached directory if it were used as a key.
  expect(branchOf('/repo', (() => 'HEAD\n') as any)).toBe(null)
  expect(branchOf('/repo', (() => { throw new Error('not a repository') }) as any)).toBe(null)
})

// --- issue #71: git and gh run with `cwd` set to directories the unauthenticated opencode server
// named, so the `.git/config` there is attacker-controlled and several of its keys name commands git
// will execute. Both of these fire on the 30s poll, before the user has typed anything.

test('branchOf neutralises the hostile repo config git would otherwise obey', () => {
  let seen: any
  branchOf('/repo', ((cmd: any, args: any) => { seen = { cmd, args }; return 'opencode/fix-tests\n' }) as any)
  // Ahead of `-C`, so they are settings git applies rather than arguments to the subcommand.
  expect(seen.args.indexOf('-c')).toBeLessThan(seen.args.indexOf('-C'))
  const flags = seen.args.filter((_: any, i: any) => seen.args[i - 1] === '-c')
  // Verified live against git 2.39.5: an armed `core.fsmonitor` executes on `rev-parse`, and a
  // `post-index-change` hook needs no config entry at all — the repository's own `.git/hooks` is
  // enough, which is why hooksPath has to be pointed somewhere no hook can be found.
  expect(flags).toContain('core.fsmonitor=')
  expect(flags).toContain('core.hooksPath=/dev/null')
  expect(flags).toContain('core.pager=cat')
  // The question being asked is unchanged — hardening prefixes the command, it does not rewrite it.
  expect(seen.args.slice(-5)).toEqual(['-C', '/repo', 'rev-parse', '--abbrev-ref', 'HEAD'])
})

test('fetchPullRequests hardens gh through the environment, since gh spawns its own git', async () => {
  const calls: any[] = []
  const run = async (cmd: any, args: any, opts: any) => { calls.push({ cmd, args, opts }); return { stdout: '[]' } }
  await fetchPullRequests('/repo', run as any)
  // `-c` is not available here: gh builds its git subprocesses' argv, not fleetview. Git reads the
  // same overrides from GIT_CONFIG_PARAMETERS and applies them anywhere in the process tree.
  const params = calls[0].opts.env.GIT_CONFIG_PARAMETERS
  expect(params).toContain("'core.fsmonitor='")
  expect(params).toContain("'core.hooksPath=/dev/null'")
  expect(params).toContain("'core.pager=cat'")
  // Inherited rather than replaced: wiping the environment would take PATH and gh's own auth with it.
  expect(calls[0].opts.env.PATH).toBe(process.env.PATH)
})

test('a GIT_CONFIG_PARAMETERS the user already set is kept, and still loses to ours', async () => {
  const calls: any[] = []
  const run = async (cmd: any, args: any, opts: any) => { calls.push({ cmd, args, opts }); return { stdout: '[]' } }
  await fetchPullRequests('/repo', run as any, { GIT_CONFIG_PARAMETERS: "'user.email=mine@example.com'" })
  const params = calls[0].opts.env.GIT_CONFIG_PARAMETERS
  expect(params).toContain("'user.email=mine@example.com'")
  // Ours come second, and git resolves a repeated key to the last one it reads.
  expect(params.indexOf("'core.fsmonitor='")).toBeGreaterThan(params.indexOf("'user.email="))
})
