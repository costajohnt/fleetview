import { EventEmitter } from 'node:events'
import { MOUSE_ON, MOUSE_OFF } from './ui/mouse.ts'

// Ink owns whatever stream it renders into and repaints whenever state changes. While a session is
// attached, the child PTY owns the terminal, so Ink's writes have to go nowhere — otherwise a
// status change on some other session would scribble a roster row across opencode's screen.
//
// This is the seam: Ink renders into this, and fleetview closes the gate for the duration of an
// attachment. `columns`/`rows` are proxied through because Ink reads them for layout, and the
// resize events matter to both sides.
// `mouse: true` ties SGR mouse reporting to the gate: on while fleetview owns the terminal, off the
// moment the gate closes for an attach or editor handover — otherwise the child process receives
// click sequences it never asked for as garbage keystrokes.
// `cursor: true` ties cursor visibility to the gate the same way: hidden while fleetview owns the
// terminal, restored for the child on close. Ink hides the cursor once at mount, but an attached
// child (opencode's TUI, an editor) shows it again on its own exit — without re-hiding on reopen,
// a visible cursor is left blinking after the hints line for the rest of the run.
const CURSOR_HIDE = '\x1b[?25l'
const CURSOR_SHOW = '\x1b[?25h'

type Gate = {
  write(chunk: string | Uint8Array, ...rest: unknown[]): boolean
  writeThrough(chunk: string | Uint8Array): boolean
  readonly columns: number
  readonly rows: number
  readonly isTTY: boolean
  open(): void
  close(): void
  readonly isOpen: boolean
  on(...a: Parameters<EventEmitter['on']>): Gate
  off(...a: Parameters<EventEmitter['off']>): Gate
  once(...a: Parameters<EventEmitter['once']>): Gate
  removeListener(...a: Parameters<EventEmitter['removeListener']>): Gate
  emit(...a: Parameters<EventEmitter['emit']>): boolean
  setMaxListeners(n: number): Gate
  dispose?: () => void
}

export function gatedStdout(target: NodeJS.WriteStream = process.stdout, { mouse = false, cursor = false }: { mouse?: boolean; cursor?: boolean } = {}) {
  const emitter = new EventEmitter()
  let open = true
  if (mouse) target.write(MOUSE_ON)
  if (cursor) target.write(CURSOR_HIDE)

  const gate: Gate = {
    write(chunk, ...rest) {
      if (open) return (target.write as (...a: unknown[]) => boolean)(chunk, ...rest)
      return true // pretend the write landed; Ink only cares about backpressure
    },
    // Escapes that aren't drawing — the bell, the tab title — must reach the terminal even while
    // a session is attached. Being told that another session needs you without leaving the one
    // you're in is the entire point of fleetview staying resident.
    writeThrough(chunk) {
      return target.write(chunk)
    },
    get columns() {
      return target.columns
    },
    get rows() {
      return target.rows
    },
    get isTTY() {
      return target.isTTY
    },
    open() {
      if (!open && mouse) target.write(MOUSE_ON)
      if (!open && cursor) target.write(CURSOR_HIDE)
      open = true
    },
    close() {
      if (open && mouse) target.write(MOUSE_OFF)
      if (open && cursor) target.write(CURSOR_SHOW)
      open = false
    },
    get isOpen() {
      return open
    },
    on: (...args) => (emitter.on(...args), gate),
    off: (...args) => (emitter.off(...args), gate),
    once: (...args) => (emitter.once(...args), gate),
    removeListener: (...args) => (emitter.removeListener(...args), gate),
    emit: (...args) => emitter.emit(...args),
    setMaxListeners: (n) => (emitter.setMaxListeners(n), gate),
  }

  // Ink subscribes to resize to re-layout; forward the real terminal's events to it. `dispose`
  // matters because fleetview builds a fresh gate per reconnect, and an unremoved listener on the real
  // stdout would accumulate across them until Node starts warning about a leak.
  const forward = () => emitter.emit('resize')
  target.on?.('resize', forward)
  gate.dispose = () => {
    if (mouse) target.write(MOUSE_OFF)
    target.off?.('resize', forward)
    emitter.removeAllListeners()
  }
  return gate
}
