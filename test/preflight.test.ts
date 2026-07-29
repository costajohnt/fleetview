import { test, expect } from 'vitest'
import { nodeVersionError, MIN_NODE_MAJOR } from '../src/preflight.ts'

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
