// The backend registry: the one place that knows which agent CLIs fleetview can drive and how to
// build one. Everything else takes a `Record<string, Backend>` and a name, so adding a fourth CLI is
// a line here plus its own folder — not a branch in the roster.
import type { Backend, ServerRef } from '../types.ts'
import type { OpencodeClient } from './opencode/client.ts'
import { createOpencodeBackend } from './opencode/index.ts'
import { createClaudeBackend } from './claude/index.ts'
import { createCopilotBackend } from './copilot/index.ts'

// Ordered as they are offered: opencode first because it is the default and the parity baseline.
// This is also the `@token` vocabulary and what `--backend` is validated against, so a name that
// isn't here cannot be selected anywhere.
export const BACKEND_NAMES = ['opencode', 'claude', 'copilot'] as const
export type BackendName = (typeof BACKEND_NAMES)[number]

// opencode, and not by accident: it is the only backend with a server, live events, questions and
// fork, so anything else as the out-of-the-box default would silently downgrade the roster.
export const DEFAULT_BACKEND: BackendName = 'opencode'

export const isBackendName = (name: unknown): name is BackendName =>
  typeof name === 'string' && (BACKEND_NAMES as readonly string[]).includes(name)

// Same override chain shape as every other fleetview setting (FLEETVIEW_*, then the pre-rename
// ROOST_* spelling). An unrecognised value falls back to the default rather than failing the launch:
// a typo in a shell profile must not make the roster unopenable, and `--backend` — which the user
// typed *this* run — is the form that errors loudly (see cli.ts).
export function defaultBackendName(env: NodeJS.ProcessEnv = process.env): BackendName {
  const want = env.FLEETVIEW_BACKEND ?? env.ROOST_BACKEND
  return isBackendName(want) ? want : DEFAULT_BACKEND
}

// One instance per backend, built once per roster mount. The process-backed two take no arguments —
// they find their own state directories — so the only wiring is opencode's server and client, which
// the caller already holds.
export function createBackends({
  server,
  client,
  fetchImpl,
}: {
  server: ServerRef
  client: OpencodeClient
  fetchImpl?: typeof fetch
}): Record<BackendName, Backend> {
  return {
    opencode: createOpencodeBackend({ server, client, ...(fetchImpl ? { fetchImpl } : {}) }),
    claude: createClaudeBackend(),
    copilot: createCopilotBackend(),
  }
}
