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

// Only the keys that actually fire on the read-only commands fleetview runs, each one confirmed
// rather than assumed. `core.sshCommand` and `credential.helper` are deliberately absent: neither
// fires on these commands, and overriding them would clobber the legitimate global settings a user
// needs to reach their own remotes — the same reason `GIT_CONFIG_GLOBAL=/dev/null` is not used here.
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

// For `gh`, which spawns git subprocesses whose argv fleetview never sees and cannot add `-c` to.
// GIT_CONFIG_PARAMETERS is the environment form of `-c` — space-separated, each pair single-quoted —
// and git applies it to every invocation that inherits the environment, however deep in the process
// tree. Verified two processes down, and verified `gh pr list` still returns its normal JSON with it
// set, so this hardens gh without changing what it answers.
const GIT_CONFIG_PARAMETERS = OVERRIDES.map(([key, value]) => `'${key}=${value}'`).join(' ')

// Appended rather than assigned: a user who sets GIT_CONFIG_PARAMETERS themselves keeps whatever
// else is in it, and git resolves duplicate keys last-one-wins, so ours still outrank theirs.
export const gitSafeEnv = (env = process.env) => ({
  ...env,
  GIT_CONFIG_PARAMETERS: env.GIT_CONFIG_PARAMETERS
    ? `${env.GIT_CONFIG_PARAMETERS} ${GIT_CONFIG_PARAMETERS}`
    : GIT_CONFIG_PARAMETERS,
})
