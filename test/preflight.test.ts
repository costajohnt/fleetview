import { test, expect, vi, afterEach } from 'vitest'
import { nodeVersionError, MIN_NODE_MAJOR, run } from '../src/preflight.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

test('a Node older than the floor gets the version, the floor and the fix', () => {
  expect(nodeVersionError('20.11.0')).toBe(
    'fleetview needs Node >= 24 (you have 20.11.0). Upgrade: https://nodejs.org or brew upgrade node',
  )
})

test('the floor itself and anything above it pass', () => {
  expect(nodeVersionError(`${MIN_NODE_MAJOR}.0.0`)).toBeNull()
  expect(nodeVersionError('24.0.0-nightly')).toBeNull()
  expect(nodeVersionError('100.2.3')).toBeNull() // string compare would call this older than 24
})

test('below the floor by one still fails, prerelease or not', () => {
  expect(nodeVersionError('23.11.1')).toMatch(/needs Node >= 24/)
  expect(nodeVersionError('22.0.0-rc.1')).toMatch(/you have 22\.0\.0-rc\.1/)
})

test('an unrecognisable version is let through rather than blocking startup', () => {
  expect(nodeVersionError('')).toBeNull()
  expect(nodeVersionError('unknown')).toBeNull()
})

// The refusal path is the install-critical half: an old Node must get the message and exit 1
// WITHOUT cli ever being imported — importing it is exactly the modern-syntax crash the guard exists
// to pre-empt.
test('run on an old Node prints the refusal, exits 1, and never imports cli', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const importImpl = vi.fn()
  const exitImpl = vi.fn()
  expect(run({ node: '20.11.0' }, importImpl, exitImpl)).toBeUndefined()
  expect(error).toHaveBeenCalledWith(expect.stringContaining('needs Node >= ' + MIN_NODE_MAJOR))
  expect(exitImpl).toHaveBeenCalledWith(1)
  expect(importImpl).not.toHaveBeenCalled()
})

test('run on a passing Node imports cli and calls main, without exiting', async () => {
  const main = vi.fn()
  const exitImpl = vi.fn()
  await run({ node: `${MIN_NODE_MAJOR}.0.0` }, vi.fn(() => Promise.resolve({ main })), exitImpl)
  expect(main).toHaveBeenCalled()
  expect(exitImpl).not.toHaveBeenCalled()
})

// The catch is what turns a broken install (a missing or unparsable cli.js) into a message and a
// non-zero exit instead of an unhandled rejection — the 0.2.0 shipped-broken failure shape.
test('run reports a failing cli import and exits 1', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const exitImpl = vi.fn()
  await run({ node: `${MIN_NODE_MAJOR}.0.0` }, vi.fn(() => Promise.reject(new Error('Cannot find module ./cli.js'))), exitImpl)
  expect(error).toHaveBeenCalledWith('Cannot find module ./cli.js')
  expect(exitImpl).toHaveBeenCalledWith(1)
})
