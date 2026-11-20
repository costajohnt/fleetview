import { stripControl } from '../../text-utils.ts'

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
  const res = await fetchImpl(`${baseUrl}${path}${query}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(auth ? { authorization: auth } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  })
  // The body is the server's words, and an adopted server is untrusted (SECURITY.md); the CLI
  // verbs print this message straight to the terminal, so it gets the same stripControl as every
  // other foreign string, and a cap so an error page cannot flood it.
  // `status` rides the error so a caller can tell "the server answered no" from "unreachable".
  if (!res.ok) throw Object.assign(new Error(`${method} ${path} → ${res.status}: ${stripControl(await res.text()).slice(0, 500)}`), { status: res.status })
  const text = await res.text()
  return (text.trim() ? JSON.parse(text) : null) as T
}
