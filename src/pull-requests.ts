// Pull request awareness, agent view's rule: "When a session opens a pull request, a `#1234` label
// appears at the right edge of the row." Agent view links a pull request two ways — by watching the
// session's own `gh` command output, and because "pushing to a branch that has an open pull request
// links it by looking up that branch with `gh pr view`". fleetview does the second only: sessions run in
// worktrees on branches named `opencode/<slug>`, so the branch is already a unique key, and reading
// it costs one local git call instead of a parser against `gh`'s unspecified human output.
//
// Everything here is either pure or takes its runner as an argument, so the tests never reach the
// network and never need a real repository.
import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { GIT_SAFE_ARGS, gitSafeEnv } from './git-safe.ts'
import { theme } from './ui/theme.ts'
import type { PullRequest, PrStatus } from './types.ts'

// One row of `statusCheckRollup`: heterogeneous by design (see below), so every field is optional.
type CheckRow = { conclusion?: string; status?: string; state?: string }

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

const checkFailed = (c: CheckRow) =>
  FAILED_CONCLUSIONS.has(c?.conclusion ?? '') || FAILED_STATES.has(c?.state ?? '')

const checkPending = (c: CheckRow) =>
  (c?.status !== undefined && c.status !== 'COMPLETED') || c?.state === 'PENDING' || c?.state === 'EXPECTED'

// The status behind the colour. Kept finer-grained than the colour itself because peek says in
// words what the row can only say in colour, and "checks failed" and "waiting on checks" are the
// same yellow but very different news.
export function prStatus(pr: PullRequest): PrStatus {
  if (pr?.state === 'MERGED') return 'merged'
  if (pr?.state === 'CLOSED') return 'closed'
  if (pr?.isDraft) return 'draft'
  const checks: CheckRow[] = Array.isArray(pr?.statusCheckRollup) ? pr.statusCheckRollup : []
  if (checks.some(checkFailed)) return 'failing'
  if (checks.some(checkPending)) return 'pending'
  if (BLOCKING_REVIEW.has(pr?.reviewDecision ?? '')) return 'pending'
  // No checks configured is not the same as checks outstanding: there is nothing left to wait for.
  return 'passing'
}

// Agent view's table exactly: yellow waiting on checks or review or checks failed, green when checks
// passed and no review is blocking, purple merged, grey draft or closed. There is deliberately no
// red — a failing pull request is something to look at, not a failed session.
export const prColor = (pr: PullRequest) => theme.pr[prStatus(pr)] ?? theme.muted

// Whether any of a session's pull requests is still live, which is what decides that the row
// survives the completed fold. Deliberately NOT the same test as "ready for review": `gh pr list
// --state all` means this array routinely holds MERGED and CLOSED entries, so a non-empty check
// would pin a session whose pull request merged weeks ago to the screen forever while folding away
// one that is still in flight. Drafts count — gh reports `state: 'OPEN'` for a draft with `isDraft`
// as a separate field, and a draft is live work even though nobody can review it yet.
export const hasOpenPr = (prs: PullRequest[] = []) => prs.some((pr) => pr?.state === 'OPEN')

// The pull requests worth a row badge: open ones (the reason the session is kept on screen) plus
// merged (agent view still colours those purple). A closed pull request is not worth a badge.
const badgeablePrs = (prs: PullRequest[] = []) => prs.filter((pr) => pr?.state === 'OPEN' || pr?.state === 'MERGED')

// Lower = more urgent. The row can only show one colour, so it shows the one most needing attention,
// exactly agent view's rule ("coloured by the one most needing attention").
const PR_URGENCY: Record<PrStatus, number> = { failing: 0, pending: 1, passing: 2, merged: 3, draft: 4, closed: 5 }

// The pull request whose colour the row shows, or null when the session has none worth a badge.
export const mostUrgentPr = (prs: PullRequest[] = []) => {
  const badgeable = badgeablePrs(prs)
  if (badgeable.length === 0) return null
  return badgeable.reduce((a, b) => (PR_URGENCY[prStatus(a)] <= PR_URGENCY[prStatus(b)] ? a : b))
}

// The right-edge label agent view puts on a row with a pull request: `#1234` for one, `N PRs` for
// several. Null when there is nothing to badge, so the row math can skip it entirely.
export const prLabel = (prs: PullRequest[] = []) => {
  const badgeable = badgeablePrs(prs)
  if (badgeable.length === 0) return null
  return badgeable.length === 1 ? `#${badgeable[0].number}` : `${badgeable.length} PRs`
}

// One `gh` call per repository answers every session in it, which is the whole reason this is
// affordable: keying on the branch means the map built here is looked up per row for free.
export function byBranch(prs: PullRequest[] = []) {
  const map = new Map<string, PullRequest[]>()
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
function reasonFor(err: NodeJS.ErrnoException & { stderr?: unknown }, dir: string) {
  // ENOENT is ambiguous: `execFile` throws it both when the `gh` binary is missing AND when `cwd`
  // does not exist. opencode keeps listing worktrees after their directories are cleaned up, so the
  // gone-directory case is the common one, and reporting "gh is not installed" for it is a lie that
  // sends a user with a working gh chasing a non-problem. A vanished directory has no reason worth a
  // peek line at all — it simply has no pull requests — so only claim gh is missing when the
  // directory is actually there. Verified live 2026-07-23: 7 stale worktrees all mislabelled this way.
  if (err?.code === 'ENOENT') return existsSync(dir) ? 'gh is not installed' : null
  const stderr = String(err?.stderr ?? '')
  if (/not logged into|authentication|gh auth login/i.test(stderr)) return 'gh is not authenticated'
  if (/no git remotes|none of the git remotes|not a git repository/i.test(stderr)) return 'no GitHub remote'
  return 'gh could not list pull requests'
}

// Asynchronous because it is a network round trip on a timer. `branchOf` below stays synchronous
// because it is a local git read measured in milliseconds; blocking the event loop for a network
// call would stutter the roster's animation on every poll tick.
export async function fetchPullRequests(dir: string, run = execFileAsync, env = process.env) {
  let stdout
  try {
    // `cwd` is a directory the unauthenticated opencode server named, so its `.git/config` is
    // hostile input. gh spawns its own git subprocesses, whose argv we cannot add `-c` to, so the
    // overrides travel in the environment instead — see git-safe.ts.
    ;({ stdout } = await run('gh', ['pr', 'list', '--state', 'all', '--limit', LIMIT, '--json', FIELDS], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 15000,
      env: gitSafeEnv(env),
    }))
  } catch (err) {
    return { prs: [], reason: reasonFor(err as NodeJS.ErrnoException, dir) }
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
export function branchOf(dir: string, run = execFileSync) {
  try {
    // `dir` is server-supplied, so its repository-local config is hostile input; `-c` outranks it.
    const branch = run('git', [...GIT_SAFE_ARGS, '-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return branch && branch !== 'HEAD' ? branch : null
  } catch {
    return null
  }
}
