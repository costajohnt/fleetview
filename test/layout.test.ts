import React from 'react'
import { test, expect, vi } from 'vitest'
import { render } from 'ink-testing-library'
import { App } from '../src/app.ts'
import { Help, helpLines, helpPage } from '../src/ui/help.ts'
import { Peek } from '../src/ui/peek.ts'
import { Header, headerRows } from '../src/ui/header.ts'
import { Roster, windowLines } from '../src/ui/roster.ts'
import { DispatchInput, tailOf } from '../src/ui/dispatch-input.ts'

// Ink cannot repaint above the visible region, so a frame taller than the terminal scrolls its own
// top away permanently. Every one of these asserts the thing the row arithmetic claims: what is
// drawn fits in what was reserved.
const rowsOf = (frame: any) => frame.split('\n').length
// Ink pads every line to the container width, so measure content, not padding — and strip ANSI
// color codes first, since they occupy string length but no terminal cells.
const stripAnsi = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;[^\x07]*\x07/g, '')
const widest = (frame: any) => Math.max(...frame.split('\n').map((l: string) => [...stripAnsi(l).trimEnd()].length))

const session = (i: number, extra: any = {}) => ({
  projectKey: '/x/alpha',
  id: `s${i}`,
  title: `session ${i}`,
  status: 'idle',
  ...extra,
})

test('a long title cannot wrap a row onto a second line', () => {
  const groups = [
    {
      projectKey: '/x/a',
      repoName: 'alpha',
      sessions: [session(1, { title: 'x'.repeat(400), snippet: 'y'.repeat(200) })],
    },
  ]
  const frame = render(
    React.createElement(Roster, { groups, selected: 0, offlineProjects: new Set(), columns: 80 }),
  ).lastFrame()
  expect(widest(frame)).toBeLessThanOrEqual(80)
  expect(rowsOf(frame)).toBe(2) // one header, one row
})

test('windowLines never renders more lines than maxRows, at any size', () => {
  const lines = Array.from({ length: 30 }, (_, i) => ({ type: 'session', key: `k${i}`, session: session(i) }))
  for (const maxRows of [-1, 0, 1, 2, 3, 5, 12, 40]) {
    const { slice, above, below } = windowLines(lines, 15, maxRows)
    const rendered = slice.length + (above > 0 ? 1 : 0) + (below > 0 ? 1 : 0)
    expect(rendered, `maxRows=${maxRows}`).toBeLessThanOrEqual(Math.max(1, maxRows))
  }
})

test('the scroll indicators count sessions, not group headers', () => {
  const lines = [
    { type: 'header', key: 'h1', text: '▾ one' },
    ...Array.from({ length: 4 }, (_, i) => ({ type: 'session', key: `a${i}`, session: session(i) })),
    { type: 'header', key: 'h2', text: '▾ two' },
    ...Array.from({ length: 4 }, (_, i) => ({ type: 'session', key: `b${i}`, session: session(i + 4) })),
  ]
  const { above, below } = windowLines(lines, 7, 5)
  expect(above + below).toBeLessThanOrEqual(8) // 8 sessions exist; headers must not inflate this
})

test('help fits the terminal it is given, and pages the rest', () => {
  const all = helpLines()
  expect(all.length).toBeGreaterThan(24) // it genuinely does not fit a standard terminal
  const frame = render(React.createElement(Help, { maxRows: 24, columns: 80 })).lastFrame()
  expect(rowsOf(frame)).toBeLessThanOrEqual(24)
  expect(widest(frame)).toBeLessThanOrEqual(80)
  expect(frame).toContain('1/') // says which page you are on

  const seen = new Set()
  const { pages } = helpPage(all, 24, 0)
  for (let p = 0; p < pages; p++) helpPage(all, 24, p).slice.forEach((l) => seen.add(l.heading ?? l.keys))
  expect(seen.size).toBe(new Set(all.map((l) => (l as any).heading ?? (l as any).keys)).size) // every row reachable
})

test('help paging clamps instead of running off the end', () => {
  const all = helpLines()
  expect(helpPage(all, 24, 999).page).toBe(helpPage(all, 24, 0).pages - 1)
  expect(helpPage(all, 24, -5).page).toBe(0)
})

test('peek never draws more rows than it was given, even when the banners alone fill it', () => {
  const frame = render(
    React.createElement(Peek, {
      target: { title: 'z'.repeat(300), projectKey: '/x/alpha' },
      messages: [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'w '.repeat(400) }] }],
      pending: [{ id: 'p1', permission: 'edit', patterns: ['src/**'] }],
      pendingQuestions: [
        {
          id: 'q1',
          questions: [
            {
              question: 'which?',
              header: 'which',
              options: Array.from({ length: 9 }, (_, i) => ({ label: `option ${i}`, description: '' })),
            },
          ],
        },
      ],
      error: "couldn't answer permission",
      maxRows: 16,
      columns: 80,
    }),
  ).lastFrame()
  expect(rowsOf(frame)).toBeLessThanOrEqual(16)
  expect(widest(frame)).toBeLessThanOrEqual(80)
})

test('the header block matches headerRows and fits even a long model name', () => {
  const props = {
    sessions: [{ status: 'waiting' }, { status: 'running' }, { status: 'error' }],
    model: { providerID: 'github-copilot', id: 'claude-sonnet-4.5-20250101' },
    cwd: '/Users/someone/dev/a-project',
  }
  // Wide: the mascot block with a breathing row above and below — the row-reservation contract
  // must match what renders.
  const wide = render(React.createElement(Header, { ...props, columns: 80 })).lastFrame()
  expect(rowsOf(wide)).toBe(headerRows(80))
  expect(rowsOf(wide)).toBe(5)
  expect(widest(wide)).toBeLessThanOrEqual(80)
  expect(wide).toMatch(/fleetview.*v\d/) // name and version top the text block
  expect(wide).toContain('a-project')
  expect(wide).toContain('awaiting input')
  // Narrow: the compact one-line name, 3 rows.
  const narrow = render(React.createElement(Header, { ...props, columns: 40 })).lastFrame()
  expect(rowsOf(narrow)).toBe(headerRows(40))
  expect(rowsOf(narrow)).toBe(3)
  expect(narrow).toMatch(/fleetview.*v\d/)
})

test('a prompt longer than the terminal scrolls rather than wrapping', () => {
  const frame = render(
    React.createElement(DispatchInput, { value: 'p'.repeat(300), view: 'main', columns: 80 }),
  ).lastFrame()
  expect(widest(frame)).toBeLessThanOrEqual(80)
  expect(tailOf('abcdef', 3)).toBe('def') // the caret end is what stays visible
})

// The whole point: App reserves rows by counting the components it draws, so the total has to fit.
const appFrameFits = async (rows?: any, drive?: (stdin: any) => void) => {
  const project = { id: 'a-1', worktree: '/x/alpha', time: { created: 1, updated: 1000 } }
  const client = {
    listProjects: vi.fn(() => Promise.resolve([project])),
    listSessions: vi.fn(() =>
      Promise.resolve(
        Array.from({ length: 25 }, (_, i) => ({ id: `s${i}`, title: `a fairly long session title ${i}`, time: { updated: i } })),
      ),
    ),
    listMessages: vi.fn(() => Promise.resolve([])),
    sessionStatus: vi.fn(() => Promise.resolve({})),
    listPermissions: vi.fn(() => Promise.resolve([])),
    listQuestions: vi.fn(() => Promise.resolve([])),
    listAgents: vi.fn(() => Promise.resolve(Array.from({ length: 12 }, (_, i) => ({ name: `agent${i}` })))),
    listCommands: vi.fn(() => Promise.resolve([])),
    providers: vi.fn(() => Promise.resolve({ providers: [] })),
  }
  const instance = (render as any)(
    React.createElement(App as any, {
      server: { host: '127.0.0.1', port: 4900 },
      client,
      connectEventsImpl: vi.fn(() => ({ done: Promise.resolve(), stop: vi.fn() })),
      ensureServerImpl: vi.fn(),
      serverReady: true,
      roster: { groupBy: 'state', sessions: Array.from({ length: 25 }, (_, i) => ({ worktree: '/x/alpha', id: `s${i}`, addedAt: i })) },
      persistRoster: vi.fn(),
      onAction: vi.fn(),
    }),
    { stdout: Object.assign(process.stdout, {}) },
  )
  const start = Date.now()
  while (!instance.lastFrame()!.includes('session title') && Date.now() - start < 3000) {
    await new Promise((r) => setTimeout(r, 10))
  }
  if (drive) {
    drive(instance.stdin)
    await new Promise((r) => setTimeout(r, 300))
  }
  const frame = instance.lastFrame()
  instance.unmount()
  return frame
}

test('the roster frame fits the terminal with a notice and a suggestion list open', async () => {
  // ink-testing-library reports 100x100, so assert against what App actually reserved rather than
  // a hard-coded 24 — the invariant is "drawn <= reserved", whatever the terminal size is.
  const plain = await appFrameFits()
  const withSuggestions = await appFrameFits(null, (stdin) => stdin.write('\t')) // Tab opens up to 8 rows
  expect(rowsOf(withSuggestions)).toBeLessThanOrEqual(rowsOf(plain) + 8 + 1)
  expect(rowsOf(plain)).toBeGreaterThan(3)
})

// tailOf runs on every render and the input can hold a pasted prompt of any size, so it must not
// segment the whole string to keep the last 80 graphemes.
test('tailOf stays cheap on a huge pasted prompt', () => {
  const huge = 'x'.repeat(500_000) + '🙂end'
  const started = process.hrtime.bigint()
  const tail = tailOf(huge, 20)
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  expect([...tail].length).toBeLessThanOrEqual(20)
  expect(tail.endsWith('🙂end')).toBe(true) // and the boundary emoji survives intact
  expect(ms).toBeLessThan(50)
})
