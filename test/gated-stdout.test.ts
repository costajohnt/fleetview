import React from 'react'
import { test, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { render } from 'ink'
import { gatedStdout } from '../src/gated-stdout.ts'
import { App } from '../src/app.ts'

// A stand-in for the real terminal: an EventEmitter that records what Ink wrote and whose
// dimensions a test can change, so a resize can be staged the way the tty stages one.
class FakeTerminal extends EventEmitter {
  isTTY = true
  columns = 100
  rows = 30
  frames: string[] = []
  write = (chunk: any) => {
    this.frames.push(String(chunk))
    return true
  }
}

// App uses useInput, so Ink needs a stdin it can put into raw mode — the same stub shape
// ink-testing-library provides, which this test can't use because its stdout has a fixed width.
class FakeStdin extends EventEmitter {
  isTTY = true
  write = () => {}
  setEncoding = () => {}
  setRawMode = () => {}
  resume = () => {}
  pause = () => {}
  ref = () => {}
  unref = () => {}
  read = () => null
}

// CSI codes and OSC strings both go — the tab title is an OSC carrying readable text, and leaving
// it in would make it look like a drawn frame.
const stripAnsi = (s: string) => s.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
const tick = () => new Promise((r) => setTimeout(r, 60))

test('gatedStdout forwards the wrapped stream resize event to its own listeners', () => {
  const target = new FakeTerminal()
  const gate = gatedStdout(target as any)
  const seen: number[] = []
  gate.on('resize', () => seen.push(target.columns))

  target.columns = 60
  target.emit('resize')
  expect(seen).toEqual([60])
})

test('gatedStdout stops forwarding on dispose and leaves no listener on the wrapped stream', () => {
  const target = new FakeTerminal()
  const before = target.listenerCount('resize')
  const gate = gatedStdout(target as any)
  expect(target.listenerCount('resize')).toBe(before + 1)

  const onResize = vi.fn()
  gate.on('resize', onResize)
  gate.dispose!()

  target.emit('resize')
  expect(onResize).not.toHaveBeenCalled()
  // rosterLoop builds a fresh gate per attach cycle, so a listener left behind here would pile up
  // on the real stdout until Node warns about a leak.
  expect(target.listenerCount('resize')).toBe(before)
})

// Regression for #23: resizing the terminal used to leave the roster laid out for the old width
// until an unrelated keypress or store event re-rendered App. Ink's own resize handling re-lays-out
// the React output it already has without re-invoking components, so App has to subscribe itself.
test('App re-lays-out for the new width when the terminal resizes', async () => {
  const server = { host: '127.0.0.1', port: 4900 }
  const project = { id: 'a-1', worktree: '/x/alpha', vcs: 'git', time: { created: 1, updated: 1000 } }
  const client = {
    listProjects: vi.fn(() => Promise.resolve([project])),
    listSessions: vi.fn(() => Promise.resolve([{ id: 's1', title: 'fix tests', time: { updated: Date.now() } }])),
    listMessages: vi.fn(() => Promise.resolve([])),
    sessionStatus: vi.fn(() => Promise.resolve({})),
    listPermissions: vi.fn(() => Promise.resolve([])),
    listQuestions: vi.fn(() => Promise.resolve([])),
  }
  const target = new FakeTerminal()
  const gate = gatedStdout(target as any)
  const instance = render(
    React.createElement(App as any, {
      server,
      client,
      connectEventsImpl: vi.fn(() => ({ done: Promise.resolve(), stop: vi.fn() })),
      ensureServerImpl: vi.fn(() => Promise.resolve({ ok: true, server })),
      serverReady: true,
      roster: { groupBy: 'state', sessions: [{ worktree: '/x/alpha', id: 's1', addedAt: 1 }] },
      persistRoster: vi.fn(),
    }),
    { stdout: gate as any, stdin: new FakeStdin() as any, exitOnCtrlC: false, patchConsole: false },
  )
  // Ink writes control-only chunks (cursor, title, synchronised-update markers) between frames;
  // the widest line of the newest chunk that actually drew text is the laid-out width.
  const widest = () => {
    for (let i = target.frames.length - 1; i >= 0; i--) {
      const frame = stripAnsi(target.frames[i])
      if (/[A-Za-z]{3}/.test(frame)) return Math.max(0, ...frame.split('\n').map((l) => l.length))
    }
    return 0
  }
  try {
    await tick()
    expect(widest()).toBeGreaterThan(60)

    target.columns = 50
    target.rows = 12
    target.emit('resize')
    await tick()
    // Without the resize subscription this frame is still drawn for 100 columns.
    expect(widest()).toBeLessThanOrEqual(50)
  } finally {
    instance.unmount()
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})
