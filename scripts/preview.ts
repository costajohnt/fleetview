// Deterministic UI previews: render each canonical surface with fixture data and write the raw
// frames (ANSI included) to docs/previews/. CI regenerates and diffs, so every visual change
// shows up in a PR as a readable before/after instead of hiding behind a green suite.
//
// FORCE_COLOR pins color output on (CI is colorless otherwise) and FLEETVIEW_REDUCED_MOTION pins
// every animation to frame 0, so the frames are byte-stable everywhere. Set BEFORE imports —
// chalk reads the environment once at load.
process.env.FORCE_COLOR = '3'
process.env.FLEETVIEW_REDUCED_MOTION = '1'

// Type-only, so it is erased and cannot import anything before the env above is set.
import type { RosterSession } from '../src/ui/view-types.ts'

const React = (await import('react')).default
const { render } = await import('ink-testing-library')
const { writeFileSync, mkdirSync } = await import('node:fs')
const { dirname, join } = await import('node:path')
const { fileURLToPath } = await import('node:url')

const { Roster } = await import('../src/ui/roster.ts')
const { DispatchInput } = await import('../src/ui/dispatch-input.ts')
const { Peek } = await import('../src/ui/peek.ts')
const { Help } = await import('../src/ui/help.ts')
const { Header } = await import('../src/ui/header.ts')

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'previews')
mkdirSync(OUT, { recursive: true })

const COLUMNS = 100
// A fixed "now" so ages are stable: sessions carry timestamps relative to it.
const NOW = 1_753_000_000_000

const pr = (number: number, state = 'OPEN') => ({
  number,
  url: `https://github.com/o/r/pull/${number}`,
  state,
  isDraft: false,
  headRefName: 'opencode/x',
  statusCheckRollup: [],
  reviewDecision: '',
})

const session = (id: string, title: string, status: string, over: Partial<RosterSession> = {}): RosterSession => ({
  id,
  projectKey: '/repo',
  title,
  status,
  updatedAt: NOW - 3 * 60_000,
  createdAt: NOW - 3 * 60_000,
  ...over,
})

const groups = [
  {
    projectKey: 'state:waiting',
    repoName: 'needs input',
    empty: true,
    sessions: [session('s1', 'fix the flaky tests', 'waiting', { snippet: 'should I delete the retry loop?' })],
  },
  {
    projectKey: 'state:running',
    repoName: 'working',
    empty: true,
    sessions: [session('s2', 'port the parser', 'running', { snippet: 'rewriting tokenizer edge cases' })],
  },
  {
    projectKey: 'state:completed',
    repoName: 'completed',
    empty: true,
    sessions: [
      session('s3', 'update the readme', 'done', { ranForMs: 4 * 60_000, prs: [pr(7, 'MERGED')] }),
      session('s4', 'spike the importer', 'error', { ranForMs: 11 * 60_000 }),
    ],
  },
]

const shoot = (name: string, element: React.ReactElement) => {
  const frame = render(element).lastFrame() ?? ''
  writeFileSync(join(OUT, `${name}.txt`), frame + '\n')
  console.log(`${name}: ${frame.split('\n').length} rows`)
}

shoot('header', React.createElement(Header, { sessions: groups.flatMap((g) => g.sessions), model: null, cwd: '/repo', columns: COLUMNS }))
shoot('roster', React.createElement(Roster, { groups, selectedKey: 'state:waiting:s1', offlineProjects: new Set(), columns: COLUMNS, now: NOW }))
shoot('roster-collapsed', React.createElement(Roster, { groups, selectedKey: 'header:state:completed', offlineProjects: new Set(), collapsed: new Set(['state:completed']), columns: COLUMNS, now: NOW }))
shoot('input-focused', React.createElement(DispatchInput, { value: '', view: 'main', kind: 'empty', columns: COLUMNS, focused: true }))
shoot('input-typing', React.createElement(DispatchInput, { value: 'fix the importer @reviewer', view: 'main', kind: 'dispatch', columns: COLUMNS, focused: true }))
shoot('input-unfocused', React.createElement(DispatchInput, { value: '', view: 'main', kind: 'empty', columns: COLUMNS, focused: false }))
shoot('peek', React.createElement(Peek, {
  target: session('s1', 'fix the flaky tests', 'waiting', { prs: [pr(9)] }),
  messages: [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'Should I delete the retry loop or raise its timeout?' }] }],
  pending: [],
  pendingQuestions: [],
  columns: COLUMNS,
  now: NOW,
}))
shoot('help', React.createElement(Help, { columns: COLUMNS, maxRows: 30 }))
