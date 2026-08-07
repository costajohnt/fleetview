import { test, expect } from 'vitest'
import { GIT_SAFE_ARGS, gitSafeEnv } from '../src/git-safe.ts'

// The exact strings matter: GIT_CONFIG_PARAMETERS is parsed by git as space-separated single-quoted
// pairs, and `-c` overrides only outrank repository-local config when the key names match verbatim.
// These are contract assertions, not shape checks — a typo'd key silently stops protecting.

test('GIT_SAFE_ARGS carries each override as its own -c pair', () => {
  expect(GIT_SAFE_ARGS).toEqual([
    '-c', 'core.fsmonitor=',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.pager=cat',
  ])
})

test('gitSafeEnv encodes the overrides single-quoted and space-separated', () => {
  const env = gitSafeEnv({})
  expect(env.GIT_CONFIG_PARAMETERS).toBe("'core.fsmonitor=' 'core.hooksPath=/dev/null' 'core.pager=cat'")
})

// Appended, not assigned: the user's own parameters survive in front, ours land last so git's
// last-one-wins duplicate resolution keeps ours in force. A space INSIDE the user's quoted value
// must not be mistaken for a pair separator — the quoting is what makes the append safe.
test('gitSafeEnv appends after an existing value, preserving a space-containing override', () => {
  const env: Record<string, string | undefined> = gitSafeEnv({ GIT_CONFIG_PARAMETERS: "'user.name=John Costa'", PATH: '/usr/bin' })
  expect(env.GIT_CONFIG_PARAMETERS).toBe(
    "'user.name=John Costa' 'core.fsmonitor=' 'core.hooksPath=/dev/null' 'core.pager=cat'",
  )
  expect(env.PATH).toBe('/usr/bin') // the rest of the env passes through
})
