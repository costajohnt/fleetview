import { readdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'

// vitest.config.js points TMPDIR at a per-run root; this removes it when the run ends (#230) and
// fails the run if a test still left a fleetview-* entry in the real temp dir, i.e. one that
// bypassed os.tmpdir() (a hardcoded /tmp path, a child process with its own TMPDIR).
const fleetviewEntries = (dir: string) =>
  readdirSync(dir).filter((n) => n.startsWith('fleetview-') && !n.startsWith('fleetview-test-run-'))

export default function setup() {
  const runTmp = process.env.FLEETVIEW_TEST_RUN_TMP
  if (!runTmp) throw new Error('vitest.config.js did not set FLEETVIEW_TEST_RUN_TMP')
  const outer = dirname(runTmp)
  const before = new Set(fleetviewEntries(outer))
  return () => {
    rmSync(runTmp, { recursive: true, force: true })
    // ponytail: a concurrent run of a pre-#230 checkout sharing this temp dir would trip this too.
    const leaked = fleetviewEntries(outer).filter((n) => !before.has(n))
    if (leaked.length) {
      // A throw here is only logged as "error during close" and vitest still exits 0.
      console.error(`test run leaked into ${outer}: ${leaked.join(', ')}`)
      process.exitCode = 1
    }
  }
}
