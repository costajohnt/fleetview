import React from 'react'
import { Box, Text } from 'ink'
import { truncateGraphemes } from '../text-utils.ts'
import { theme } from './theme.ts'
import type { HelpLine } from './view-types.ts'

// `?` opens this, matching agent view's "Press `?` in agent view to see every shortcut in context."
// Only reachable on an empty input — with text typed, `?` is just a character.
const SHORTCUTS = [
  ['↑ / ↓', 'move between rows'],
  ['⏎', 'attach to the selected session, or dispatch if there is text in the input'],
  ['⇧⏎ / ⌥⏎', 'dispatch and attach immediately'],
  ['space', 'peek at the selected session (types a space when the input has text)'],
  ['1..9', 'in peek, answer the pending question with that choice'],
  ['y / a / d', 'in peek, allow once / always allow / deny a permission'],
  ['! cmd', 'in peek, run a shell command in that session instead of prompting'],
  ['tab', 'in peek, fill the reply with the choice the session offered'],
  ['→', 'attach to the selected session'],
  ['^z', 'detach from an attached session and come back here'],
  ['⌥1..9', 'while attached, jump to that row (best-effort; see FLEETVIEW_NO_ALT_SWITCH)'],
  ['←', 'while attached, back on empty prompt (opencode app_exit keybind, see docs/guide.md)'],
  ['^s', 'switch grouping between state and project'],
  ['^r', 'rename the selected session'],
  ['^x', 'stop the session; press again within 2s to delete it'],
  ['esc', 'close peek, clear the input, or quit when there is nothing to clear'],
  ['tab', 'apply the highlighted @ or / suggestion'],
  ['^j', 'insert a newline in the prompt instead of dispatching'],
  ['^g', 'edit the prompt in $VISUAL or $EDITOR'],
  ['^c', 'clear the input; press twice to exit'],
  ['?', 'show this list'],
]

// What the input understands beyond a plain prompt.
const GRAMMAR = [
  ['@repo', 'run the session in that repository'],
  ['@agent', 'run the session as that subagent (also works as the first word)'],
  ['@backend', 'dispatch on a backend — @claude, @copilot (a subagent or repo of the same name wins)'],
  ['/command', "run one of opencode's commands as the session's first prompt"],
  ['! cmd', 'run a shell command as a job instead of starting a session'],
  ['s:working', 'filter the list by state (also s:blocked, s:failed, s:idle)'],
  ['a:name', 'filter the list by agent'],
  ['s:pr', 'filter to sessions with an open pull request (s:review too)'],
  ['#1234', 'filter to the session working on that pull request (a PR URL works too)'],
  ['/model p/m', 'set the model for sessions dispatched from here (/model default clears it)'],
  ['/fork [p]', "copy the selected session's conversation to a new one; a prompt goes to the fork"],
  ['^t', 'pin or unpin the selected session — pinned sit in their own group on top, bold'],
  ['⇧↑ ⇧↓', "move the selected row within its group; the group's order sticks from then on"],
  ['/exit', 'close fleetview'],
]

// fleetview has no agent-view equivalent: opencode tracks every project in one database, so sessions
// started outside fleetview (including from opencode's own TUI) exist and are worth adopting.
const FLEETVIEW_ONLY = [
  ['^b', 'browse every opencode session, including ones fleetview did not start'],
  ['^a', 'add or remove the selected session from the roster (browse)'],
]

// Flattened once so the whole thing can be paged: help is 30-odd rows and a standard terminal is
// 24, and Ink cannot repaint above the visible region — an overlong overlay scrolls its own top
// off screen, taking the first shortcuts with it.
const SECTIONS: [string, string[][]][] = [
  ['Shortcuts', SHORTCUTS],
  ['In the input', GRAMMAR],
  ['fleetview only', FLEETVIEW_ONLY],
]

export function helpLines(): HelpLine[] {
  return SECTIONS.flatMap(([heading, pairs]) => [
    { heading },
    ...pairs.map(([keys, what]) => ({ keys, what })),
  ])
}

// Pure: the slice of help that fits, plus whether anything was cut. `page` scrolls it.
export function helpPage(lines: readonly HelpLine[], maxRows: number, page = 0) {
  const body = Math.max(1, maxRows - 1) // last row is the footer
  const pages = Math.max(1, Math.ceil(lines.length / body))
  const current = Math.min(Math.max(0, page), pages - 1)
  const start = current * body
  return { slice: lines.slice(start, start + body), page: current, pages }
}

export type HelpProps = { maxRows?: number; columns?: number; page?: number }

export function Help({ maxRows = Infinity, columns = 80, page = 0 }: HelpProps) {
  const { slice, page: current, pages } = helpPage(helpLines(), maxRows, page)
  const width = Math.max(20, columns)
  return React.createElement(
    Box,
    { flexDirection: 'column' },
    ...slice.map((line, i) =>
      // `!== undefined`, not truthiness: a heading is the discriminant between the two line shapes,
      // and only an explicit undefined check tells the compiler the other branch has keys/what.
      // Every heading in SECTIONS is a non-empty string, so the branch taken is unchanged.
      line.heading !== undefined
        ? React.createElement(Text, { key: `h${i}`, bold: true }, line.heading)
        : React.createElement(
            Box,
            // Keys repeat across sections (`! cmd` is both a shortcut and input grammar), so the
            // index is what makes them unique — a duplicate key makes React drop rows.
            { key: `r${i}`, gap: 1 },
            React.createElement(Text, { color: theme.info }, line.keys.padEnd(9)),
            React.createElement(Text, { dimColor: true }, truncateGraphemes(line.what, Math.max(4, width - 11))),
          ),
    ),
    React.createElement(
      Text,
      { dimColor: true },
      pages > 1 ? `any key to close · ↓ more (${current + 1}/${pages})` : 'any key to close',
    ),
  )
}
