import { test, expect } from 'vitest'
import { pickTarget, repoChoices, defaultProjectFromEnv } from '../src/dispatch-target.ts'

const projects = [{ worktree: '/x/beta' }, { worktree: '/x/alpha' }] // sorted newest-updated first
const dirExists = () => true // these paths are fixtures, not real directories

test('launch cwd wins when opencode already knows it as a project', () => {
  expect(pickTarget({ cwd: '/x/alpha', projects, current: { projectKey: '/x/beta' }, dirExists })).toBe('/x/alpha')
})

test('an unknown cwd falls back to the selected row rather than dispatching somewhere invisible', () => {
  expect(pickTarget({ cwd: '/somewhere/else', projects, current: { projectKey: '/x/beta' }, dirExists })).toBe('/x/beta')
})

test('project grouping targets the highlighted row even when cwd is a known project', () => {
  const target = pickTarget({ cwd: '/x/alpha', projects, current: { projectKey: '/x/beta' }, groupBy: 'project', dirExists })
  expect(target).toBe('/x/beta')
})

test('with no cwd match and no selection, the most recently updated project wins', () => {
  expect(pickTarget({ cwd: '/somewhere/else', projects, dirExists })).toBe('/x/beta')
})

test('no projects at all yields null so the caller can say so instead of dispatching nowhere', () => {
  expect(pickTarget({ cwd: '/x/alpha', projects: [], dirExists })).toBe(null)
})

// --- pinned default target (#119) ---
//
// The reported failure: the newest-updated project keeps winning, so every bare dispatch lands in a
// repository the user never dispatches to. A pinned default has to beat that, and the highlighted
// row under state grouping with it, while still losing to the two explicit signals.

test('the configured default beats the newest-updated project', () => {
  expect(pickTarget({ cwd: '/somewhere/else', projects, defaultProject: '/x/pinned', dirExists })).toBe('/x/pinned')
})

test('the configured default beats a highlighted row that is not a project grouping', () => {
  const target = pickTarget({ cwd: '/somewhere/else', projects, current: { projectKey: '/x/beta' }, defaultProject: '/x/pinned', dirExists })
  expect(target).toBe('/x/pinned')
})

test('a known launch cwd and a project-grouped row still outrank the configured default', () => {
  expect(pickTarget({ cwd: '/x/alpha', projects, defaultProject: '/x/pinned', dirExists })).toBe('/x/alpha')
  const grouped = pickTarget({ cwd: '/somewhere/else', projects, current: { projectKey: '/x/beta' }, groupBy: 'project', defaultProject: '/x/pinned', dirExists })
  expect(grouped).toBe('/x/beta')
})

// The default names a repository precisely because recency keeps losing to it — a directory that
// has gone away must not strand dispatch there.
test('a configured default that no longer exists falls through to the projects', () => {
  const target = pickTarget({ cwd: '/somewhere/else', projects, defaultProject: '/x/pinned', dirExists: (d) => d !== '/x/pinned' })
  expect(target).toBe('/x/beta')
})

test('defaultProjectFromEnv expands a tilde, resolves a relative path, and ignores blanks', () => {
  expect(defaultProjectFromEnv({ FLEETVIEW_DEFAULT_PROJECT: '~/repos/ui' }, '/home/j', '/base')).toBe('/home/j/repos/ui')
  expect(defaultProjectFromEnv({ FLEETVIEW_DEFAULT_PROJECT: '~' }, '/home/j', '/base')).toBe('/home/j')
  expect(defaultProjectFromEnv({ FLEETVIEW_DEFAULT_PROJECT: '../sibling' }, '/home/j', '/base/here')).toBe('/base/sibling')
  expect(defaultProjectFromEnv({ FLEETVIEW_DEFAULT_PROJECT: '/abs/path' }, '/home/j', '/base')).toBe('/abs/path')
  expect(defaultProjectFromEnv({ FLEETVIEW_DEFAULT_PROJECT: '  ' }, '/home/j', '/base')).toBe(undefined)
  expect(defaultProjectFromEnv({}, '/home/j', '/base')).toBe(undefined)
  // `~backup` is a directory name, not a home reference — expanding it would invent a path
  expect(defaultProjectFromEnv({ FLEETVIEW_DEFAULT_PROJECT: '~backup' }, '/home/j', '/base')).toBe('/base/~backup')
})

// --- stale worktrees (#102) ---

test('a project whose worktree was deleted is skipped for the next one', () => {
  const target = pickTarget({ cwd: '/somewhere/else', projects, dirExists: (d) => d === '/x/alpha' })
  expect(target).toBe('/x/alpha')
})

test('a deleted selection and cwd both fall through to a project that still exists', () => {
  const target = pickTarget({
    cwd: '/x/beta',
    projects,
    current: { projectKey: '/x/beta' },
    groupBy: 'project',
    dirExists: (d) => d === '/x/alpha',
  })
  expect(target).toBe('/x/alpha')
})

test('every worktree gone yields null rather than a target that can never dispatch', () => {
  expect(pickTarget({ cwd: '/x/alpha', projects, current: { projectKey: '/x/beta' }, dirExists: () => false })).toBe(null)
})

// --- @repo completion targets ---

const fakeFs = {
  readDir: (dir: string) => ({ '/home': ['fleetview', 'notes', 'my project'] } as Record<string, string[]>)[dir] ?? [],
  isRepo: (p: string) => p !== '/home/notes', // notes is a plain directory, not a repo
  dirExists: () => true, // these paths are fixtures, not real directories
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

test('a project whose worktree was deleted is not offered as an @repo target (#102)', () => {
  const names = repoChoices({
    cwd: '/home',
    projects: [{ worktree: '/elsewhere/sandbox' }],
    ...fakeFs,
    dirExists: (d) => d !== '/elsewhere/sandbox',
  }).map((c) => c.name)
  expect(names).not.toContain('sandbox')
  expect(names).toContain('fleetview') // the cwd scan is unaffected
})

test('a deleted project does not shadow a live same-named directory below cwd', () => {
  const choices = repoChoices({
    cwd: '/home',
    projects: [{ worktree: '/elsewhere/fleetview' }],
    ...fakeFs,
    dirExists: (d) => d !== '/elsewhere/fleetview',
  })
  expect(choices.filter((c) => c.name === 'fleetview')).toEqual([{ name: 'fleetview', worktree: '/home/fleetview' }])
})

test('a project already in the list wins over a same-named directory below cwd', () => {
  const choices = repoChoices({ cwd: '/home', projects: [{ worktree: '/elsewhere/fleetview' }], ...fakeFs })
  expect(choices.filter((c) => c.name === 'fleetview')).toEqual([{ name: 'fleetview', worktree: '/elsewhere/fleetview' }])
})
