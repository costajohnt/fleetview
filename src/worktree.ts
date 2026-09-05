// Worktree isolation, agent view's rule: "Background sessions move into an isolated git worktree
// before editing files." Without it, dispatching three sessions into one repository means three
// agents editing the same working copy — which is the whole point of a roster that runs many
// sessions at once, and the reason this is not optional.
//
// opencode does the git work: POST /experimental/worktree makes a real worktree on a branch named
// `opencode/<name>`, under ~/.local/share/opencode/worktree/<repo-hash>/<name>. What it does NOT do
// is protect anything on the way out — DELETE removes a worktree holding uncommitted changes, and
// its branch, without complaint (verified by losing a file to it). So the refusal rules live here.
import { execFileSync } from 'node:child_process'
import { statSync, appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { GIT_SAFE_ARGS } from './git-safe.ts'
import { fleetviewDir } from './paths.ts'
import type { Project } from './types.ts'

// A project row from GET /project carries `sandboxes`: the worktree directories opencode has made
// for it. That is the whole parent↔worktree mapping, already maintained by the server, so fleetview
// keeps no bookkeeping of its own and stays correct across restarts and across other clients.
export function sandboxParents(projects: Project[] = []) {
  const parents = new Map<string, string>()
  for (const p of projects) {
    for (const dir of p.sandboxes ?? []) parents.set(dir, p.worktree)
  }
  return parents
}

// Sandbox classification is sticky for the life of the process (#22). The project list keeps a
// vanished project (repoll unions in what's fresh and never drops, so an OFFLINE repository keeps
// its rows), but a worktree deleted with `^x^x` also leaves its repository's `sandboxes` — so a
// parent map rebuilt from fresh data alone stops calling that stale record a sandbox and promotes
// it to a plain repo: an empty browse group, an `@name repo` completion, and a dispatch target
// pointing at a directory that no longer exists. Once seen as a sandbox, always a sandbox; the
// record then leaves browse, `@repo` and dispatch candidates by the same worktree filter that
// already keeps live worktrees out of them.
export function rememberSandboxes(sticky: Map<string, string>, projects: Project[] = []) {
  for (const [dir, parent] of sandboxParents(projects)) sticky.set(dir, parent)
  return sticky
}

// opencode publishes a synthetic `global` project whose worktree is the filesystem root (#25). It is
// not a repository anyone chose: as a browse group it renders as a bare `/`, and as a dispatch
// candidate it would run a session against `/`. Its sessions still stream like any other directory's.
export const isRootProject = (p: Project) => p.worktree === '/' || p.id === 'global'

// Every directory fleetview has to talk to: the projects opencode lists, plus each worktree named in a
// project's `sandboxes`. The two are not the same set — a worktree is not reliably published as a
// project row of its own, and verified live: a repository listed its sandbox while the sandbox
// itself was absent from GET /project, so anything iterating the project list alone could not see
// the session running in it. Streaming and listing both key off this instead.
export function allProjectDirectories(projects: Project[] = []) {
  const seen = new Set<string>()
  const out: Project[] = []
  const add = (worktree: string, row: Project) => {
    if (!worktree || seen.has(worktree)) return
    seen.add(worktree)
    out.push(row)
  }
  for (const p of projects) add(p.worktree, p)
  for (const p of projects) {
    // Synthetic rows for sandboxes opencode hasn't published. `vcs: 'git'` because a worktree
    // always is one, and `sandboxes: []` because worktrees don't nest.
    for (const dir of p.sandboxes ?? []) add(dir, { id: `sandbox:${dir}`, worktree: dir, vcs: 'git', sandboxes: [], time: p.time })
  }
  return out
}

// Where a session's rows and headers should say it lives. A worktree is an implementation detail of
// running the session safely, not a place the user chose, so it is always displayed as its repo.
export const displayProject = (parents: Map<string, string>, projectKey: string) =>
  parents.get(projectKey) ?? projectKey

export const isSandbox = (parents: Map<string, string>, projectKey: string) => parents.has(projectKey)

// Agent view skips isolation when the session is "already inside a linked git worktree" or the
// directory is "not a git repository". Both are cases where making another worktree is either
// redundant or impossible.
//
// `gitKind` exists because the project list is not enough on its own. opencode only knows a
// directory once something has run there, so the *first* dispatch into a repository — the moment
// isolation matters most, because nothing has been isolated yet — asks about a project that is
// not in the list. Falling back to looking at the directory answers it correctly.
export function shouldIsolate(projectKey: string, projects: Project[] = [], parents = sandboxParents(projects), gitKind = gitKindOf) {
  if (isSandbox(parents, projectKey)) return false // already isolated
  const project = projects.find((p) => p.worktree === projectKey)
  // `vcs` is absent (rather than 'git') for a directory opencode tracks that isn't a repository.
  if (project) return project.vcs === 'git' && gitKind(projectKey) !== 'worktree'
  return gitKind(projectKey) === 'repo'
}

// 'repo' | 'worktree' | null. A linked worktree's `.git` is a file holding a `gitdir:` pointer,
// where a normal repository's is a directory — which is how "already inside a linked git worktree"
// is recognised for a directory opencode has never listed, including one the user made themselves
// with `git worktree add` and then dispatched into.
export function gitKindOf(dir: string, statImpl = statSync) {
  try {
    return statImpl(join(dir, '.git')).isDirectory() ? 'repo' : 'worktree'
  } catch {
    return null
  }
}

// Worktree names become branch names and directory names, so they have to survive both. The prompt
// is the only thing available at dispatch time that means anything to a human — the session doesn't
// exist yet and opencode hasn't named it.
export function worktreeName(prompt: string, existing: string[] = []) {
  const base =
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32)
      .replace(/-+$/, '') || 'session'
  const taken = new Set(existing.map((dir) => dir.slice(dir.lastIndexOf('/') + 1)))
  if (!taken.has(base)) return base
  // Collisions are ordinary: "fix the tests" twice in a day is not a mistake worth reporting.
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

// #128 instrumentation: a dispatch got a collision-suffixed worktree name even though the user
// says the prompts were different — which means worktreeName received text slugging identical to
// an existing worktree, and nobody can tell after the fact WHAT text that was. Append the evidence
// (prompt, chosen name, taken slots) to a local NDJSON file so the next occurrence self-documents.
// Best-effort by design: a debug log must never cost anyone their dispatch.
export function logNameCollision(entry: { prompt: string; name: string; existing: string[] }) {
  try {
    const dir = (process.env.FLEETVIEW_STATE_DIR ?? process.env.ROOST_STATE_DIR) ?? fleetviewDir(join(homedir(), '.local', 'state'))
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    appendFileSync(
      join(dir, 'dispatch-debug.ndjson'),
      // The prompt is capped: this is a lookup key for the bug, not an archive of pasted walls.
      `${JSON.stringify({ ts: new Date().toISOString(), ...entry, prompt: entry.prompt.slice(0, 200) })}\n`,
      { mode: 0o600 },
    )
  } catch {}
}

// Every caller's `dir` is a project or sandbox path the unauthenticated opencode server named, which
// makes its repository-local `.git/config` — and its `.git/hooks` — attacker-controlled. `status`
// runs both a hostile `core.fsmonitor` and a `post-index-change` hook, so the same overrides
// pull-requests.ts uses belong here too; see git-safe.ts.
const git = (dir: string, args: string[], run = execFileSync) =>
  run('git', [...GIT_SAFE_ARGS, '-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

// What `^x^x` is allowed to destroy. Agent view's rules exactly: pressing it twice "removes the
// worktree and uncommitted changes (commit first)", but "neither removes a worktree with unpushed
// commits — it is kept with the session row". So dirt is expendable and commits are not.
//
// `base` is what the commits would be measured against: the branch's upstream when it has one,
// otherwise the parent repository's current branch. With no remote configured, every commit is
// unpushed by the literal reading, which would strand a worktree per session forever in a local-only
// repository — measuring against the parent instead asks the question that actually matters, which
// is whether deleting this branch would lose work that exists nowhere else.
export function worktreeSafety(dir: string, parentDir: string | null | undefined, run = execFileSync) {
  try {
    const dirty = git(dir, ['status', '--porcelain'], run).length > 0
    let base
    try {
      base = git(dir, ['rev-parse', '--abbrev-ref', '@{upstream}'], run)
    } catch {
      base = parentDir ? git(parentDir, ['rev-parse', '--abbrev-ref', 'HEAD'], run) : null
    }
    // No base to compare against is not proof of safety — refuse rather than guess. A parent on a
    // detached HEAD reports the literal `HEAD`, which resolves in the worktree's own context to
    // `HEAD..HEAD` = 0 commits ahead — a confident "safe to delete" for a branch whose commits exist
    // nowhere else. It is a sentinel, not a branch, and branchOf (pull-requests.ts) refuses it too.
    if (!base || base === 'HEAD') return { removable: false, dirty, unpushed: true, reason: 'no branch to compare against' }
    const ahead = Number(git(dir, ['rev-list', '--count', `${base}..HEAD`], run))
    const unpushed = Number.isNaN(ahead) ? true : ahead > 0
    return {
      removable: !unpushed,
      dirty,
      unpushed,
      // Non-numeric output means the count is unknown, so say that rather than "NaN unpushed commits".
      reason: !unpushed ? null : Number.isNaN(ahead) ? 'could not count unpushed commits' : `${ahead} unpushed commit${ahead === 1 ? '' : 's'}`,
    }
  } catch {
    // A worktree git can't read is one fleetview must not delete. Any failure here — the directory is
    // gone, git is missing, the repository is broken — resolves to "leave it alone".
    return { removable: false, dirty: false, unpushed: true, reason: 'could not read the worktree' }
  }
}

// #113.4: the last manual step of dispatch → isolate → complete. The guide ends with "merging back
// is yours", and the two things that step needs — which repository the worktree belongs to and
// which branch the session committed on — are already known here, so the command can be spelled out
// in full instead of leaving the user to reconstruct it.
//
// Shown, never run: a merge can conflict, the parent checkout may have work in it, and neither is
// something a keystroke in a roster should decide. Pure so the wording is testable without a
// repository; the caller supplies the branch lookup.
export function mergeBackCommand(worktree: string, repo: string | null | undefined, branch: string | null | undefined) {
  if (!repo || !branch || repo === worktree) return null
  // Both halves are quoted: paths carry spaces, and branch names may legally carry `$`, backticks,
  // `;`, `&`, `|` and quotes (check-ref-format bans only space, ~^:?*[\ and control characters) —
  // and the branch is whatever the session checked out, so this copy-paste line must not trust it.
  const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`
  return `git -C ${sq(repo)} merge ${sq(branch)}`
}

