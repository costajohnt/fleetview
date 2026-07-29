import { test, expect } from 'vitest'

// Every other PTY test runs against a fake, so this is the only place the native binding, the
// spawn-helper exec bit the postinstall restores, and a real fork are actually exercised. node-pty
// is a dependency, so a skip here means the install is already broken — it only fires on a checkout
// where the native build did not happen.
let pty: any = null
try {
  pty = (await import('node-pty')).default
} catch {
  pty = null
}

// …and CI is not such a checkout: `npm ci` builds the binding there, so a null import is a broken
// install and has to fail the run rather than skip quietly into a green tick.
test.runIf(process.env.CI)('node-pty is importable in CI', () => {
  expect(pty).not.toBeNull()
})

test.skipIf(!pty)('real node-pty runs a command, streams its output and reports the exit', async () => {
  const out: string[] = []
  const child = pty.spawn('/bin/sh', ['-c', 'printf hello-from-a-real-pty'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: process.env,
  })
  child.onData((d: string) => out.push(d))
  const exit = await new Promise((resolve) => child.onExit(resolve))
  expect(out.join('')).toContain('hello-from-a-real-pty')
  expect(exit).toMatchObject({ exitCode: 0 })
}, 30000)
