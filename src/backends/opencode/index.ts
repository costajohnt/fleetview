// opencode as a Backend (see types.ts). The wire code underneath is unchanged: this is the mapping
// from fleetview's backend contract onto OpencodeClient, connectEvents and `opencode attach` argv,
// and nothing more. Anything opencode can do that the contract doesn't name is still reached through
// OpencodeClient directly.
import type { Backend, OpencodeEvent, ServerRef } from '../../types.ts'
import { OpencodeClient } from './client.ts'
import { connectEvents } from './event-mux.ts'
import { assertSessionId } from '../session-id.ts'

// opencode is the server-backed family, so every flag is true — which is exactly why the flags could
// not be inferred from it. It is the parity baseline the process-backed backends are measured
// against, not the default. Exported because it doubles as the fallback capability set where a
// row's backend cannot be resolved (app.ts, use-peek.ts).
export const OPENCODE_CAPABILITIES = {
  fork: true, // POST /session/:id/fork
  rename: true, // PATCH /session/:id
  delete: true, // DELETE /session/:id
  questions: true, // GET /question + /permission, answerable from the roster
  messages: true, // GET /session/:id/message, what peek renders
} as const

// The client is passed in rather than built here: fleetview already holds one per server for the
// opencode-only calls, and a second one would mean two auth headers and two timeouts to keep in step.
// `fetchImpl` only reaches the event stream — the client carries its own — and exists for the same
// reason connectEvents and isServerHealthy take one: nothing here should open a real socket in a test.
export function createOpencodeBackend({
  server,
  client,
  fetchImpl = globalThis.fetch,
}: {
  server: ServerRef
  client: OpencodeClient
  fetchImpl?: typeof fetch
}): Backend {
  return {
    name: 'opencode',
    capabilities: OPENCODE_CAPABILITIES,
    listSessions: (directory) => client.listSessions(directory),
    async dispatch({ prompt, directory, agent, model }) {
      const session = await client.createSession({ agent, model }, directory)
      // Prompt after the session exists, and don't swallow a prompt failure: a created-but-unprompted
      // session is visible in the roster, so the caller has to hear about it rather than get a ref
      // that looks dispatched.
      await client.promptAsync(session.id, prompt, directory)
      return { id: session.id, directory }
    },
    prompt: (id, text, directory) => client.promptAsync(id, text, directory),
    events: ({ directory }, handlers) =>
      connectEvents({ host: server.host, port: server.port, directory }, { ...handlers, fetchImpl }),
    attach: ({ id, directory }) => [
      'opencode',
      'attach',
      `http://${server.host}:${server.port}`,
      '-s',
      // Server-supplied, and the server may be an adopted foreign one — asserted because it becomes
      // argv, same as the process backends (session-id.ts).
      assertSessionId(id),
      // --dir is the worktree, not the repository: attach exits 1 immediately and silently if it
      // points at a directory that no longer exists (see describeExit in cli.ts).
      '--dir',
      directory,
    ],
    abort: (id, directory) => client.abortSession(id, directory),
    rename: (id, title, directory) => client.renameSession(id, title, directory),
    delete: (id, directory) => client.deleteSession(id, directory),
    // Identity, both of them: opencode's payloads are already the store's vocabulary — they ARE the
    // vocabulary (backend-normalise.ts) — which is what keeps the opencode path free of any
    // normalisation cost or behaviour change at all.
    normaliseSessions: (rows) => rows ?? [],
    createNormaliser: () => (event) => [event as OpencodeEvent],
  }
}
