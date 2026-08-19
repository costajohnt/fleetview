import React from 'react'
import { Box, Text } from 'ink'
import { StatusBadge, badgeLabel, stateLabel, stateColor, usePulse } from './status-badge.ts'
import { truncateGraphemes, graphemes, osc8 } from '../text-utils.ts'
import { prLabel, mostUrgentPr, prColor } from '../pull-requests.ts'

import { theme } from './theme.ts'
import type { KeySet, RosterGroup, RosterLine, RosterSession } from './view-types.ts'

export const flattenGroups = (groups: RosterGroup[]) => groups.flatMap((g) => g.sessions)

// Pure: relative-time label for a row's dim metadata suffix. now defaults to Date.now() at call
// time (component callers), but takes an explicit `now` so it's deterministically unit-testable.
export function relTime(ms: number, now = Date.now()) {
  const sec = Math.floor(Math.max(0, now - ms) / 1000)
  if (sec < 60) return 'now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  return `${Math.floor(hr / 24)}d`
}

// A finished session's age stops being a clock and becomes a duration: agent view's age "counts
// from when the session was created; a finished session's age freezes at how long the run took".
// The `in 4m`-style prefix agent view uses for sleeping loops has no opencode analog, so a frozen
// duration renders bare.
export function ageLabel(session: Pick<RosterSession, 'ranForMs' | 'createdAt' | 'updatedAt'>, now = Date.now()) {
  if (typeof session.ranForMs === 'number') return spanLabel(session.ranForMs)
  const from = session.createdAt || session.updatedAt
  return typeof from === 'number' && from > 0 ? relTime(from, now) : null
}

function spanLabel(ms: number) {
  const sec = Math.floor(Math.max(0, ms) / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  return hr < 24 ? `${hr}h` : `${Math.floor(hr / 24)}d`
}

// M3: budget left for the snippet after everything else in the row — marker, badge, title, the
// optional project label, and the optional relative-time suffix — is measured, grapheme-safe
// (text-utils), so a row never wraps past one physical terminal line regardless of `columns`.
// ponytail: width is grapheme count per cell (matches peek.ts's wrapLines), not true wcwidth —
// wide/emoji glyphs can still overrun by a cell or two; upgrade both together if that ever bites.
function snippetBudget(columns: number, fixedParts: string[]) {
  const used = fixedParts.reduce((sum, p) => sum + graphemes(p).length, 0) + fixedParts.length // + one gap per part (N-1 internal + 1 leading into the snippet)
  return Math.max(0, columns - used - 2) // -2 for the snippet's own "— " prefix
}

// Flat list of renderable line-descriptors (group headers, session rows, hidden-count lines) —
// the unit windowLines() operates on, so viewport math never has to know about groups.
// Group headers are rows you can land on, which is what makes "Enter on a group header collapses
// it" and "Ctrl+X on a group header deletes every session in it" possible at all. A collapsed group
// keeps its header and hides its sessions, and its arrow says which it is.
export const headerKey = (projectKey: string) => `header:${projectKey}`

export function buildLines(groups: RosterGroup[], offlineProjects: KeySet = new Set(), collapsed: KeySet = new Set()) {
  const lines: RosterLine[] = []
  for (const g of groups) {
    const suffix = offlineProjects.has(g.projectKey) ? ' (offline)' : ''
    const isCollapsed = collapsed.has(g.projectKey)
    // A blank spacer row between groups, agent-view style — breathing room the eye uses to find
    // section boundaries. Counted by foldCompleted, skipped by navigation.
    if (lines.length > 0) lines.push({ type: 'spacer', key: `spacer:${g.projectKey}` })
    // The collapse state renders at the row's right edge (John's spec): a collapsed header always
    // carries its `▸` and hidden count; an expanded one shows `▾` only while the cursor is on it.
    lines.push({
      type: 'header',
      key: headerKey(g.projectKey),
      projectKey: g.projectKey,
      collapsed: isCollapsed,
      text: isCollapsed ? `${g.repoName}${suffix} (${g.sessions.length})` : `${g.repoName}${suffix}`,
    })
    if (isCollapsed) continue
    for (const s of g.sessions) lines.push({ type: 'session', key: `${g.projectKey}:${s.id}`, session: s })
    // An always-shown group (state grouping) with nothing in it draws a dim placeholder rather
    // than collapsing away, so the three categories keep their shape from the first launch on.
    if (g.sessions.length === 0 && g.empty) {
      // A description under the empty header, agent view style: it teaches a first-time user what the
      // section is for. Falls back to `no items` for any empty group without one (e.g. a project).
      lines.push({ type: 'placeholder', key: `empty:${g.projectKey}`, text: g.hint ? `  ${g.hint}` : '  no items' })
    }
    if ((g.hidden ?? 0) > 0) lines.push({ type: 'hidden', key: `hidden:${g.projectKey}`, text: `  … ${g.hidden} more` })
  }
  return lines
}

// The rows ↑/↓ can land on, in screen order — headers and sessions, never the `… N more` marker,
// which is a count rather than a thing to act on. App navigates this; the roster draws from the
// same buildLines, so the two can't disagree about what is on screen.
export const navigableRows = (groups: RosterGroup[], collapsed?: Set<string>) =>
  buildLines(groups, new Set(), collapsed).filter((l) => l.type === 'header' || l.type === 'session')

// Pure: window `lines` to fit `maxRows` (reserving 2 rows for ↑/↓ edge indicators), keeping
// `selectedIdx` in view — centered when possible, clamped at the list's edges.
// Generic in the line type: the roster passes RosterLine[], and App's tests (and the viewport unit
// tests) pass plain values, which the counting rule below deliberately still supports.
export function windowLines<T>(lines: readonly T[], selectedIdx: number, maxRows: number) {
  // Below 3 rows there is no room for a slice plus both indicators, and the old floor of 1 row
  // still added them — rendering 3 lines however small maxRows got, including when it went
  // negative on a tiny terminal. The contract is "fits"; drop the indicators instead.
  if (maxRows <= 2) {
    const size = Math.max(1, maxRows)
    const start = Math.min(Math.max(0, selectedIdx), Math.max(0, lines.length - size))
    return { slice: lines.slice(start, start + size), above: 0, below: 0 }
  }
  const size = Math.max(1, maxRows - 2)
  if (lines.length <= size) return { slice: lines, above: 0, below: 0 }
  let start = Math.max(0, selectedIdx - Math.floor(size / 2))
  start = Math.min(start, lines.length - size)
  const end = start + size
  // Count sessions, not lines: group headers and fold markers are chrome the user has already
  // seen, and counting them makes `↑ 12 more` promise sessions that aren't there. Untyped entries
  // are counted as-is, so the function still means "lines" for callers that pass plain values.
  const kindOf = (l: unknown) => (typeof l === 'object' && l !== null && 'type' in l ? l.type : undefined)
  const sessionsIn = (from: number, to: number) =>
    lines.slice(from, to).filter((l) => kindOf(l) === undefined || kindOf(l) === 'session').length
  return {
    slice: lines.slice(start, end),
    above: sessionsIn(0, start),
    below: sessionsIn(end, lines.length),
  }
}

// The title takes at most half the row. A dispatch prompt is shown raw as the provisional title
// until opencode names the session ~20s later, so an unbounded title is the common case, not the
// pathological one — and a wrapped row breaks the viewport arithmetic, which counts it as one line.
export function titleBudget(columns: number) {
  return Math.max(8, Math.floor((columns || 80) / 2))
}

// Rows are name + state + summary + age, and never the directory: agent view shows the directory
// only in its group headers, so a state-grouped row has nowhere to put it. markMembers: browse
// view — Set of `${worktree}:${id}` roster members, flagged with a dim `[roster]` suffix so
// browsing shows current membership.
export type RosterProps = {
  groups: RosterGroup[]
  // Index into the flattened sessions — the pre-header selection model, still accepted (see below).
  selected?: number
  selectedKey?: string
  offlineProjects: KeySet
  collapsed?: KeySet
  maxRows?: number
  columns?: number
  // Browse view: `${projectKey}:${id}` of every roster member, flagged with a dim `[roster]`.
  markMembers?: KeySet
  showStateWord?: boolean
  showBackendTag?: boolean
  // #126: `${projectKey}:${id}` of the session the user last attached to; its title renders bold.
  lastAttachedKey?: string
  now?: number
}

export function Roster({
  groups,
  selected,
  selectedKey,
  offlineProjects,
  collapsed = new Set(),
  maxRows = Infinity,
  columns = 80,
  markMembers,
  showStateWord = false,
  // "Roster rows carry a backend tag when more than one is active." Off by default and off whenever
  // one backend holds every session, so the opencode-only row is byte-for-byte what it was: no tag,
  // no gap, no change to the snippet budget.
  showBackendTag = false,
  lastAttachedKey,
  now,
}: RosterProps) {
  const flat = flattenGroups(groups)
  const lines = buildLines(groups, offlineProjects, collapsed)
  // Selection is a key now that headers are selectable too. `selected` (an index into the sessions)
  // stays accepted so existing callers and tests that predate headers keep working.
  const selectedSession = selectedKey === undefined && selected !== undefined ? flat[selected] : undefined
  const selectedLineIdx = Math.max(
    0,
    selectedKey === undefined
      ? lines.findIndex((l) => l.type === 'session' && l.session === selectedSession)
      : lines.findIndex((l) => l.key === selectedKey),
  )
  const { slice, above, below } = windowLines(lines, selectedLineIdx, maxRows)
  // Only animate while something is actually running, and only over the rows on screen.
  const frame = usePulse(slice.some((l) => l.type === 'session' && l.session.status === 'running'))

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    above > 0 ? React.createElement(Text, { dimColor: true }, `↑ ${above} more`) : null,
    ...slice.map((line) => {
      if (line.type === 'header') {
        const headerSelected = selectedKey !== undefined && line.key === selectedKey
        // Selection is a row highlight now, not a marker glyph (John's call): the whole line is
        // one Text so the background paints edge to edge, with the pieces nested inside it.
        const tail = line.collapsed ? '▸ collapsed' : headerSelected ? '▾ expanded' : ''
        const pad = Math.max(1, columns - 2 - graphemes(line.text).length - graphemes(tail).length)
        return React.createElement(
          Text,
          { key: line.key, backgroundColor: headerSelected ? theme.selectionBg : undefined, wrap: 'truncate' },
          '  ',
          // Every header is bold in the neutral secondary grey — agent view gives headers no
          // per-state color; the state lives in the row glyphs. A selected header goes white on
          // the bar, the same treatment a selected session row gets.
          React.createElement(Text, { bold: true, color: headerSelected ? theme.selectionFg : theme.header }, line.text),
          ' '.repeat(pad),
          // Right edge: a collapsed group always says so; an expanded one says so while it is
          // selected, so ⏎'s meaning is visible before pressing it.
          tail ? React.createElement(Text, { dimColor: true }, tail) : '',
        )
      }
      if (line.type === 'spacer') return React.createElement(Text, { key: line.key }, ' ')
      if (line.type === 'hidden') return React.createElement(Text, { key: line.key, dimColor: true }, line.text)
      if (line.type === 'placeholder') return React.createElement(Text, { key: line.key, dimColor: true }, line.text)
      const s = line.session
      const isSelected = selectedKey === undefined ? s === selectedSession : line.key === selectedKey
      const isLastAttached = lastAttachedKey !== undefined && line.key === lastAttachedKey
      const isMember = markMembers?.has(`${s.projectKey}:${s.id}`)
      const isOffline = offlineProjects.has(s.projectKey)
      const timeText = ageLabel(s, now)
      // Grouped by project the header names the directory, not the state, so the summary has to
      // carry the state itself: "the summary opens with the session's state as a colored word".
      const stateWord = showStateWord ? stateLabel(s.status) : null
      // Which CLI is behind the row. Sits where the state word does — immediately after the title,
      // before the summary — because it answers the same kind of question about the row, and the
      // right edge is already spoken for by the pull request label and the age.
      const backendTag = showBackendTag ? s.backend ?? 'opencode' : null
      // The `#N` pull-request label agent view puts at the right edge, before the age (`#2048 2h`),
      // coloured by the pull request most needing attention and hyperlinked (OSC 8) for a single one.
      // It exists so a session the completed-fold deliberately keeps on screen shows *why*.
      const prBadge = prLabel(s.prs)
      const prUrgent = prBadge ? mostUrgentPr(s.prs) : null
      const prUrl = prBadge?.startsWith('#') ? prUrgent?.url : null // only a single PR links to one url
      // Padded to the full title column, not just truncated: every snippet then starts at the
      // same column, so the roster reads as title column | summary column, agent-view style.
      const rawTitle = truncateGraphemes(s.title ?? '', titleBudget(columns))
      const title = rawTitle + ' '.repeat(Math.max(0, titleBudget(columns) - graphemes(rawTitle).length))
      // The predicate is what `.filter(Boolean)` already does at runtime — spelled out so the
      // budget math below sees strings rather than "string or the absent parts we just dropped".
      const fixedParts = [' ', badgeLabel(), title, timeText, prBadge, stateWord, backendTag, isMember ? '[roster]' : null].filter(
        (p): p is string => Boolean(p),
      )
      // The right-aligned cluster is the PR label then the age; each present part costs one gap.
      const budget = snippetBudget(columns, fixedParts) - (timeText ? 1 : 0) - (prBadge ? 1 : 0)
      // M3: below-zero budget means even the "— " prefix has no room — drop the snippet entirely
      // rather than render a bare "— " that pushes the row past `columns` anyway.
      const snippetText = s.snippet && budget > 0 ? `— ${truncateGraphemes(s.snippet, budget)}` : null
      // One Text per row so a selection paints as a full-width highlight (no marker glyph): the
      // colored pieces nest inside, explicit single spaces replace Box gaps, and computed padding
      // replaces the flexGrow spacer.
      const leftLen =
        2 + 1 + 1 + graphemes(title).length +
        (stateWord ? graphemes(stateWord).length + 1 : 0) +
        (backendTag ? graphemes(backendTag).length + 1 : 0) +
        (snippetText ? graphemes(snippetText).length + 1 : 0) +
        (isMember ? '[roster]'.length + 1 : 0)
      // The right cluster is `<#N> <age>` — either can be absent. Its visible width drives the pad,
      // so the OSC 8 escapes (zero width) around the label never shift the alignment.
      const rightText = [prBadge, timeText].filter(Boolean).join(' ')
      const pad = rightText ? Math.max(1, columns - leftLen - graphemes(rightText).length) : 0
      // The selection bar must span the whole terminal row, but Ink's backgroundColor covers only
      // the text extent — so a selected row pads its tail out to `columns`. Unselected rows skip
      // the padding and stay byte-identical to what they always were.
      const endPad = isSelected ? Math.max(0, columns - leftLen - (rightText ? pad + graphemes(rightText).length : 0)) : 0
      return React.createElement(
        Text,
        { key: line.key, backgroundColor: isSelected ? theme.selectionBg : undefined, wrap: 'truncate' },
        '  ',
        React.createElement(StatusBadge, { status: s.status, alive: !isOffline, frame }),
        ' ',
        // Title: white on the selection bar, otherwise the secondary grey the snippet uses — agent
        // view's rows carry color only in the state glyph until selected. Pinned and last-attached stay bold.
        React.createElement(Text, { bold: Boolean(s.pinned) || isLastAttached, color: isSelected ? theme.selectionFg : undefined, dimColor: !isSelected }, title),
        stateWord ? React.createElement(Text, { color: stateColor(s.status) }, ` ${stateWord}`) : '',
        backendTag ? React.createElement(Text, { dimColor: true }, ` ${backendTag}`) : '',
        snippetText ? React.createElement(Text, { dimColor: true }, ` ${snippetText}`) : '',
        isMember ? React.createElement(Text, { dimColor: true }, ' [roster]') : '',
        rightText ? ' '.repeat(pad) : '',
        // `prBadge && prUrgent` rather than a non-null assertion on prUrgent: both come from the
        // same badgeable-PR list, so a badge without an urgent PR cannot happen — and the narrowing
        // says so without asserting it.
        prBadge && prUrgent ? React.createElement(Text, { color: prColor(prUrgent) }, prUrl ? osc8(prUrl, prBadge) : prBadge) : '',
        prBadge && timeText ? ' ' : '',
        timeText ? React.createElement(Text, { dimColor: true }, timeText) : '',
        endPad ? ' '.repeat(endPad) : '',
      )
    }),
    below > 0 ? React.createElement(Text, { dimColor: true }, `↓ ${below} more`) : null,
  )
}
