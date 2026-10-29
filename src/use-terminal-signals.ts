import { useEffect, useRef } from 'react'
import { titleFor, setTitle, bell, newlyNotable, hookTransitions, runNotifyHook, type TitleStream } from './ui/notify.ts'
import type { RosterSession } from './ui/view-types.ts'

// Terminal-level signals: the tab title carries the awaiting-input count, and a session that
// starts needing you (or fails) rings the bell. Staying resident is what makes this useful —
// it keeps happening while you're attached to some other session. `allMembers` is App's whole
// fleet, never the rendered rows (see App). Its own module, not ui/notify.ts, so runNotifyHook is
// reached through notify's export — the seam test/app-notify.test.ts mocks.
export function useTerminalSignals({ stdout, serverReady, allMembers }: { stdout: TitleStream; serverReady: boolean; allMembers: RosterSession[] }) {
  const statusSnapshot = useRef<Map<string, any> | null>(null) // null until the first pass, which only records
  const lastTitle = useRef<string | null>(null)
  useEffect(() => {
    if (!serverReady) return
    // Same rule as the tab title: only a server-reported block is worth interrupting for. A row
    // that reads as waiting because its last line happened to end in a question mark must not ring.
    const current = new Map(
      allMembers.map((row) => [`${row.projectKey}:${row.id}`, row.status === 'waiting' && !row.pendingRequest ? 'done' : row.status]),
    )
    // The first pass is discovery, not news: sessions that were already waiting when fleetview
    // started didn't just start needing you, and ringing for them would make every launch chime.
    if (statusSnapshot.current && newlyNotable(statusSnapshot.current, current).length > 0) bell(stdout)
    // The user's notifier command sees every meaningful transition, not just the bell-worthy two.
    if (statusSnapshot.current) {
      const byKey = new Map(allMembers.map((row) => [`${row.projectKey}:${row.id}`, row]))
      for (const t of hookTransitions(statusSnapshot.current, current)) {
        runNotifyHook({ event: t.event, session: byKey.get(t.key) })
      }
    }
    statusSnapshot.current = current
    // Only on change — this effect runs on every render, and re-emitting the title on each
    // keystroke makes some terminals flicker.
    const title = titleFor(allMembers)
    if (title !== lastTitle.current) {
      lastTitle.current = title
      setTitle(stdout, title)
    }
  })
  // Hand the tab title back on the way out rather than leaving a stale count on the terminal.
  useEffect(() => () => setTitle(stdout, ''), [stdout])
}
