// Runs `opencode attach` as a child PTY while fleetview stays alive behind it.
//
// The old attach was a spawnSync after unmounting Ink: fleetview stopped existing for the duration, so
// every SSE stream died and nothing could be noticed while you were attached. Here fleetview keeps its
// event loop, its streams, and its state; it just stops drawing.
//
// What fleetview cannot copy from agent view is `←` on an empty prompt. Agent view is the session, so
// it knows whether its prompt is empty; fleetview is a terminal in front of somebody else's TUI and
// has no idea. So by default `←` is forwarded to opencode like any other key, and detaching is
// Ctrl+Z, which agent view also documents ("Ctrl+Z also detaches but goes back to where you
// started"). FLEETVIEW_BACK_ARROW=1 opts into treating `←` as a detach chord instead — the trade is
// explicit: every left-arrow goes to fleetview, none reach opencode's TUI, because only opencode
// knows whether its cursor is leftmost and it offers no hook to ask.

export const DETACH = '\x1a' // Ctrl+Z

// A chunk of stdin. A real tty delivers Buffers and the tests inject them too, but nothing here does
// more than decode one, so the contract is the decode rather than the concrete class — which is also
// what lets a plain string stand in without a branch.
export type StdinChunk = { toString(encoding?: string): string }

// What a chord means. Closed on purpose: `guarded` and the attach loop both switch on `type`, and a
// third kind would have to be handled in both places rather than slipping through as a string tag.
export type Chord = { type: 'detach' } | { type: 'switch'; index: number }

// Why an attachment ended — the chords above, or the child leaving on its own. `message` is set only
// by the caller's own catch (a spawn that never started), which is why it lives on the exit member.
export type AttachEnd = Chord | { type: 'exit'; exitCode: number; drewNothing: boolean; ms: number; message?: string }

// Whatever the injected timer factory handed back. The default is Node's Timeout and the tests hand
// back plain numbers; nothing here does anything with one but pass it straight to clearTimer.
export type TimerHandle = ReturnType<typeof setTimeout> | number

// The tty surface this module actually touches, on each side. Structural rather than
// NodeJS.ReadStream/WriteStream so the real streams and the tests' EventEmitter stand-ins both
// satisfy it without either being cast into the other's shape.
export type PtyStdin = {
  isTTY?: boolean
  setRawMode?: (raw: boolean) => unknown
  resume?: () => unknown
  on(event: 'data', listener: (chunk: StdinChunk) => void): unknown
  off?(event: 'data', listener: (chunk: StdinChunk) => void): unknown
}
export type PtyStdout = {
  columns?: number
  rows?: number
  write(data: string): unknown
  on?(event: 'resize', listener: () => void): unknown
  off?(event: 'resize', listener: () => void): unknown
}

// node-pty ships its own typings, so the injected spawn is the real thing rather than a stand-in —
// which is also what pins the child members below (write/resize/kill/onData/onExit).
export type PtySpawn = typeof import('node-pty').spawn

// Restoring the terminal is not optional. Raw mode is a global property of the tty, so a fleetview
// killed mid-attach — SIGTERM, a dropped SSH session, a closed terminal — leaves the user's shell
// with no echo and no line editing until they blindly type `stty sane`. Nothing in the process
// otherwise runs on the way out, so the active attachment registers itself here and the handlers
// put the terminal back.
const active = new Set<() => void>()

let handlersInstalled = false
function installHandlers() {
  if (handlersInstalled) return
  handlersInstalled = true
  const restoreAll = () => {
    for (const restore of [...active]) {
      try {
        restore()
      } catch {
        // best effort: one failure must not stop the others
      }
    }
    active.clear()
  }
  process.on('exit', restoreAll)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => {
      restoreAll()
      // Re-raise with the default disposition so the exit code and any parent's wait() are honest.
      // Remove only our own handler, not every subsystem's listener for this signal.
      process.removeListener(signal, handler)
      process.kill(process.pid, signal)
    }
    process.on(signal, handler)
  }
}
// Alt+1..9, as agent view's Alt+1..9 quick-switch. Terminals send these as ESC followed by the
// digit; the pty never sees them.
const ALT_DIGIT = /^\x1b([1-9])$/

// Both encodings of ←. Terminals send CSI `\x1b[D` in normal mode but SS3 `\x1bOD` once the
// attached TUI (or tmux) has switched cursor keys to application mode (DECCKM, CSI ?1h) — and an
// attached session is exactly where that mode is likely to be on. Matching only the CSI form meant
// the chord worked when tested with injected bytes and died on a real keyboard inside a session.
const BACK_ARROWS = ['\x1b[D', '\x1bOD']

// Reads a chord out of a chunk of stdin. Returns null when the bytes are just input for the child.
export function chordFor(
  chunk: StdinChunk,
  { backArrow = (process.env.FLEETVIEW_BACK_ARROW ?? process.env.ROOST_BACK_ARROW) === '1' } = {},
): Chord | null {
  const text = chunk.toString('utf8')
  if (text === DETACH) return { type: 'detach' }
  if (backArrow && BACK_ARROWS.includes(text)) return { type: 'detach' }
  const alt = ALT_DIGIT.exec(text)
  if (alt) return { type: 'switch', index: Number(alt[1]) - 1 }
  return null
}

// Alt+N arrives as ESC followed by a digit, and whether those land in one stdin read or two is
// down to buffering — so whole-chunk matching missed the chord whenever the terminal split them,
// forwarding a stray Escape and a digit into opencode instead.
//
// Holding a lone trailing ESC briefly fixes that without making the opposite mistake worse: a
// human pressing Escape and then a digit takes far longer than the window, so their keys still
// reach the session. Delaying a solitary Escape by a few milliseconds is the same trade readline
// and every terminal app makes.
export const ESC_WINDOW_MS = 40

// Alt+N is best-effort and cannot be made exact. A true Alt+1 and an Escape followed by a 1 are
// the same two bytes; the only thing telling them apart is arrival timing, and a laggy link that
// stalls and then flushes delivers both in one segment with that evidence already destroyed. So on
// a slow connection an Escape typed in opencode's TUI, followed by a digit, can switch sessions.
//
// FLEETVIEW_NO_ALT_SWITCH=1 turns the chord off for anyone who would rather never risk it — Escape is
// heavily used in a TUI, and losing a quick-switch beats losing the view you were looking at.
// Ctrl+Z detach is unaffected: one byte, no prefix, unambiguous everywhere.
export function makeChordReader({
  onChord,
  onBytes,
  windowMs = ESC_WINDOW_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  altSwitch = (process.env.FLEETVIEW_NO_ALT_SWITCH ?? process.env.ROOST_NO_ALT_SWITCH) !== '1',
  backArrow = (process.env.FLEETVIEW_BACK_ARROW ?? process.env.ROOST_BACK_ARROW) === '1',
}: {
  onChord: (chord: Chord) => void
  onBytes: (text: string) => void
  windowMs?: number
  setTimer?: (fn: () => void, ms: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
  altSwitch?: boolean
  backArrow?: boolean
}) {
  let pendingEsc: TimerHandle | null = null // timer handle while a lone ESC is held

  const flushEsc = () => {
    if (!pendingEsc) return
    clearTimer(pendingEsc)
    pendingEsc = null
    onBytes('\x1b')
  }

  return {
    feed(chunk: StdinChunk) {
      const text = chunk.toString('utf8')
      if (pendingEsc) {
        clearTimer(pendingEsc)
        pendingEsc = null
        const digit = altSwitch ? /^([1-9])/.exec(text) : null
        if (digit) {
          onChord({ type: 'switch', index: Number(digit[1]) - 1 })
          const rest = text.slice(1)
          if (rest) onBytes(rest)
          return
        }
        // A held ESC followed by `[D` (or application-cursor-mode's `OD`) is a split `←` —
        // reassemble it into the back-arrow detach chord, the same way a held ESC + digit becomes a
        // switch. Without this, a `←` whose ESC and tail arrive in separate stdin reads (common
        // once opencode's TUI is redrawing and fragmenting stdin) never detached — the chord only
        // ever matched when `←` came whole.
        if (backArrow && (text.startsWith('[D') || text.startsWith('OD'))) {
          onChord({ type: 'detach' })
          const rest = text.slice(2)
          if (rest) onBytes(rest)
          return
        }
        onBytes('\x1b') // it was a real Escape after all
      }
      // Hold a lone ESC when either chord that begins with one is armed: alt+N (ESC + digit) or,
      // now, back-arrow (ESC + `[D`). Holding is what lets a split escape sequence reassemble.
      if (text === '\x1b' && (altSwitch || backArrow)) {
        pendingEsc = setTimer(() => {
          pendingEsc = null
          onBytes('\x1b')
        }, windowMs)
        return
      }
      const chord = chordFor(text, { backArrow })
      if (chord && (altSwitch || chord.type === 'detach')) return onChord(chord)
      onBytes(text)
    },
    // Called on teardown so a held Escape is never swallowed.
    stop() {
      flushEsc()
    },
  }
}

// The handoff back to the roster is not instantaneous: the reader is gone, Ink's input hooks
// re-register a tick or two later, and whatever is typed (or replayed by the terminal) in between
// belongs to neither side. Those bytes are the phantom text in the dispatch input (#19) — a
// fragmented arrow reaching Ink as a bare Escape is the same window, and a bare Escape on an empty
// input quits. Discard the window instead of delivering it late.
export const RESUME_DRAIN_MS = 50

// Resolves with why the attachment ended: 'exit' when opencode quit on its own, 'detach' when the
// user pressed the chord, or {type:'switch', index} to attach somewhere else.
//
// Every dependency is injected so the control flow can be tested without a real terminal.
export function attachPty({
  command,
  args,
  cwd,
  now = () => Date.now(),
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  spawn,
  onSuspend = () => {},
  onResume = () => {},
  // Only for process-backed attaches (claude/copilot): their interactive child IS the turn, so a
  // detach mid-stream kills in-flight work. opencode sessions live on a server and lose nothing on
  // detach, which is why this defaults off and the call site never sets it for opencode.
  busyDetachGuard = false,
  // How long stdin stays discarded on the way back to the roster; see cleanup().
  resumeDrainMs = RESUME_DRAIN_MS,
  setTimer = setTimeout,
  defer = setImmediate,
}: {
  command: string
  args: string[]
  cwd?: string
  now?: () => number
  env?: NodeJS.ProcessEnv
  // Only the handful of tty members this reaches for. Narrower than NodeJS.ReadStream/WriteStream on
  // purpose: process.stdin/stdout satisfy it, and so does the EventEmitter stand-in the tests build,
  // without either side pretending to be a whole stream.
  stdin?: PtyStdin
  stdout?: PtyStdout
  // node-pty's own `spawn` — it ships typings, so this is the real signature rather than a stand-in.
  spawn: PtySpawn
  onSuspend?: () => void
  onResume?: () => void
  busyDetachGuard?: boolean
  resumeDrainMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  defer?: (fn: () => void) => unknown
}): Promise<AttachEnd> {
  return new Promise<AttachEnd>((resolve) => {
    onSuspend() // stop fleetview drawing before the child writes a single byte
    const child = spawn(command, args, {
      name: env.TERM || 'xterm-256color',
      cols: stdout.columns || 80,
      rows: stdout.rows || 24,
      cwd,
      env,
    })

    let settled = false
    const finish = (reason: AttachEnd) => {
      if (settled) return
      settled = true
      cleanup()
      onResume()
      resolve(reason)
    }

    let drew = false
    let lastOutputAt: number | null = null // timestamp of the child's most recent output — "busy" evidence for the detach guard
    const onData = (data: string) => {
      drew = true
      lastOutputAt = now()
      stdout.write(data)
    }
    // Mirrors Claude Code's double-press detach: a first chord while the child wrote output in the
    // last 2s arms instead of detaching, and a second chord within 3s of arming goes through. The
    // notice is painted straight to the terminal's last row (save cursor, move, inverse, restore) —
    // the child's next redraw may overwrite it, which is acceptable for a transient hint.
    //
    // Every chord goes through here, not just detach (#56): Alt+N leaves the attachment via the same
    // cleanup() → child.kill(), so switching rows mid-turn destroys exactly the in-flight work this
    // guard exists to protect. guardArmedAt is shared, so an armed Ctrl+Z followed by Alt+2 switches.
    const BUSY_WINDOW_MS = 2000
    const ARM_WINDOW_MS = 3000
    let guardArmedAt: number | null = null
    const guarded = (chord: Chord) => {
      if (busyDetachGuard) {
        const t = now()
        if (guardArmedAt !== null && t - guardArmedAt <= ARM_WINDOW_MS) return finish(chord)
        // Past the window (or never armed): a busy child re-arms the guard rather than leaving.
        if (lastOutputAt !== null && t - lastOutputAt < BUSY_WINDOW_MS) {
          guardArmedAt = t
          const rows = stdout.rows || 24
          stdout.write(`\x1b7\x1b[${rows};1H\x1b[7m still working — press again \x1b[0m\x1b8`)
          return
        }
      }
      finish(chord)
    }
    const reader = makeChordReader({
      onChord: (chord) => guarded(chord),
      // cleanup() flushes any held Escape, and cleanup also runs on the exit path — where writing
      // to an already-dead pty would throw straight out of the onExit handler.
      onBytes: (text: string) => {
        try {
          child.write(text)
        } catch {
          // the child is gone; the keystroke has nowhere to go
        }
      },
    })
    const onInput = (chunk: StdinChunk) => reader.feed(chunk)
    const onResize = () => {
      try {
        child.resize(stdout.columns || 80, stdout.rows || 24)
      } catch {
        // the child can exit between the resize event and this call; nothing to do about it
      }
    }

    installHandlers()
    // Registered before anything can throw, so an early failure still restores the terminal.
    const restoreTerminal = () => {
      // Unconditionally cooked: fleetview is on its way out and the shell inheriting this tty expects
      // echo and line editing, whatever mode it was in when fleetview started.
      if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(false)
      try {
        child.kill()
      } catch {
        // already gone
      }
    }
    active.add(restoreTerminal)
    const untrack = () => active.delete(restoreTerminal)

    const disposeData = child.onData(onData)
    // The exit code matters: `opencode attach` exits 1 immediately and silently when its --dir no
    // longer exists, which happens the moment a git worktree behind a session is removed.
    const startedAt = now()
    const disposeExit = child.onExit((e) =>
      finish({ type: 'exit', exitCode: e?.exitCode ?? 0, drewNothing: !drew, ms: now() - startedAt }),
    )
    // Ink releases stdin asynchronously once its input hooks go inactive, and that teardown lands
    // after this setup — so raw mode is asserted again on the next tick, or the first keystrokes
    // after attaching arrive line-buffered.
    const setRaw = (on: boolean) => {
      if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(on)
    }
    const assertRaw = () => {
      if (settled) return
      setRaw(true)
      stdin.resume?.()
    }
    assertRaw()
    stdin.on('data', onInput)
    defer(assertRaw)
    stdout.on?.('resize', onResize)

    function cleanup() {
      reader.stop() // never swallow an Escape that was being held for a possible Alt+N
      disposeData?.dispose?.()
      disposeExit?.dispose?.()
      stdin.off?.('data', onInput)
      stdout.off?.('resize', onResize)
      // Raw is the only correct state here: fleetview keeps running and its roster always owns the
      // terminal in raw mode. Restoring cooked belongs to process exit alone (restoreTerminal), and
      // the mode Ink believes it left behind cannot be trusted — Ink's stdin release is async, so a
      // fast detach→attach cycle sampled it mid-teardown and dropped the roster into cooked mode
      // while Ink's refcount still said raw: echoing input, nothing reaching the app, and the
      // line buffer flushing into the dispatch prompt on recovery (#19). Re-assert on the next tick
      // as well, for the same reason the attach direction does: Ink re-registers after this returns.
      setRaw(true)
      defer(() => setRaw(true))
      // Keep stdin flowing into a sink for the window instead of letting it pause with no reader:
      // a paused stdin buffers everything typed during the handoff and replays it into Ink as one
      // late chunk the moment Ink subscribes. Nothing typed here was aimed at either side.
      const drain = () => {}
      stdin.on('data', drain)
      setTimer(() => stdin.off?.('data', drain), resumeDrainMs)
      untrack()
      // Detaching never stops a session: kill the local viewer, never the session behind it.
      // node-pty's IPty declares only `kill(signal?)` — there is no `killed` property (that
      // belongs to child_process.ChildProcess), so the guard that used to be here was always true
      // and read as a liveness check it never was. The try/catch is the real protection.
      try {
        child.kill()
      } catch {
        // already gone
      }
    }
  })
}
