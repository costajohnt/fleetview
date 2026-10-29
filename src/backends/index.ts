// The backend registry: the one place that knows which agent CLIs fleetview can drive and how to
// build one. Everything else takes a `Record<string, Backend>` and a name — normalisation included,
// since every adapter carries its own normaliseSessions/createNormaliser (#83) — so adding a fourth
// CLI is a line here plus its own folder, not a branch in the roster or in backend-normalise.ts.
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
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

// The adapter for a backend name, falling back to the default one: a row (or attach target) whose
// backend can't be resolved must not go inert or hide keys that have always worked.
// Without opencode installed the registry has no default adapter at all, so the last resort is
// whichever adapter is there rather than undefined.
export const resolveBackend = (backends: Record<string, Backend>, name: string | undefined): Backend =>
  backends[name ?? DEFAULT_BACKEND] ?? backends[DEFAULT_BACKEND] ?? Object.values(backends)[0]

// Whether `command` is an executable on PATH. A PATH walk rather than spawning `<cli> --version`:
// claude and copilot are Node programs, so asking them costs a cold start each, and this runs
// before the roster can paint.
export function onPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PATH ?? '').split(delimiter).some((dir) => {
    if (!dir) return false
    try {
      accessSync(join(dir, command), constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

// The launch backend when opencode is not installed: what was asked for unless that is opencode,
// else the first process-backed CLI that is installed. null means none of the three is, which is
// the one case the roster still refuses to open for.
export function fallbackBackend(wanted: string, installed: (command: string) => boolean = onPath): string | null {
  const first = BACKEND_NAMES.find((name) => name !== DEFAULT_BACKEND && installed(name))
  if (!first) return null
  return wanted === DEFAULT_BACKEND ? first : wanted
}

// The roster's headline when none of the three CLIs is installed.
export const NO_AGENT_CLI =
  'fleetview needs at least one of opencode, claude or copilot on your PATH. Install one (opencode from https://opencode.ai) and run fleetview again.'

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
// the caller already holds. No server means opencode is not installed: the registry then has no
// opencode entry, and that absence is how the roster knows to run without it.
export function createBackends({
  server,
  client,
  fetchImpl,
}: {
  server?: ServerRef
  client?: OpencodeClient
  fetchImpl?: typeof fetch
} = {}): Partial<Record<BackendName, Backend>> {
  return {
    ...(server && client ? { opencode: createOpencodeBackend({ server, client, ...(fetchImpl ? { fetchImpl } : {}) }) } : {}),
    ...createProcessBackends(),
  }
}

// The backends that need no server, on their own: what the shell commands (commands.ts) use when
// opencode is missing or down, and alongside opencode when it is not.
export const createProcessBackends = () => ({ claude: createClaudeBackend(), copilot: createCopilotBackend() })
