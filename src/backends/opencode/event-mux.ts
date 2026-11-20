import { opencodeApi } from './client.ts'
import { subscribeV2 } from './event-v2.ts'
import { IDLE_MS, backoff, readEventStream } from './sse.ts'
import type { OpencodeEvent } from '../../types.ts'

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

// One directory's events, whichever API the server speaks. 1.x has a stream per directory, read
// here; 2.x has one per server, which event-v2.ts shares between every directory on it.
export function connectEvents({ host, port, directory }: ConnectTarget, { fetchImpl = globalThis.fetch, onEvent, onOffline, onOnline, reconnect = true, idleMs = IDLE_MS }: ConnectOptions) {
  let stopped = false
  let delay = 1000
  const ac = new AbortController()
  const base = `http://${host}:${port}`
  let v2: ReturnType<typeof subscribeV2> | null = null

  const done = (async () => {
    while (!stopped) {
      try {
        const isV2 = (await opencodeApi(base, fetchImpl).catch(() => 1)) === 2 // unanswered: try 1.x's stream; a 1.x server whose /api/info is proxied off-box can be slow to answer it
        if (stopped) return
        if (isV2) {
          v2 = subscribeV2(base, directory, { onEvent, onOffline, onOnline, reconnect }, { fetchImpl, idleMs })
          return await v2.done
        }
        await readEventStream(`${base}/event?directory=${encodeURIComponent(directory)}`, {
          fetchImpl,
          signal: ac.signal,
          idleMs,
          onOpen: () => {
            onOnline?.(directory)
            delay = 1000
          },
          onChunk: (frames) => {
            for (const e of frames) onEvent(directory, e as OpencodeEvent)
          },
        })
      } catch {
        if (stopped) return
        onOffline?.(directory)
        if (!reconnect) return
        await backoff(delay, ac.signal)
        delay = Math.min(delay * 2, 30_000)
      }
    }
  })()

  return {
    done,
    stop: () => {
      stopped = true
      ac.abort()
      v2?.stop()
    },
  }
}
