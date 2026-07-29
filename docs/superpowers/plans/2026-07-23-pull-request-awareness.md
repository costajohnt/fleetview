# Pull Request Awareness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give roost the `#1234` row label, a `Ready for review` group, linked PRs in peek, and `#N`/URL filtering, all fed by one `gh pr list` per repository on the existing 30s poll.

**Architecture:** A new `src/pull-requests.js` holds the `gh`/git plumbing and every pure mapping (status, colour, label, urgency). `app.js` calls it on the tick that already re-lists projects, keeps a branch → PRs map in state, and decorates each session with a `prs` array at the one place every view derives from (`byProjectSessions`). The four consumers — roster row, state groups, peek, filter — then read `session.prs` and never touch `gh`.

**Tech Stack:** Node 20+, React 18, Ink 5, vitest. No build step. `gh` CLI ≥ 2.x, invoked as a subprocess. No new dependency.

## Global Constraints

- Source of truth for behaviour: `docs/superpowers/specs/2026-07-23-pull-request-awareness-design.md`, which quotes the agent view page verbatim.
- Comments explain *why*, in full sentences, and reference the agent view behaviour being matched. Match the surrounding prose style.
- No em-dashes in commit messages or PR text. Em-dashes in source comments are the existing house style and stay.
- Every new test is red-verified: break the implementation, watch the test fail, restore. A test that cannot be made to fail says so in its own comment rather than implying it discriminates.
- `npx vitest run` is the whole suite and must stay green. Baseline before this plan: 475 tests, 22 files.
- Never `git add -A` in this worktree: `node_modules` is a symlink and `.gitignore`'s `node_modules/` does not match it. Add named paths only.
- Colour names must be Ink colour names: `yellow`, `green`, `magenta`, `gray`.

---

## File Structure

- **Create** `src/pull-requests.js` — all PR plumbing and mapping. Nothing else in the codebase learns what `gh` is.
- **Create** `test/pull-requests.test.js` — unit tests for the above, with injected runners.
- **Modify** `src/app.js` — poll, state, session decoration, `STATE_GROUPS`, group assignment.
- **Modify** `src/ui/roster.js` — the right-edge label and its width budget.
- **Modify** `src/ui/peek.js` — PR lines and their row reservation.
- **Modify** `src/dispatch-parse.js` — `#N`/URL parsing and filter matching.
- **Modify** `src/ui/help.js` — one hint line.
- **Modify** `test/roster.test.js`, `test/peek.test.js`, `test/dispatch-parse.test.js`, `test/app.test.js` — tests alongside each change.
- **Modify** `docs/audits/2026-07-22-agent-view-parity.md` — flip the four ❌ rows last.

---

### Task 1: The `pull-requests` module

**Files:**
- Create: `src/pull-requests.js`
- Test: `test/pull-requests.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `prStatus(pr) -> 'merged'|'closed'|'draft'|'failing'|'pending'|'passing'`
  - `prColor(pr) -> 'magenta'|'gray'|'yellow'|'green'`
  - `isOpen(pr) -> boolean`
  - `mostUrgent(prs) -> pr|null`
  - `prLabel(prs) -> string|null`
  - `byBranch(prs) -> Map<string, pr[]>`
  - `fetchPullRequests(dir, run?) -> Promise<{prs: pr[], reason: string|null}>`
  - `branchOf(dir, run?) -> string|null`

A `pr` is a raw `gh pr list --json` row: `{number, url, state, isDraft, headRefName, statusCheckRollup, reviewDecision}`.

- [ ] **Step 1: Write the failing test**

Create `test/pull-requests.test.js`:

```js
import { test, expect } from 'vitest'
import {
  prStatus,
  prColor,
  isOpen,
  mostUrgent,
  prLabel,
  byBranch,
  fetchPullRequests,
  branchOf,
} from '../src/pull-requests.js'

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

test('a merged pull request is purple whatever its checks said', () => {
  const merged = pr({ state: 'MERGED', statusCheckRollup: [check({ conclusion: 'FAILURE' })] })
  expect(prStatus(merged)).toBe('merged')
  expect(prColor(merged)).toBe('magenta')
  expect(isOpen(merged)).toBe(false)
})

test('closed and draft are both grey, and neither is open for grouping', () => {
  expect(prStatus(pr({ state: 'CLOSED' }))).toBe('closed')
  expect(prColor(pr({ state: 'CLOSED' }))).toBe('gray')
  expect(prStatus(pr({ isDraft: true }))).toBe('draft')
  expect(prColor(pr({ isDraft: true }))).toBe('gray')
  // "a session moves to Ready for review when it has an open pull request" — a draft is not ready
  // for anyone to review, which is exactly why agent view greys it.
  expect(isOpen(pr({ isDraft: true }))).toBe(false)
  expect(isOpen(pr({ state: 'CLOSED' }))).toBe(false)
  expect(isOpen(pr())).toBe(true)
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

test('the label is a number for one pull request and a count for several', () => {
  expect(prLabel([])).toBe(null)
  expect(prLabel([pr()])).toBe('#1234')
  expect(prLabel([pr(), pr({ number: 9 })])).toBe('2 PRs')
})

test('a count is coloured by the open pull request that most needs attention', () => {
  // "the label shows a count instead, such as `3 PRs`, colored by the open pull request that most
  // needs attention" — failing outranks pending, pending outranks passing, and a merged or closed
  // pull request never speaks for the group while an open one exists.
  const merged = pr({ number: 1, state: 'MERGED' })
  const passing = pr({ number: 2, statusCheckRollup: [check()] })
  const failing = pr({ number: 3, statusCheckRollup: [check({ conclusion: 'FAILURE' })] })
  expect(mostUrgent([merged, passing, failing]).number).toBe(3)
  expect(mostUrgent([merged, passing]).number).toBe(2)
  // Nothing open: the label still has to be coloured something, so the first pull request speaks.
  expect(mostUrgent([merged]).number).toBe(1)
  expect(mostUrgent([])).toBe(null)
})

test('byBranch groups several pull requests onto one branch', () => {
  const a = pr({ number: 1, headRefName: 'opencode/one' })
  const b = pr({ number: 2, headRefName: 'opencode/one' })
  const c = pr({ number: 3, headRefName: 'opencode/two' })
  const map = byBranch([a, b, c])
  expect(map.get('opencode/one').map((p) => p.number)).toEqual([1, 2])
  expect(map.get('opencode/two').map((p) => p.number)).toEqual([3])
})

test('fetchPullRequests parses gh output and asks the right question', async () => {
  const calls = []
  const run = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    return { stdout: JSON.stringify([pr()]) }
  }
  const { prs, reason } = await fetchPullRequests('/repo', run)
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
  const fail = (err) => async () => { throw err }
  expect((await fetchPullRequests('/repo', fail(Object.assign(new Error('x'), { code: 'ENOENT' })))).reason)
    .toMatch(/not installed/)
  expect((await fetchPullRequests('/repo', fail(Object.assign(new Error('x'), { stderr: 'gh auth login required: not logged into any GitHub hosts' })))).reason)
    .toMatch(/not authenticated/)
  expect((await fetchPullRequests('/repo', fail(Object.assign(new Error('x'), { stderr: 'none of the git remotes configured for this repository point to a known GitHub host' })))).reason)
    .toMatch(/no GitHub remote/)
  // Anything else still has to resolve to no data rather than throwing into the poll.
  const other = await fetchPullRequests('/repo', fail(Object.assign(new Error('x'), { stderr: 'boom' })))
  expect(other.prs).toEqual([])
  expect(other.reason).toBeTruthy()
})

test('output that is not a JSON array is data roost must not trust', async () => {
  const garbage = await fetchPullRequests('/repo', async () => ({ stdout: 'not json' }))
  expect(garbage.prs).toEqual([])
  expect(garbage.reason).toMatch(/could not read/)
  const wrongShape = await fetchPullRequests('/repo', async () => ({ stdout: '{"prs":[]}' }))
  expect(wrongShape.prs).toEqual([])
  expect(wrongShape.reason).toBeTruthy()
})

test('branchOf reads the checked-out branch, and refuses a detached HEAD', () => {
  expect(branchOf('/repo', () => 'opencode/fix-tests\n')).toBe('opencode/fix-tests')
  // A detached HEAD reports the literal string "HEAD", which is not a branch and would collide
  // across every detached directory if it were used as a key.
  expect(branchOf('/repo', () => 'HEAD\n')).toBe(null)
  expect(branchOf('/repo', () => { throw new Error('not a repository') })).toBe(null)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pull-requests.test.js`
Expected: FAIL — `Failed to resolve import "../src/pull-requests.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/pull-requests.js`:

```js
// Pull request awareness, agent view's rule: "When a session opens a pull request, a `#1234` label
// appears at the right edge of the row." Agent view links a pull request two ways — by watching the
// session's own `gh` command output, and because "pushing to a branch that has an open pull request
// links it by looking up that branch with `gh pr view`". roost does the second only: sessions run in
// worktrees on branches named `opencode/<slug>`, so the branch is already a unique key, and reading
// it costs one local git call instead of a parser against `gh`'s unspecified human output.
//
// Everything here is either pure or takes its runner as an argument, so the tests never reach the
// network and never need a real repository.
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Exactly the fields the four consumers need. Asking for more would slow every poll for data
// nothing renders.
const FIELDS = 'number,url,state,isDraft,headRefName,statusCheckRollup,reviewDecision'

// `--state all` because merged and closed pull requests have colours of their own — asking only for
// open ones would make a purple or grey label impossible. The limit is a guard against a repository
// with thousands of pull requests turning one poll tick into a long download; a session's own branch
// is almost always among the most recent.
const LIMIT = '50'

// A review is blocking when it is outstanding or negative. An empty `reviewDecision` means the
// repository requires no review at all, which is not the same as a review being outstanding, so it
// must not be treated as blocking or every pull request in an unprotected repository stays yellow
// forever.
const BLOCKING_REVIEW = new Set(['REVIEW_REQUIRED', 'CHANGES_REQUESTED'])

// `statusCheckRollup` is heterogeneous. GitHub Actions produce CheckRun rows carrying
// `status`/`conclusion`, while commit statuses from older integrations produce StatusContext rows
// carrying `state`, and one pull request can have both. Reading only one shape would silently call a
// repository with commit statuses "passing" while its builds were red.
const FAILED_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const FAILED_STATES = new Set(['FAILURE', 'ERROR'])

const checkFailed = (c) =>
  FAILED_CONCLUSIONS.has(c?.conclusion ?? '') || FAILED_STATES.has(c?.state ?? '')

const checkPending = (c) =>
  (c?.status !== undefined && c.status !== 'COMPLETED') || c?.state === 'PENDING' || c?.state === 'EXPECTED'

export const isOpen = (pr) => pr?.state === 'OPEN' && !pr.isDraft

// The status behind the colour. Kept finer-grained than the colour itself because peek says in
// words what the row can only say in colour, and "checks failed" and "waiting on checks" are the
// same yellow but very different news.
export function prStatus(pr) {
  if (pr?.state === 'MERGED') return 'merged'
  if (pr?.state === 'CLOSED') return 'closed'
  if (pr?.isDraft) return 'draft'
  const checks = Array.isArray(pr?.statusCheckRollup) ? pr.statusCheckRollup : []
  if (checks.some(checkFailed)) return 'failing'
  if (checks.some(checkPending)) return 'pending'
  if (BLOCKING_REVIEW.has(pr?.reviewDecision ?? '')) return 'pending'
  // No checks configured is not the same as checks outstanding: there is nothing left to wait for.
  return 'passing'
}

// Agent view's table exactly: yellow waiting on checks or review or checks failed, green when checks
// passed and no review is blocking, purple merged, grey draft or closed. There is deliberately no
// red — a failing pull request is something to look at, not a failed session.
const COLORS = {
  merged: 'magenta',
  closed: 'gray',
  draft: 'gray',
  failing: 'yellow',
  pending: 'yellow',
  passing: 'green',
}

export const prColor = (pr) => COLORS[prStatus(pr)] ?? 'gray'

// "the label shows a count instead, such as `3 PRs`, colored by the open pull request that most
// needs attention". Failing needs attention before pending, which needs it before a passing pull
// request nobody has merged yet. A merged or closed pull request never speaks for the group while an
// open one exists, but has to speak when it is all there is, or the label would have no colour.
const URGENCY = { failing: 0, pending: 1, passing: 2 }

export function mostUrgent(prs = []) {
  const open = prs.filter(isOpen)
  if (open.length === 0) return prs[0] ?? null
  return open.reduce((best, pr) => (URGENCY[prStatus(pr)] < URGENCY[prStatus(best)] ? pr : best))
}

export function prLabel(prs = []) {
  if (prs.length === 0) return null
  return prs.length === 1 ? `#${prs[0].number}` : `${prs.length} PRs`
}

// One `gh` call per repository answers every session in it, which is the whole reason this is
// affordable: keying on the branch means the map built here is looked up per row for free.
export function byBranch(prs = []) {
  const map = new Map()
  for (const pr of prs) {
    if (!pr?.headRefName) continue
    map.set(pr.headRefName, [...(map.get(pr.headRefName) ?? []), pr])
  }
  return map
}

// Every way this can fail resolves to no data plus a reason, never a throw: it runs inside the
// project poll, and an exception there would take out the reconciliation the whole roster depends
// on. The reason is shown in peek rather than as a notice, because a user without `gh` should not be
// nagged on every launch in every repository that will never have a pull request.
function reasonFor(err) {
  if (err?.code === 'ENOENT') return 'gh is not installed'
  const stderr = String(err?.stderr ?? '')
  if (/not logged into|authentication|gh auth login/i.test(stderr)) return 'gh is not authenticated'
  if (/no git remotes|none of the git remotes|not a git repository/i.test(stderr)) return 'no GitHub remote'
  return 'gh could not list pull requests'
}

// Asynchronous because it is a network round trip on a timer. `branchOf` below stays synchronous
// because it is a local git read measured in milliseconds; blocking the event loop for a network
// call would stutter the roster's animation on every poll tick.
export async function fetchPullRequests(dir, run = execFileAsync) {
  let stdout
  try {
    ;({ stdout } = await run('gh', ['pr', 'list', '--state', 'all', '--limit', LIMIT, '--json', FIELDS], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 15000,
    }))
  } catch (err) {
    return { prs: [], reason: reasonFor(err) }
  }
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return { prs: [], reason: 'could not read gh output' }
  }
  if (!Array.isArray(parsed)) return { prs: [], reason: 'could not read gh output' }
  return { prs: parsed, reason: null }
}

// The key every session is looked up by. A detached HEAD reports the literal string "HEAD", which is
// not a branch and would collide across every detached directory if it were used as a key, so it is
// refused the same way an unreadable directory is.
export function branchOf(dir, run = execFileSync) {
  try {
    const branch = run('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return branch && branch !== 'HEAD' ? branch : null
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/pull-requests.test.js`
Expected: PASS, 13 tests.

- [ ] **Step 5: Red-verify three of them**

The colour table, the urgency order, and the detached-HEAD guard are the claims worth proving discriminate.

1. In `COLORS`, change `pending: 'yellow'` to `pending: 'green'`. Run the suite. Expected: `waiting on review is yellow even when every check passed` FAILS. Restore.
2. In `URGENCY`, swap to `{ failing: 2, pending: 1, passing: 0 }`. Run. Expected: `a count is coloured by the open pull request that most needs attention` FAILS. Restore.
3. In `branchOf`, drop `&& branch !== 'HEAD'`. Run. Expected: `branchOf reads the checked-out branch, and refuses a detached HEAD` FAILS. Restore.

Run after restoring: `npx vitest run test/pull-requests.test.js` — PASS.

- [ ] **Step 6: Commit**

```bash
git add src/pull-requests.js test/pull-requests.test.js
git commit -m "feat: read pull requests for a repository with gh

One gh call per repository, keyed by branch, which is what makes the
label affordable: sessions run in worktrees on opencode/<slug>, so every
session in a repository is answered by one subprocess rather than one per
row per render.

Colours are agent view's table exactly, and there is deliberately no red.
statusCheckRollup is read in both its shapes because Actions and older
commit statuses land in the same array, and reading only CheckRun would
call a repository with red commit statuses passing.

Every failure resolves to no data plus a reason rather than a throw: this
runs inside the project poll, where an exception would take out the
reconciliation the whole roster depends on."
```

---

### Task 2: Poll `gh` and hang `prs` on every session

**Files:**
- Modify: `src/app.js` (imports, the `refreshProjects` effect, `byProjectSessions`)
- Test: `test/app.test.js`

**Interfaces:**
- Consumes: `fetchPullRequests`, `branchOf`, `byBranch` from Task 1.
- Produces: every session object reaching a view carries `prs: pr[]` (always an array, never undefined). `App` accepts two new props, `fetchPullRequestsImpl` and `branchOfImpl`, defaulting to the real ones, so tests drive PR data without a `gh` binary. Peek receives `prReason: string|null`.

- [ ] **Step 1: Write the failing test**

Append to `test/app.test.js`. Follow the file's existing render helper; the snippet below names it `renderApp`, so rename to whatever that file already uses.

```js
test('a session on a branch with an open pull request carries it into the view', async () => {
  // One gh call per repository, never per session: the assertion on `calls` is the affordability
  // claim the whole design rests on, so it is asserted rather than assumed.
  const calls = []
  const fetchPullRequestsImpl = async (dir) => {
    calls.push(dir)
    return {
      prs: [{ number: 77, url: 'https://github.com/o/r/pull/77', state: 'OPEN', isDraft: false, headRefName: 'opencode/fix', statusCheckRollup: [], reviewDecision: '' }],
      reason: null,
    }
  }
  const { lastFrame, cleanup } = renderApp({
    fetchPullRequestsImpl,
    branchOfImpl: () => 'opencode/fix',
  })
  await tick()
  expect(lastFrame()).toContain('#77')
  // The repository, not each of its sessions and not its worktrees.
  expect(new Set(calls).size).toBe(calls.length)
  cleanup()
})

test('gh being unavailable leaves the roster exactly as it was', async () => {
  const { lastFrame, cleanup } = renderApp({
    fetchPullRequestsImpl: async () => ({ prs: [], reason: 'gh is not installed' }),
    branchOfImpl: () => 'opencode/fix',
  })
  await tick()
  expect(lastFrame()).not.toContain('#')
  expect(lastFrame()).not.toContain('gh is not installed') // no startup nag; peek carries the reason
  cleanup()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/app.test.js -t 'carries it into the view'`
Expected: FAIL — the frame has no `#77`.

- [ ] **Step 3: Wire the poll**

In `src/app.js`, add to the imports beside the `worktree.js` line:

```js
import { fetchPullRequests, branchOf, byBranch } from './pull-requests.js'
```

Add the two injection props to the `App` signature, beside `projectPollMs = 30000`:

```js
  fetchPullRequestsImpl = fetchPullRequests,
  branchOfImpl = branchOf,
```

Add state beside the other `useState` calls:

```js
  // Pull requests, keyed the way they are looked up: branch to pull requests, plus the branch each
  // project directory is on. `reason` is why there is no data, shown in peek rather than as a
  // notice.
  const [pullRequests, setPullRequests] = useState({ byBranch: new Map(), branches: new Map(), reason: null })
```

Inside `refreshProjects`, immediately after `setProjects((prev) => mergeProjects(prev, fresh))`, add:

```js
        // Pull requests refresh on the tick that already re-lists projects: no second timer and no
        // TTL bookkeeping. A poll is unavoidable rather than a shortcut — the label's colour encodes
        // CI state, and checks go green while the session sits idle, so no session event could ever
        // turn a row green.
        await refreshPullRequests(fresh)
```

Define `refreshPullRequests` inside the same effect, above `refreshProjects`:

```js
    const refreshPullRequests = async (fresh) => {
      // One call per repository, never per worktree: a worktree shares its repository's remote, so
      // asking it the same question again would double the subprocesses for identical answers.
      const parentsNow = sandboxParents(fresh)
      const repoDirs = fresh.filter((p) => !parentsNow.has(p.worktree)).map((p) => p.worktree)
      const results = await Promise.all(repoDirs.map((dir) => fetchPullRequestsImpl(dir)))
      if (cancelled) return
      const merged = new Map()
      for (const { prs } of results) {
        for (const [branch, list] of byBranch(prs)) merged.set(branch, [...(merged.get(branch) ?? []), ...list])
      }
      // The first reason is enough: peek needs to say why there is no data, not enumerate every
      // repository that said so.
      const reason = results.find((r) => r.reason)?.reason ?? null
      // Branches are read for every directory including worktrees, because a session's key is the
      // branch of the directory it actually runs in, not of the repository that owns it.
      const branches = new Map()
      for (const p of fresh) {
        const branch = branchOfImpl(p.worktree)
        if (branch) branches.set(p.worktree, branch)
      }
      setPullRequests({ byBranch: merged, branches, reason })
    }
```

- [ ] **Step 4: Decorate the sessions**

Still in `src/app.js`, replace the `byProjectSessions` line:

```js
  const byProjectSessions = new Map(store.byProject().map((g) => [g.projectKey, g.sessions]))
```

with:

```js
  // Every view derives from this map, so decorating here is the one place a session learns about its
  // pull requests — the roster row, the state groups, peek and the `#N` filter all read
  // `session.prs` and none of them knows `gh` exists. `prs` is always an array so no consumer needs
  // a guard.
  const prsFor = (projectKey) => {
    const branch = pullRequests.branches.get(projectKey)
    return (branch && pullRequests.byBranch.get(branch)) || []
  }
  const byProjectSessions = new Map(
    store.byProject().map((g) => [g.projectKey, g.sessions.map((s) => ({ ...s, prs: prsFor(s.projectKey) }))]),
  )
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/app.test.js`
Expected: PASS. `#77` will not render until Task 3 adds the label — so at this point the first new test still FAILS. Confirm instead that the second test passes and nothing else regressed, then leave the first failing and finish it in Task 3.

To keep the tree green per-commit, mark the first test `test.todo` here with the comment `// unskipped in Task 3, when the label is rendered` and unskip it in Task 3.

Run: `npx vitest run`
Expected: PASS, 476 tests (475 + the gh-unavailable test), 23 files.

- [ ] **Step 6: Commit**

```bash
git add src/app.js test/app.test.js
git commit -m "feat: poll pull requests on the project tick

Piggybacks the 30s project poll rather than adding a timer of its own, and
calls gh once per repository rather than once per worktree, since a
worktree shares its repository's remote and would return identical answers.

Sessions are decorated with prs at byProjectSessions, which every view
derives from, so the roster row, the state groups, peek and the filter all
read session.prs and none of them knows gh exists."
```

---

### Task 3: The `#1234` label on the row

**Files:**
- Modify: `src/ui/roster.js`
- Test: `test/roster.test.js`, and unskip the Task 2 test in `test/app.test.js`

**Interfaces:**
- Consumes: `session.prs` from Task 2, `prLabel`/`prColor`/`mostUrgent` from Task 1.
- Produces: nothing new; the label is rendered inside `Roster`.

- [ ] **Step 1: Write the failing test**

Append to `test/roster.test.js`, matching that file's existing render idiom:

```js
import { prLabel } from '../src/pull-requests.js'

const openPr = (number, over = {}) => ({
  number,
  url: `https://github.com/o/r/pull/${number}`,
  state: 'OPEN',
  isDraft: false,
  headRefName: 'opencode/x',
  statusCheckRollup: [],
  reviewDecision: '',
  ...over,
})

test('a linked pull request shows as a label at the right edge of the row', () => {
  const session = { id: 's1', projectKey: '/repo', title: 'fix the tests', status: 'idle', updatedAt: Date.now(), prs: [openPr(1234)] }
  const frame = renderRoster({ groups: [{ projectKey: '/repo', repoName: 'repo', sessions: [session] }], columns: 80 })
  expect(frame).toContain('#1234')
  // The right edge: nothing of the row's own content may follow it.
  const row = frame.split('\n').find((l) => l.includes('#1234'))
  expect(row.trimEnd().endsWith('#1234')).toBe(true)
})

test('several pull requests collapse to a count', () => {
  const session = { id: 's1', projectKey: '/repo', title: 'fix', status: 'idle', updatedAt: Date.now(), prs: [openPr(1), openPr(2), openPr(3)] }
  const frame = renderRoster({ groups: [{ projectKey: '/repo', repoName: 'repo', sessions: [session] }], columns: 80 })
  expect(frame).toContain('3 PRs')
})

test('the label is counted in the row budget, so a labelled row still cannot wrap', () => {
  // The viewport arithmetic counts every row as one physical line. A label added after the budget
  // was computed would push a long snippet past `columns` and wrap it, which scrolls the top of the
  // roster out of the region Ink can repaint.
  const session = {
    id: 's1',
    projectKey: '/repo',
    title: 'a fairly long session title here',
    status: 'idle',
    updatedAt: Date.now(),
    snippet: 'x'.repeat(400),
    prs: [openPr(1234)],
  }
  const frame = renderRoster({ groups: [{ projectKey: '/repo', repoName: 'repo', sessions: [session] }], columns: 80 })
  for (const line of frame.split('\n')) expect(line.length).toBeLessThanOrEqual(80)
})

test('a session with no pull requests renders exactly as before', () => {
  const session = { id: 's1', projectKey: '/repo', title: 'fix', status: 'idle', updatedAt: Date.now(), prs: [] }
  const frame = renderRoster({ groups: [{ projectKey: '/repo', repoName: 'repo', sessions: [session] }], columns: 80 })
  expect(frame).not.toContain('#')
  expect(prLabel([])).toBe(null)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/roster.test.js -t 'right edge'`
Expected: FAIL — the frame has no `#1234`.

- [ ] **Step 3: Render the label**

In `src/ui/roster.js`, add to the imports:

```js
import { prLabel, prColor, mostUrgent } from '../pull-requests.js'
```

Inside the session branch of the `slice.map`, after the `const stateWord = ...` line, add:

```js
      // "a `#1234` label appears at the right edge of the row" — and when a session is linked to
      // more than one, "the label shows a count instead, such as `3 PRs`, colored by the open pull
      // request that most needs attention". It is not hyperlinked: agent view links it in terminals
      // that support hyperlinks, roost has no OSC 8 helper, and peek lists the URL one keypress away.
      const prs = s.prs ?? []
      const prText = prLabel(prs)
```

Change the `fixedParts` line to include it, so the snippet budget shrinks by the label's width rather than the row overflowing:

```js
      const fixedParts = [marker, badgeLabel(), title, timeText, stateWord, isMember ? '[roster]' : null, prText].filter(Boolean)
```

Add the element as the last child of the row `Box`, after the `isMember` element:

```js
        prText ? React.createElement(Text, { color: prColor(mostUrgent(prs)) }, prText) : null,
```

- [ ] **Step 4: Unskip the Task 2 test and run everything**

In `test/app.test.js`, change the `test.todo` back to `test` and delete the `// unskipped in Task 3` comment.

Run: `npx vitest run`
Expected: PASS, 481 tests.

- [ ] **Step 5: Red-verify the budget test**

Remove `prText` from `fixedParts` (leave the element rendering). Run: `npx vitest run test/roster.test.js -t 'row budget'`. Expected: FAIL, a line longer than 80. Restore, re-run, PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/roster.js test/roster.test.js test/app.test.js
git commit -m "feat: a pull request label at the right edge of the row

Counted in the snippet budget rather than appended after it, because the
viewport arithmetic counts every row as one physical line and a label
added after the budget was computed wraps the row, which scrolls the top
of the roster out of the region Ink can repaint.

Not hyperlinked. Agent view links the label in terminals that support
hyperlinks; roost has no OSC 8 helper and peek lists the URL one keypress
away, so this is unbuilt rather than dropped."
```

---

### Task 4: The `Ready for review` group

**Files:**
- Modify: `src/app.js` (`STATE_GROUPS`, `stateGroups()`)
- Test: `test/app.test.js` or `test/group-headers.test.js` — whichever already covers state grouping

**Interfaces:**
- Consumes: `session.prs` from Task 2, `isOpen` from Task 1.
- Produces: a `state:review` group key, matching `buildLines`' `header:state:review`.

- [ ] **Step 1: Write the failing test**

```js
import { isOpen } from '../src/pull-requests.js'

const openPr = (number) => ({ number, url: `https://github.com/o/r/pull/${number}`, state: 'OPEN', isDraft: false, headRefName: 'opencode/x', statusCheckRollup: [], reviewDecision: '' })
const draftPr = (number) => ({ ...openPr(number), isDraft: true })

test('a session with an open pull request groups under ready for review', async () => {
  const { lastFrame, cleanup } = renderApp({
    fetchPullRequestsImpl: async () => ({ prs: [openPr(5)], reason: null }),
    branchOfImpl: () => 'opencode/x',
  })
  await tick()
  expect(lastFrame()).toContain('ready for review')
  cleanup()
})

test('a draft pull request does not make a session ready for review', () => {
  // Grey is agent view's colour for a draft precisely because it is not ready for anyone.
  expect(isOpen(draftPr(5))).toBe(false)
})

test('a waiting session with an open pull request appears once, under ready for review', async () => {
  // Group assignment has to be first-match-wins now. Every other predicate tests `status` and so is
  // mutually exclusive for free, but having an open pull request is not exclusive with any status —
  // and a session in two groups breaks the partition that stops the arrow keys visiting the same
  // row twice. Agent view puts `Ready for review` above `Needs input`, so it wins.
  const { lastFrame, cleanup } = renderApp({
    fetchPullRequestsImpl: async () => ({ prs: [openPr(5)], reason: null }),
    branchOfImpl: () => 'opencode/x',
    seedStatus: 'waiting', // whatever this test file's helper uses to force a waiting session
  })
  await tick()
  const frame = lastFrame()
  const occurrences = frame.split('\n').filter((l) => l.includes('#5')).length
  expect(occurrences).toBe(1)
  cleanup()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run -t 'ready for review'`
Expected: FAIL — no such group exists.

- [ ] **Step 3: Add the group and make assignment first-match-wins**

In `src/app.js`, add to the `pull-requests.js` import: `isOpen`.

Replace the `STATE_GROUPS` block's comment and array:

```js
// Agent view's groups, in its order: "sessions so the ones that need input are at the top, with
// Ready for review and Needs input above Working and Completed".
//
// These deliberately don't map 1:1 to states — "Completed collects finished, failed, and stopped
// sessions together" — which is why each group carries a predicate rather than a status string.
//
// `Ready for review` is the reason assignment below is first-match-wins. Every other predicate tests
// `status`, so they are mutually exclusive for free; "has an open pull request" is exclusive with
// nothing, and a session landing in two groups would break the partition that stops ↑/↓ visiting the
// same session twice.
const FINISHED = ['done', 'error', 'stopped']
const STATE_GROUPS = [
  { key: 'pinned', label: 'pinned', match: () => false }, // filled by pin membership, not status
  // "a session moves to Ready for review when it has an open pull request" — open, so a draft or a
  // closed pull request leaves the session wherever its status puts it.
  { key: 'review', label: 'ready for review', match: (s) => (s.prs ?? []).some(isOpen) },
  { key: 'waiting', label: 'needs input', match: (s) => s.status === 'waiting' },
  { key: 'running', label: 'working', match: (s) => s.status === 'running' },
  { key: 'completed', label: 'completed', match: (s) => FINISHED.includes(s.status) },
  { key: 'idle', label: 'idle', match: (s) => s.status === 'idle' },
]
```

In `stateGroups()`, replace the `inGroup` line and the `STATE_GROUPS.map` that follows it:

```js
    // A pinned session appears under `pinned` and nowhere else, so the groups stay a partition and
    // ↑/↓ never visits the same session twice. First-match-wins keeps that true now that one
    // predicate reads pull requests rather than status: a waiting session with an open pull request
    // is ready for review, because agent view puts that group higher.
    const groupFor = (s) => {
      if (isPinned(s.projectKey, s.id)) return 'pinned'
      return STATE_GROUPS.find((g) => g.key !== 'pinned' && g.match(s))?.key
    }
    return STATE_GROUPS.map((g) => ({
      projectKey: `state:${g.key}`,
      repoName: g.label,
      sessions: members
        .filter((s) => groupFor(s) === g.key)
        // Failures first inside `completed`: the fold cuts from the end, and a failure must
        // survive it.
        .sort((a, b) => (a.status === 'error' ? -1 : 0) - (b.status === 'error' ? -1 : 0) || b.updatedAt - a.updatedAt),
    })).filter((g) => g.sessions.length > 0)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS, 484 tests. If any existing grouping test fails, it is asserting the old independent-predicate behaviour on a session that now matches two groups — read it before changing it, because it may be the partition bug this task fixes.

- [ ] **Step 5: Red-verify first-match-wins**

Change `groupFor` back to the independent form by replacing `.filter((s) => groupFor(s) === g.key)` with `.filter((s) => (g.key === 'pinned' ? isPinned(s.projectKey, s.id) : !isPinned(s.projectKey, s.id) && g.match(s)))`. Run: `npx vitest run -t 'appears once'`. Expected: FAIL, 2 occurrences. Restore, re-run, PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app.js test/app.test.js
git commit -m "feat: a ready for review group, above needs input

A session moves there when it has an open pull request, so a draft or a
closed one leaves it wherever its status puts it.

Group assignment becomes first-match-wins. Every other predicate tests
status and so is mutually exclusive for free, but having an open pull
request is exclusive with nothing, and a session landing in two groups
breaks the partition that stops the arrow keys visiting the same row
twice. A waiting session with an open pull request therefore sorts as
ready for review, which is the order agent view lists the groups in."
```

---

### Task 5: Linked pull requests in peek

**Files:**
- Modify: `src/ui/peek.js`, `src/app.js` (pass `prReason` to `Peek`)
- Test: `test/peek.test.js`

**Interfaces:**
- Consumes: `target.prs` (already present via Task 2's decoration), `pullRequests.reason`.
- Produces: `Peek` accepts a new optional prop `prReason: string|null`.

- [ ] **Step 1: Write the failing test**

Append to `test/peek.test.js`, matching its existing render idiom:

```js
const openPr = (number, over = {}) => ({ number, url: `https://github.com/o/r/pull/${number}`, state: 'OPEN', isDraft: false, headRefName: 'opencode/x', statusCheckRollup: [], reviewDecision: '', ...over })

test('peek lists every linked pull request with its state and url', () => {
  const target = { id: 's1', projectKey: '/repo', title: 'fix', prs: [openPr(12), openPr(34, { state: 'MERGED' })] }
  const frame = renderPeek({ target, messages: [], columns: 100 })
  expect(frame).toContain('#12')
  expect(frame).toContain('#34')
  expect(frame).toContain('merged')
  expect(frame).toContain('https://github.com/o/r/pull/12')
})

test('peek says why there is no pull request data rather than staying silent', () => {
  // Rows stay clean and there is no startup notice, so this line is the only place a user who
  // wonders where their label went can find out.
  const target = { id: 's1', projectKey: '/repo', title: 'fix', prs: [] }
  const frame = renderPeek({ target, messages: [], prReason: 'gh is not installed', columns: 100 })
  expect(frame).toContain('gh is not installed')
})

test('the pull request lines are reserved, so peek still fits its viewport', () => {
  const target = {
    id: 's1',
    projectKey: '/repo',
    title: 'fix',
    prs: [openPr(1), openPr(2), openPr(3)],
  }
  const messages = [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'y'.repeat(500) }] }]
  const frame = renderPeek({ target, messages, maxRows: 10, columns: 60 })
  expect(frame.split('\n').length).toBeLessThanOrEqual(10)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/peek.test.js -t 'linked pull request'`
Expected: FAIL — no `#12` in the frame.

- [ ] **Step 3: Render the lines**

In `src/ui/peek.js`, add to the imports:

```js
import { prStatus, prColor } from '../pull-requests.js'
```

Add above the `Peek` component:

```js
// "Open the peek panel to see them all" — the row can only show a number and a colour, so peek is
// where a session's pull requests are actually listed, one per line, with the URL that the row
// deliberately does not hyperlink.
const prLine = (pr) => `${`#${pr.number}`} ${prStatus(pr)} · ${pr.url}`
```

Add `prReason = null` to the `Peek` prop list.

After the `const waited = ...` line, add:

```js
  const prs = target.prs ?? []
  // Each line is truncated rather than wrapped: a pull request URL is long, and letting three of
  // them wrap would eat the body of the panel on a narrow terminal.
  const prRows = prs.map((pr) => ({ text: truncateGraphemes(prLine(pr), columns), color: prColor(pr) }))
  // No pull requests and a reason means gh could not answer. Saying so here rather than as a
  // startup notice keeps roost from nagging in every repository that will never have one.
  const prReasonRow = prs.length === 0 && prReason ? truncateGraphemes(prReason, columns) : null
```

Extend `extras`, which both the reserve calculations already read, so the body shrinks by exactly what these lines take:

```js
  const extras = (waited ? 1 : 0) + (savedReply ? 1 : 0) + prRows.length + (prReasonRow ? 1 : 0)
```

Add the elements immediately after the `waited` element:

```js
    ...prRows.map((r, i) => React.createElement(Text, { key: `pr${i}`, color: r.color }, r.text)),
    prReasonRow ? React.createElement(Text, { key: 'prReason', dimColor: true }, prReasonRow) : null,
```

In `src/app.js`, find where `Peek` is created and add the prop:

```js
          prReason: pullRequests.reason,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS, 487 tests.

- [ ] **Step 5: Red-verify the reservation**

Remove `+ prRows.length + (prReasonRow ? 1 : 0)` from `extras`. Run: `npx vitest run test/peek.test.js -t 'still fits its viewport'`. Expected: FAIL, more than 10 lines. Restore, re-run, PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/peek.js src/app.js test/peek.test.js
git commit -m "feat: list a session's pull requests in peek

The row can only show a number and a colour, so peek is where they are
actually listed, one per line with the URL the row deliberately does not
hyperlink. Lines are truncated rather than wrapped, since three long pull
request URLs would otherwise eat the body of the panel.

When gh could not answer, the reason goes here instead. Rows stay clean
and there is no startup notice, so this is the only place a user wondering
where their label went can find out."
```

---

### Task 6: `#N` and PR URLs as a filter

**Files:**
- Modify: `src/dispatch-parse.js`, `src/ui/help.js`
- Test: `test/dispatch-parse.test.js`

**Interfaces:**
- Consumes: `session.prs` from Task 2.
- Produces: `parseInput` may return `{kind: 'filter', filter: {pr: number}}`; `applyFilter` honours it.

- [ ] **Step 1: Write the failing test**

Append to `test/dispatch-parse.test.js`:

```js
test('#1234 and a pull request URL both filter to that pull request', () => {
  expect(parseInput('#1234')).toEqual({ kind: 'filter', filter: { pr: 1234 } })
  expect(parseInput('https://github.com/costajohnt/roost/pull/1234')).toEqual({ kind: 'filter', filter: { pr: 1234 } })
  // The trailing path GitHub adds on a files or checks tab still names the same pull request.
  expect(parseInput('https://github.com/costajohnt/roost/pull/1234/files')).toEqual({ kind: 'filter', filter: { pr: 1234 } })
})

test('a bare # and a hash inside a prompt are not filters', () => {
  // "#" alone names no pull request, and a prompt is the far commoner thing to type.
  expect(parseInput('#').kind).toBe('dispatch')
  expect(parseInput('fix issue #12 in the parser').kind).toBe('dispatch')
  expect(parseInput('#12a').kind).toBe('dispatch')
})

test('applyFilter keeps only the session working on that pull request', () => {
  const withPr = (id, numbers) => ({ id, status: 'idle', prs: numbers.map((number) => ({ number })) })
  const sessions = [withPr('a', [1234]), withPr('b', [7]), withPr('c', [])]
  expect(applyFilter(sessions, { pr: 1234 }).map((s) => s.id)).toEqual(['a'])
  expect(applyFilter(sessions, { pr: 999 })).toEqual([])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/dispatch-parse.test.js -t 'filter to that pull request'`
Expected: FAIL — `parseInput('#1234')` returns a `dispatch`.

- [ ] **Step 3: Parse and apply it**

In `src/dispatch-parse.js`, add beside the `FILTER` constant:

```js
// "`#<number>` or a PR URL — shows the session working on that pull request." Anchored on both ends
// so a prompt that merely mentions an issue number is still a prompt: `fix issue #12 in the parser`
// dispatches, `#12` filters.
const PR_NUMBER = /^#(\d+)$/
const PR_URL = /^https?:\/\/[^/]*github[^/]*\/[^/]+\/[^/]+\/pull\/(\d+)(?:\/\S*)?$/
```

Inside `parseInput`, immediately after the existing `FILTER` block:

```js
  const prMatch = PR_NUMBER.exec(text) ?? PR_URL.exec(text)
  // Agent view defines this as a filter and nothing else — filtering to that one row is the
  // selector, so there is no second jump-to-session mechanism to build.
  if (prMatch) return { kind: 'filter', filter: { pr: Number(prMatch[1]) } }
```

In `applyFilter`, before the final `return sessions`:

```js
  if (filter.pr !== undefined) {
    return sessions.filter((s) => (s.prs ?? []).some((pr) => pr.number === filter.pr))
  }
```

In `src/ui/help.js`, add after the `a:name` row:

```js
  ['#1234', 'filter to the session working on that pull request (a PR URL works too)'],
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS, 490 tests.

- [ ] **Step 5: Red-verify the anchoring**

Change `PR_NUMBER` to `/#(\d+)/` (unanchored). Run: `npx vitest run test/dispatch-parse.test.js -t 'not filters'`. Expected: FAIL — `fix issue #12 in the parser` is parsed as a filter, which would make that prompt undispatchable. Restore, re-run, PASS.

- [ ] **Step 6: Commit**

```bash
git add src/dispatch-parse.js src/ui/help.js test/dispatch-parse.test.js
git commit -m "feat: #N and pull request URLs filter the roster

Anchored on both ends, so a prompt that merely mentions an issue number is
still a prompt: '#12' filters and 'fix issue #12 in the parser'
dispatches. Getting that wrong would make a whole class of prompt
undispatchable.

Agent view defines this as a filter and nothing else, and filtering to one
row is the selector, so there is no second jump-to-session mechanism."
```

---

### Task 7: Live verification and the audit scoreboard

**Files:**
- Modify: `docs/audits/2026-07-22-agent-view-parity.md`

No new code. Every parity claim in the audit docs that was unit-tested only has been wrong at least once, so nothing here is flipped to ✅ on the strength of the suite.

- [ ] **Step 1: Make a real pull request to look at**

From this worktree, on a scratch branch pushed to the roost remote:

```bash
git -C /Users/johncosta/dev/roost/.claude/worktrees/pr-awareness checkout -b opencode/pr-awareness-smoke
git commit --allow-empty -m "chore: a commit to hang a smoke-test pull request on"
git push -u origin opencode/pr-awareness-smoke
gh pr create --draft --title "smoke: pr awareness" --body "Temporary, for verifying roost's PR label. Close me."
```

This is an outward-facing action on the user's own repository. Confirm with the user before running it, and close the pull request when Step 5 is done.

- [ ] **Step 2: Verify the four hats by hand**

Run roost in a real terminal in the roost repository and check, writing down what you actually saw:

1. The row for a session in that worktree shows `#N`, in grey while the pull request is a draft.
2. `gh pr ready` on it, wait for the next 30s poll, and the label turns yellow or green and the session moves into `ready for review`.
3. Space peeks and lists the pull request with its state and URL.
4. Typing `#N` filters the roster to that one row; typing a nonexistent `#999999` empties it.
5. Resize the terminal to 60 columns and confirm no labelled row wraps.

- [ ] **Step 3: Verify the gh-unavailable path**

```bash
env PATH=/usr/bin:/bin npx roost
```

Expected: no labels, no `ready for review` group, no startup notice, and peek's line reading `gh is not installed`.

- [ ] **Step 4: Five consecutive clean suite runs**

```bash
for i in 1 2 3 4 5; do npx vitest run 2>&1 | tail -3; done
```

Expected: five identical passes. Past flakes only ever showed up on repeat runs.

- [ ] **Step 5: Close the smoke pull request and delete its branch**

```bash
gh pr close <N> --delete-branch
```

- [ ] **Step 6: Update the audit**

In `docs/audits/2026-07-22-agent-view-parity.md`, flip these rows to ✅ and mark each `verified live`, quoting what was actually observed in Step 2:

- §2 `` `#1234` PR label, coloured by status ``
- §3 `Groups: Pinned, Ready for review, ...` (the ⚠️ becomes ✅)
- §4 `Linked pull requests listed`
- §5 `` `#1234` / URL selects the PR's session `` — noting it is a filter, which is what the page defines it as

Then recount §10b's tally and rewrite its "Pull request awareness" paragraph, and strike item 1 from §11 the way item 2 is struck.

Note under the §2 row that the label is not hyperlinked, and why.

- [ ] **Step 7: Commit**

```bash
git add docs/audits/2026-07-22-agent-view-parity.md
git commit -m "docs: pull request awareness is built, verified live

Recounts the scoreboard. The four rows are flipped on what was actually
seen in a terminal against a real pull request, not on the suite, because
every parity claim in these docs that was unit tested only has been wrong
at least once.

Records the one deliberate shortfall: the label is not an OSC 8 hyperlink,
and peek carries the URL instead."
```

---

## Self-Review

**Spec coverage.** `gh` plumbing and every pure mapping → Task 1. Per-repository keying and the 30s piggyback → Task 2. Row label with its budget → Task 3. `Ready for review` and first-match-wins → Task 4. Peek lines and the failure reason → Task 5. `#N`/URL filter → Task 6. Live verification and the scoreboard → Task 7. The spec's "no OSC 8 hyperlink" appears in Task 3's comment and Task 7's audit note. The spec's testing section is distributed across each task's own tests plus Task 7's five clean runs.

**One spec correction to make in Task 1.** The spec's testing paragraph says "all five statuses"; `prStatus` returns six, because peek needs `failing` and `pending` distinguished in words even though both are yellow. Fix that word in the spec file as part of Task 1's commit.

**Type consistency.** `prs` is an array everywhere, defaulted at the decoration site in Task 2 and guarded with `?? []` at each consumer. `prLabel` returns `null` (not `''`) for none, and every call site tests it for truthiness. `fetchPullRequests` resolves `{prs, reason}` in Task 1 and is destructured as `{prs}` and `.reason` in Task 2. `branchOf` returns `string|null` and Task 2 skips the null. `isOpen` is used in Task 4 only. `mostUrgent` returns `pr|null` and `prColor(null)` falls through to `'gray'`, which never renders because `prText` is null in that case.

**Known unknown.** Tasks 2, 4 and 5 reference the render helpers in `test/app.test.js` and `test/peek.test.js` by placeholder names (`renderApp`, `renderPeek`, `tick`, `seedStatus`). Use whatever those files already define; read the top of each file before writing the test.
