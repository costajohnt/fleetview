import React from 'react'
import { test, expect, vi } from 'vitest'
import { render } from 'ink-testing-library'
import { StatusBadge, badgeGlyph, stateLabel } from '../src/ui/status-badge.ts'
import { DispatchInput, hints } from '../src/ui/dispatch-input.ts'
import { summarise } from '../src/ui/header.ts'

// Shape carries state now: `✳` asks for you, `✻/✽` is working, `•` is settled. Liveness still
// wins — a dead project's sessions all show `∙` whatever their state.
test('StatusBadge shape tracks state, and liveness overrides it', () => {
  expect(render(React.createElement(StatusBadge, { status: 'waiting', alive: true })).lastFrame()).toContain('✳')
  expect(render(React.createElement(StatusBadge, { status: 'running', alive: true })).lastFrame()).toContain('✻')
  for (const status of ['done', 'idle', 'error', 'stopped']) {
    expect(render(React.createElement(StatusBadge, { status, alive: true })).lastFrame()).toContain('•')
  }
  for (const status of ['running', 'waiting', 'done', 'idle', 'error', 'stopped']) {
    expect(render(React.createElement(StatusBadge, { status, alive: false })).lastFrame()).toContain('∙')
  }
})

test('a working session animates between frames; every other state holds still', () => {
  expect(badgeGlyph('running', { frame: 0 })).toBe('✻')
  expect(badgeGlyph('running', { frame: 1 })).toBe('✽')
  expect(badgeGlyph('done', { frame: 1 })).toBe('•')
})

test('a dead process shows the exited shape whatever the state says', () => {
  expect(badgeGlyph('running', { alive: false, frame: 1 })).toBe('∙')
})

test('state labels use agent view vocabulary', () => {
  expect(stateLabel('running')).toBe('working')
  expect(stateLabel('waiting')).toBe('needs input')
  expect(stateLabel('done')).toBe('completed')
  expect(stateLabel('error')).toBe('failed')
  expect(stateLabel('stopped')).toBe('stopped')
})

// Enter and space act on the input when it holds text and on the selected row when it doesn't, so
// the footer has to say which — it's the only signal the user gets for that switch.
test('hints swap the Enter verb on whether the input holds text', () => {
  expect(hints({ empty: true, view: 'main' } as any)).toContain('⏎ attach')
  expect(hints({ empty: true, view: 'main' } as any)).toContain('space peek')
  expect(hints({ empty: false, view: 'main' } as any)).toContain('⏎ dispatch')
  expect(hints({ empty: false, view: 'main' } as any)).not.toContain('⏎ attach')
})

test('hints offer roster membership only in browse', () => {
  expect(hints({ empty: true, view: 'browse' } as any)).toContain('^a add/remove')
  expect(hints({ empty: true, view: 'main' } as any)).toContain('^b browse')
})

// App reserves exactly one row for this line. At 109 graphemes it wrapped to two, so the frame
// came out a row taller than the terminal and scrolled the roster's top away.
test('the footer fits on one row of a standard terminal in every state', () => {
  for (const empty of [true, false]) {
    for (const view of ['main', 'browse']) {
      for (const kind of [undefined, 'shell', 'filter']) {
        const text = hints({ empty, view, kind } as any)
        expect([...text].length, `${empty}/${view}/${kind}: ${text}`).toBeLessThanOrEqual(80)
      }
    }
  }
})

test('DispatchInput shows a placeholder when empty and the typed text otherwise', () => {
  expect(render(React.createElement(DispatchInput, { value: '', view: 'main' })).lastFrame()).toContain('describe a task')
  const typed = render(React.createElement(DispatchInput, { value: 'fix the parser', view: 'main' })).lastFrame()
  expect(typed).toContain('fix the parser█')
  expect(typed).not.toContain('describe a task')
})

test('DispatchInput draws a bordered box with the ❯ prompt, hints below it', () => {
  const frame = render(React.createElement(DispatchInput, { value: '', view: 'main', columns: 80 })).lastFrame()
  expect(frame).toContain('╭') // rounded border, an obvious box
  expect(frame).toContain('❯')
  const lines = frame!.split('\n')
  expect(lines[lines.length - 1]).toContain('? help') // hints are the last row, outside the box
  // Border top/bottom + 1 prompt row + 1 hint row: matches INPUT_BOX_ROWS the app reserves.
  expect(lines.length).toBe(4)
})

test('DispatchInput surfaces a transient notice above the input', () => {
  const frame = render(
    React.createElement(DispatchInput, { value: '', view: 'main', notice: '^x again to delete' }),
  ).lastFrame()
  expect(frame).toContain('^x again to delete')
})

test('summarise always shows the three-way count, zeros included', () => {
  expect(
    summarise([{ status: 'waiting', pendingRequest: true }, { status: 'running' }, { status: 'done' }]),
  ).toBe('1 awaiting input · 1 working · 1 completed')
  // The header and the tab title must agree: a row that only looks like a question counts in
  // neither, or the two numbers on screen contradict each other.
  expect(summarise([{ status: 'waiting', pendingRequest: false }, { status: 'running' }])).toBe(
    '0 awaiting input · 1 working · 0 completed',
  )
  // Completed collects the same statuses as the roster's completed group: done, error, stopped,
  // idle — with failures called out separately since they're the ones worth a look.
  expect(summarise([{ status: 'done' }, { status: 'stopped' }, { status: 'idle' }])).toBe(
    '0 awaiting input · 0 working · 3 completed',
  )
  expect(summarise([{ status: 'error' }])).toBe('0 awaiting input · 0 working · 1 completed · 1 failed')
  expect(summarise([])).toBe('0 awaiting input · 0 working · 0 completed')
})

test('the footer says what Enter will do with a shell job or a filter', () => {
  expect(hints({ empty: false, view: 'main', kind: 'shell' })).toContain('⏎ run shell job')
  expect(hints({ empty: false, view: 'main', kind: 'filter' })).toBe('filtering · esc clears')
})

test('summarise ignores pull requests — the counts line is status only', () => {
  const open = { number: 5, state: 'OPEN', isDraft: false, url: 'https://github.com/o/r/pull/5' }
  // Open PRs surface in peek, not the counts line (the ready-for-review group and its count both
  // went, same call).
  expect(summarise([{ status: 'idle', prs: [open] }])).toBe('0 awaiting input · 0 working · 1 completed')
})
