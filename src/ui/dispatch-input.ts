import React from 'react'
import { Box, Text } from 'ink'
import { graphemes, truncateGraphemes } from '../text-utils.ts'
import { theme } from './theme.ts'

// Agent view's input is always focused and always visible; it is the home row of the whole screen.
// Text state lives in App, not here — App's single useInput handler has to decide whether a
// keypress is text or a command (Enter dispatches with text, attaches without), so splitting the
// state across two components would mean two sources of truth for that decision.

// Pure so the footer can be asserted without rendering Ink. `empty` drives the Enter/Space verbs:
// with text they act on the input, without text they act on the selected row.
// Kept under 80 columns deliberately. The previous version ran to 109 and wrapped to a second row
// that App had not reserved, so the frame was a row taller than the terminal and scrolled the top
// of the roster out of the repaint region. The full list lives behind `?`, which is where agent
// view puts it too.
export function hints({ empty, view, kind }: { empty: boolean; view: string; kind: string }) {
  if (kind === 'filter') return 'filtering · esc clears'
  const verb = kind === 'shell' ? '⏎ run shell job' : '⏎ dispatch · ⇧⏎ +attach'
  const primary = empty ? '⏎ attach · space peek' : verb
  const fleetviewOnly = view === 'browse' ? '^a add/remove · ^b back' : '^b browse'
  return `${primary} · ↑↓ move · ${fleetviewOnly} · ^x stop · ? help`
}

// How many physical rows the prompt itself occupies. `^j` puts real newlines in the input, and App
// reserves screen space by counting rows — so this is the one place that decides, and both the
// reservation and the render read it rather than agreeing by coincidence.
export const MAX_INPUT_ROWS = 5
export const inputRows = (value: string) => Math.min(MAX_INPUT_ROWS, Math.max(1, value.split('\n').length))

// The bordered box adds its top and bottom rows on top of inputRows(). App's row reservation
// reads this rather than hard-coding 2, same contract as HEADER_ROWS.
export const INPUT_BOX_ROWS = 2

// Every line here is one physical row, truncated rather than wrapped: App reserves rows by
// counting them, so a wrap silently makes the frame taller than the terminal.
// TODO(types): props are dynamic UI state (suggestions is opencode wire data) — any.
export function DispatchInput({ value, view, notice, kind, suggestions, columns = 80, focused = true }: any) {
  const empty = value.length === 0
  // A solid block caret, no blink (John's polish pass — the animation earned nothing).
  const caret = focused ? '█' : ''
  const fit = (text: string) => truncateGraphemes(text, Math.max(8, columns))
  // The last MAX_INPUT_ROWS lines: a long pasted or hand-written prompt scrolls, exactly as the
  // single-line version scrolls horizontally, and the caret stays visible either way.
  const lines = value.split('\n')
  const shown = lines.slice(-MAX_INPUT_ROWS)
  return React.createElement(
    Box,
    { flexDirection: 'column' },
    notice ? React.createElement(Text, { color: theme.warn }, fit(notice)) : null,
    // "Typing `@` lists these targets" / "`/<command>` Suggest skills and commands". Tab applies
    // the first one.
    ...(suggestions?.matches ?? []).map((m: any) =>
      React.createElement(
        Box,
        { key: `${m.kind}:${m.name}`, gap: 1 },
        React.createElement(Text, { color: m.kind === 'agent' ? theme.info : m.kind === 'repo' ? theme.accent : undefined }, `  ${suggestions.sigil}${m.name}`),
        React.createElement(Text, { dimColor: true }, m.kind),
      ),
    ),
    // The box is what makes the input the obvious home row of the screen. Rounded, and its border
    // answers "is this input live": dim while empty, accent the moment it holds text — the same
    // signal a focus ring gives a form field. The border's 2 rows are INPUT_BOX_ROWS in App's
    // reservation, and its 2 columns come out of the prompt's truncation budget below.
    React.createElement(
      Box,
      {
        flexDirection: 'column',
        borderStyle: 'round',
        // Plain and dim, always (John's polish pass — no colored focus ring): the input is
        // always live for typing, so a focus state would be a lie.
        borderDimColor: true,
        width: Math.max(8, columns),
      },
      empty
        ? React.createElement(
            Box,
            null,
            React.createElement(Text, { dimColor: true }, '❯ '),
            React.createElement(Text, { dimColor: true }, `${caret ? `${caret} ` : ''}describe a task and press ⏎`),
          )
        : // Keep the caret visible on a long prompt by showing the tail, not the head. Only the last
          // line carries the caret; earlier lines are ordinary text.
          React.createElement(
            Box,
            { flexDirection: 'column' },
            ...shown.map((line: string, i: number) =>
              React.createElement(
                Box,
                { key: `line${i}` },
                React.createElement(Text, { dimColor: i > 0 }, i === 0 ? '❯ ' : '  '),
                React.createElement(
                  Text,
                  null,
                  `${tailOf(line, Math.max(8, columns - 5))}${i === shown.length - 1 ? caret : ''}`,
                ),
              ),
            ),
          ),
    ),
    React.createElement(Text, { dimColor: true }, fit(hints({ empty, view, kind }))),
  )
}

// The last `width` graphemes, so typing past the terminal edge scrolls instead of wrapping.
//
// Pre-slices by code unit before segmenting, the same trick session-store uses for snippets: a
// pasted prompt can be enormous, this runs on every render, and segmenting the whole string to
// keep 80 graphemes is the kind of per-keystroke cost that shows up as input lag. No grapheme
// cluster is anywhere near 8 code units per character, so the tail is always intact.
export function tailOf(text: string, width: number) {
  if (!text || text.length <= width) return text
  const candidate = text.slice(-width * 8)
  const g = graphemes(candidate)
  return g.length <= width ? candidate : g.slice(g.length - width).join('')
}
