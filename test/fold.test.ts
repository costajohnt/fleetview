import { test, expect } from 'vitest'
import { foldCompleted } from '../src/app.ts'

const g = (key: string, ...statuses: any[]) => ({
  projectKey: `state:${key}`,
  repoName: key,
  sessions: statuses.map((status, i) => ({ projectKey: '/x/a', id: `${key}${i}`, status })),
})

test('nothing folds while everything fits', () => {
  const groups = [g('working', 'running'), g('completed', 'done', 'done')]
  expect(foldCompleted(groups, 20)).toBe(groups)
})

// The fold costs a line of its own for `… N more`, so the arithmetic has to account for it —
// otherwise the "folded" list still overflows by one row.
const rendered = (groups: any[]) =>
  groups.reduce((n, group) => n + 1 + group.sessions.length + (group.hidden > 0 ? 1 : 0), 0) +
  Math.max(0, groups.length - 1) // the blank spacer row drawn between adjacent groups

test('completed folds to a hidden count when the screen runs out', () => {
  const groups = [g('working', 'running'), g('completed', 'done', 'done', 'done', 'done')]
  const folded = foldCompleted(groups, 6) // 2 headers + 1 spacer + 1 working + 4 completed = 8
  const [, completed] = folded
  expect(completed.sessions).toHaveLength(1)
  expect(completed.hidden).toBe(3)
  expect(rendered(folded)).toBe(6) // fits exactly, counting the fold's own line
})

test('a folded list never renders more rows than it was given', () => {
  for (const total of [5, 8, 13, 21]) {
    for (const maxRows of [4, 6, 10]) {
      const groups = [g('working', 'running'), { ...g('completed'), sessions: Array.from({ length: total }, () => ({ status: 'done' })) }]
      expect(rendered(foldCompleted(groups, maxRows)), `${total} completed in ${maxRows} rows`).toBeLessThanOrEqual(
        Math.max(maxRows, 5), // 2 headers + spacer + the working row + the fold line is the floor
      )
    }
  }
})

test('failures survive the fold even when nothing else does', () => {
  const groups = [g('working', 'running', 'running', 'running'), g('completed', 'error', 'error', 'done', 'done')]
  const [, completed] = foldCompleted(groups, 6)
  expect(completed.sessions.map((s: any) => s.status)).toEqual(['error', 'error'])
  expect(completed.hidden).toBe(2)
})

test('a roster with no completed group is left alone', () => {
  const groups = [g('working', 'running', 'running')]
  expect(foldCompleted(groups, 1)).toBe(groups)
})

// "Failures and sessions with an open pull request always stay visible." Only the failures half
// was implemented, so a completed session with a live pull request folded away like any other
// success — the row you most want to see after a batch of work finishes.
//
// These cases have to be built so `protectedCount` is the BINDING constraint, or they pass whether
// or not the fix is present: foldCompleted keeps a prefix and never reorders (the sort in
// stateGroups puts protected rows first), so a protected row placed at the front survives on
// position alone. With 6 sessions and maxRows 3 the unprotected arithmetic keeps exactly 1 row,
// so anything that must survive beyond the first is only kept by being counted as protected.
const plain = (n: number) => Array.from({ length: n }, (_, i) => ({ projectKey: '/x/a', id: `d${i}`, status: 'done' }))
const withPr = (id: string, over?: any) => ({ projectKey: '/x/a', id, status: 'done', prs: [{ number: 1, state: 'OPEN', isDraft: false, ...over }] })
const completedOf = (sessions: any) => ({ projectKey: 'state:completed', repoName: 'completed', sessions })

test('completed sessions with an open pull request are all kept, not just the first', () => {
  const live = [withPr('pr-a'), withPr('pr-b'), withPr('pr-c')]
  const kept = foldCompleted([completedOf([...live, ...plain(3)])], 3)[0].sessions.map((s: any) => s.id)
  expect(kept).toEqual(['pr-a', 'pr-b', 'pr-c']) // unprotected arithmetic would keep only pr-a
})

// A draft is still live work, and gh reports state OPEN for it with isDraft as a separate field.
test('a draft pull request counts as open for the fold', () => {
  const drafts = [withPr('dr-a', { isDraft: true }), withPr('dr-b', { isDraft: true }), withPr('dr-c', { isDraft: true })]
  const kept = foldCompleted([completedOf([...drafts, ...plain(3)])], 3)[0].sessions.map((s: any) => s.id)
  expect(kept).toEqual(['dr-a', 'dr-b', 'dr-c'])
})

// The inverse, and the reason a non-empty `prs` array is the wrong test: `gh pr list --state all`
// leaves merged and closed pull requests in this array indefinitely. Protecting on them would pin
// a session whose work landed weeks ago to the screen while folding away one still in flight.
test('merged and closed pull requests do not protect a completed session', () => {
  const dead = [withPr('pr-merged', { state: 'MERGED' }), withPr('pr-closed', { state: 'CLOSED' }), withPr('pr-gone', { state: 'CLOSED' })]
  const kept = foldCompleted([completedOf([...dead, ...plain(3)])], 3)[0].sessions.map((s: any) => s.id)
  expect(kept).toEqual(['pr-merged']) // one row, on position alone — none of them counted as protected
})

// foldCompleted is called with rows that predate PR decoration, so the predicate must tolerate a
// missing `prs` field rather than throwing inside a render.
test('a session with no prs field does not throw', () => {
  expect(() => foldCompleted([completedOf(plain(6))], 3)).not.toThrow()
})
