import { test, expect } from 'vitest'
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRoster, makePersistRoster, saveRoster, withRosterLock } from '../src/roster-store.ts'

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'fleetview-roster-sync-')), 'roster.json')

// M12: a persist that merged a foreign (`fleetview bg`) member onto disk used to stamp the file as
// seen, so the next reload answered "unchanged" and the member never reached the running TUI.
test('a persist that carried a foreign member leaves it for the next reload to surface', () => {
  const file = tmpFile()
  const mine = { worktree: '/x', id: 'mine', addedAt: 1 }
  const roster: any = { groupBy: 'state', sessions: [mine], collapsed: [] }
  saveRoster(file, roster)
  const persist = makePersistRoster({ roster, file })
  // another process appends while this instance holds its snapshot
  saveRoster(file, { ...roster, sessions: [mine, { worktree: '/x', id: 'bg', addedAt: 2 }] })
  persist({ ...roster, sessions: [{ ...mine, pinned: true }] }) // a pin in this instance
  const reloaded = persist.reload()
  expect(reloaded?.sessions.map((m) => m.id)).toEqual(['mine', 'bg'])
})

test('a persist with nothing foreign is still stamped as seen', () => {
  const file = tmpFile()
  const roster: any = { groupBy: 'state', sessions: [{ worktree: '/x', id: 'mine', addedAt: 1 }], collapsed: [] }
  saveRoster(file, roster)
  const persist = makePersistRoster({ roster, file })
  persist({ ...roster, collapsed: ['state:completed'] })
  expect(persist.reload()).toBeNull()
})

// L10: a stale lock is moved aside atomically and the holder proceeds; nothing is left behind.
test('a stale lock is broken and leaves no lock or aside file', () => {
  const file = tmpFile()
  saveRoster(file, { groupBy: 'state', sessions: [], collapsed: [] })
  writeFileSync(`${file}.lock`, '')
  const old = (Date.now() - 60_000) / 1000
  utimesSync(`${file}.lock`, old, old)
  const started = Date.now()
  expect(withRosterLock(file, () => 'ran')).toBe('ran')
  expect(Date.now() - started).toBeLessThan(1000) // broken on sight, not waited out
  expect(readdirSync(join(file, '..')).filter((f) => f.includes('.lock'))).toEqual([])
  expect(loadRoster(file).sessions).toEqual([])
})
