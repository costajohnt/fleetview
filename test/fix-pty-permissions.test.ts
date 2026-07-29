import { test, expect, vi, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, statSync, lstatSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// The postinstall that runs on every user install. It is a side-effect script, so the real-tree
// cases run it as a child process against a fixture root (argv[2]); the EACCES branch cannot be
// produced with real files by their own owner, so it gets a mocked fs and an in-process import.
const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'fix-pty-permissions.mjs')

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fleetview-pty-'))
  const platform = join(root, 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64')
  mkdirSync(platform, { recursive: true })
  return { root, platform }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
  vi.doUnmock('node:fs')
})

test('a non-executable spawn-helper gets the exec bit back', () => {
  const { root, platform } = fixture()
  const helper = join(platform, 'spawn-helper')
  writeFileSync(helper, '', { mode: 0o644 })
  execFileSync(process.execPath, [script, root])
  expect(statSync(helper).mode & 0o111).toBe(0o111)
  rmSync(root, { recursive: true, force: true })
})

test('a symlinked spawn-helper is left alone, target included', () => {
  const { root, platform } = fixture()
  const target = join(root, 'elsewhere')
  writeFileSync(target, '', { mode: 0o644 })
  symlinkSync(target, join(platform, 'spawn-helper'))
  execFileSync(process.execPath, [script, root])
  expect(statSync(target).mode & 0o111).toBe(0)
  expect(lstatSync(join(platform, 'spawn-helper')).isSymbolicLink()).toBe(true)
  rmSync(root, { recursive: true, force: true })
})

test('a missing prebuilds dir is a no-op, not a failed install', () => {
  const root = mkdtempSync(join(tmpdir(), 'fleetview-pty-'))
  expect(() => execFileSync(process.execPath, [script, root])).not.toThrow()
  rmSync(root, { recursive: true, force: true })
})

test('an unwritable install tree warns instead of failing the install', async () => {
  vi.doMock('node:fs', () => ({
    existsSync: () => true,
    readdirSync: () => ['darwin-arm64'],
    lstatSync: () => ({ isFile: () => true }),
    chmodSync: () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }) },
  }))
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  // finally, not a trailing splice: an assertion that throws would otherwise leak the fixture root
  // into process.argv for every test that runs after this one in the same worker.
  const argv = process.argv.slice()
  process.argv[2] = '/fleetview-fixture-root'
  try {
    // @ts-expect-error the script is plain .mjs with no declarations; running it is the point
    await expect(import('../scripts/fix-pty-permissions.mjs')).resolves.toBeTruthy()
    expect(warn.mock.calls.join(' ')).toContain('EACCES')
  } finally {
    process.argv = argv
  }
})
