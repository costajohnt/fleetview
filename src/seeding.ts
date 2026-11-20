// The seeding steps the roster (use-discovery.ts) and the one-shot commands (`ls`, `--json`;
// commands.ts) both run, kept out of React so the two cannot drift apart (#187): how a
// process-backed backend's events and listings reach the store, and opencode's pending
// permission/question round.
import type { EventSubscription, ListedSession, ProcessBackend, SeedOutcome } from './types.ts'
import type { SeenMap } from './seen-store.ts'
import type { SessionStore } from './session-store.ts'
import type { RosterClient } from './backends/opencode/client.ts'

// A process backend's events in one directory, normalised and tagged with the backend's name before
// they reach the store. One normaliser per subscription, because it folds per-session state across
// events and two directories' runs must never share that fold.
export function streamProcessBackend(store: SessionStore, name: string, backend: ProcessBackend, directory: string): EventSubscription {
  const normalise = backend.createNormaliser()
  return backend.events(
    { directory },
    {
      onEvent: (dir, event) => {
        for (const e of normalise(event)) {
          // Not every union member carries sessionID (session.updated nests an info object), and
          // the ones a normaliser emits all do — the loose read says so once.
          const id = (e.properties as { sessionID?: string }).sessionID
          if (id) store.noteOrigin(dir, id, name)
          store.apply(dir, e)
        }
      },
    },
  )
}

// A process backend's normalised listing into the store, each row tagged with its origin first.
// Never `retire: true`: that sweep is scoped to a project, not to a backend, so a claude listing
// armed with it would delete the opencode rows in the same directory. Leaving these records unlisted
// is also what keeps opencode's own retiring listing from deleting them — it only sweeps records its
// own listings armed.
export function applyProcessListing(store: SessionStore, name: string, directory: string, list: ListedSession[], seen: SeenMap | undefined) {
  for (const s of list) store.noteOrigin(directory, s.id, name)
  store.setSessions(directory, list, seen)
}

// opencode's pending permissions and questions for one directory, against a watermark taken before
// the GETs went out. Each list fails on its own and is reported on its own: a peek path that only
// cares whether `/question` succeeded must not read a `/permission` timeout as its own failure.
// `additive` adds what the store lacks and never drops (the periodic pass); the default replace is
// authoritative.
export async function seedPending(
  store: SessionStore,
  client: Pick<RosterClient, 'listPermissions' | 'listQuestions'>,
  worktree: string,
  mark: number,
  additive = false,
): Promise<SeedOutcome> {
  const outcome = { permissions: true, questions: true }
  await Promise.all([
    client
      .listPermissions(worktree)
      .then((p) => store.seedPermissions(worktree, p, mark, { additive }))
      .catch(() => { outcome.permissions = false }),
    client
      .listQuestions(worktree)
      .then((q) => store.seedQuestions(worktree, q, mark, { additive }))
      .catch(() => { outcome.questions = false }),
  ])
  return outcome
}
