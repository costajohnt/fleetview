// M7: the roster opens and works on claude/copilot alone when the opencode CLI is not installed.
import { test, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { render as inkRender } from 'ink-testing-library'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from '../src/app.ts'
import { createBackends, fallbackBackend, NO_AGENT_CLI, onPath } from '../src/backends/index.ts'
import { OPENCODE_MISSING } from '../src/backends/opencode/server-manager.ts'
import { claudeNormaliser, normaliseClaudeSessions } from '../src/backend-normalise.ts'
import { tick, waitFor } from './helpers.ts'

const live: any[] = []
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
const render = (element: React.ReactElement) => {
  const instance = inkRender(element)
  live.push(instance)
  return { stdin: instance.stdin, lastFrame: () => stripAnsi(instance.lastFrame() ?? '') }
}
afterEach(() => {
  for (const instance of live.splice(0)) instance.unmount()
})

const server = { host: '127.0.0.1', port: 4900 }

// Every opencode call fails, the way a client pointed at a server that was never started would.
// The assertions below are that none of them is made at all.
const deadClient = () => {
  const fail = () => vi.fn(() => Promise.reject(new Error('ECONNREFUSED')))
  return {
    listProjects: fail(),
    listSessions: fail(),
    createSession: fail(),
    promptAsync: fail(),
    sessionStatus: fail(),
    listPermissions: fail(),
    listQuestions: fail(),
    listAgents: fail(),
    listCommands: fail(),
    providers: fail(),
  }
}

const fakeClaude = (sessions: any[] = []) => ({
  name: 'claude',
  capabilities: { fork: false, rename: false, delete: false, questions: false, messages: false },
  listSessions: vi.fn(async () => sessions),
  dispatch: vi.fn(async ({ directory }: any) => ({ id: 'claude-9', directory })),
  prompt: vi.fn(async () => ({})),
  events: vi.fn(() => ({ done: Promise.resolve(), stop: vi.fn() })),
  attach: ({ id }: any) => ['claude', '--resume', id],
  abort: vi.fn(async () => ({})),
  rename: vi.fn(async () => ({})),
  delete: vi.fn(async () => ({})),
  normaliseSessions: (rows: any[] | null | undefined) => normaliseClaudeSessions(rows),
  createNormaliser: () => claudeNormaliser(),
})

const mount = (overrides: Record<string, unknown> = {}) => {
  const client = deadClient()
  const claude = fakeClaude([{ id: 'c1', title: 'claude work', directory: '/x/alpha', updatedAt: Date.now() }])
  const ensureServerImpl = vi.fn()
  const view = render(
    React.createElement(App, {
      server,
      client: client as any,
      ensureServerImpl,
      serverReady: true,
      backends: { claude } as any,
      initialBackend: 'claude',
      cwd: '/x/alpha',
      roster: { groupBy: 'state', sessions: [{ worktree: '/x/alpha', id: 'c1', addedAt: 1, backend: 'claude' }] },
      persistRoster: vi.fn(),
      dirExistsImpl: () => true,
      onAction: vi.fn(),
      ...overrides,
    } as any),
  )
  return { ...view, client, claude, ensureServerImpl }
}

const submit = async (stdin: { write: (s: string) => void }, text: string) => {
  stdin.write(text)
  await tick()
  stdin.write('\r')
}

test('the roster renders claude sessions and never touches the opencode server', async () => {
  const { lastFrame, client, ensureServerImpl } = mount()
  await waitFor(() => lastFrame().includes('claude work'))
  expect(lastFrame()).toContain('opencode not installed')
  expect(lastFrame()).not.toContain('unreachable')
  for (const call of Object.values(client)) expect(call).not.toHaveBeenCalled()
  expect(ensureServerImpl).not.toHaveBeenCalled()
})

test('an unprefixed dispatch lands on claude in the launch directory', async () => {
  const { stdin, lastFrame, client, claude } = mount()
  await waitFor(() => lastFrame().includes('claude work'))
  await submit(stdin, 'fix the tests')
  await waitFor(() => claude.dispatch.mock.calls.length > 0)
  expect(claude.dispatch).toHaveBeenCalledWith({ prompt: 'fix the tests', directory: '/x/alpha', agent: undefined, model: undefined })
  expect(client.createSession).not.toHaveBeenCalled()
})

test.each([
  ['!ls', '! shell dispatch'],
  ['/model anthropic/x', '/model'],
  ['/fork', '/fork'],
  ['@opencode hi', '@opencode'],
])('%s says it needs opencode instead of failing', async (input, what) => {
  const { stdin, lastFrame, client, claude } = mount()
  await waitFor(() => lastFrame().includes('claude work'))
  await submit(stdin, input)
  await waitFor(() => lastFrame().includes(`${what} needs opencode, which is not installed`))
  expect(claude.dispatch).not.toHaveBeenCalled()
  expect(client.createSession).not.toHaveBeenCalled()
})

test('an opencode member from an earlier run is not ghosted while opencode is missing', async () => {
  const { stdin, lastFrame, claude } = mount({
    roster: {
      groupBy: 'state',
      sessions: [
        { worktree: '/x/alpha', id: 'c1', addedAt: 1, backend: 'claude' },
        { worktree: '/x/alpha', id: 'o1', addedAt: 1, prompt: 'an opencode job' },
      ],
    },
  })
  await waitFor(() => lastFrame().includes('claude work'))
  // A dispatch marks the directory seeded, which is what would arm the ghost row.
  await submit(stdin, 'go')
  await waitFor(() => claude.dispatch.mock.calls.length > 0)
  await tick()
  expect(lastFrame()).not.toContain('an opencode job')
})

test('with none of the three installed the missing screen names all three', async () => {
  const { lastFrame } = mount({ serverReady: false, serverFailReason: OPENCODE_MISSING })
  await tick()
  expect(lastFrame().replace(/\s+/g, ' ')).toContain(NO_AGENT_CLI)
})

test('fallbackBackend: opencode or nothing falls back to the first installed CLI', () => {
  const only = (...names: string[]) => (cmd: string) => names.includes(cmd)
  expect(fallbackBackend('opencode', only('claude', 'copilot'))).toBe('claude')
  expect(fallbackBackend('opencode', only('copilot'))).toBe('copilot')
  expect(fallbackBackend('copilot', only('claude', 'copilot'))).toBe('copilot') // an explicit choice stands
  expect(fallbackBackend('opencode', only())).toBeNull()
  expect(fallbackBackend('claude', only())).toBeNull() // nothing installed: the missing screen
})

test('onPath finds an executable on PATH and ignores a non-executable one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleetview-path-'))
  writeFileSync(join(dir, 'claude'), '#!/bin/sh\n')
  chmodSync(join(dir, 'claude'), 0o755)
  writeFileSync(join(dir, 'copilot'), '')
  chmodSync(join(dir, 'copilot'), 0o644)
  expect(onPath('claude', { PATH: dir })).toBe(true)
  expect(onPath('copilot', { PATH: dir })).toBe(false)
  expect(onPath('opencode', { PATH: dir })).toBe(false)
})

test('createBackends without a server builds no opencode adapter', () => {
  expect(Object.keys(createBackends()).sort()).toEqual(['claude', 'copilot'])
})
