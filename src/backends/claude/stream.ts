// Reading a `claude -p --output-format=stream-json` run. Pure: takes text, returns events and a
// state, touches no disk and no clock, so the fixtures under test/fixtures can drive it directly.
import { parseNdjsonChunk } from '../ndjson.ts'
import { isRecord } from '../../types.ts'

// Wire shapes are documented in docs/specs/2026-07-25-claude-backend-wire.md and typed the same way
// the opencode payloads in types.ts are — only the fields this file reads are named, everything else
// rides along. The stream carries more than the documented event types (this machine's SessionStart
// hooks alone added seven `system` lines before the run began), so every reader below skips what it
// doesn't recognise rather than switching exhaustively.

// 'idle' is not a run outcome — it is the honest answer for a session read out of a Claude Code
// transcript rather than out of a run fleetview captured. Those transcripts have no `result` record
// (see the wire notes), so whether the session finished, failed or is still going cannot be known
// from the file; 'idle' says that, where seeding such a session as 'working' would claim it.
export type ClaudeRunStatus = 'working' | 'completed' | 'failed' | 'needs-input' | 'idle'

export type ClaudeRunState = {
  status: ClaudeRunStatus
  // Latest assistant `text` block, or the finished run's `result` string — what a roster row shows.
  lastOutput: string
  sessionId: string | undefined
  // Tools the run asked for and policy refused. Non-empty is the whole of `needs-input`: the run is
  // over, but it stopped short of the work and only a person at an attached terminal can unblock it.
  denials: unknown[]
  // Set only on a failed run. `result.errors` when the CLI gave one, else the final text.
  error: string | undefined
}

export const emptyRunState = (): ClaudeRunState => ({
  status: 'working',
  lastOutput: '',
  sessionId: undefined,
  denials: [],
  error: undefined,
})

// The seed for a session read out of a Claude Code transcript. Same reducer, different starting
// status: a transcript's records are `assistant`/`user` in the same shape the stream uses, so
// last-output falls out correctly, but nothing in the file can ever move the status off 'idle'.
// ponytail: a discovered session's completion is unknowable from the transcript alone — the upgrade
// path is the roster ageing it off mtime (listTranscripts already returns updatedAt), not this
// module inventing a result event.
export const emptyTranscriptState = (): ClaudeRunState => ({ ...emptyRunState(), status: 'idle' })

// The shared NDJSON line loop under the name this backend's consumers know it by (ndjson.ts).
export const parseStreamChunk = parseNdjsonChunk

const textOf = (event: Record<string, unknown>): string | undefined => {
  const blocks = isRecord(event.message) ? event.message.content : undefined
  if (!Array.isArray(blocks)) return undefined
  // Last `text` block, not last block: a turn emits thinking and tool_use blocks through the same
  // field, and either one rendered as the session's visible output is wrong.
  let found: string | undefined
  for (const b of blocks) if (isRecord(b) && b.type === 'text' && typeof b.text === 'string' && b.text) found = b.text
  return found
}

// Folds a run's events onto a state. Left-fold rather than a scan of the whole array so a tail can
// apply only what arrived since the last poll, and so a resume — which appends a second run's
// events to the same log — is handled by the same code: its `init` resets the state to working.
export function applyEvent(state: ClaudeRunState, event: unknown): ClaudeRunState {
  // A frame that isn't an object carries no fields to read; every branch below then misses.
  const e: Record<string, unknown> = isRecord(event) ? event : {}
  if (e.type === 'system' && e.subtype === 'init') {
    // A second init means a follow-up prompt resumed the session into the same log. Status, denials
    // and the error go back to square one; lastOutput stays, so the row doesn't blank out between
    // the resume starting and its first reply.
    return { ...state, status: 'working', sessionId: typeof e.session_id === 'string' ? e.session_id : state.sessionId, denials: [], error: undefined }
  }
  if (e.type === 'assistant') {
    const text = textOf(e)
    return text === undefined ? state : { ...state, lastOutput: text }
  }
  if (e.type === 'result') {
    // First result wins. A run that writes a valid `result` and *then* exits non-zero gets a
    // synthetic failure line appended by the backend's exit handler, and a second terminal line
    // must not overwrite what the run itself reported. Mirrors copilot's `if (run.exitCode !==
    // null) return run` in events.ts. An `init` (a resume) puts the state back to 'working', so a
    // follow-up prompt's own result still lands.
    if (state.status === 'completed' || state.status === 'failed' || state.status === 'needs-input') return state
    const denials = Array.isArray(e.permission_denials) ? e.permission_denials : []
    const errors = Array.isArray(e.errors) ? e.errors.filter((x: unknown) => typeof x === 'string') : []
    // The child exits 0 whether the run worked or not (a resume against an unknown session exits 0
    // with subtype error_during_execution), so success is read off the event and nowhere else.
    const failed = e.is_error === true || e.subtype !== 'success'
    const result = typeof e.result === 'string' && e.result ? e.result : undefined
    return {
      ...state,
      status: failed ? 'failed' : denials.length ? 'needs-input' : 'completed',
      // `result` repeats the final assistant text, so a run whose last event is the only one we saw
      // still has something to show.
      lastOutput: result ?? state.lastOutput,
      sessionId: typeof e.session_id === 'string' ? e.session_id : state.sessionId,
      denials,
      error: failed ? (errors.join('; ') || result || 'claude run failed') : undefined,
    }
  }
  return state
}

export const reduceRun = (events: Iterable<unknown>, from = emptyRunState()) => {
  let state = from
  for (const e of events) state = applyEvent(state, e)
  return state
}
