// The version-neutral half of the opencode event stream: one connection's bytes to parsed frames.
// Which URL, what the frames mean and who gets them is event-mux.ts (1.x) and event-v2.ts (2.x).
import { authHeader } from './client.ts'
import { credentialFor, ownershipLost } from './request.ts'

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
export const IDLE_MS = 120_000

// One connection, from request to its end. Never returns normally: a stream that ends, stalls past
// `idleMs`, is refused or isn't an event stream throws, which is each caller's reconnect path.
// `onOpen` runs once the response is a stream; `onChunk` gets each chunk's frames, and may be async
// (later chunks wait unread meanwhile, and a throw from it ends the connection like any other).
export async function readEventStream(
  url: string,
  {
    fetchImpl,
    signal,
    idleMs,
    onOpen,
    onChunk,
  }: { fetchImpl: typeof fetch; signal: AbortSignal; idleMs: number; onOpen: () => void; onChunk: (frames: unknown[]) => void | Promise<void> },
): Promise<never> {
  // The event stream needs the same credential as every other request, or enabling auth
  // would leave fleetview rendering a permanently offline roster.
  // #216: unless the owner is in doubt (request.ts). A lost connection, not one of our own stops,
  // puts it there: refused, reset, ended or silent. A server that answers (a status, a page) or a
  // handler that throws has not given up the port.
  const auth = credentialFor(url, authHeader())
  const lost: (err: unknown) => never = (err) => {
    if (!signal.aborted) ownershipLost(url)
    throw err
  }
  const res = await fetchImpl(url, { signal, headers: auth ? { authorization: auth } : undefined }).catch(lost)
  if (signal.aborted) throw new Error('event stream stopped')
  if (!res.ok || !res.body) throw new Error(`event stream ${res.status}`)
  // A 2.x server answers 1.x's /event (asked after an unanswered probe) 200 with its web app,
  // which read as online and then dropped: a flap per attempt (#186). Only a stream is one.
  const type = res.headers?.get?.('content-type')
  if (type && !type.startsWith('text/event-stream')) throw new Error(`event stream is ${type}`)
  onOpen()
  const decoder = new TextDecoder()
  let buf = ''
  // Read chunk by chunk against a deadline rather than `for await`, which has no way to say
  // "and give up if nothing arrives". Timing out throws, so a stalled stream takes the caller's
  // reconnect/backoff path instead of a second one. A stop races the read the same way, so a body
  // that ignores the abort can't hold its reader open.
  const iterator = (res.body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
  try {
    for (;;) {
      let timer!: ReturnType<typeof setTimeout>
      let onAbort!: () => void
      const idle: Promise<never> = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('event stream idle')), idleMs)
        onAbort = () => reject(new Error('event stream stopped'))
        signal.addEventListener('abort', onAbort, { once: true })
      })
      // Armed per chunk, so the deadline measures silence since the last byte — not since the
      // connection opened, which would kill every healthy long-lived stream on schedule.
      const step = await Promise.race([iterator.next(), idle])
        .catch(lost)
        .finally(() => {
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
        })
      if (step.done) lost(new Error('event stream ended'))
      if (signal.aborted) throw new Error('event stream stopped')
      const chunk = step.value
      buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
      const { events, rest } = parseSseChunk(buf)
      buf = rest
      await onChunk(events)
      if (signal.aborted) throw new Error('event stream stopped')
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
      // return() threw synchronously; nothing more to release
    }
  }
  throw new Error('event stream ended')
}

// Sleep `ms`, cut short by `signal`. The listener is removed when the timer wins, so a long run of
// backoffs doesn't pile listeners on one signal.
export function backoff(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((r) => {
    const onAbort = () => {
      clearTimeout(t)
      r()
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      r()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
