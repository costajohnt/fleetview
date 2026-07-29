import { test, expect } from 'vitest'
import { pickTarget, repoChoices } from '../src/dispatch-target.ts'

const projects = [{ worktree: '/x/beta' }, { worktree: '/x/alpha' }] // sorted newest-updated first

test('launch cwd wins when opencode already knows it as a project', () => {
  expect(pickTarget({ cwd: '/x/alpha', projects, current: { projectKey: '/x/beta' } })).toBe('/x/alpha')
})

test('an unknown cwd falls back to the selected row rather than dispatching somewhere invisible', () => {
  expect(pickTarget({ cwd: '/somewhere/else', projects, current: { projectKey: '/x/beta' } })).toBe('/x/beta')
})

test('project grouping targets the highlighted row even when cwd is a known project', () => {
  const target = pickTarget({ cwd: '/x/alpha', projects, current: { projectKey: '/x/beta' }, groupBy: 'project' })
  expect(target).toBe('/x/beta')
})

test('with no cwd match and no selection, the most recently updated project wins', () => {
  expect(pickTarget({ cwd: '/somewhere/else', projects })).toBe('/x/beta')
})

test('no projects at all yields null so the caller can say so instead of dispatching nowhere', () => {
  expect(pickTarget({ cwd: '/x/alpha', projects: [] })).toBe(null)
})

// --- @repo completion targets ---

const fakeFs = {
  readDir: (dir: string) => ({ '/home': ['fleetview', 'notes', 'my project'] } as Record<string, string[]>)[dir] ?? [],
  isRepo: (p: string) => p !== '/home/notes', // notes is a plain directory, not a repo
}

test('repoChoices lists projects with sessions plus git repos one level below cwd', () => {
  const choices = repoChoices({ cwd: '/home', projects: [{ worktree: '/elsewhere/sandbox' }], ...fakeFs })
  expect(choices.map((c) => c.name).sort()).toEqual(['fleetview', 'sandbox'])
})

test('repoChoices skips non-repos and names containing a space', () => {
  const names = repoChoices({ cwd: '/home', projects: [], ...fakeFs }).map((c) => c.name)
  expect(names).not.toContain('notes') // not a git repo
  expect(names).not.toContain('my project') // agent view skips these too
})

test('a project already in the list wins over a same-named directory below cwd', () => {
  const choices = repoChoices({ cwd: '/home', projects: [{ worktree: '/elsewhere/fleetview' }], ...fakeFs })
  expect(choices.filter((c) => c.name === 'fleetview')).toEqual([{ name: 'fleetview', worktree: '/elsewhere/fleetview' }])
})
