// Copilot CLI's `--output-format json` stream (verified against 1.0.75 — see
// docs/specs/2026-07-25-copilot-backend-wire.md). Parsing and derivation live here, apart from the
// file reading in index.ts, for the same reason parseSseChunk sits apart from connectEvents: the
// interesting logic is "what does this run's state look like now", and that has to be testable
// against a recorded fixture rather than a spawned process.
import { parseNdjsonChunk } from '../ndjson.ts'

// Only the fields fleetview reads are named. Copilot adds event types between versions, and an
// exhaustive union would turn every new one into a type error over a line this code ignores anyway.
export type CopilotEvent = {
  type?: string
  data?: any // TODO(types): per-event payloads, shapes differ by `type` and are not pinned by the CLI
  ephemeral?: boolean
  sessionId?: string
  exitCode?: number
  [key: string]: unknown
}

// The shared NDJSON line loop (ndjson.ts) under the name this backend's consumers know it by.
export const parseJsonlChunk = (buffer: string) => parseNdjsonChunk<CopilotEvent>(buffer)

// `working` until the run says otherwise. There is no `needs input` here: a headless copilot run
// cannot ask — a tool it lacks permission for fails with `code: "denied"` and the model carries on
// unaware — so a status meaning "waiting for you" would never be true.
export type CopilotStatus = 'working' | 'completed' | 'failed'

export type RunState = {
  status: CopilotStatus
  lastOutput: string
  deniedTools: number // tools the run wanted and silently could not have; see the wire doc
  exitCode: number | null
  aborted: boolean // an `abort` event was seen this run; a clean end must not report `completed`
}

export const initialRun = (): RunState => ({ status: 'working', lastOutput: '', deniedTools: 0, exitCode: null, aborted: false })

// Pure and incremental: the poller in index.ts reads only the bytes appended since last tick, so it
// needs to fold new events onto the state it already had rather than re-reading the whole log.
export function applyEvent(run: RunState, event: CopilotEvent): RunState {
  // `ephemeral` marks display-only lines that a durable line repeats — assistant.message_delta then
  // assistant.message with the same text. Folding both would concatenate every reply with itself.
  if (event.ephemeral) return run

  // `result` is the one event with no `data` wrapper: sessionId/exitCode/usage sit at the top level.
  // Checked before anything reaches for event.data, which is what that asymmetry costs.
  if (event.type === 'result') {
    const exitCode = typeof event.exitCode === 'number' ? event.exitCode : 1
    // A denied run also exits 0 (verified: five denied tool calls, nothing written, exitCode 0), so
    // the exit code alone cannot separate worked from didn't. A run that reached its end having
    // produced no assistant text at all did not complete anything, whatever it exited with — and an
    // aborted one exits 0 too (verified: SIGTERM writes abort events then result with exitCode 0),
    // so an interrupted run with earlier output would otherwise go green.
    const status: CopilotStatus = exitCode !== 0 || !run.lastOutput || run.aborted ? 'failed' : 'completed'
    return { ...run, status, exitCode }
  }

  // Written when the run is interrupted (SIGTERM/^C — data.reason "user_initiated"). Not terminal
  // by itself: the result/shutdown that follows carries the exit, so this only marks the run.
  if (event.type === 'abort') return { ...run, aborted: true }

  // The on-disk transcript's terminal line, and the only one it has: `result` goes to stdout, which
  // only a run fleetview itself spawned captures — a discovered session's events.jsonl ends with
  // session.shutdown instead (verified against real interactive, headless and aborted sessions; the
  // wire doc's "result only for headless runs" was wrong — it is stdout-only for every run).
  // shutdownType says "routine" even for an aborted run, so the abort mark above is the tiebreak.
  if (event.type === 'session.shutdown') {
    if (run.exitCode !== null) return run // a result already settled this run
    const status: CopilotStatus = run.aborted || !run.lastOutput ? 'failed' : 'completed'
    return { ...run, status, exitCode: 0 }
  }

  // A resumed session appends a second run to the same transcript, so the previous run's terminal
  // state has to be cleared or the session would report `completed` for as long as the new run takes
  // — the exact window where the roster most needs to say `working`. The denial count goes with it:
  // it describes the run in progress, not everything the session was ever refused.
  if (event.type === 'user.message') return { ...run, status: 'working', deniedTools: 0, exitCode: null, aborted: false }

  if (event.type === 'assistant.message') {
    const content = event.data?.content
    // Empty on a pure tool call — the message carries `toolRequests` and no prose. Keeping it would
    // blank out the last real thing the session said every time it picked up a tool.
    if (typeof content !== 'string' || !content) return run
    return { ...run, lastOutput: content }
  }

  if (event.type === 'tool.execution_complete' && event.data?.error?.code === 'denied') {
    return { ...run, deniedTools: run.deniedTools + 1 }
  }

  return run
}

export function foldEvents(run: RunState, events: readonly CopilotEvent[]): RunState {
  let next = run
  for (const event of events) next = applyEvent(next, event)
  return next
}
