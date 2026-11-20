import { readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

// vitest.config.js points TMPDIR at a per-run root; this removes it when the run ends (#230) and
// reports any fleetview-* entry that appeared in the real temp dir (or /tmp, which is a different
// dir on macOS) during the run, i.e. one that bypassed os.tmpdir(): a hardcoded /tmp path, or a
// child process spawned without TMPDIR.
// Fails the run only under CI: a dev box or the shared worker can have another checkout's suite, or
// fleetview's own editPrompt, writing fleetview-* dirs there at the same time.
const fleetviewEntries = (dirs: string[]) =>
  dirs.flatMap((d) => readdirSync(d).filter((n) => n.startsWith('fleetview-') && !n.startsWith('fleetview-test-run-')).map((n) => join(d, n)))

export default function setup() {
  const runTmp = process.env.FLEETVIEW_TEST_RUN_TMP
  if (!runTmp) throw new Error('vitest.config.js did not set FLEETVIEW_TEST_RUN_TMP')
  const dirs = [...new Set([dirname(runTmp), '/tmp'])]
  const before = new Set(fleetviewEntries(dirs))
  return () => {
    // A throw here is only logged as "error during close" and vitest still exits 0, so failures
    // set process.exitCode instead.
    try {
      rmSync(runTmp, { recursive: true, force: true })
    } catch (e) {
      console.error(`FAIL (#230 temp-dir guard): could not remove ${runTmp}:`, e)
      process.exitCode = 1
    }
    const leaked = fleetviewEntries(dirs).filter((p) => !before.has(p))
    if (!leaked.length) return
    console.error(`${process.env.CI ? 'FAIL' : 'WARN'} (#230 temp-dir guard): test run leaked ${leaked.join(', ')}`)
    if (process.env.CI) process.exitCode = 1
  }
}
