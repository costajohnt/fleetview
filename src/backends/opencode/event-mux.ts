import { authHeader } from './client.ts'
import type { OpencodeEvent } from '../../types.ts'

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
  const url = `http://${host}:${port}/event?directory=${encodeURIComponent(directory)}`

  const done = (async () => {
    while (!stopped) {
      const decoder = new TextDecoder()
      try {
        // The event stream needs the same credential as every other request, or enabling auth
        // would leave fleetview rendering a permanently offline roster.
        const auth = authHeader()
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
            const chunk = step.value
            buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
            const { events, rest } = parseSseChunk(buf)
            buf = rest
            for (const e of events) onEvent(directory, e as OpencodeEvent)
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
