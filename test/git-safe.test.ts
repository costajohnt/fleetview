import { test, expect } from 'vitest'
import { GIT_SAFE_ARGS, gitSafeEnv } from '../src/git-safe.ts'

// The denylist's safety proof ("neither key fires on status/rev-parse/rev-list") covers fleetview's
// own git commands, not gh's unenumerable internal git subprocesses — so the gh path clears
// credential.helper and core.sshCommand outright, while the argv form must keep the user's global
// helpers working for their own remotes.
test('the gh environment clears credential.helper and core.sshCommand; own-git argv does not', () => {
  const params = gitSafeEnv({}).GIT_CONFIG_PARAMETERS
  expect(params).toContain("'credential.helper='")
  expect(params).toContain("'core.sshCommand='")
  expect(params).toContain("'core.fsmonitor='") // the shared denylist rides along on the gh path too
  const argv = GIT_SAFE_ARGS.join(' ')
  expect(argv).not.toContain('credential.helper')
  expect(argv).not.toContain('core.sshCommand')
  expect(argv).toContain('core.fsmonitor=')
})

// Appended, not assigned: a user's own GIT_CONFIG_PARAMETERS survives, and git resolves duplicate
// keys last-one-wins, so fleetview's overrides still outrank theirs.
test('a user-set GIT_CONFIG_PARAMETERS is kept, with the overrides appended after it', () => {
  const params = gitSafeEnv({ GIT_CONFIG_PARAMETERS: "'user.key=x'" }).GIT_CONFIG_PARAMETERS
  expect(params!.startsWith("'user.key=x' ")).toBe(true)
  expect(params).toContain("'credential.helper='")
})
