import React, { useEffect, useState } from 'react'
import { Text } from 'ink'
import { theme } from './theme.ts'

// Agent view puts two independent things in one character. Colour is the session's state; shape
// is whether the underlying process is alive. Keeping them separate here is what lets a row say
// "this finished successfully, but nothing is running for it any more" in a single glyph.
// Shape is the state now, not just colour, matching agent view: `✳` asks for you, animated
// `✻/✽` is working, `•` is settled (done, failed, stopped, idle — colour still separates those).
const STATE: Record<string, { color: string; label: string; glyph: string; dim?: boolean }> = {
  running: { color: theme.info, label: 'working', glyph: '✻' },
  waiting: { color: theme.warn, label: 'needs input', glyph: '✳' },
  idle: { color: theme.muted, dim: true, label: 'idle', glyph: '•' },
  done: { color: theme.accent, label: 'completed', glyph: '•' },
  error: { color: theme.danger, label: 'failed', glyph: '•' },
  stopped: { color: theme.muted, label: 'stopped', glyph: '•' },
  // #34: not a status any backend reports — fleetview mints it for a roster member whose session
  // no longer exists server-side. The `∙` is the same "nothing is behind this" glyph an offline
  // row gets, because that is exactly what it means here, permanently.
  gone: { color: theme.muted, dim: true, label: 'gone', glyph: '∙' },
}

// `∙` process gone. fleetview's liveness signal is the project's SSE stream: opencode has no
// per-session worker to be dead, so a session in a project whose stream is down is the closest
// true equivalent of "can't reply right now".
const WORKING_FRAMES = ['✻', '✽']
const DEAD = '∙'

export const stateLabel = (status: string) => (STATE[status] ?? STATE.idle).label
export const stateColor = (status: string) => (STATE[status] ?? STATE.idle).color

export function badgeGlyph(status: string, { alive = true, frame = 0 } = {}) {
  if (!alive) return DEAD
  if (status === 'running') return WORKING_FRAMES[frame % WORKING_FRAMES.length]
  return (STATE[status] ?? STATE.idle).glyph
}

// M3: exported so callers can measure the badge's rendered width without duplicating the lookup.
// Always one cell now that the state word lives in the group header, per agent view: "In the
// default state grouping, the group header already names the state, so the row shows only the
// summary."
export const badgeLabel = () => '✻' // every glyph is one cell; callers only measure width

// Drives the working animation. Off entirely when nothing is running, so an idle fleetview doesn't
// wake the event loop every 400ms, and off under FLEETVIEW_REDUCED_MOTION for the same reason agent
// view honours prefersReducedMotion.
export function usePulse(active: boolean, { intervalMs = 400, reducedMotion = (process.env.FLEETVIEW_REDUCED_MOTION ?? process.env.ROOST_REDUCED_MOTION) === '1' } = {}) {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (!active || reducedMotion) return
    const id = setInterval(() => setFrame((f) => f + 1), intervalMs)
    return () => clearInterval(id)
  }, [active, reducedMotion, intervalMs])
  return reducedMotion ? 0 : frame
}

export function StatusBadge({ status, alive = true, frame = 0 }: { status: string; alive?: boolean; frame?: number }) {
  const { color, dim } = STATE[status] ?? STATE.idle
  return React.createElement(Text, { color, dimColor: dim }, badgeGlyph(status, { alive, frame }))
}
