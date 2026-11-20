import { stripControl } from '../../text-utils.ts'

// #216: who holds a server's port is checked when fleetview adopts or spawns it (probeServer, pid-
// matched since #213), not on every request. A server that dies and has its port taken in between
// would get the password on fleetview's next request. So a connection that fails (refused, reset,
// timed out, an event stream that drops) makes that origin's owner unknown: requests and streams go
// without the credential until a probe answers healthy again (server-manager.ts). Against fleetview's
// own server that is a 401, which sends the roster to ensureServer, whose probe re-verifies it.
// ponytail: a port taken over with no failed connection in between (no stream open, no request in
// flight) is not seen; a probe per request is the upgrade if that matters. Nor is an `opencode`
// TUI already attached: it reconnects with the password from its own env, out of fleetview's reach.
const unverified = new Set<string>()
const originOf = (url: string) => URL.parse(url)?.origin ?? url
export const ownershipLost = (url: string) => void unverified.add(originOf(url))
export const ownershipVerified = (url: string) => void unverified.delete(originOf(url))
export const ownershipKnown = (url: string) => !unverified.has(originOf(url))
export const credentialFor = (url: string, auth: string | undefined) => (ownershipKnown(url) ? auth : undefined)

// #225: opencode's error bodies are JSON envelopes, 1.x `{"name":…,"data":{"message":…}}` and 2.x a
// tagged error (`_tag`, `name`, `message`), so the raw text puts the readable message last and any
// cut lands in the envelope. `detail` is their message, else their tag, else the text as sent; the
// error message keeps the whole body, since a tag and any other fields are facts too.
const str = (...vs: unknown[]) => vs.find((v): v is string => typeof v === 'string' && v.trim() !== '')
const errorDetail = (text: string) => {
  let body: { data?: { message?: unknown } | null; message?: unknown; _tag?: unknown; name?: unknown } | null = null
  try {
    body = JSON.parse(text)
  } catch {}
  return str(body?.data?.message, body?.message, body?._tag, body?.name) ?? text
}

// One request to an opencode server, for both API versions: they differ in paths, in how the
// directory travels (1.x `?directory=`, 2.x a header) and in payload shapes, not in this.
// `query` is appended to the URL but left out of the error message; `headers` ride after the
// content type and credential. Parsed JSON is cast to the caller-declared T; null for a 2xx with an
// empty body.
export async function opencodeRequest<T = unknown>(
  fetchImpl: typeof fetch,
  baseUrl: string,
  method: string,
  path: string,
  { body, auth, query = '', headers = {} }: { body?: unknown; auth?: string; query?: string; headers?: Record<string, string> } = {},
): Promise<T> {
  const credential = credentialFor(baseUrl, auth)
  const res = await fetchImpl(`${baseUrl}${path}${query}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(credential ? { authorization: credential } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  }).catch((err: unknown) => {
    // A timeout is a slow server, not a lost one: whoever hangs has already read this request.
    if ((err as Error)?.name !== 'TimeoutError') ownershipLost(baseUrl)
    throw err
  })
  // Withheld above and refused for it: say so, or this reads as the server rejecting fleetview.
  if (res.status === 401 && auth && !credential) {
    throw Object.assign(new Error(`${method} ${path}: not sending the password to ${baseUrl} until fleetview re-checks the server it lost the connection to; try again in a moment`), { status: 401 })
  }
  // The body is the server's words, and an adopted server is untrusted (SECURITY.md); the CLI
  // verbs print this message straight to the terminal, so it gets the same stripControl as every
  // other foreign string, and a cap so an error page cannot flood it.
  // `status` rides the error so a caller can tell "the server answered no" from "unreachable".
  // #225: `detail` is the body's own message, so a caller with room for one short line (the dispatch
  // notice) shows the readable part rather than the method, path and JSON envelope around it.
  if (!res.ok) {
    const text = await res.text()
    const detail = stripControl(errorDetail(text)).slice(0, 500)
    throw Object.assign(new Error(`${method} ${path} → ${res.status}: ${stripControl(text).slice(0, 500)}`), { status: res.status, detail })
  }
  const text = await res.text()
  return (text.trim() ? JSON.parse(text) : null) as T
}
