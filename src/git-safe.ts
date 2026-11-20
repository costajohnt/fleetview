// Every git and gh call fleetview makes runs against a directory the opencode server named, and that
// server may be unauthenticated (an adopted passwordless server) — so the `.git/config` in that
// directory is attacker-controlled input rather than the user's own. Git reads repository-local config on every invocation and several of
// its keys name commands it will execute. Verified live against git 2.39.5 by arming each candidate
// in a scratch repository and running fleetview's exact command set: a repository-local
// `core.fsmonitor` executes on both `status` and `rev-parse`, and a `post-index-change` hook sitting
// in the repository's own `.git/hooks` executes on `status` with no config entry at all. That is
// arbitrary code execution on a 30s poll tick, reached without the user typing anything.
//
// `GIT_CONFIG_NOSYSTEM` does not close this. It suppresses /etc/gitconfig, and the vector is the
// repository's own config, which it does not touch — confirmed: the payload still ran with it set.
// Command-line `-c` is what outranks repository-local config, so that is what this uses.
import { execFileSync } from 'node:child_process'

// Only the keys that actually fire on the read-only commands fleetview runs, each one confirmed
// rather than assumed. `core.sshCommand` and `credential.helper` are deliberately absent HERE:
// neither fires on these commands, and overriding them would clobber the legitimate global settings
// a user needs to reach their own remotes — the same reason `GIT_CONFIG_GLOBAL=/dev/null` is not
// used. They ARE cleared on the gh path (GH_ONLY_OVERRIDES below), where that proof does not reach.
// Aliases are absent too, because a repository-local alias cannot shadow a builtin, and `status`,
// `rev-parse` and `rev-list` are all builtins.
const OVERRIDES = [
  ['core.fsmonitor', ''], // executes on status and rev-parse
  // Not a directory, so no hook is ever found under it. This one has to point somewhere rather than
  // be cleared, because the danger is not only a hostile `core.hooksPath` — the repository's own
  // `.git/hooks` is reached with no config entry at all, and only redirecting the path escapes it.
  ['core.hooksPath', '/dev/null'],
  ['core.pager', 'cat'], // only reachable when stdout is a tty, which ours never is, but free to close
]

// For git calls whose argv fleetview builds itself. `-c` beats repository-local config, and git
// re-exports these to any git subprocess of its own, so a submodule is covered too.
export const GIT_SAFE_ARGS = OVERRIDES.flatMap(([key, value]) => ['-c', `${key}=${value}`])

// #181: a filter driver named by an in-tree `.gitattributes` runs its `clean`, `smudge` or `process`
// command on `status` and on the checkout `worktree add` does, and the driver name is the
// attacker's choice, so no fixed list can cover it. `git config --get-regexp` only reads config
// (verified: it runs nothing), so every driver a repository-scope config defines is listed and
// blanked by name; an empty command is git's "no filter". `required=false` too, or a blanked
// required driver makes git die rather than pass the file through. Global and system drivers are
// left alone: they are the user's own (git-lfs), and blanking them would check LFS files out as
// pointers. Throws when the config cannot be read, so callers fail closed.
export function gitFilterOverrides(dir: string, run = execFileSync) {
  let out = ''
  try {
    out = run('git', [...GIT_SAFE_ARGS, '-C', dir, 'config', '--show-scope', '--name-only', '--get-regexp', '^filter\\.'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch (err) {
    if ((err as { status?: number }).status !== 1) throw err // 1 is "no filter keys", anything else is unknown
  }
  const drivers = new Set<string>()
  for (const line of out.split('\n')) {
    const [scope, key] = line.split('\t')
    if (!key || scope === 'global' || scope === 'system') continue
    const driver = key.slice('filter.'.length, key.lastIndexOf('.'))
    if (!driver) continue // `filter.<var>` with no subsection names no driver
    // `-c` splits at the first `=`, so a driver named `a=b` cannot be overridden: refuse it outright.
    if (driver.includes('=')) throw new Error(`unoverridable git filter driver name: ${driver}`)
    drivers.add(driver)
  }
  return [...drivers].flatMap((d) => ['clean', 'smudge', 'process', 'required'].flatMap((v) => ['-c', `filter.${d}.${v}=${v === 'required' ? 'false' : ''}`]))
}

// gh-path-only additions to the list above. The denylist's safety argument ("neither key fires on
// status/rev-parse/rev-list") was proven for fleetview's own commands, but gh's internal git
// subprocess set is unenumerable — so on that path both keys are cleared outright. gh authenticates
// with its own token over its own HTTP client, so clearing them costs gh nothing; they stay out of
// GIT_SAFE_ARGS because fleetview's own git commands must not clobber the global helpers a user
// needs to reach their own remotes.
const GH_ONLY_OVERRIDES = [
  ['credential.helper', ''],
  ['core.sshCommand', ''],
]

// For `gh`, which spawns git subprocesses whose argv fleetview never sees and cannot add `-c` to.
// GIT_CONFIG_PARAMETERS is the environment form of `-c` — space-separated, each pair single-quoted —
// and git applies it to every invocation that inherits the environment, however deep in the process
// tree. Verified two processes down, and verified `gh pr list` still returns its normal JSON with it
// set, so this hardens gh without changing what it answers.
const GIT_CONFIG_PARAMETERS = [...OVERRIDES, ...GH_ONLY_OVERRIDES].map(([key, value]) => `'${key}=${value}'`).join(' ')

// Appended rather than assigned: a user who sets GIT_CONFIG_PARAMETERS themselves keeps whatever
// else is in it, and git resolves duplicate keys last-one-wins, so ours still outrank theirs.
export const gitSafeEnv = (env = process.env) => ({
  ...env,
  GIT_CONFIG_PARAMETERS: env.GIT_CONFIG_PARAMETERS
    ? `${env.GIT_CONFIG_PARAMETERS} ${GIT_CONFIG_PARAMETERS}`
    : GIT_CONFIG_PARAMETERS,
})
