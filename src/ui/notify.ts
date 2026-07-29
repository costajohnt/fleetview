import { spawn } from 'node:child_process'
import { stripControl } from '../text-utils.ts'
import { envWithoutServerPassword } from '../registry.ts'
// Terminal-level signals agent view sends while it's open:
//
//   "The terminal tab title shows the awaiting-input count while agent view is open:
//    `2 awaiting input · claude agents`"
//   "Claude Code also sends a notification ... when a local background session starts needing your
//    input, finishes, or fails."
//
// Both are plain terminal escapes rather than drawing, so they deliberately bypass the render gate
// and keep firing while a session is attached — noticing that another session needs you without
// leaving the one you're in is the whole reason fleetview stays resident.

// Counts only sessions actually blocked on a request the server reported — a pending permission
// or question. The `?` heuristic is a guess about prose, and a guess should not put a number in
// the user's tab title or interrupt them; it earns a place in the `needs input` group and nothing
// louder.
export const titleFor = (sessions: any[]) => {
  const waiting = sessions.filter((s) => s.status === 'waiting' && s.pendingRequest).length
  return waiting > 0 ? `${waiting} awaiting input · fleetview` : 'fleetview'
}

// Neither of these is drawing, so both bypass the render gate when one is present — see
// gated-stdout. Wrapped so a non-TTY (tests, pipes) is a no-op.
const emit = (stream: any, text: string) => (stream.writeThrough ? stream.writeThrough(text) : stream.write(text))

// OSC 0 sets both the window and tab title.
export function setTitle(stream: any, title: string) {
  if (!stream?.isTTY) return
  emit(stream, `\u001B]0;${title}\u0007`)
}

export const bell = (stream: any) => stream?.isTTY && emit(stream, '\u0007')

// Which sessions crossed into a state worth interrupting the user for. Compares two snapshots of
// `${projectKey}:${id}` → status, so a session that was already waiting doesn't re-notify on every
// unrelated re-render.
// Agent view fires Notification hooks (agent_needs_input, agent_completed) so users can wire
// desktop notifications. fleetview's version: FLEETVIEW_NOTIFY_CMD names a shell command, run
// fire-and-forget on each transition with the event and session in its environment. Failed hooks
// are silent — a notifier must never take down the roster.
export function hookTransitions(previous: Map<string, string>, current: Map<string, string>) {
  // Deliberately NOT session-store's FINISHED_STATUSES: `error` is missing on purpose. A run that
  // ended badly fires `agent_failed` on the line below, and a notifier that also saw it as
  // `agent_completed` would announce the same event twice with opposite meanings.
  const finished = new Set(['done', 'stopped', 'idle'])
  const out = []
  for (const [key, status] of current) {
    const prev = previous.get(key)
    if (prev === status) continue
    if (status === 'waiting') out.push({ key, event: 'agent_needs_input' })
    else if (status === 'error' && previous.has(key)) out.push({ key, event: 'agent_failed' })
    else if (finished.has(status) && prev === 'running') out.push({ key, event: 'agent_completed' })
  }
  return out
}

export function runNotifyHook({ event, session }: { event: string; session: any }, { spawnImpl, command = process.env.FLEETVIEW_NOTIFY_CMD ?? process.env.ROOST_NOTIFY_CMD }: { spawnImpl?: any; command?: string } = {}) {
  if (!command) return
  try {
    const child = (spawnImpl ?? spawn)('sh', ['-c', command], {
      detached: true,
      stdio: 'ignore',
      env: {
        // Not process.env: the hook is a shell command running on every status transition, and the
        // opencode server password would give it ungated shell on the server (M1).
        ...envWithoutServerPassword(),
        // stripControl: the title is model-derived and the id/project are server-derived. fleetview
        // passes them as env values (not shell-interpolated, so no injection here), but a hook that
        // echoes them to a terminal would inherit escape sequences — strip control bytes first.
        FLEETVIEW_EVENT: event,
        FLEETVIEW_SESSION_ID: stripControl(session?.id ?? ''),
        FLEETVIEW_SESSION_TITLE: stripControl(session?.title ?? ''),
        FLEETVIEW_PROJECT: stripControl(session?.projectKey ?? ''),
      },
    })
    child.unref?.()
  } catch {
    // deliberately silent
  }
}

export function newlyNotable(previous: Map<string, string>, current: Map<string, string>) {
  const notable = new Set(['waiting', 'error'])
  const out = []
  for (const [key, status] of current) {
    if (!notable.has(status)) continue
    if (previous.get(key) === status) continue
    if (previous.has(key) || status === 'waiting') out.push({ key, status })
  }
  return out
}
