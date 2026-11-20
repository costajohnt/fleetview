// opencode 2.x's event stream: one server-wide connection, cut per directory and translated into
// the 1.x events session-store handles, so the store downstream never knows which it got. The
// transport underneath (sse.ts) is version-neutral; event-mux.ts hands 2.x subscribers here.
import { resolve } from 'node:path'
import { authHeader } from './client.ts'
import { OpencodeV2Client, isSessionForm, v1Error, v1Permission, v1Question } from './client-v2.ts'
import { backoff, readEventStream } from './sse.ts'
import type { OpencodeEvent } from '../../types.ts'
import { asString, isRecord } from '../../types.ts'

export type V2Handlers = {
  onEvent: (directory: string, event: OpencodeEvent) => void
  onOffline?: (directory: string) => void
  onOnline?: (directory: string) => void
  reconnect: boolean
}

type Subscriber = V2Handlers & {
  directory: string
  // This directory's filter for the current connection; null until its seed listing is in, and
  // frames meanwhile wait in `held`, in order.
  route: ((frame: unknown) => OpencodeEvent[]) | null
  held: unknown[]
  connection: number // which connection `route` and any in-flight seed belong to
  stopped: boolean
  finish: () => void
}

// 2.x's /api/event carries every directory's events, so the server gets one connection however
// many worktrees the roster streams (#186), and each subscriber takes its slice. Keyed by
// fetch implementation too, so tests with their own fake servers never share one.
const servers = new WeakMap<typeof fetch, Map<string, { join: (sub: Subscriber) => void; leave: (sub: Subscriber) => void }>>()

export function subscribeV2(base: string, directory: string, handlers: V2Handlers, { fetchImpl, idleMs }: { fetchImpl: typeof fetch; idleMs: number }) {
  let byBase = servers.get(fetchImpl)
  if (!byBase) servers.set(fetchImpl, (byBase = new Map()))
  const key = `${base} ${idleMs}`
  let server = byBase.get(key)
  if (!server) {
    const created = serverStream(base, fetchImpl, idleMs, () => byBase.get(key) === created && byBase.delete(key))
    byBase.set(key, (server = created))
  }
  let finish!: () => void
  const done = new Promise<void>((r) => (finish = r))
  const sub: Subscriber = { ...handlers, directory, route: null, held: [], connection: -1, stopped: false, finish }
  const joined = server
  joined.join(sub)
  return {
    done,
    stop: () => {
      sub.stopped = true
      joined.leave(sub)
    },
  }
}

// The one connection to `base`, reconnecting with backoff while anyone is subscribed. Each
// subscriber keeps the semantics it had with a connection of its own: online when the stream opens,
// a seed listed once the first bytes are in (#184), offline on any failure, and its own listing
// failure taking only it offline, to retry a second later.
function serverStream(base: string, fetchImpl: typeof fetch, idleMs: number, forget: () => void) {
  const subs = new Set<Subscriber>()
  let ac = new AbortController()
  let connection = 0
  let open = false // the current connection answered with a stream
  let flowing = false // and its first bytes are in
  let running = false
  let waiting = false // in the backoff between connections

  // The last one out is finished only once the connection has wound down and released its body,
  // as its own connection's `done` would have been.
  const winding: (() => void)[] = []
  const leave = (sub: Subscriber) => {
    if (!subs.delete(sub)) return
    if (subs.size > 0 || !running) return sub.finish()
    winding.push(sub.finish)
    forget()
    ac.abort()
  }
  const deliver = (sub: Subscriber, frames: unknown[]) => {
    for (const frame of frames) {
      if (sub.stopped || !sub.route) return
      for (const event of sub.route(frame)) sub.onEvent(sub.directory, event)
    }
  }
  const seed = (sub: Subscriber) => {
    const at = connection
    sub.connection = at
    v2Filter(base, sub.directory, fetchImpl).then(
      (route) => {
        if (sub.stopped || sub.connection !== at || at !== connection) return
        sub.route = route
        const held = sub.held
        sub.held = []
        deliver(sub, held)
      },
      async () => {
        if (sub.stopped || sub.connection !== at || at !== connection) return
        sub.held = []
        sub.onOffline?.(sub.directory)
        if (!sub.reconnect) return leave(sub)
        await backoff(1000, ac.signal)
        if (sub.stopped || at !== connection || !open) return
        sub.onOnline?.(sub.directory)
        seed(sub)
      },
    )
  }
  const reset = (sub: Subscriber) => {
    sub.route = null
    sub.held = []
    sub.connection = -1
  }

  const run = async () => {
    running = true
    let delay = 1000
    while (subs.size) {
      ac = new AbortController()
      connection++
      open = false
      flowing = false
      try {
        await readEventStream(`${base}/api/event`, {
          fetchImpl,
          signal: ac.signal,
          idleMs,
          onOpen: () => {
            open = true
            delay = 1000
            for (const sub of subs) sub.onOnline?.(sub.directory)
          },
          onChunk: (frames) => {
            if (!flowing) {
              flowing = true
              for (const sub of subs) seed(sub)
            }
            for (const sub of subs) {
              if (sub.route) deliver(sub, frames)
              else sub.held.push(...frames)
            }
          },
        })
      } catch {
        open = false
        connection++ // a seed still in flight belongs to the connection that just ended
        for (const sub of [...subs]) {
          reset(sub)
          if (sub.stopped) continue
          sub.onOffline?.(sub.directory)
          if (!sub.reconnect) leave(sub)
        }
        if (!subs.size) break
        waiting = true
        await backoff(delay, ac.signal)
        waiting = false
        delay = Math.min(delay * 2, 30_000)
      }
    }
    running = false
    for (const finish of winding.splice(0)) finish()
  }

  return {
    join: (sub: Subscriber) => {
      subs.add(sub)
      if (!running) return void run()
      // Joining a live connection: online now, and seeded now if its bytes are already flowing.
      if (open) {
        sub.onOnline?.(sub.directory)
        if (flowing) seed(sub)
      }
      // A connection of its own would have been attempted at once, not after the backoff.
      else if (waiting) ac.abort()
    },
    leave,
  }
}

// One directory's slice of 2.x's server-wide stream, already translated. Events carry the
// session's `location` (opencode v2.3.2 publishes session.created with it); one that doesn't is
// kept when its session is one this directory is known to hold, seeded from the listing at every
// (re)connect and grown by session.created. Session renames and deletes carry no location (verified
// live against 2.3.2, recorded in test/fixtures/opencode-2.3.2-events.sse), so the seed is what
// routes them.
//
// Paths are compared resolved: 2.x strips a trailing slash from the directory it is given (verified
// live), so a roster directory spelled with one never matched. Not realpath: 2.x keeps a symlinked
// spelling as given (also verified), so its sessions are listed under that spelling, not the target.
async function v2Filter(base: string, directory: string, fetchImpl: typeof fetch) {
  const mine = new Set((await new OpencodeV2Client(base, fetchImpl, () => authHeader()).listSessions(directory)).map((s) => s.id))
  const here = resolve(directory)
  const translate = createV2Translator()
  return (frame: unknown): OpencodeEvent[] => {
    if (!isRecord(frame) || !isRecord(frame.data)) return []
    const raw = isRecord(frame.location) ? asString(frame.location.directory) : undefined
    const where = raw === undefined ? undefined : resolve(raw)
    const sessionID = asString(frame.data.sessionID) ?? (isRecord(frame.data.form) ? asString(frame.data.form.sessionID) : undefined)
    if (frame.type === 'session.created' && where === here && sessionID) mine.add(sessionID)
    if (where !== undefined ? where !== here : !sessionID || !mine.has(sessionID)) return []
    return translate(frame)
  }
}

// 2.x frames ({type, created, data}) to the 1.x events session-store handles ({type, properties}).
// Stateful only for streamed text: 2.x sends deltas, 1.x sent the part's whole text each time.
export function createV2Translator() {
  const texts = new Map<string, string>()
  // Assistant messages this translator has announced. A stream that reconnects mid-step never sees
  // that step's session.step.started, and the store drops text for a message it doesn't know.
  const announced = new Set<string>()
  const running = new Map<string, number>() // executions plus shells in flight, per session
  const announce = (sessionID: string, messageID: string | undefined): OpencodeEvent[] => {
    if (!messageID || announced.has(messageID)) return []
    announced.add(messageID)
    return [{ type: 'message.updated', properties: { sessionID, info: { id: messageID, role: 'assistant' } } }]
  }
  return (frame: unknown): OpencodeEvent[] => {
    if (!isRecord(frame) || !isRecord(frame.data)) return []
    const d = frame.data
    const sessionID = asString(d.sessionID) ?? ''
    // No 2.x event carries the session's time.updated; the server sets it to the event's own
    // `created` on the events below, so that is what the store is told.
    const touched = (): OpencodeEvent[] =>
      typeof frame.created === 'number' ? [{ type: 'session.updated', properties: { info: { id: sessionID, time: { updated: frame.created } } } }] : []
    const messageID = asString(d.assistantMessageID)
    const idle: OpencodeEvent = { type: 'session.status', properties: { sessionID, status: { type: 'idle' } } }
    // 2.x lets a shell overlap a model execution (Session.shell has no busy check), and idle closes
    // the run and clears pending permissions and questions in the store, so idle waits until both
    // have finished. Starts from zero at each connect, where an unmatched end reads as idle.
    const busy = (): OpencodeEvent[] => {
      running.set(sessionID, (running.get(sessionID) ?? 0) + 1)
      return [{ type: 'session.status', properties: { sessionID, status: { type: 'busy' } } }]
    }
    const ended = (): OpencodeEvent[] => {
      const left = Math.max(0, (running.get(sessionID) ?? 0) - 1)
      if (left) running.set(sessionID, left)
      else running.delete(sessionID)
      return left ? [] : [idle]
    }
    switch (frame.type) {
      case 'session.status':
        return [{ type: 'session.status', properties: { sessionID, status: isRecord(d.status) ? (d.status as { type: string }) : undefined } }]
      case 'session.renamed':
        return [{ type: 'session.updated', properties: { info: { id: sessionID, title: asString(d.title), ...(typeof frame.created === 'number' ? { time: { updated: frame.created } } : {}) } } }]
      case 'session.deleted':
        return [{ type: 'session.deleted', properties: { info: { id: sessionID } } }]
      case 'session.inbox.enqueued':
        return [{ type: 'message.updated', properties: { sessionID, info: { role: 'user' } } }, ...touched()]
      case 'session.step.started':
        announced.delete(messageID ?? '')
        return [...announce(sessionID, messageID), ...touched()]
      case 'session.step.ended':
      case 'session.step.failed':
        return touched()
      case 'session.text.delta':
      case 'session.text.ended': {
        const key = `${messageID}:${String(d.ordinal)}`
        const text = frame.type === 'session.text.ended' ? (asString(d.text) ?? '') : (texts.get(key) ?? '') + (asString(d.delta) ?? '')
        if (frame.type === 'session.text.ended') texts.delete(key)
        else texts.set(key, text)
        return [...announce(sessionID, messageID), { type: 'message.part.updated', properties: { sessionID, part: { type: 'text', text, messageID } } }]
      }
      // opencode 2.3.2 publishes no session.status (core/session/execution.ts sends only these
      // execution events, and opencode's own client derives busy/idle from them), so busy and idle
      // come from here. Idle after the error, as 1.x ordered them.
      case 'session.execution.started':
        return busy()
      case 'session.execution.succeeded':
        return ended()
      // A `!` shell job runs no execution at all on 2.x: these are the only frames it sends (opencode
      // 2.3.2 schema/session-event.ts has started and ended, nothing else; recorded live in
      // test/fixtures/opencode-2.3.2-events.sse), so they are its busy and idle (#206).
      case 'session.shell.started':
        return [...busy(), ...touched()]
      case 'session.shell.ended':
        return [...ended(), ...touched()]
      case 'session.execution.failed':
        return [{ type: 'session.error', properties: { sessionID, error: v1Error(d.error) } }, ...ended()]
      // 1.x reported a user's stop as an error named MessageAbortedError, which the store records as
      // stopped rather than failed. A shutdown, supersede or inactivity stop is just the end.
      case 'session.execution.interrupted':
        return d.reason === 'user' ? [{ type: 'session.error', properties: { sessionID, error: { name: 'MessageAbortedError', data: { message: 'user' } } } }, ...ended()] : ended()
      case 'permission.asked':
        return [{ type: 'permission.asked', properties: v1Permission(d) }]
      case 'permission.replied':
        return [{ type: 'permission.replied', properties: { sessionID, requestID: asString(d.requestID) ?? '', reply: d.reply as 'once' | 'always' | 'reject' } }]
      case 'form.created':
        return isRecord(d.form) && isSessionForm(d.form) ? [{ type: 'question.asked', properties: v1Question(d.form) }] : []
      case 'form.replied':
        return [{ type: 'question.replied', properties: { sessionID, requestID: asString(d.id) ?? '' } }]
      case 'form.cancelled':
        return [{ type: 'question.rejected', properties: { sessionID, requestID: asString(d.id) ?? '' } }]
      default:
        return []
    }
  }
}
