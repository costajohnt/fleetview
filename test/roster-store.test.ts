import { test, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readdirSync, mkdirSync, rmdirSync, existsSync, rmSync, utimesSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadRoster, saveRoster, hasSession, makePersistRoster } from '../src/roster-store.ts'
import { waitFor } from './helpers.ts'

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'fleetview-roster-')), 'roster.json')

test('loadRoster returns default shape when file missing', () => {
  expect(loadRoster(tmpFile())).toEqual({ groupBy: 'state', sessions: [], collapsed: [] })
})

test('saveRoster + loadRoster roundtrip', () => {
  const file = tmpFile()
  const roster: any = { groupBy: 'state', sessions: [{ worktree: '/x', id: 's1', addedAt: 100 }], collapsed: ['state:idle'] }
  saveRoster(file, roster)
  expect(loadRoster(file)).toEqual(roster)
})

// A roster.json written before groups could be collapsed still loads, and gains the field.
test('a roster from before collapsing is read as having nothing collapsed', () => {
  const file = tmpFile()
  saveRoster(file, { groupBy: 'project', sessions: [{ worktree: '/x', id: 's1', addedAt: 1 }] } as any)
  expect(loadRoster(file)).toEqual({
    groupBy: 'project',
    sessions: [{ worktree: '/x', id: 's1', addedAt: 1 }],
    collapsed: [],
  })
})

test('a collapsed list of the wrong shape is tolerated as nothing collapsed', () => {
  const file = tmpFile()
  saveRoster(file, { groupBy: 'state', sessions: [], collapsed: { nope: true } } as any)
  expect(loadRoster(file).collapsed).toEqual([])
  saveRoster(file, { groupBy: 'state', sessions: [], collapsed: ['ok', 7, null] } as any)
  expect(loadRoster(file).collapsed).toEqual(['ok'])
})

test('loadRoster returns default roster on corrupt JSON and sets aside the bad file', () => {
  const file = tmpFile()
  writeFileSync(file, '{ truncated')
  expect(loadRoster(file)).toEqual({ groupBy: 'state', sessions: [], collapsed: [] })
  // The bad file must have been renamed aside so nothing is silently discarded.
  expect(existsSync(file)).toBe(false)
  expect(existsSync(`${file}.corrupt`)).toBe(true)
})

test('saveRoster writes atomically: no leftover .tmp, content roundtrips', () => {
  const file = tmpFile()
  const roster: any = { groupBy: 'state', sessions: [{ worktree: '/x', id: 's1', addedAt: 100 }], collapsed: [] }
  saveRoster(file, roster)
  expect(loadRoster(file)).toEqual(roster)
  const leftovers = readdirSync(join(file, '..')).filter((f) => f.endsWith('.tmp'))
  expect(leftovers).toEqual([])
})

test.each([
  ['null', 'null'],
  ['an array', '[]'],
  ['a string', '"x"'],
])('loadRoster of %s parses to default shape', (_label, contents) => {
  const file = tmpFile()
  writeFileSync(file, contents)
  expect(loadRoster(file)).toEqual({ groupBy: 'state', sessions: [], collapsed: [] })
})

test('hasSession checks membership by worktree+id', () => {
  const roster: any = { groupBy: 'state', sessions: [{ worktree: '/x', id: 's1', addedAt: 1 }] }
  expect(hasSession(roster, '/x', 's1')).toBe(true)
  expect(hasSession(roster, '/x', 's2')).toBe(false)
  expect(hasSession(roster, '/y', 's1')).toBe(false)
})

test.each([
  ['{}', '{}'],
  ['sessions not an array', '{"sessions":{}}'],
])('loadRoster of %s parses to default shape (M1)', (_label, contents) => {
  const file = tmpFile()
  writeFileSync(file, contents)
  expect(loadRoster(file)).toEqual({ groupBy: 'state', sessions: [], collapsed: [] })
})

test('loadRoster falls back to groupBy "state" on an invalid groupBy value (M1)', () => {
  const file = tmpFile()
  writeFileSync(file, '{"groupBy":"bogus","sessions":[]}')
  expect(loadRoster(file)).toEqual({ groupBy: 'state', sessions: [], collapsed: [] })
})


// #70: the interactive App rewrote roster.json from a snapshot loaded at mount, so a `fleetview bg`
// append from another terminal vanished on the next pin/collapse/TTL-clean write.
const member = (id: any, extra: any = {}) => ({ worktree: '/x', id, addedAt: 1, ...extra })
const rosterOf = (...sessions: any[]): any => ({ groupBy: 'state', sessions, collapsed: [] })

test('makePersistRoster keeps a member another process added since the snapshot (#70)', () => {
  const file = tmpFile()
  const mounted = rosterOf(member('existing'))
  saveRoster(file, mounted)
  const persist = makePersistRoster({ roster: mounted, file })
  saveRoster(file, rosterOf(member('existing'), member('from-bg'))) // `fleetview bg` in another terminal
  persist(rosterOf(member('existing', { pinned: true }))) // a pin in the running instance
  expect(loadRoster(file).sessions.map((s) => s.id)).toEqual(['existing', 'from-bg'])
})

test('makePersistRoster keeps a member this instance deleted deleted', () => {
  const file = tmpFile()
  const mounted = rosterOf(member('a'), member('b'))
  saveRoster(file, mounted)
  const persist = makePersistRoster({ roster: mounted, file })
  persist(rosterOf(member('a'))) // ^x removed b
  expect(loadRoster(file).sessions.map((s) => s.id)).toEqual(['a'])
  persist(rosterOf(member('a', { pinned: true }))) // and a later write must not resurrect it
  expect(loadRoster(file).sessions.map((s) => s.id)).toEqual(['a'])
})

test('makePersistRoster does not treat a foreign addition as a later deletion (#70)', () => {
  const file = tmpFile()
  const mounted = rosterOf(member('existing'))
  saveRoster(file, mounted)
  const persist = makePersistRoster({ roster: mounted, file })
  saveRoster(file, rosterOf(member('existing'), member('from-bg')))
  persist(rosterOf(member('existing'))) // first write adopts from-bg into the file...
  persist(rosterOf(member('existing'))) // ...and the second must not read it back as one of ours and drop it
  expect(loadRoster(file).sessions.map((s) => s.id)).toEqual(['existing', 'from-bg'])
})

// #177: a member synced in through reload (not persist) was never in prev, so removing it here
// looked like a foreign addition to keep, and the next sync re-added it.
test('makePersistRoster removes a member synced in and adopted when this instance drops it (#177)', () => {
  const file = tmpFile()
  const mounted = rosterOf(member('existing'))
  saveRoster(file, mounted)
  const persist = makePersistRoster({ roster: mounted, file })
  saveRoster(file, rosterOf(member('existing'), member('from-bg'))) // `fleetview bg` in another terminal
  const disk = persist.reload()!
  persist.adopt(disk.sessions.filter((m) => m.id === 'from-bg')) // what syncExternalMembers unions in
  persist(rosterOf(member('existing'))) // ^x removed from-bg
  expect(loadRoster(file).sessions.map((s) => s.id)).toEqual(['existing'])
})

// The other half of #177: reload alone adopts nothing, so a member read but not taken into state
// is still someone else's and survives this instance's next write.
test('makePersistRoster keeps a reloaded member that was never adopted (#177)', () => {
  const file = tmpFile()
  const mounted = rosterOf(member('existing'))
  saveRoster(file, mounted)
  const persist = makePersistRoster({ roster: mounted, file })
  saveRoster(file, rosterOf(member('existing'), member('from-bg')))
  persist.reload()
  persist(rosterOf(member('existing')))
  expect(loadRoster(file).sessions.map((s) => s.id)).toEqual(['existing', 'from-bg'])
})

test('makePersistRoster lets this instance win the fields of members it knows', () => {
  const file = tmpFile()
  const mounted = rosterOf(member('a'), member('b'))
  saveRoster(file, mounted)
  const persist = makePersistRoster({ roster: mounted, file })
  persist(rosterOf(member('b', { rank: 0 }), member('a', { rank: 1, pinned: true })))
  expect(loadRoster(file).sessions).toEqual([
    member('a', { rank: 1, pinned: true }),
    member('b', { rank: 0 }),
  ])
})

test('makePersistRoster keeps concurrent additions from two instances', () => {
  const file = tmpFile()
  const shared = rosterOf(member('existing'))
  saveRoster(file, shared)
  const one = makePersistRoster({ roster: shared, file })
  const two = makePersistRoster({ roster: shared, file })
  one(rosterOf(member('existing'), member('from-one')))
  two(rosterOf(member('existing'), member('from-two')))
  expect(loadRoster(file).sessions.map((s) => s.id)).toEqual(['existing', 'from-one', 'from-two'])
})

// groupBy/collapsed are one terminal's view state, so there is nothing to merge — last writer wins.
test('makePersistRoster resolves groupBy/collapsed disagreement last-writer-wins', () => {
  const file = tmpFile()
  const shared = rosterOf()
  saveRoster(file, shared)
  const one = makePersistRoster({ roster: shared, file })
  const two = makePersistRoster({ roster: shared, file })
  one({ groupBy: 'project', sessions: [], collapsed: ['project:/x'] })
  two({ groupBy: 'state', sessions: [], collapsed: [] })
  expect(loadRoster(file)).toEqual({ groupBy: 'state', sessions: [], collapsed: [] })
})

// A failed save must not commit the snapshot: advancing `prev` before the write meant an in-flight
// removal was remembered as done while it never reached disk, and the next successful persist
// merged the row back from disk — resurrecting what the user deleted.
test('makePersistRoster retries a removal whose save failed instead of resurrecting it', () => {
  const file = tmpFile()
  const mounted = rosterOf(member('a'), member('b'))
  saveRoster(file, mounted)
  const persist = makePersistRoster({ roster: mounted, file })
  const tmp = `${file}.${process.pid}.tmp`
  mkdirSync(tmp) // saveRoster's tmp write lands on a directory and throws
  expect(() => persist(rosterOf(member('a')))).toThrow() // ^x removed b, but nothing reached disk
  rmdirSync(tmp)
  persist(rosterOf(member('a'))) // the retry must still know b was removed here, not merge it back
  expect(loadRoster(file).sessions.map((s) => s.id)).toEqual(['a'])
})

// #106: makePersistRoster's read-merge-write is unlocked, so two processes that both loadRoster
// before either saves each write back a merge missing the other's append. The lockfile serialises
// the read-merge-write across processes. Driven through real child processes because a single JS
// thread runs each sync persist to completion — the race only exists between processes.
// #185: start-up jitter alone serialised the workers, so this passed with the lock removed. Each
// worker now loads, says it is ready, and blocks on a go file, so all eight persist at once.
const STORE = resolve(import.meta.dirname, '../src/roster-store.ts')
const appendWorker = (dir: string) => {
  const worker = join(dir, 'append.mjs')
  writeFileSync(
    worker,
    `import { existsSync, writeFileSync } from 'node:fs'
import { loadRoster, makePersistRoster } from ${JSON.stringify(STORE)}
const [file, id, ready, go] = process.argv.slice(2)
const roster = loadRoster(file)
const persist = makePersistRoster({ roster, file })
writeFileSync(ready, '')
const cell = new Int32Array(new SharedArrayBuffer(4))
const deadline = Date.now() + 30000 // a test that died before opening the barrier must not orphan us
while (go && !existsSync(go)) {
  if (Date.now() > deadline) process.exit(2)
  Atomics.wait(cell, 0, 0, 1)
}
persist({ ...roster, sessions: [...roster.sessions, { worktree: '/x', id, addedAt: 1 }] })
`,
  )
  return worker
}
const runWorker = (worker: string, args: string[]) => {
  const c = spawn(process.execPath, [worker, ...args], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  c.stderr.on('data', (d) => (stderr += d))
  const exited = new Promise<void>((res, rej) => {
    c.on('exit', (code) => (code === 0 ? res() : rej(new Error(`worker ${args[1]} exited ${code}: ${stderr}`))))
    c.on('error', rej)
  })
  exited.catch(() => {}) // observed by the test; this only keeps an early crash from going unhandled
  return { child: c, exited }
}

test('#106: concurrent persists from separate processes all survive the merge', async () => {
  const file = tmpFile()
  const dir = join(file, '..')
  saveRoster(file, rosterOf(member('seed')))
  const worker = appendWorker(dir)
  const go = join(dir, 'go')
  const ids = Array.from({ length: 8 }, (_, i) => `p${i}`)
  const runs = ids.map((id) => runWorker(worker, [file, id, join(dir, `ready-${id}`), go]))
  const all = Promise.all(runs.map((r) => r.exited))
  try {
    let crashed: unknown
    all.catch((e) => (crashed = e))
    await waitFor(() => crashed || ids.every((id) => existsSync(join(dir, `ready-${id}`))))
    if (crashed) throw crashed
  } finally {
    writeFileSync(go, '') // never leave a worker spinning on a barrier that won't open
  }
  await all
  const got = loadRoster(file).sessions.map((s) => s.id).sort()
  expect(got).toEqual(['seed', ...ids].sort())
})

// #185: the wait path. A fresh lock is a live holder: the writer must block on it rather than
// write unlocked, and finish once the holder lets go.
test('#106: a persist waits out a live lock holder, then writes', async () => {
  const file = tmpFile()
  const dir = join(file, '..')
  saveRoster(file, rosterOf(member('seed')))
  writeFileSync(`${file}.lock`, '') // a live holder: fresh mtime, well inside STALE_LOCK_MS
  const ready = join(dir, 'ready')
  const run = runWorker(appendWorker(dir), [file, 'late', ready, ''])
  let exited = false
  let failure: unknown
  run.exited.then(() => (exited = true), (e) => ((exited = true), (failure = e)))
  try {
    // Refreshed on every poll, so however slow the worker is to start, the holder it meets is fresh.
    await waitFor(() => {
      const now = Date.now() / 1000
      utimesSync(`${file}.lock`, now, now)
      return exited || existsSync(ready)
    })
    await new Promise((r) => setTimeout(r, 300)) // a window for an unlocked write to show itself
    expect(failure).toBeUndefined()
    expect(exited).toBe(false)
  } catch (e) {
    run.child.kill()
    throw e
  }
  expect(loadRoster(file).sessions.map((s) => s.id)).toEqual(['seed'])
  rmSync(`${file}.lock`)
  await run.exited
  expect(loadRoster(file).sessions.map((s) => s.id)).toEqual(['seed', 'late'])
})

// A file corrupted mid-run must not take the running instance down on its next keystroke; writing
// the snapshot back restores something loadable.
test('makePersistRoster writes through a corrupt file rather than throwing', () => {
  const file = tmpFile()
  const mounted = rosterOf(member('a'))
  saveRoster(file, mounted)
  const persist = makePersistRoster({ roster: mounted, file })
  writeFileSync(file, 'not json')
  expect(() => persist(rosterOf(member('a'), member('b')))).not.toThrow()
  expect(loadRoster(file).sessions.map((s) => s.id)).toEqual(['a', 'b'])
})
