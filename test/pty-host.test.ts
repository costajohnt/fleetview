import { test, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { attachPty, chordFor, makeChordReader, DETACH, RESUME_DRAIN_MS } from '../src/pty-host.ts'
import { gatedStdout } from '../src/gated-stdout.ts'

// A stand-in for node-pty's child: records what was written to it and lets a test drive its
// output and exit.
function fakePty() {
  const dataHandlers: any[] = []
  const exitHandlers: any[] = []
  const child: any = {
    written: [] as any[],
    killed: false,
    resized: null as any,
    write: (s: any) => child.written.push(s),
    kill: () => { child.killed = true },
    resize: (cols: any, rows: any) => { child.resized = [cols, rows] },
    onData: (fn: any) => (dataHandlers.push(fn), { dispose: () => {} }),
    onExit: (fn: any) => (exitHandlers.push(fn), { dispose: () => {} }),
    emitData: (s: any) => dataHandlers.forEach((fn) => fn(s)),
    emitExit: (e = { exitCode: 0 }) => exitHandlers.forEach((fn) => fn(e)),
  }
  return child
}

function harness() {
  const child = fakePty()
  const stdin: any = new EventEmitter()
  stdin.isTTY = false
  stdin.resume = () => {}
  const stdout: any = new EventEmitter()
  stdout.columns = 100
  stdout.rows = 40
  stdout.written = []
  stdout.write = (s: any) => stdout.written.push(s)
  const spawn = vi.fn(() => child)
  return { child, stdin, stdout, spawn }
}

test('chordFor recognises the detach chord and Alt+1..9, and passes everything else through', () => {
  expect(chordFor(Buffer.from(DETACH))).toEqual({ type: 'detach' })
  expect(chordFor(Buffer.from('\x1b3'))).toEqual({ type: 'switch', index: 2 })
  expect(chordFor(Buffer.from('a'))).toBe(null)
  expect(chordFor(Buffer.from('\x1b[D'))).toBe(null) // ← belongs to opencode by default
})

// ROOST_BACK_ARROW=1 trades every left-arrow for a way back: fleetview cannot see opencode's cursor,
// so the choice is the user's, not a heuristic's.
test('with backArrow opted in, ← detaches; other arrows still reach opencode', () => {
  expect(chordFor(Buffer.from('\x1b[D'), { backArrow: true })).toEqual({ type: 'detach' })
  expect(chordFor(Buffer.from('\x1b[C'), { backArrow: true })).toBe(null) // →
  expect(chordFor(Buffer.from('\x1b[A'), { backArrow: true })).toBe(null) // ↑
  expect(chordFor(Buffer.from('\x1b[D'), { backArrow: false })).toBe(null)
})

test('child output reaches the terminal and keystrokes reach the child', async () => {
  const { child, stdin, stdout, spawn } = harness()
  const done = attachPty({ command: 'opencode', args: ['attach'], spawn, stdin, stdout })
  child.emitData('hello from opencode')
  stdin.emit('data', Buffer.from('some typing'))
  expect(stdout.written).toContain('hello from opencode')
  expect(child.written).toEqual(['some typing'])
  child.emitExit()
  expect(await done).toMatchObject({ type: 'exit', exitCode: 0, drewNothing: false })
})

// `opencode attach` exits 1 instantly and silently when its --dir is gone, which is what a removed
// git worktree leaves behind. The caller needs enough to say so instead of flashing a blank screen.
test('an attachment that dies without drawing reports the exit code and that nothing was drawn', async () => {
  const { child, stdin, stdout, spawn } = harness()
  const done = attachPty({ command: 'opencode', args: [], spawn, stdin, stdout, now: () => 0 })
  child.emitExit({ exitCode: 1 })
  expect(await done).toMatchObject({ type: 'exit', exitCode: 1, drewNothing: true })
})

test('the detach chord ends the attachment and kills the viewer, not the session', async () => {
  const { child, stdin, stdout, spawn } = harness()
  const done = attachPty({ command: 'opencode', args: [], spawn, stdin, stdout })
  stdin.emit('data', Buffer.from(DETACH))
  expect(await done).toEqual({ type: 'detach' })
  expect(child.killed).toBe(true) // the local `opencode attach` process only
  expect(child.written).toEqual([]) // the chord is never forwarded
})

test('Alt+N asks for a switch and reports which row', async () => {
  const { stdin, stdout, spawn } = harness()
  const done = attachPty({ command: 'opencode', args: [], spawn, stdin, stdout })
  stdin.emit('data', Buffer.from('\x1b2'))
  expect(await done).toEqual({ type: 'switch', index: 1 })
})

test('fleetview stops drawing for exactly the length of the attachment', async () => {
  const { child, stdin, stdout, spawn } = harness()
  const events: any[] = []
  const done = attachPty({
    command: 'opencode',
    args: [],
    spawn,
    stdin,
    stdout,
    onSuspend: () => events.push('suspend'),
    onResume: () => events.push('resume'),
  })
  expect(events).toEqual(['suspend']) // before the child can write a byte
  child.emitExit()
  await done
  expect(events).toEqual(['suspend', 'resume'])
})

test('a terminal resize is forwarded to the child', async () => {
  const { child, stdin, stdout, spawn } = harness()
  const done = attachPty({ command: 'opencode', args: [], spawn, stdin, stdout })
  stdout.columns = 120
  stdout.rows = 50
  stdout.emit('resize')
  expect(child.resized).toEqual([120, 50])
  child.emitExit()
  await done
})

test('input stops reaching the child once the attachment has ended', async () => {
  const { child, stdin, stdout, spawn } = harness()
  const done = attachPty({ command: 'opencode', args: [], spawn, stdin, stdout })
  child.emitExit()
  await done
  stdin.emit('data', Buffer.from('late keystroke'))
  expect(child.written).toEqual([])
})

test('the child is spawned with the terminal size and the session directory', async () => {
  const { child, stdin, stdout, spawn } = harness()
  const done = attachPty({
    command: 'opencode',
    args: ['attach', 'url', '-s', 'ses_1'],
    cwd: '/x/alpha',
    env: { TERM: 'xterm-256color' },
    spawn,
    stdin,
    stdout,
  })
  expect(spawn).toHaveBeenCalledWith(
    'opencode',
    ['attach', 'url', '-s', 'ses_1'],
    expect.objectContaining({ cols: 100, rows: 40, cwd: '/x/alpha', name: 'xterm-256color' }),
  )
  child.emitExit()
  await done
})

// --- the write gate ---

test('the gate passes writes through until it is closed', () => {
  const target = { written: [] as any[], write: (s: any) => target.written.push(s), columns: 80, rows: 24, on: () => {} }
  const gate = gatedStdout(target as any)
  gate.write('drawn')
  gate.close()
  gate.write('while attached') // would otherwise scribble over the attached session
  gate.open()
  gate.write('drawn again')
  expect(target.written).toEqual(['drawn', 'drawn again'])
})

test('the gate proxies the terminal size Ink lays out against', () => {
  const target = { write: () => {}, columns: 132, rows: 43, isTTY: true, on: () => {} }
  const gate = gatedStdout(target as any)
  expect([gate.columns, gate.rows, gate.isTTY]).toEqual([132, 43, true])
})

test('a resize on the real terminal reaches Ink through the gate', () => {
  const target: any = new EventEmitter()
  target.write = () => {}
  const gate = gatedStdout(target as any)
  const seen = vi.fn()
  gate.on('resize', seen)
  target.emit('resize')
  expect(seen).toHaveBeenCalled()
})

test('signals that are not drawing reach the terminal even while the gate is closed', () => {
  const target = { written: [] as any[], write: (s: any) => target.written.push(s), isTTY: true, on: () => {} }
  const gate = gatedStdout(target as any)
  gate.close()
  gate.write('a roster repaint') // dropped: the attached session owns the screen
  gate.writeThrough('a bell')
  expect(target.written).toEqual(['a bell'])
})

test('disposing a gate stops it forwarding resize, so reconnects do not stack listeners', () => {
  const target: any = new EventEmitter()
  target.write = () => {}
  const gate = gatedStdout(target as any)
  const seen = vi.fn()
  gate.on('resize', seen)
  gate.dispose!()
  target.emit('resize')
  expect(seen).not.toHaveBeenCalled()
  expect(target.listenerCount('resize')).toBe(0)
})

// --- chord reading across stdin read boundaries ---

const reader = (overrides = {}) => {
  const chords: any[] = []
  const bytes: any[] = []
  const timers = new Map()
  let next = 1
  const r = makeChordReader({
    onChord: (c) => chords.push(c),
    onBytes: (b) => bytes.push(b),
    setTimer: (fn) => { const id = next++; timers.set(id, fn); return id },
    clearTimer: (id) => timers.delete(id),
    ...overrides,
  })
  return { r, chords, bytes, fireTimers: () => { for (const fn of [...timers.values()]) fn(); timers.clear() } }
}

// Whether ESC and the digit land in one read or two is down to buffering, and the old whole-chunk
// match only handled the coalesced case — so a split Alt+N sent a stray Escape into the session.
test('Alt+N is recognised when ESC and the digit arrive in separate reads', () => {
  const { r, chords, bytes } = reader()
  r.feed(Buffer.from('\x1b'))
  r.feed(Buffer.from('3'))
  expect(chords).toEqual([{ type: 'switch', index: 2 }])
  expect(bytes).toEqual([])
})

test('Alt+N is still recognised when they arrive together', () => {
  const { r, chords } = reader()
  r.feed(Buffer.from('\x1b2'))
  expect(chords).toEqual([{ type: 'switch', index: 1 }])
})

test('a real Escape reaches the session once the window passes', () => {
  const { r, chords, bytes, fireTimers } = reader()
  r.feed(Buffer.from('\x1b'))
  expect(bytes).toEqual([]) // held, briefly
  fireTimers()
  expect(bytes).toEqual(['\x1b'])
  expect(chords).toEqual([])
})

test('Escape followed by a non-digit passes both through in order', () => {
  const { r, chords, bytes } = reader()
  r.feed(Buffer.from('\x1b'))
  r.feed(Buffer.from('[A')) // an arrow key: ESC [ A
  expect(chords).toEqual([])
  expect(bytes).toEqual(['\x1b', '[A'])
})

test('trailing input after a chord still reaches the session', () => {
  const { r, chords, bytes } = reader()
  r.feed(Buffer.from('\x1b'))
  r.feed(Buffer.from('4rest'))
  expect(chords).toEqual([{ type: 'switch', index: 3 }])
  expect(bytes).toEqual(['rest'])
})

// ← is ESC + `[D`; whether those land in one read or two is buffering, and the old code only
// matched the coalesced case — so a split ← forwarded a stray Escape and never detached. This is
// the same split bug Alt+N had, now covered for back-arrow too.
test('back-arrow detach is recognised when ESC and [D arrive in separate reads', () => {
  const { r, chords, bytes } = reader({ backArrow: true })
  r.feed(Buffer.from('\x1b'))
  r.feed(Buffer.from('[D'))
  expect(chords).toEqual([{ type: 'detach' }])
  expect(bytes).toEqual([])
})

test('split back-arrow detaches even with alt-switch off (ESC held for the back-arrow chord alone)', () => {
  const { r, chords, bytes } = reader({ backArrow: true, altSwitch: false })
  r.feed(Buffer.from('\x1b'))
  r.feed(Buffer.from('[D'))
  expect(chords).toEqual([{ type: 'detach' }])
  expect(bytes).toEqual([])
})

// Application cursor mode (DECCKM): once the attached TUI or tmux sets CSI ?1h, the terminal sends
// SS3 `\x1bOD` for ← instead of CSI `\x1b[D`. An attached full-screen session is exactly where that
// mode tends to be on, so both encodings must detach — whole and split.
test('application-cursor-mode back-arrow (ESC O D) detaches when it arrives whole', () => {
  const { r, chords, bytes } = reader({ backArrow: true })
  r.feed(Buffer.from('\x1bOD'))
  expect(chords).toEqual([{ type: 'detach' }])
  expect(bytes).toEqual([])
})

test('application-cursor-mode back-arrow detaches when ESC and OD arrive in separate reads', () => {
  const { r, chords, bytes } = reader({ backArrow: true })
  r.feed(Buffer.from('\x1b'))
  r.feed(Buffer.from('OD'))
  expect(chords).toEqual([{ type: 'detach' }])
  expect(bytes).toEqual([])
})

// Off means off in both encodings: OD with the chord disarmed is opencode's keystroke, not ours.
test('application-cursor-mode ← is forwarded untouched when back-arrow is off', () => {
  const { r, chords, bytes } = reader({ backArrow: false, altSwitch: false })
  r.feed(Buffer.from('\x1bOD'))
  expect(chords).toEqual([])
  expect(bytes).toEqual(['\x1bOD'])
})

test('back-arrow still detaches when ← arrives whole', () => {
  const { r, chords } = reader({ backArrow: true })
  r.feed(Buffer.from('\x1b[D'))
  expect(chords).toEqual([{ type: 'detach' }])
})

test('without backArrow, a split ← is forwarded, never a detach (opt-in preserved)', () => {
  const { r, chords, bytes } = reader()
  r.feed(Buffer.from('\x1b'))
  r.feed(Buffer.from('[D'))
  expect(chords).toEqual([])
  expect(bytes).toEqual(['\x1b', '[D'])
})

test('with backArrow on, a split ↑ (ESC then [A) is not mistaken for a detach', () => {
  const { r, chords, bytes } = reader({ backArrow: true })
  r.feed(Buffer.from('\x1b'))
  r.feed(Buffer.from('[A'))
  expect(chords).toEqual([])
  expect(bytes).toEqual(['\x1b', '[A'])
})

test('a held Escape is flushed on teardown rather than swallowed', () => {
  const { r, bytes } = reader()
  r.feed(Buffer.from('\x1b'))
  r.stop()
  expect(bytes).toEqual(['\x1b'])
})

test('ordinary typing is forwarded untouched', () => {
  const { r, chords, bytes } = reader()
  r.feed(Buffer.from('hello'))
  expect(chords).toEqual([])
  expect(bytes).toEqual(['hello'])
})

// cleanup() flushes a held Escape, and cleanup also runs on the exit path — writing to a dead pty
// there would throw straight out of the onExit handler.
test('flushing a held Escape after the child has gone does not throw', async () => {
  const { child, stdin, stdout, spawn } = harness()
  child.write = () => { throw new Error('write EPIPE') }
  const done = attachPty({ command: 'opencode', args: [], spawn, stdin, stdout })
  stdin.emit('data', Buffer.from('\x1b')) // held, waiting to see if a digit follows
  child.emitExit({ exitCode: 0 })
  expect(await done).toMatchObject({ type: 'exit' })
})

// Alt+N cannot be distinguished from a coalesced Escape-then-digit at the byte level, and a laggy
// link destroys the timing that would tell them apart. Anyone who would rather keep their Escape
// key can turn the chord off; detach must keep working regardless.
test('ROOST_NO_ALT_SWITCH passes Escape and digits through, but still detaches', () => {
  const chords: any[] = []
  const bytes: any[] = []
  const r = makeChordReader({ onChord: (c) => chords.push(c), onBytes: (b) => bytes.push(b), altSwitch: false })
  r.feed(Buffer.from('\x1b')) // not held: no chord to wait for
  r.feed(Buffer.from('1'))
  r.feed(Buffer.from('\x1b1')) // the coalesced form a slow link produces
  expect(chords).toEqual([])
  expect(bytes).toEqual(['\x1b', '1', '\x1b1'])
  r.feed(Buffer.from(DETACH))
  expect(chords).toEqual([{ type: 'detach' }])
})

test('cursor visibility follows the gate: hidden while fleetview owns the terminal, restored for the child', () => {
  // Ink hides the cursor once at mount, but an attached child (opencode, an editor) shows it again
  // on its own exit — the reopen must re-hide it or a cursor blinks after the hints line forever.
  const target = { written: [] as any[], write: (s: any) => target.written.push(s), columns: 80, rows: 24, on: () => {} }
  const gate = gatedStdout(target as any, { cursor: true })
  expect(target.written).toEqual(['\x1b[?25l'])
  gate.close()
  expect(target.written).toEqual(['\x1b[?25l', '\x1b[?25h'])
  gate.open()
  expect(target.written).toEqual(['\x1b[?25l', '\x1b[?25h', '\x1b[?25l'])
  // Idempotent: reopening an open gate writes nothing.
  gate.open()
  expect(target.written.length).toBe(3)
})

// --- busy-detach guard: process-backed attaches (claude/copilot) ---
//
// Leaving the attachment kills the child, and for those backends the child IS the in-flight turn.
// Fresh output (< 2s old) means "still working", so the first chord arms and paints a last-row
// notice; a second chord within 3s of arming goes through for real. Both chord types are guarded —
// Alt+N kills the turn exactly as dead as Ctrl+Z (#56). opencode never sets the option — its
// sessions live on a server and lose nothing on detach.

test('busy guard: fresh output arms on the first chord, and the second chord within 3s detaches', async () => {
  const { child, stdin, stdout, spawn } = harness()
  let t = 0
  const done = attachPty({ command: 'claude', args: [], spawn, stdin, stdout, busyDetachGuard: true, now: () => t })
  let settled = false
  done.then(() => { settled = true })
  t = 1000
  child.emitData('streaming tokens') // the child is mid-turn
  t = 1500
  stdin.emit('data', Buffer.from(DETACH)) // 500ms after output → busy → arm, no detach
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(child.written).toEqual([]) // the chord is a chord, never input for the child
  const painted = stdout.written.join('')
  expect(painted).toContain('still working — press again')
  expect(painted).toContain('\x1b7') // cursor saved…
  expect(painted).toContain('\x1b8') // …and restored around the transient notice
  t = 3500
  stdin.emit('data', Buffer.from(DETACH)) // 2s after arming, inside the 3s window
  expect(await done).toEqual({ type: 'detach' })
})

test('busy guard: stale output (>2s old) detaches on the first chord', async () => {
  const { child, stdin, stdout, spawn } = harness()
  let t = 0
  const done = attachPty({ command: 'claude', args: [], spawn, stdin, stdout, busyDetachGuard: true, now: () => t })
  t = 1000
  child.emitData('done a while ago')
  t = 4000
  stdin.emit('data', Buffer.from(DETACH)) // 3s since output → idle → straight through
  expect(await done).toEqual({ type: 'detach' })
})

test('busy guard: a second chord past the 3s window re-arms instead of detaching', async () => {
  const { child, stdin, stdout, spawn } = harness()
  let t = 0
  const done = attachPty({ command: 'claude', args: [], spawn, stdin, stdout, busyDetachGuard: true, now: () => t })
  let settled = false
  done.then(() => { settled = true })
  t = 1000
  child.emitData('output')
  t = 1500
  stdin.emit('data', Buffer.from(DETACH)) // arms at 1500
  t = 5000
  child.emitData('still going') // the turn is genuinely still running
  t = 5500
  stdin.emit('data', Buffer.from(DETACH)) // 4s after arming → window expired → re-arm, not detach
  await Promise.resolve()
  expect(settled).toBe(false)
  t = 6000
  stdin.emit('data', Buffer.from(DETACH)) // within 3s of the re-arm
  expect(await done).toEqual({ type: 'detach' })
})

// #56: Alt+N used to bypass the guard entirely and kill the in-flight turn with no warning.
test('busy guard: Alt+N on a busy child arms instead of switching, and a second Alt+N switches', async () => {
  const { child, stdin, stdout, spawn } = harness()
  let t = 0
  const done = attachPty({ command: 'claude', args: [], spawn, stdin, stdout, busyDetachGuard: true, now: () => t })
  let settled = false
  done.then(() => { settled = true })
  t = 1000
  child.emitData('streaming tokens')
  t = 1500
  stdin.emit('data', Buffer.from('\x1b2')) // Alt+2, 500ms after output → busy → arm, no switch
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(child.written).toEqual([]) // the chord is a chord, never input for the child
  expect(stdout.written.join('')).toContain('still working — press again')
  t = 3000
  stdin.emit('data', Buffer.from('\x1b2')) // within the 3s arm window → the switch goes through
  expect(await done).toEqual({ type: 'switch', index: 1 })
})

// guardArmedAt is shared across chord types, so arming with Ctrl+Z and confirming with Alt+2 works.
test('busy guard: an armed Ctrl+Z followed by Alt+2 performs the switch, not a detach', async () => {
  const { child, stdin, stdout, spawn } = harness()
  let t = 0
  const done = attachPty({ command: 'claude', args: [], spawn, stdin, stdout, busyDetachGuard: true, now: () => t })
  let settled = false
  done.then(() => { settled = true })
  t = 1000
  child.emitData('streaming tokens')
  t = 1500
  stdin.emit('data', Buffer.from(DETACH)) // arms
  await Promise.resolve()
  expect(settled).toBe(false)
  t = 2000
  stdin.emit('data', Buffer.from('\x1b2'))
  expect(await done).toEqual({ type: 'switch', index: 1 })
})

test('busy guard: a stale child switches on the first Alt+N', async () => {
  const { child, stdin, stdout, spawn } = harness()
  let t = 0
  const done = attachPty({ command: 'claude', args: [], spawn, stdin, stdout, busyDetachGuard: true, now: () => t })
  t = 1000
  child.emitData('done a while ago')
  t = 4000
  stdin.emit('data', Buffer.from('\x1b2')) // 3s since output → idle → straight through
  expect(await done).toEqual({ type: 'switch', index: 1 })
})

test('busy guard off (the opencode default): a chord detaches immediately even mid-output', async () => {
  const { child, stdin, stdout, spawn } = harness()
  let t = 0
  const done = attachPty({ command: 'opencode', args: [], spawn, stdin, stdout, now: () => t })
  t = 1000
  child.emitData('busy busy')
  t = 1100
  stdin.emit('data', Buffer.from(DETACH))
  expect(await done).toEqual({ type: 'detach' })
})

// #19: Ink hands stdin back asynchronously, so the raw flag sampled at attach time is not evidence
// of anything by the time the attachment ends. fleetview's roster is always raw while it owns the
// terminal — the only cooked restore that is ever right is the one on process exit.
test('detaching leaves the terminal in raw mode even when it looked cooked at attach time', async () => {
  const { child, stdin, stdout, spawn } = harness()
  const deferred: (() => void)[] = []
  stdin.isTTY = true
  stdin.isRaw = false // Ink mid-teardown: the flag lies
  stdin.rawCalls = [] as boolean[]
  stdin.setRawMode = (on: boolean) => { stdin.rawCalls.push(on); stdin.isRaw = on }
  const done = attachPty({
    command: 'opencode', args: [], spawn, stdin, stdout,
    setTimer: () => 0, defer: (fn: () => void) => deferred.push(fn),
  })
  stdin.emit('data', Buffer.from(DETACH))
  await done
  expect(stdin.rawCalls.at(-1)).toBe(true)
  deferred.forEach((fn) => fn()) // the tick Ink re-registers on
  expect(stdin.rawCalls).not.toContain(false)
  expect(stdin.isRaw).toBe(true)
  expect(child.killed).toBe(true)
})

// #19: with no reader on stdin the bytes typed across the handoff queue up and are replayed into
// Ink as one late chunk — the phantom text in the dispatch input. A sink for the window drops them.
test('stdin keeps a reader for the drain window after a detach, then lets go', async () => {
  const { stdin, stdout, spawn } = harness()
  let fire: (() => void) | null = null
  let drainMs = 0
  const done = attachPty({
    command: 'opencode', args: [], spawn, stdin, stdout,
    setTimer: (fn: () => void, ms: number) => { fire = fn; drainMs = ms; return 0 },
    defer: () => 0,
  })
  stdin.emit('data', Buffer.from(DETACH))
  await done
  expect(stdin.listenerCount('data')).toBe(1) // the sink, not the chord reader
  stdin.emit('data', Buffer.from('\x1b[A')) // an arrow still in flight: swallowed, not queued
  expect(drainMs).toBe(RESUME_DRAIN_MS)
  fire!()
  expect(stdin.listenerCount('data')).toBe(0)
})
