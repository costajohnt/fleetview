import React from 'react'
import { createRequire } from 'node:module'
import { basename } from 'node:path'
import { Box, Text } from 'ink'
import { truncateGraphemes } from '../text-utils.ts'
import { FINISHED_STATUSES } from '../session-store.ts'
import { theme } from './theme.ts'
import type { ModelRef, StatusCountable } from './view-types.ts'

const VERSION = createRequire(import.meta.url)('../../package.json').version

// Agent view's header is a block, not a row: the tool's name and version on top, then the model
// and working directory, then the summary count. The count is the part that earns its place: it
// says whether anything needs you without reading the list.
//
// Always the full three-way count, zeros included — a stable shape the eye can land on, matching
// the roster's three always-shown groups. `awaiting input` counts only sessions blocked on a
// server-reported request (same rule as the tab title, or the two numbers on screen contradict
// each other), and `completed` collects the same statuses as the roster's completed group.
export function summarise(sessions: readonly StatusCountable[]) {
  const n = (pred: (s: StatusCountable) => boolean) => sessions.filter(pred).length
  const awaiting = n((s) => s.status === 'waiting' && Boolean(s.pendingRequest))
  const working = n((s) => s.status === 'running')
  const failed = n((s) => s.status === 'error')
  const completed = n((s) => FINISHED_STATUSES.has(s.status))
  const parts = [`${awaiting} awaiting input`, `${working} working`, `${completed} completed`]
  // `failed` trails the stable three-way shape only when nonzero. The ready-for-review count went
  // with its group (John's call): open PRs surface in peek, not the counts line.
  if (failed) parts.push(`${failed} failed`)
  return parts.join(' · ')
}

// The mascot: a chunky pixel tug in half-blocks — sail and mast up top, a hull with two
// porthole eyes, drawn on an 8x8 pixel grid and collapsed two-rows-per-char, the way Claude
// Code's own header creature is built. Sits left of the text block, agent-view style.
const MASCOT = [
  ' ▟▀▙ ',
  '  █  ',
  '▙▄█▄▟',
]
const MASCOT_WIDTH = 7 // icon column plus the gap before the text block

// App reserves rows by counting them, so the header's height is a function, not a constant: the
// mascot block needs the width to breathe, and a narrow terminal falls back to the compact
// one-line name. Both consumers (row reservation, mouse row math) read this same function.
// 5 = blank row above the mascot, three icon/text rows, blank row before the roster.
export const headerRows = (columns: number) => (columns >= MASCOT_WIDTH + 40 ? 5 : 3)

export type HeaderProps = {
  sessions?: readonly StatusCountable[]
  // Whatever `/model` set, or null/undefined for "the server's default".
  model?: ModelRef | null
  cwd?: string | null
  columns?: number
}

export function Header({ sessions = [], model, cwd, columns = 80 }: HeaderProps) {
  const width = Math.max(20, columns)
  const fit = (text: string) => truncateGraphemes(text, width)
  const modelText = model ? `${model.providerID}/${model.id}` : 'default model'
  const place = cwd ? basename(cwd) || cwd : null
  const big = headerRows(columns) > 3
  return React.createElement(
    Box,
    { flexDirection: 'column' },
    big ? React.createElement(Text, null, ' ') : null, // breathing room above the mascot
    big
      ? React.createElement(
          Box,
          { gap: 2 },
          React.createElement(
            Box,
            { flexDirection: 'column' },
            ...MASCOT.map((row, i) => React.createElement(Text, { key: `m${i}`, color: theme.info }, row)),
          ),
          React.createElement(
            Box,
            { flexDirection: 'column' },
            React.createElement(
              Box,
              { gap: 1 },
              React.createElement(Text, { bold: true }, 'fleetview'),
              React.createElement(Text, { dimColor: true }, `v${VERSION}`),
            ),
            React.createElement(
              Text,
              { dimColor: true },
              truncateGraphemes(place ? `${truncateGraphemes(modelText, Math.max(4, width - MASCOT_WIDTH - place.length - 3))} · ${place}` : modelText, Math.max(8, width - MASCOT_WIDTH)),
            ),
            React.createElement(Text, { dimColor: true }, truncateGraphemes(summarise(sessions), Math.max(8, width - MASCOT_WIDTH))),
          ),
        )
      : React.createElement(
          Box,
          { gap: 1 },
          React.createElement(Text, { bold: true }, 'fleetview'),
          React.createElement(Text, { dimColor: true }, `v${VERSION}`),
        ),
    big
      ? null
      : React.createElement(
          Text,
          { dimColor: true },
          fit(place ? `${truncateGraphemes(modelText, Math.max(4, width - place.length - 3))} · ${place}` : modelText),
        ),
    big ? null : React.createElement(Text, { dimColor: true }, fit(summarise(sessions))),
    big ? React.createElement(Text, null, ' ') : null, // and below, before the first group header
  )
}
