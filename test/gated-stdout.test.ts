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
// Bounded polling, not a fixed sleep: on a loaded CI runner Ink's frame can take longer than any
// sleep this test would want to hardcode, and a too-short one reads as "resize handling broke".
const waitFor = async (fn: () => boolean, timeoutMs = 3000) => {
  const start = Date.now()
  for (;;) {
    if (fn()) return
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

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
    // `interactive: true` is what makes this test run the same on a laptop and on CI. Ink decides
    // interactivity with `interactive ?? (!isInCi && stdout.isTTY)` (ink 7 `ink.js:707`), and a
    // non-interactive Ink writes only the final frame at unmount — so under GitHub Actions, which
    // is-in-ci detects, there are no mid-run frames to measure and nothing resize-related runs at all.
    { stdout: gate as any, stdin: new FakeStdin() as any, interactive: true, exitOnCtrlC: false, patchConsole: false },
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
    await waitFor(() => widest() > 60)

    target.columns = 50
    target.rows = 12
    target.emit('resize')
    // Without the resize subscription every later frame is still drawn for 100 columns and this
    // times out; with it, the newest text frame shrinks to the new width.
    await waitFor(() => widest() <= 50)
  } finally {
    instance.unmount()
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})
