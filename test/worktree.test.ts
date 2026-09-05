import { test, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  sandboxParents,
  rememberSandboxes,
  isRootProject,
  displayProject,
  isSandbox,
  mergeBackCommand,
  shouldIsolate,
  worktreeName,
  logNameCollision,
  worktreeSafety,
  gitKindOf,
} from '../src/worktree.ts'

// The shape GET /project really returns — verified live against opencode 1.18.4, where creating a
// worktree for a repo added its directory to that repo's `sandboxes` array and also published the
// worktree as a project of its own.
const projects = [
  { id: 'p1', worktree: '/repo/alpha', vcs: 'git', sandboxes: ['/wt/alpha/one', '/wt/alpha/two'] },
  { id: 'p2', worktree: '/wt/alpha/one', vcs: 'git', sandboxes: [] },
  { id: 'p3', worktree: '/repo/beta', vcs: 'git', sandboxes: [] },
  { id: 'p4', worktree: '/notes', sandboxes: [] }, // no vcs: not a git repository
]

test('sandboxParents maps every worktree back to the repository that owns it', () => {
  const parents = sandboxParents(projects)
  expect(parents.get('/wt/alpha/one')).toBe('/repo/alpha')
  expect(parents.get('/wt/alpha/two')).toBe('/repo/alpha')
  expect(parents.has('/repo/alpha')).toBe(false)
})

test('sandboxParents tolerates a project row with no sandboxes field', () => {
  expect(sandboxParents([{ worktree: '/repo/x' }]).size).toBe(0)
  expect(sandboxParents().size).toBe(0)
})

// #22: the listing that drops a deleted worktree also drops it from its repository's `sandboxes`,
// while the stale project record survives the merge. Without stickiness it would be reclassified as
// a plain repo — a browse group and a dispatch target for a directory that no longer exists.
test('rememberSandboxes keeps a directory classified as a sandbox after a later listing omits it', () => {
  const sticky = new Map<string, string>()
  rememberSandboxes(sticky, projects)
  const afterDelete = [
    { id: 'p1', worktree: '/repo/alpha', vcs: 'git', sandboxes: ['/wt/alpha/two'] }, // one was deleted
    { id: 'p2', worktree: '/wt/alpha/one', vcs: 'git', sandboxes: [] }, // its record lives on
  ]
  const parents = rememberSandboxes(sticky, afterDelete)
  expect(isSandbox(parents, '/wt/alpha/one')).toBe(true)
  expect(displayProject(parents, '/wt/alpha/one')).toBe('/repo/alpha')
  expect(sandboxParents(afterDelete).has('/wt/alpha/one')).toBe(false) // fresh-only is what leaked
})

// #25: opencode's synthetic global project. Not a repository anyone chose.
test('isRootProject matches the synthetic global project and nothing else', () => {
  expect(isRootProject({ id: 'global', worktree: '/' })).toBe(true)
  expect(isRootProject({ id: 'p1', worktree: '/repo/alpha' })).toBe(false)
})

// A worktree is machinery, not a place the user picked, so rows and headers name the repository.
test('displayProject reports a worktree as its repository, and leaves a plain project alone', () => {
  const parents = sandboxParents(projects)
  expect(displayProject(parents, '/wt/alpha/one')).toBe('/repo/alpha')
  expect(displayProject(parents, '/repo/beta')).toBe('/repo/beta')
  expect(isSandbox(parents, '/wt/alpha/two')).toBe(true)
  expect(isSandbox(parents, '/repo/beta')).toBe(false)
})

test('shouldIsolate: a git repository yes, an existing worktree no, a non-repository no', () => {
  const asRepo = () => 'repo' as const
  expect(shouldIsolate('/repo/alpha', projects, undefined, asRepo)).toBe(true)
  expect(shouldIsolate('/wt/alpha/one', projects, undefined, asRepo)).toBe(false) // already isolated
  expect(shouldIsolate('/notes', projects, undefined, asRepo)).toBe(false) // not a git repository
})

// opencode only lists a directory once something has run there, so the first dispatch into a
// repository asks about a project that is not in the list — and that is precisely the dispatch that
// must be isolated, because nothing has been isolated yet.
test('shouldIsolate: a repository opencode has never listed is still isolated', () => {
  expect(shouldIsolate('/brand/new', projects, undefined, () => 'repo')).toBe(true)
  expect(shouldIsolate('/brand/new', projects, undefined, () => null)).toBe(false) // not a repository
  expect(shouldIsolate('/brand/new', projects, undefined, () => 'worktree')).toBe(false)
})

// "Skips the worktree when the session is already inside a linked git worktree" — including one the
// user made themselves with `git worktree add` and dispatched into, which opencode never listed as
// a sandbox of anything.
test('shouldIsolate: a hand-made linked worktree is left alone', () => {
  const listed = [{ worktree: '/hand/made', vcs: 'git', sandboxes: [] }]
  expect(shouldIsolate('/hand/made', listed, undefined, () => 'worktree')).toBe(false)
})

test('gitKindOf tells a repository from a linked worktree by what .git is', () => {
  const repo = makeRepo()
  const wt = makeWorktree(repo, 'kind')
  expect(gitKindOf(repo.dir)).toBe('repo')
  expect(gitKindOf(wt)).toBe('worktree')
  expect(gitKindOf('/nonexistent')).toBe(null)
})

test('worktreeName slugs the prompt and never collides with an existing directory', () => {
  expect(worktreeName('Fix the flaky tests!')).toBe('fix-the-flaky-tests')
  expect(worktreeName('  ')).toBe('session')
  expect(worktreeName('***')).toBe('session')
  expect(worktreeName('fix tests', ['/wt/x/fix-tests'])).toBe('fix-tests-2')
  expect(worktreeName('fix tests', ['/wt/x/fix-tests', '/wt/x/fix-tests-2'])).toBe('fix-tests-3')
  // long prompts are cut without leaving a trailing dash on the branch name
  expect(worktreeName('a'.repeat(50)).length).toBe(32)
  expect(worktreeName('some words that run right up to the cut here').endsWith('-')).toBe(false)
})

// #128: two genuinely different prompts must never share a name — pins the behavior the bug report
// disputes, and documents the one legitimate suffix case: prompts identical through the 32-char cut.
test('worktreeName: distinct prompts get distinct names; only a shared 32-char prefix collides', () => {
  const existing = ['/wt/x/find-some-jira-cards-to-work-on']
  expect(worktreeName('review the open pull requests', existing)).toBe('review-the-open-pull-requests')
  // Same first 32 chars, different tails — this suffix is the false-positive path, not the bug.
  expect(worktreeName('find some jira cards to work on today', existing)).toBe('find-some-jira-cards-to-work-on-2')
})

test('logNameCollision appends an NDJSON line with the prompt capped, and never throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleetview-dbg-'))
  const prev = process.env.FLEETVIEW_STATE_DIR
  process.env.FLEETVIEW_STATE_DIR = dir
  try {
    logNameCollision({ prompt: 'p'.repeat(500), name: 'fix-tests-2', existing: ['/wt/x/fix-tests'] })
    const lines = readFileSync(join(dir, 'dispatch-debug.ndjson'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const entry = JSON.parse(lines[0])
    expect(entry.name).toBe('fix-tests-2')
    expect(entry.existing).toEqual(['/wt/x/fix-tests'])
    expect(entry.prompt).toHaveLength(200)
    expect(typeof entry.ts).toBe('string')
    // best-effort contract: an unwritable dir must not throw into the dispatch path
    process.env.FLEETVIEW_STATE_DIR = '/dev/null/nope'
    expect(() => logNameCollision({ prompt: 'x', name: 'y', existing: [] })).not.toThrow()
  } finally {
    if (prev === undefined) delete process.env.FLEETVIEW_STATE_DIR
    else process.env.FLEETVIEW_STATE_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- the refusal rules, against real git repositories ---

const repos: string[] = []
const makeRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleetview-wt-'))
  repos.push(dir)
  const g = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@t')
  g('config', 'user.name', 't')
  writeFileSync(join(dir, 'a.txt'), 'hello\n')
  g('add', '-A')
  g('commit', '-qm', 'init')
  return { dir, g }
}
// Inside a fresh mkdtemp rather than a predictable path under the temp root: a leftover directory
// from an earlier run makes `git worktree add` fail, which reads as a broken assertion rather than
// the collision it is.
const makeWorktree = (repo: any, name: string) => {
  const dir = join(mkdtempSync(join(tmpdir(), 'fleetview-wt-parent-')), name)
  repos.push(dir)
  repo.g('worktree', 'add', '-q', '-b', `opencode/${name}`, dir)
  return dir
}
process.on('exit', () => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true })
})

test('a clean worktree with no commits of its own is removable', () => {
  const repo = makeRepo()
  const wt = makeWorktree(repo, 'clean')
  expect(worktreeSafety(wt, repo.dir)).toMatchObject({ removable: true, dirty: false, unpushed: false })
})

// Agent view: "Ctrl+X twice removes the worktree and uncommitted changes (commit first)." Dirt is
// expendable — it is committed work that is protected.
test('uncommitted changes alone do not stop removal, but are reported', () => {
  const repo = makeRepo()
  const wt = makeWorktree(repo, 'dirty')
  writeFileSync(join(wt, 'a.txt'), 'changed\n')
  expect(worktreeSafety(wt, repo.dir)).toMatchObject({ removable: true, dirty: true, unpushed: false })
})

// Agent view: "Neither removes a worktree with unpushed commits — it is kept with the session row."
test('a commit that exists nowhere else makes the worktree un-removable', () => {
  const repo = makeRepo()
  const wt = makeWorktree(repo, 'work')
  writeFileSync(join(wt, 'b.txt'), 'work\n')
  execFileSync('git', ['-C', wt, 'add', '-A'], { stdio: 'ignore' })
  execFileSync('git', ['-C', wt, 'commit', '-qm', 'real work'], { stdio: 'ignore' })
  const safety = worktreeSafety(wt, repo.dir)
  expect(safety).toMatchObject({ removable: false, unpushed: true })
  expect(safety.reason).toBe('1 unpushed commit')
})

test('a worktree git cannot read is never removable', () => {
  expect(worktreeSafety('/nonexistent/worktree', '/nonexistent/repo')).toMatchObject({
    removable: false,
    reason: 'could not read the worktree',
  })
})

// With no parent to measure against there is no way to tell a shared commit from a lost one, so the
// answer has to be "leave it alone" rather than a guess in either direction.
test('with no upstream and no parent directory, removal is refused rather than guessed', () => {
  const repo = makeRepo()
  const wt = makeWorktree(repo, 'nobase')
  expect(worktreeSafety(wt, null)).toMatchObject({ removable: false, reason: 'no branch to compare against' })
})

// A parent on a detached HEAD reports the literal `HEAD` from `rev-parse --abbrev-ref HEAD`, which
// resolves in the worktree's own context to `HEAD..HEAD` — zero commits ahead, and a confident
// "safe to delete" for commits that exist nowhere else.
test('a parent on a detached HEAD is not a base, so real commits are not approved for deletion', () => {
  const repo = makeRepo()
  const wt = makeWorktree(repo, 'detached')
  execFileSync('git', ['-C', repo.dir, 'checkout', '-q', '--detach', 'HEAD'], { stdio: 'ignore' })
  writeFileSync(join(wt, 'b.txt'), 'work\n')
  execFileSync('git', ['-C', wt, 'add', '-A'], { stdio: 'ignore' })
  execFileSync('git', ['-C', wt, 'commit', '-qm', 'real work'], { stdio: 'ignore' })
  expect(worktreeSafety(wt, repo.dir)).toMatchObject({ removable: false, unpushed: true, reason: 'no branch to compare against' })
})

// --- issue #71: `dir` and `parentDir` are paths the unauthenticated opencode server named, so the
// `.git/config` and `.git/hooks` under them are attacker-controlled. The issue only named
// pull-requests.ts, but `worktreeSafety` runs `status`/`rev-parse`/`rev-list` on the same class of
// path, on the same poll — the vector is identical.

test('worktreeSafety passes git the overrides that outrank a hostile repo config', () => {
  const seen: any[] = []
  worktreeSafety('/wt', '/repo', ((cmd: any, args: any) => { seen.push(args); return '' }) as any)
  for (const args of seen) {
    // Ahead of `-C`, so git reads them as settings rather than subcommand arguments.
    expect(args.indexOf('-c')).toBeLessThan(args.indexOf('-C'))
    const flags = args.filter((_: any, i: number) => args[i - 1] === '-c')
    expect(flags).toContain('core.fsmonitor=')
    expect(flags).toContain('core.hooksPath=/dev/null')
    expect(flags).toContain('core.pager=cat')
  }
  expect(seen.length).toBeGreaterThan(0)
})

// The assertions above only prove the flags are passed. This proves they work: a repository armed
// exactly as an attacker would arm it, run through the real code path with the real execFileSync.
test('a repo whose config and hooks try to run commands cannot run them through worktreeSafety', () => {
  const repo = makeRepo()
  const wt = makeWorktree(repo, 'hostile')
  const marker = join(wt, 'PWNED')
  // `core.fsmonitor` is invoked by `status` and `rev-parse`; `post-index-change` is invoked by
  // `status` from the repository's own hooks directory, needing no config entry to be reached.
  execFileSync('git', ['-C', wt, 'config', 'core.fsmonitor', `touch ${marker}; false`], { stdio: 'ignore' })
  // A linked worktree's `.git` is a file, and its hooks resolve to the common directory — the parent
  // repository's `.git/hooks`, which is exactly what an attacker supplying the parent would control.
  const hooks = join(repo.dir, '.git', 'hooks')
  mkdirSync(hooks, { recursive: true })
  writeFileSync(join(hooks, 'post-index-change'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 })

  const safety = worktreeSafety(wt, repo.dir)
  expect(existsSync(marker)).toBe(false)
  // And the answer is still the right one — hardening must not cost the refusal rules their meaning.
  expect(safety).toMatchObject({ removable: true, dirty: false, unpushed: false })
})

// --- #113.4: the merge-back command line ---

test('mergeBackCommand names the parent repository and the session branch', () => {
  expect(mergeBackCommand('/wt/one', '/x/repo', 'opencode/fix-tests')).toBe("git -C '/x/repo' merge 'opencode/fix-tests'")
  expect(mergeBackCommand('/wt/one', '/My Projects/ui', 'feat')).toBe("git -C '/My Projects/ui' merge 'feat'")
  expect(mergeBackCommand('/wt/one', "/Users/o'malley/proj", 'main')).toBe("git -C '/Users/o'\\''malley/proj' merge 'main'")
  // A branch name is whatever the session checked out; metachars are legal refname characters.
  expect(mergeBackCommand('/wt/one', '/x/repo', 'x;echo pwned`id`')).toBe("git -C '/x/repo' merge 'x;echo pwned`id`'")
})

test('mergeBackCommand yields nothing when there is nothing to merge back', () => {
  expect(mergeBackCommand('/wt/one', null, 'opencode/fix')).toBe(null) // not isolated: no parent repo
  expect(mergeBackCommand('/wt/one', '/x/repo', null)).toBe(null) // detached HEAD or no git
  // an unisolated session works IN the repository, so there is no branch to merge into it
  expect(mergeBackCommand('/x/repo', '/x/repo', 'main')).toBe(null)
})
