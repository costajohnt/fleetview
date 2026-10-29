import { useEffect, useRef } from 'react'
import { useStdin } from 'ink'
import { buildLines, windowLines, type navigableRows } from './ui/roster.ts'
import { headerRows } from './ui/header.ts'
import type { AttachTarget, MouseEvent as SgrMouseEvent } from './types.ts'
import type { RosterGroup } from './ui/view-types.ts'

type NavRow = ReturnType<typeof navigableRows>[number]

// Mouse support, lifted out of App: the click/wheel → roster mapping, and the stdin tap that gets
// SGR reports past Ink 8 at all. Returns `handleMouse` for the roster's key handler to call.
export function useMouse({
  active,
  groups,
  offlineProjects,
  collapsed,
  navRows,
  navSel,
  navRow,
  maxRows,
  columns,
  backgroundedNoticeRows,
  setSelectedKey,
  toggleCollapsed,
  attach,
}: {
  // The roster is live: roster mode, server ready, nothing attached.
  active: boolean
  groups: RosterGroup[]
  offlineProjects: Set<string>
  collapsed: Set<string>
  navRows: NavRow[]
  navSel: number
  navRow: NavRow | undefined
  maxRows: number
  columns: number
  backgroundedNoticeRows: number
  setSelectedKey: (key: string | null) => void
  toggleCollapsed: (projectKey: string) => void
  attach: (row: AttachTarget) => void
}) {
  // Click-to-act, mirroring the keyboard: a click selects a row, a click on the selected row
  // attaches (Enter's empty-input verb), a click on a header toggles its collapse, and the wheel
  // moves the selection like arrows. Mapping y back to a line reuses the exact buildLines +
  // windowLines pair the Roster draws from, so a click can never land on a row that isn't there.
  const handleMouse = (ev: SgrMouseEvent) => {
    if (ev.kind === 'wheel-up' || ev.kind === 'wheel-down') {
      if (!navRows.length) return
      const next = ev.kind === 'wheel-up' ? Math.max(0, navSel - 1) : Math.min(navRows.length - 1, navSel + 1)
      return setSelectedKey(navRows[next].key)
    }
    if (ev.kind !== 'press' || ev.button !== 0) return
    const lines = buildLines(groups, offlineProjects, collapsed)
    const selIdx = Math.max(0, lines.findIndex((l) => l.key === navRow?.key))
    const { slice, above } = windowLines(lines, selIdx, maxRows)
    // Terminal rows are 1-based; the roster starts under the header block, plus the `↑ N more`
    // indicator row when it is drawn, plus the "moved to the background" notice line. The closure
    // still holds this press's notice state (the clear above is an async state update), which is
    // the frame the user actually clicked on.
    const line = slice[ev.y - headerRows(columns) - 1 - (above > 0 ? 1 : 0) - backgroundedNoticeRows]
    if (!line) return
    if (line.type === 'header') {
      setSelectedKey(line.key)
      return toggleCollapsed(line.projectKey)
    }
    if (line.type !== 'session') return
    // One click launches: select and attach in the same press (John's ask; the old
    // select-then-click-again dance made the first click feel dead).
    setSelectedKey(line.key)
    return attach(line.session)
  }

  // Clicks and the wheel. Ink 8 drops SGR mouse reports before any useInput sees them (ink
  // build/components/App.js handleReadable: a complete CSI sequence that parses to no key name is
  // discarded, ink #1014), so this taps stdin for them and feeds each one back into Ink's input
  // emitter, where the roster's useInput (use-roster-keys.ts) handles it exactly as it did on Ink 7.
  // Ink pulls input with stdin.read(), and every read() also emits 'data' with the same chunk, so the
  // tap never competes with Ink for bytes. Going back through Ink, not calling handleMouse here, is
  // load-bearing: useInput runs its handler inside the reconciler's discreteUpdates, so a click
  // that attaches commits synchronously and Ink's raw-mode release lands before pty-host's
  // deferred re-assert. Called from here, that release landed after it and left the attached
  // child's tty cooked (the detach chord echoed as ^Z). `internal_eventEmitter` is the emitter
  // useInput subscribes to (build/hooks/use-input.js); it is not in useStdin's public type.
  // The tail carry rejoins a report a slow link split across two reads.
  const { stdin, internal_eventEmitter: inkInput } = useStdin() as ReturnType<typeof useStdin> & { internal_eventEmitter: NodeJS.EventEmitter }
  const mouseTail = useRef('')
  useEffect(() => {
    if (!active) return
    mouseTail.current = ''
    const tap = (chunk: string | Buffer) => {
      const buf = mouseTail.current + String(chunk)
      mouseTail.current = /\x1b(\[(<[\d;]*)?)?$/.exec(buf)?.[0] ?? ''
      // Deferred out of the read() that emitted this chunk, so Ink finishes its own pass first.
      for (const [report] of buf.matchAll(/\x1b\[<\d+;\d+;\d+[Mm]/g)) queueMicrotask(() => inkInput.emit('input', report))
    }
    stdin.on('data', tap)
    return () => {
      stdin.off('data', tap)
    }
  }, [stdin, inkInput, active])

  return handleMouse
}
