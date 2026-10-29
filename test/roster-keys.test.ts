import { test, expect } from 'vitest'
import { rosterKey, RESUME_QUIET_MS, type RosterKeyState } from '../src/use-roster-keys.ts'
import type { Roster } from '../src/roster-store.ts'
import type { RosterSession } from '../src/ui/view-types.ts'

const row = (id: string, extra: Partial<RosterSession> = {}): RosterSession => ({ id, projectKey: '/repo', status: 'idle', title: id, ...extra }) as RosterSession

const NO_KEY = {
  ctrl: false, shift: false, meta: false, upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
  return: false, tab: false, escape: false, backspace: false, delete: false,
}
const k = (over: Partial<typeof NO_KEY> = {}) => ({ ...NO_KEY, ...over })

const state = (over: Partial<RosterKeyState> = {}): RosterKeyState => ({
  input: '',
  current: row('a'),
  selectedHeader: null,
  navRows: [{ key: 'h' }, { key: 'a' }, { key: 'b' }],
  navSel: 1,
  unfoldedGroups: [],
  suggestions: null,
  view: 'main',
  backgrounded: null,
  allMembers: [],
  now: 10_000,
  resumedAt: 0,
  resumeQuietMs: RESUME_QUIET_MS,
  ctrlCArmedAt: null,
  ...over,
})

test('arrows move the selection on an empty prompt and the caret on a non-empty one', () => {
  expect(rosterKey(state(), '', k({ upArrow: true }))).toEqual({ type: 'select', key: 'h' })
  expect(rosterKey(state({ navSel: 2 }), '', k({ downArrow: true }))).toEqual({ type: 'select', key: 'b' }) // clamped
  expect(rosterKey(state({ navRows: [] }), '', k({ upArrow: true }))).toBeNull()
  expect(rosterKey(state({ input: 'hi' }), '', k({ leftArrow: true }))).toEqual({ type: 'caret', motion: 'left' })
  // → attaches only on an empty prompt
  expect(rosterKey(state(), '', k({ rightArrow: true }))).toEqual({ type: 'attach', row: row('a') })
})

test('^c clears text, arms on an empty prompt, and quits on a second press within 2s', () => {
  expect(rosterKey(state({ input: 'x' }), 'c', k({ ctrl: true }))).toEqual({ type: 'setInput', value: '' })
  expect(rosterKey(state(), 'c', k({ ctrl: true }))).toEqual({ type: 'armCtrlC' })
  expect(rosterKey(state({ ctrlCArmedAt: 9_000 }), 'c', k({ ctrl: true }))).toEqual({ type: 'quit' })
  expect(rosterKey(state({ ctrlCArmedAt: 7_000 }), 'c', k({ ctrl: true }))).toEqual({ type: 'armCtrlC' })
})

test('^x targets the selected header before the selected row; unknown ctrl keys do nothing', () => {
  expect(rosterKey(state({ selectedHeader: 'state:running' }), 'x', k({ ctrl: true }))).toEqual({ type: 'deleteGroup', projectKey: 'state:running' })
  expect(rosterKey(state(), 'x', k({ ctrl: true }))).toEqual({ type: 'stopOrDelete', row: row('a') })
  expect(rosterKey(state(), 'z', k({ ctrl: true }))).toBeNull()
  expect(rosterKey(state({ current: undefined }), 't', k({ ctrl: true }))).toBeNull()
})

test('roster updates: ^a toggles membership, ^t toggles the pin, ^s flips the grouping', () => {
  const roster: Roster = { groupBy: 'state', sessions: [], collapsed: [] }
  const add = rosterKey(state(), 'a', k({ ctrl: true }))
  if (add?.type !== 'roster') throw new Error('expected a roster update')
  const added = add.update(roster)
  expect(added.sessions.map((m) => [m.worktree, m.id])).toEqual([['/repo', 'a']])
  expect(add.update(added).sessions).toEqual([])

  const pin = rosterKey(state(), 't', k({ ctrl: true }))
  if (pin?.type !== 'roster') throw new Error('expected a roster update')
  expect(pin.update(added).sessions[0].pinned).toBe(true)

  const group = rosterKey(state(), 's', k({ ctrl: true }))
  if (group?.type !== 'roster') throw new Error('expected a roster update')
  expect(group.update(roster).groupBy).toBe('project')
})

test('Shift+↑/↓ swaps within the unfolded group and ranks every row in it', () => {
  const [a, b, c] = [row('a'), row('b'), row('c')]
  const s = state({ current: b, unfoldedGroups: [{ sessions: [a, b, c] }] })
  const up = rosterKey(s, '', k({ shift: true, upArrow: true }))
  if (up?.type !== 'roster') throw new Error('expected a roster update')
  const roster: Roster = { groupBy: 'state', collapsed: [], sessions: ['a', 'b', 'c', 'other'].map((id) => ({ worktree: '/repo', id })) }
  expect(up.update(roster).sessions.map((m) => [m.id, m.rank])).toEqual([['a', 1], ['b', 0], ['c', 2], ['other', undefined]])
  // at the edge of the group: nothing
  expect(rosterKey(state({ current: a, unfoldedGroups: [{ sessions: [a, b, c] }] }), '', k({ shift: true, upArrow: true }))).toBeNull()
})

test('Enter and space collapse a selected header only on an empty prompt', () => {
  const s = state({ selectedHeader: 'state:completed', current: undefined })
  expect(rosterKey(s, '', k({ return: true }))).toEqual({ type: 'toggleCollapsed', projectKey: 'state:completed' })
  expect(rosterKey(s, ' ', k())).toEqual({ type: 'toggleCollapsed', projectKey: 'state:completed' })
  expect(rosterKey({ ...s, input: 'fix' }, '', k({ return: true }))).toEqual({ type: 'submit', thenAttach: false })
  expect(rosterKey(state(), '', k({ return: true, meta: true }))).toEqual({ type: 'submit', thenAttach: true })
})

test('space peeks, but says a ghost is gone; ? opens help', () => {
  expect(rosterKey(state(), ' ', k())).toEqual({ type: 'peek', row: row('a') })
  const ghost = row('g', { ghost: true })
  expect(rosterKey(state({ current: ghost }), ' ', k())).toEqual({ type: 'gone', row: ghost })
  expect(rosterKey(state(), '?', k())).toEqual({ type: 'help' })
  expect(rosterKey(state({ input: 'why' }), '?', k())).toEqual({ type: 'insert', text: '?' })
})

test('Tab: @ on an empty prompt, the first suggestion otherwise, nothing without one', () => {
  expect(rosterKey(state(), '', k({ tab: true }))).toEqual({ type: 'setInput', value: '@' })
  expect(rosterKey(state({ input: '@bu' }), '', k({ tab: true }))).toBeNull()
  const suggestions = { partial: 'bu', matches: [{ name: 'build' }, { name: 'bugs' }] }
  expect(rosterKey(state({ input: '@bu', suggestions }), '', k({ tab: true }))).toEqual({ type: 'complete', partial: 'bu', name: 'build' })
})

test('Esc: ignored in the resume quiet window, then clears text, closes browse, undoes a detach, quits', () => {
  const esc = k({ escape: true })
  expect(rosterKey(state({ now: 1_000, resumedAt: 1_000 - RESUME_QUIET_MS + 1, input: 'x' }), '', esc)).toBeNull()
  expect(rosterKey(state({ input: 'x' }), '', esc)).toEqual({ type: 'setInput', value: '' })
  expect(rosterKey(state({ view: 'browse' }), '', esc)).toEqual({ type: 'closeBrowse' })
  const live = row('bg')
  const backgrounded = { id: 'bg', projectKey: '/repo', notice: true }
  expect(rosterKey(state({ backgrounded, allMembers: [live] }), '', esc)).toEqual({ type: 'attach', row: live })
  // the backgrounded session is gone: Esc quits as usual
  expect(rosterKey(state({ backgrounded }), '', esc)).toEqual({ type: 'quit' })
  expect(rosterKey(state(), '', esc)).toEqual({ type: 'quit' })
})

test('Esc honours a custom resumeQuietMs: ignored inside the wider window, live once it lapses', () => {
  const esc = k({ escape: true })
  expect(rosterKey(state({ now: 1_000, resumedAt: 500, resumeQuietMs: 1_000, input: 'x' }), '', esc)).toBeNull()
  expect(rosterKey(state({ now: 1_500, resumedAt: 500, resumeQuietMs: 1_000, input: 'x' }), '', esc)).toEqual({ type: 'setInput', value: '' })
})

test('typed text: control bytes stripped, CRLF kept as a newline, a long paste becomes a placeholder', () => {
  expect(rosterKey(state(), 'a\x07b', k())).toEqual({ type: 'insert', text: 'ab' })
  expect(rosterKey(state(), 'one\r\ntwo', k())).toEqual({ type: 'insert', text: 'one\ntwo' })
  expect(rosterKey(state(), '\x07', k())).toBeNull()
  expect(rosterKey(state(), 'x', k({ meta: true }))).toBeNull()
  expect(rosterKey(state(), 'a\nb\nc', k())).toEqual({ type: 'paste', text: 'a\nb\nc' })
  expect(rosterKey(state(), 'y'.repeat(801), k())).toEqual({ type: 'paste', text: 'y'.repeat(801) })
  expect(rosterKey(state(), '', k({ ctrl: true }))).toBeNull()
  expect(rosterKey(state(), 'j', k({ ctrl: true }))).toEqual({ type: 'insert', text: '\n' })
})
