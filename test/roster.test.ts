import React from 'react'
import { test, expect } from 'vitest'
import { render as inkRender } from 'ink-testing-library'

// Strip ANSI codes from frames: colored/bold text puts escape codes inside the raw frame, which
// breaks contiguous-string matching and line-shape assertions.
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
const render = (...args: Parameters<typeof inkRender>) => {
  const instance = inkRender(...args)
  return { ...instance, lastFrame: () => stripAnsi(instance.lastFrame() ?? '') }
}
import { Roster, flattenGroups, windowLines, relTime, ageLabel } from '../src/ui/roster.ts'
import { theme } from '../src/ui/theme.ts'

const openPr = (number: number, over: Record<string, any> = {}) => ({
  number,
  url: `https://github.com/o/r/pull/${number}`,
  state: 'OPEN',
  isDraft: false,
  headRefName: 'opencode/x',
  statusCheckRollup: [],
  reviewDecision: '',
  ...over,
})

const groups = [
  { projectKey: '/x/a', repoName: 'alpha', sessions: [{ projectKey: '/x/a', id: 's1', title: 'fix tests', status: 'running' }] },
  { projectKey: '/x/b', repoName: 'beta', sessions: [{ projectKey: '/x/b', id: 's2', title: 'write docs', status: 'done' }] },
]

test('flattenGroups returns selectable rows in render order', () => {
  expect(flattenGroups(groups).map((s) => s.id)).toEqual(['s1', 's2'])
})

// Selection is a full-width background bar (theme.selectionBg), not a marker glyph. The bar exists
// only over painted cells, so a selected row pads its tail out to the terminal width -- and that
// padding survives ANSI stripping, which makes "the selected row is exactly `columns` wide" the
// colorless assertion (CI renders no ANSI; Ink trims trailing spaces off unpainted rows).
const highlighted = (frame: string, text: string, columns = 80) =>
  (frame.split('\n').find((l: string) => l.includes(text)) ?? '').length === columns

test('renders repo headers, titles, state glyphs, and a full-width highlighted selection', () => {
  const instance = inkRender(React.createElement(Roster, { groups, selected: 1, offlineProjects: new Set() }))
  const frame = stripAnsi(instance.lastFrame() ?? '')
  expect(frame).toContain('alpha')
  expect(frame).toContain('beta')
  expect(frame).toContain('fix tests')
  expect(frame).toContain('\u273b') // state lives in the glyph's colour now, not a word on the row
  expect(highlighted(frame, 'write docs')).toBe(true)
  expect(highlighted(frame, 'fix tests')).toBe(false)
})

test('offline project is flagged', () => {
  const frame = render(React.createElement(Roster, { groups, selected: 0, offlineProjects: new Set(['/x/b']) })).lastFrame()
  expect(frame).toContain('offline')
})

test('shows hidden count when a group has capped sessions', () => {
  const groupsWithHidden = [
    { projectKey: '/x/a', repoName: 'alpha', sessions: [{ projectKey: '/x/a', id: 's1', title: 'fix tests', status: 'running' }], hidden: 3 },
  ]
  const frame = render(
    React.createElement(Roster, { groups: groupsWithHidden, selected: 0, offlineProjects: new Set() }),
  ).lastFrame()
  expect(frame).toContain('… 3 more')
})

// windowLines: pure viewport math, unit-tested hard per the edge cases the ticket calls out.
test('windowLines: list shorter than the window renders in full, no indicators', () => {
  const lines = ['a', 'b', 'c']
  expect(windowLines(lines, 1, 20)).toEqual({ slice: lines, above: 0, below: 0 })
})

test('windowLines: exact fit (list length === maxRows - 2) shows no indicators', () => {
  const lines = Array.from({ length: 5 }, (_, i) => `l${i}`)
  expect(windowLines(lines, 2, 7)).toEqual({ slice: lines, above: 0, below: 0 })
})

test('windowLines: selection at top clamps the window to the start', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `l${i}`)
  const { slice, above, below } = windowLines(lines, 0, 12) // size = 10
  expect(above).toBe(0)
  expect(below).toBe(10)
  expect(slice).toEqual(lines.slice(0, 10))
})

test('windowLines: selection at bottom clamps the window to the end', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `l${i}`)
  const { slice, above, below } = windowLines(lines, 19, 12) // size = 10
  expect(below).toBe(0)
  expect(above).toBe(10)
  expect(slice).toEqual(lines.slice(10, 20))
})

test('windowLines: mid-list selection centers the window with both edges clipped', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `l${i}`)
  const { slice, above, below } = windowLines(lines, 10, 12) // size = 10
  expect(above).toBe(5)
  expect(below).toBe(5)
  expect(slice).toEqual(lines.slice(5, 15))
})

test('Roster: maxRows clips rendering and shows ↑/↓ N more indicators around the selection', () => {
  const manyGroups = [
    {
      projectKey: '/x/a',
      repoName: 'alpha',
      sessions: Array.from({ length: 20 }, (_, i) => ({ projectKey: '/x/a', id: `s${i}`, title: `session ${i}`, status: 'idle' })),
    },
  ]
  const frame = render(React.createElement(Roster, { groups: manyGroups, selected: 10, offlineProjects: new Set(), maxRows: 12 })).lastFrame()
  expect(frame).toMatch(/↑ \d+ more/)
  expect(frame).toMatch(/↓ \d+ more/)
  expect(frame).toContain('session 10') // the selection itself must stay in view
  expect(frame).not.toContain('session 0') // scrolled out above
  expect(frame).not.toContain('session 19') // scrolled out below
})

test('markMembers flags member rows with a [roster] marker, leaves non-members unmarked', () => {
  const g = [
    {
      projectKey: '/x/a',
      repoName: 'alpha',
      sessions: [
        { projectKey: '/x/a', id: 's1', title: 'member row', status: 'idle' },
        { projectKey: '/x/a', id: 's2', title: 'non member row', status: 'idle' },
      ],
    },
  ]
  const frame = render(
    React.createElement(Roster, { groups: g, selected: 0, offlineProjects: new Set(), markMembers: new Set(['/x/a:s1']) }),
  ).lastFrame()
  expect(frame.split('\n').find((l: string) => l.includes('member row') && !l.includes('non'))).toContain('[roster]')
  expect(frame.split('\n').find((l: string) => l.includes('non member row'))).not.toContain('[roster]')
})

// --- relTime: pure helper (Wave B) ---

test('relTime: under 60s is "now"', () => {
  expect(relTime(1000, 1000)).toBe('now')
  expect(relTime(1000, 1000 + 59_000)).toBe('now')
})

test('relTime: minutes', () => {
  expect(relTime(0, 3 * 60_000)).toBe('3m')
  expect(relTime(0, 60_000)).toBe('1m')
})

test('relTime: hours', () => {
  expect(relTime(0, 2 * 3_600_000)).toBe('2h')
})

test('relTime: days', () => {
  expect(relTime(0, 5 * 86_400_000)).toBe('5d')
})

// --- row metadata: relative time + snippet, one line (Wave B) ---

// M3: the snippet cap is no longer a fixed 40 — it's `columns` minus everything else on the row
// (marker+badge+title+time here). columns:64 with this row's fixed parts (marker 1 + '○ idle' 6 +
// 'fix tests' 9 + '3m' 2 = 18, +4 gaps = 22, -2 for the "— " prefix) works out to a 40-char budget,
// reproducing the pre-M3 cap so this regression case still exercises the same boundary.
test('Roster row renders dim relative time and a truncated snippet after the title', () => {
  const g = [
    {
      projectKey: '/x/a',
      repoName: 'alpha',
      sessions: [
        {
          projectKey: '/x/a',
          id: 's1',
          title: 'fix tests',
          status: 'idle',
          updatedAt: Date.now() - 3 * 60_000, // component's relTime uses real Date.now() internally
          snippet: 'y'.repeat(60),
        },
      ],
    },
  ]
  const frame = render(React.createElement(Roster, { groups: g, selected: 0, offlineProjects: new Set(), columns: 64 })).lastFrame()
  const row = frame.split('\n').find((l: string) => l.includes('fix tests'))
  expect(row).toContain('3m')
  expect(row).toContain(`— ${'y'.repeat(21)}`)
  expect(row).not.toContain('y'.repeat(22)) // capped so the row stays within `columns` (title is padded to its column)
  expect(frame.split('\n').filter((l: string) => l.includes('fix tests')).length).toBe(1)
})

// M5: grapheme-safe truncation — a code-unit slice at the cap can split a surrogate pair.
// columns:60 here (marker 1 + glyph 1 + padded title 30 + 'now' 3 = 35, +4 gaps, -2 prefix, -1
// right-align spacer gap) yields an 18-char budget, landing the truncation right after the emoji.
test('M5: row snippet truncation at the cap keeps a boundary emoji whole, not split into a lone surrogate', () => {
  const g = [
    {
      projectKey: '/x/a',
      repoName: 'alpha',
      sessions: [
        {
          projectKey: '/x/a',
          id: 's1',
          title: 'fix tests',
          status: 'idle',
          updatedAt: Date.now(),
          snippet: 'a'.repeat(17) + '\u{1F600}' + 'b'.repeat(10), // 😀 is a surrogate pair
        },
      ],
    },
  ]
  const frame = render(React.createElement(Roster, { groups: g, selected: 0, offlineProjects: new Set(), columns: 60 })).lastFrame()
  const row = frame.split('\n').find((l: string) => l.includes('fix tests'))
  expect(row).toContain(`— ${'a'.repeat(17)}\u{1F600}`) // whole emoji, not a corrupted lone surrogate half
})

// M3: a row must never exceed `columns`, however long the title/snippet — the snippet absorbs the
// truncation so title/badge/time are never touched.
test('M3: narrow columns + long title + snippet keeps the rendered row within columns, no wrap', () => {
  const g = [
    {
      projectKey: '/x/a',
      repoName: 'alpha',
      sessions: [
        {
          projectKey: '/x/a',
          id: 's1',
          title: 'a fairly long session title',
          status: 'running',
          snippet: 'z'.repeat(200),
        },
      ],
    },
  ]
  const columns = 60
  const frame = render(React.createElement(Roster, { groups: g, selected: 0, offlineProjects: new Set(), columns })).lastFrame()
  const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, '')
  const row = frame.split('\n').map(stripAnsi).find((l: string) => l.includes('a fairly long session title'))
  expect(row!.trimEnd().length).toBeLessThanOrEqual(columns)
  expect(frame.split('\n').filter((l: string) => l.includes('a fairly long session title')).length).toBe(1) // single physical line, no wrap
})

test('Roster row omits time/snippet when the session carries neither (backward compatible)', () => {
  const g = [{ projectKey: '/x/a', repoName: 'alpha', sessions: [{ projectKey: '/x/a', id: 's1', title: 'fix tests', status: 'idle' }] }]
  const frame = render(React.createElement(Roster, { groups: g, selected: 0, offlineProjects: new Set() })).lastFrame()
  expect(frame).toContain('fix tests')
})

// M6: updatedAt: 0 is not "no timestamp" (that's undefined) — it's the epoch, and relTime(0)
// against a real Date.now() would render an absurd "20000d" row.
test('Roster row omits time when updatedAt is 0', () => {
  const g = [{ projectKey: '/x/a', repoName: 'alpha', sessions: [{ projectKey: '/x/a', id: 's1', title: 'fix tests', status: 'idle', updatedAt: 0 }] }]
  const frame = render(React.createElement(Roster, { groups: g, selected: 0, offlineProjects: new Set() })).lastFrame()
  const row = frame.split('\n').find((l: string) => l.includes('fix tests'))
  expect(row).not.toMatch(/\d+d/)
})

test('Roster: selection at the bottom of a long list scrolls the window down to it', () => {
  const manyGroups = [
    {
      projectKey: '/x/a',
      repoName: 'alpha',
      sessions: Array.from({ length: 20 }, (_, i) => ({ projectKey: '/x/a', id: `s${i}`, title: `session ${i}`, status: 'idle' })),
    },
  ]
  const instance = inkRender(React.createElement(Roster, { groups: manyGroups, selected: 19, offlineProjects: new Set(), maxRows: 12 }))
  const frame = stripAnsi(instance.lastFrame() ?? '')
  expect(frame).toContain('session 19')
  expect(highlighted(frame, 'session 19')).toBe(true)
  expect(frame).not.toMatch(/↓ \d+ more/) // nothing left below the last row
})

// Grouped by project the header names the directory, so the row has to carry the state itself:
// "the summary opens with the session's state as a colored word".
test('showStateWord puts the state on the row for project grouping', () => {
  const g = [
    {
      projectKey: '/x/a',
      repoName: 'alpha',
      sessions: [{ projectKey: '/x/a', id: 's1', title: 'fix tests', status: 'waiting', snippet: 'which one?' }],
    },
  ]
  const withWord = render(React.createElement(Roster, { groups: g, selected: 0, offlineProjects: new Set(), showStateWord: true })).lastFrame()
  expect(withWord).toContain('needs input')
  const without = render(React.createElement(Roster, { groups: g, selected: 0, offlineProjects: new Set() })).lastFrame()
  expect(without).not.toContain('needs input') // state grouping: the header already said it
})

test('ageLabel counts from creation while live, and freezes at the run duration when finished', () => {
  const now = 1_000_000
  expect(ageLabel({ createdAt: now - 3 * 60_000, ranForMs: null }, now)).toBe('3m')
  expect(ageLabel({ createdAt: now - 3 * 60_000, ranForMs: 45_000 }, now)).toBe('45s')
  expect(ageLabel({ createdAt: now - 5 * 60 * 60_000, ranForMs: 2 * 60 * 60_000 }, now)).toBe('2h')
})

test('ageLabel falls back to updatedAt when the session carries no creation time', () => {
  const now = 1_000_000
  expect(ageLabel({ createdAt: 0, updatedAt: now - 60_000, ranForMs: null }, now)).toBe('1m')
  expect(ageLabel({ createdAt: 0, updatedAt: 0, ranForMs: null }, now)).toBe(null)
})

// OSC 8 open/close are zero visible width; strip them before measuring on-screen width.
const stripLinks = (s: string) => s.replace(/\x1b\]8;;[^\x07]*\x07/g, '')

test('a single pull request shows the #N label at the right edge, linked to its url (#89)', () => {
  const session = { id: 's1', projectKey: '/repo', title: 'fix the tests', status: 'idle', updatedAt: Date.now(), prs: [openPr(1234)] }
  const groups = [{ projectKey: '/repo', repoName: 'repo', sessions: [session] }]
  const frame = render(React.createElement(Roster, { groups, selected: 0, offlineProjects: new Set(), columns: 80 })).lastFrame()
  expect(frame).toContain('#1234')
  expect(frame).toContain(openPr(1234).url) // hyperlinked via OSC 8
})

test('several pull requests collapse to an N PRs label, not linked (#89)', () => {
  const session = { id: 's1', projectKey: '/repo', title: 'fix the tests', status: 'idle', updatedAt: Date.now(), prs: [openPr(1234), openPr(2)] }
  const groups = [{ projectKey: '/repo', repoName: 'repo', sessions: [session] }]
  const frame = render(React.createElement(Roster, { groups, selected: 0, offlineProjects: new Set(), columns: 80 })).lastFrame()
  expect(frame).toContain('2 PRs')
  expect(frame).not.toContain('#1234')
})

test('the label is counted in the row budget, so a labelled row still cannot wrap', () => {
  // The viewport arithmetic counts every row as one physical line. A label added after the budget
  // was computed would push a long snippet past `columns` and wrap it, which scrolls the top of the
  // roster out of the region Ink can repaint.
  const session = {
    id: 's1',
    projectKey: '/repo',
    title: 'a fairly long session title here',
    status: 'idle',
    updatedAt: Date.now(),
    snippet: 'x'.repeat(400),
    prs: [openPr(1234)],
  }
  const groups = [{ projectKey: '/repo', repoName: 'repo', sessions: [session] }]
  const frame = render(React.createElement(Roster, { groups, selected: 0, offlineProjects: new Set(), columns: 80 })).lastFrame()
  for (const line of frame.split('\n')) expect(stripLinks(line).length).toBeLessThanOrEqual(80)
})

test('a session with no pull requests renders exactly as before', () => {
  const session = { id: 's1', projectKey: '/repo', title: 'fix', status: 'idle', updatedAt: Date.now(), prs: [] }
  const groups = [{ projectKey: '/repo', repoName: 'repo', sessions: [session] }]
  const frame = render(React.createElement(Roster, { groups, selected: 0, offlineProjects: new Set(), columns: 80 })).lastFrame()
  expect(frame).not.toContain('#')
})

test('group headers are neutral bold grey; selection is the white-on-bar treatment', () => {
  // CI has no color support, so a rendered frame carries no ANSI to assert on: the theme tokens
  // are the testable contract (Roster reads theme.header and theme.selectionBg/Fg directly; wiring
  // verified live 2026-07-27). Agent view gives headers NO per-state color, so the old
  // waiting-red/running-yellow/completed-green map must stay gone.
  expect(theme.header).toBe('gray')
  expect((theme as Record<string, unknown>).group).toBeUndefined()
  expect(theme.selectionBg).toBe('#373737')
  expect(theme.selectionFg).toBe('white')
})
