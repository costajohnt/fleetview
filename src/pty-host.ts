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
    process.on(signal, () => {
      restoreAll()
      // Re-raise with the default disposition so the exit code and any parent's wait() are honest.
      process.removeAllListeners(signal)
      process.kill(process.pid, signal)
    })
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
export function chordFor(chunk: any, { backArrow = (process.env.FLEETVIEW_BACK_ARROW ?? process.env.ROOST_BACK_ARROW) === '1' } = {}) { // TODO(types): chunk is a Buffer or string from stdin; typed loose since callers vary
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
  onChord: (chord: any) => void
  onBytes: (text: string) => void
  windowMs?: number
  setTimer?: (fn: () => void, ms: number) => any
  clearTimer?: (handle: any) => void
  altSwitch?: boolean
  backArrow?: boolean
}) { // TODO(types): chord shape ({type,index?}) is internal and matched by string tag; loose to avoid a union that adds no safety
  let pendingEsc: any = null // timer handle while a lone ESC is held

  const flushEsc = () => {
    if (!pendingEsc) return
    clearTimer(pendingEsc)
    pendingEsc = null
    onBytes('\x1b')
  }

  return {
    feed(chunk: any) {
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
}: {
  command: string
  args: string[]
  cwd?: string
  now?: () => number
  env?: NodeJS.ProcessEnv
  stdin?: any
  stdout?: any
  spawn: any // TODO(types): node-pty spawn; @types/node-pty not installed, injected as any
  onSuspend?: () => void
  onResume?: () => void
  busyDetachGuard?: boolean
}) {
  return new Promise((resolve) => {
    onSuspend() // stop fleetview drawing before the child writes a single byte
    const child = spawn(command, args, {
      name: env.TERM || 'xterm-256color',
      cols: stdout.columns || 80,
      rows: stdout.rows || 24,
      cwd,
      env,
    })

    let settled = false
    const finish = (reason: any) => {
      if (settled) return
      settled = true
      cleanup()
      onResume()
      resolve(reason)
    }

    let drew = false
    let lastOutputAt: number | null = null // timestamp of the child's most recent output — "busy" evidence for the detach guard
    const onData = (data: any) => {
      drew = true
      lastOutputAt = now()
      stdout.write(data)
    }
    // Mirrors Claude Code's double-press detach: a first chord while the child wrote output in the
    // last 2s arms instead of detaching, and a second chord within 3s of arming goes through. The
    // notice is painted straight to the terminal's last row (save cursor, move, inverse, restore) —
    // the child's next redraw may overwrite it, which is acceptable for a transient hint.
    const BUSY_WINDOW_MS = 2000
    const ARM_WINDOW_MS = 3000
    let guardArmedAt: number | null = null
    const detachRequested = () => {
      if (busyDetachGuard) {
        const t = now()
        if (guardArmedAt !== null && t - guardArmedAt <= ARM_WINDOW_MS) return finish({ type: 'detach' })
        // Past the window (or never armed): a busy child re-arms the guard rather than detaching.
        if (lastOutputAt !== null && t - lastOutputAt < BUSY_WINDOW_MS) {
          guardArmedAt = t
          const rows = stdout.rows || 24
          stdout.write(`\x1b7\x1b[${rows};1H\x1b[7m still working — press again to detach \x1b[0m\x1b8`)
          return
        }
      }
      finish({ type: 'detach' })
    }
    const reader = makeChordReader({
      onChord: (chord: any) => (chord.type === 'detach' ? detachRequested() : finish(chord)),
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
    const onInput = (chunk: any) => reader.feed(chunk)
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
    const disposeExit = child.onExit((e: any) =>
      finish({ type: 'exit', exitCode: e?.exitCode ?? 0, drewNothing: !drew, ms: now() - startedAt }),
    )
    const wasRaw = stdin.isRaw
    // Ink releases stdin asynchronously once its input hooks go inactive, and that teardown lands
    // after this setup — so raw mode is asserted again on the next tick, or the first keystrokes
    // after attaching arrive line-buffered.
    const assertRaw = () => {
      if (settled) return
      if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(true)
      stdin.resume?.()
    }
    assertRaw()
    stdin.on('data', onInput)
    setImmediate(assertRaw)
    stdout.on?.('resize', onResize)

    function cleanup() {
      reader.stop() // never swallow an Escape that was being held for a possible Alt+N
      disposeData?.dispose?.()
      disposeExit?.dispose?.()
      stdin.off?.('data', onInput)
      stdout.off?.('resize', onResize)
      if (stdin.isTTY && stdin.setRawMode && !wasRaw) stdin.setRawMode(false)
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
