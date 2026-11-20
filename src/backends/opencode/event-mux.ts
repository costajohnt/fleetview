import { resolve } from 'node:path'
import { authHeader, opencodeApi } from './client.ts'
import { OpencodeV2Client, isSessionForm, v1Error, v1Permission, v1Question } from './client-v2.ts'
import type { OpencodeEvent } from '../../types.ts'
import { asString, isRecord } from '../../types.ts'

export function parseSseChunk(buffer: string): { events: unknown[]; rest: string } {
  const events: unknown[] = []
  // SSE permits CRLF line endings, not just LF — a CRLF/proxied server would otherwise never frame.
  const blocks = buffer.split(/\r?\n\r?\n/)
  const rest = blocks.pop() ?? '' // partial block stays buffered
  for (const block of blocks) {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      try {
        events.push(JSON.parse(line.slice(5).trim()))
      } catch {
        // malformed frame: skip
      }
    }
  }
  return { events, rest }
}

// How long a connected stream may say nothing at all before it counts as dead. A half-open TCP
// connection (laptop sleep, VPN flap) delivers no bytes and no error, so the read below would sit
// there until undici's implicit ~300s bodyTimeout — five minutes of a project quietly frozen while
// the roster shows it online. Two minutes instead, and the server is on 127.0.0.1, so the cost of
// being wrong (a quiet-but-live stream reconnecting) is one localhost round trip and a re-seed.
const IDLE_MS = 120_000

export type ConnectTarget = { host: string; port: number; directory: string }
export type ConnectOptions = {
  fetchImpl?: typeof fetch
  // Parsed SSE frame. Cast from the JSON below at the call site: the stream also carries event
  // types fleetview doesn't handle, which the session store's switch ignores. See OpencodeEvent.
  onEvent: (directory: string, event: OpencodeEvent) => void
  onOffline?: (directory: string) => void
  onOnline?: (directory: string) => void
  reconnect?: boolean
  idleMs?: number
}

export function connectEvents({ host, port, directory }: ConnectTarget, { fetchImpl = globalThis.fetch, onEvent, onOffline, onOnline, reconnect = true, idleMs = IDLE_MS }: ConnectOptions) {
  let stopped = false
  let delay = 1000
  const ac = new AbortController()
  const base = `http://${host}:${port}`

  const done = (async () => {
    while (!stopped) {
      const decoder = new TextDecoder()
      try {
        // The event stream needs the same credential as every other request, or enabling auth
        // would leave fleetview rendering a permanently offline roster.
        const auth = authHeader()
        // 2.x has one server-wide stream in its own vocabulary; it is cut to this directory and
        // translated to 1.x's events here, so the store downstream never knows which it got.
        // An unanswered probe backs off like any failed connect. It used to fall back to 1.x's
        // /event, which a 2.x server answers 200 with its web app: online, then offline, on a loop.
        const isV2 = (await opencodeApi(base, fetchImpl)) === 2
        let v2: ((frame: unknown) => OpencodeEvent[]) | null = null
        const url = isV2 ? `${base}/api/event` : `${base}/event?directory=${encodeURIComponent(directory)}`
        const res = await fetchImpl(url, { signal: ac.signal, headers: auth ? { authorization: auth } : undefined })
        if (stopped) return
        if (!res.ok || !res.body) throw new Error(`event stream ${res.status}`)
        onOnline?.(directory)
        delay = 1000
        let buf = ''
        // Read chunk by chunk against a deadline rather than `for await`, which has no way to say
        // "and give up if nothing arrives". Timing out throws into the catch below, so a stalled
        // stream takes the reconnect/backoff path that already exists instead of a second one.
        const iterator = (res.body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
        try {
          for (;;) {
            let timer!: ReturnType<typeof setTimeout>
            const idle: Promise<never> = new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('event stream idle')), idleMs)
            })
            // Armed per chunk, so the deadline measures silence since the last byte — not since the
            // connection opened, which would kill every healthy long-lived stream on schedule.
            const step = await Promise.race([iterator.next(), idle]).finally(() => clearTimeout(timer))
            if (step.done) break
            if (stopped) return
            // The 2.x seed is listed once the first bytes are in, not before the stream opens (#184):
            // 2.3.2 subscribes only when the body starts flowing (handlers/event.ts, announced by
            // server.connected), so a session created before that was known to nobody and its
            // location-less frames were dropped until reconnect. Later frames wait unread meanwhile;
            // a failed listing throws into the reconnect path, and the finally releases the body.
            if (isV2 && !v2) {
              v2 = await v2Filter(base, directory, fetchImpl)
              if (stopped) return
            }
            const chunk = step.value
            buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
            const { events, rest } = parseSseChunk(buf)
            buf = rest
            for (const e of events) for (const out of v2 ? v2(e) : [e as OpencodeEvent]) onEvent(directory, out)
          }
        } finally {
          // The deadline walks away from a still-pending next(); returning the iterator cancels the
          // body so a stalled connection's socket is released instead of leaking one per reconnect.
          // Not awaited: return() on an iterator parked mid-read only settles when that read does,
          // and a read that never settles is the exact case this exists for — awaiting it would
          // hang the reconnect the deadline just earned.
          try {
            Promise.resolve(iterator.return?.()).catch(() => {})
          } catch {
            // an iterator without a return(); nothing to release
          }
        }
        throw new Error('event stream ended')
      } catch {
        if (stopped) return
        onOffline?.(directory)
        if (!reconnect) return
        await new Promise<void>((r) => {
          const onAbort = () => { clearTimeout(t); r() }
          const t = setTimeout(() => { ac.signal.removeEventListener('abort', onAbort); r() }, delay)
          ac.signal.addEventListener('abort', onAbort, { once: true })
        })
        delay = Math.min(delay * 2, 30_000)
      }
    }
  })()

  return { done, stop: () => { stopped = true; ac.abort() } }
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
        return [{ type: 'session.status', properties: { sessionID, status: { type: 'busy' } } }]
      case 'session.execution.succeeded':
        return [idle]
      case 'session.execution.failed':
        return [{ type: 'session.error', properties: { sessionID, error: v1Error(d.error) } }, idle]
      // 1.x reported a user's stop as an error named MessageAbortedError, which the store records as
      // stopped rather than failed. A shutdown, supersede or inactivity stop is just the end.
      case 'session.execution.interrupted':
        return d.reason === 'user' ? [{ type: 'session.error', properties: { sessionID, error: { name: 'MessageAbortedError', data: { message: 'user' } } } }, idle] : [idle]
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
