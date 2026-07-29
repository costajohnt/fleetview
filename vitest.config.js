import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    // Agent worktrees live under .claude/worktrees/ and carry their own copy of this suite, which
    // the default include glob happily collects — so a run could pass or fail on a stale copy of a
    // test file nobody is editing. Only ever run the tests in this checkout.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
    env: {
      // Selection is a background highlight now — tests that assert it need the ANSI codes CI
      // otherwise strips. Files that match on plain text keep their stripAnsi wrappers.
      FORCE_COLOR: '3',
    },
  },
})
