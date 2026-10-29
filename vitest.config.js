import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    // Agent worktrees live under .claude/worktrees/ and carry their own copy of this suite, which
    // the default include glob happily collects — so a run could pass or fail on a stale copy of a
    // test file nobody is editing. Only ever run the tests in this checkout.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
    // Above test/helpers.ts waitFor's 15s ceiling. Under vitest's 5s default a slow wait killed the
    // test instead of failing the wait, and the abandoned body kept rendering into the next test.
    testTimeout: 20000,
    env: {
      // Selection is a background highlight now — tests that assert it need the ANSI codes CI
      // otherwise strips. Files that match on plain text keep their stripAnsi wrappers.
      FORCE_COLOR: '3',
      // Anything that writes state during a test (the #128 dispatch-debug log, seen.json) lands in
      // a per-run temp dir, not the developer's real ~/.local/state/fleetview — where every test
      // run was appending a fabricated collision row to the very log #128 is waiting on.
      FLEETVIEW_STATE_DIR: mkdtempSync(join(tmpdir(), 'fleetview-test-state-')),
      // Same for config (roster.json, server.json, backend run logs): a test that reaches a default
      // path must not read or write the developer's real ~/.config/fleetview.
      FLEETVIEW_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'fleetview-test-config-')),
    },
  },
})
