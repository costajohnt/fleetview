// opencode as a Backend (see types.ts): the mapping from fleetview's backend contract onto
// OpencodeClient and `opencode attach` argv, and nothing more. Listing, dispatch and live events are
// not here (#187): the roster runs those over the client and the shared event stream directly
// (use-discovery, use-dispatch), so adapter copies of them only ever ran in tests and drifted.
import type { Backend, ServerRef } from '../../types.ts'
import { knownOpencodeApi, type RosterClient } from './client.ts'
import { assertSessionId } from '../session-id.ts'
import { isAbsolute } from 'node:path'

// opencode is the server-backed family, so every flag is true — which is exactly why the flags could
// not be inferred from it. It is the parity baseline the process-backed backends are measured
// against, not the default. Exported because it doubles as the fallback capability set where a
// row's backend cannot be resolved (use-peek.ts's `capabilitiesOf` default).
export const OPENCODE_CAPABILITIES = {
  rename: true, // PATCH /session/:id
  delete: true, // DELETE /session/:id
  questions: true, // GET /question + /permission, answerable from the roster
} as const

// The client is passed in rather than built here: fleetview already holds one per server for the
// opencode-only calls, and a second one would mean two auth headers and two timeouts to keep in step.
export function createOpencodeBackend({ server, client }: { server: ServerRef; client: RosterClient }): Backend {
  const url = `http://${server.host}:${server.port}`
  // A healthy probe or the client's first request has settled the server's API before anything on
  // it could be listed, so there is no guess to make here: an unknown one is refused, not handed
  // 1.x argv.
  const serverApi = () => {
    const api = knownOpencodeApi(url)
    if (!api) throw new Error(`opencode server at ${url} has not been probed yet`)
    return api
  }
  return {
    name: 'opencode',
    capabilities: OPENCODE_CAPABILITIES,
    prompt: (id, text, directory) => client.promptAsync(id, text, directory),
    fork: (id, directory) => client.forkSession(id, directory),
    listMessages: (id, directory) => client.listMessages(id, directory),
    shell: (id, command, directory) => client.runShell(id, command, directory),
    // 2.x has no `attach`: its TUI takes the server as a flag and the directory as an argument, and
    // reads the password from the environment (OPENCODE_PASSWORD, else OPENCODE_SERVER_PASSWORD).
    attach: ({ id, directory }) => serverApi() === 2
      ? ['opencode', '--server', url, '-s', assertSessionId(id), absoluteDirectory(directory)]
      : [
      'opencode',
      'attach',
      url,
      '-s',
      // Server-supplied, and the server may be an adopted foreign one — asserted because it becomes
      // argv, same as the process backends (session-id.ts).
      assertSessionId(id),
      // --dir is the worktree, not the repository: attach exits 1 immediately and silently if it
      // points at a directory that no longer exists (see describeExit in cli.ts). Server-supplied, so
      // held to the same absolute-path check as 2.x's bare argument.
      '--dir',
      absoluteDirectory(directory),
    ],
    abort: (id, directory) => client.abortSession(id, directory),
    rename: (id, title, directory) => client.renameSession(id, title, directory),
    delete: (id, directory) => client.deleteSession(id, directory),
  }
}

// 2.x takes the directory as a bare argument where 1.x took it as --dir's value, so a
// server-supplied one starting with `-` would be read as a flag. Real ones are absolute.
function absoluteDirectory(directory: string) {
  if (!isAbsolute(directory)) throw new Error(`refusing non-absolute directory: ${JSON.stringify(directory.slice(0, 80))}`)
  return directory
}
