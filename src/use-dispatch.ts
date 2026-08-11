import { basename } from 'node:path'
import { existsSync } from 'node:fs'
import { DEFAULT_BACKEND } from './backends/index.ts'
import { shouldIsolate, worktreeName } from './worktree.ts'

// The dispatch pair, lifted out of App the same way usePeek and useDiscovery were: the opencode
// path (worktree isolation, shell jobs, provisional titles), the process-backed-CLI path, and the
// post-dispatch tail they share. Everything App owns and this needs is passed in explicitly; the
// hook is re-invoked per render, so each returned `dispatch` closes over that render's values
// exactly as the inline functions did.
// TODO(types): all inputs are App-owned dynamic collaborators (client, session store, backend
// registry, roster callbacks); typed loose because their real shapes live in other modules.
export function useDispatch({
  client,
  store,
  seen,
  backendRegistry,
  initialAgent,
  initialBackend,
  dispatchModel,
  isolate,
  projects,
  parents,
  input,
  setInput,
  flash,
  attach,
  // Display placeholders back to what was actually pasted, and where a dispatch lands — both
  // stay in App (the paste buffer belongs to the input handler, the target resolution to the
  // selection state) and are handed over as functions, mirroring usePeek's backendFor.
  expandPastes,
  dispatchTarget,
  // App-side roster addition (updateRoster + withMember), so the membership helpers stay
  // private to app.ts — the counterpart of useDiscovery's onSessionDeleted.
  addMember,
  seededProjectKeys,
  setOfflineProjects,
  streamProjectRef,
  activateBackendRef,
  dirExistsImpl = existsSync,
}: {
  client: any
  store: any
  seen?: any
  backendRegistry: Record<string, any>
  initialAgent?: any
  initialBackend: string
  dispatchModel: any
  isolate: boolean
  projects: any[]
  parents: Map<string, string>
  input: string
  setInput: (value: string | ((current: string) => string)) => void
  flash: (message: string, ms?: number) => void
  attach: (row: any) => void
  expandPastes: (text: string) => string
  dispatchTarget: (repo?: string) => string | undefined
  addMember: (worktree: any, id: any, extra?: any) => void
  seededProjectKeys: { current: Set<string> }
  setOfflineProjects: (updater: (s: Set<string>) => Set<string>) => void
  streamProjectRef: { current: any }
  activateBackendRef: { current: ((name: string) => Promise<void>) | null }
  dirExistsImpl?: (dir: string) => boolean
}) {
  // The post-dispatch tail both dispatch paths share (H2): the immediate relist that makes the new
  // row reflect the backend's own record now rather than on the next poll, and the offline-list
  // cleanup a successful dispatch has just proven right.
  const noteDispatchedProject = (worktree: string, list: any[]) => {
    seededProjectKeys.current.add(worktree)
    store.setSessions(worktree, list, seen)
    setOfflineProjects((s) => {
      const next = new Set(s)
      next.delete(worktree)
      return next
    })
  }

  // A dispatch onto a process-backed CLI. Deliberately a separate path rather than a generalisation
  // of the opencode one below: that path carries worktree isolation, shell jobs, a provisional title
  // written between createSession and promptAsync, and a listSessions refresh — all of it opencode's
  // own machinery, and all of it covered by a test corpus that must keep passing unchanged. What is
  // shared is what is genuinely shared (target resolution, roster membership, the notice).
  const dispatchOnBackend = async (name: string, rawText: string, { thenAttach = false, agent, repo, shell = false }: any = {}) => {
    const backend = backendRegistry[name]
    if (!backend) return flash(`no ${name} backend`)
    // `!` is opencode's shell-job route (POST /session/:id/shell); a process-backed CLI has no
    // equivalent, and quietly sending the command as a prompt would run something else entirely.
    if (shell) return flash(`! shell jobs run on opencode — ${name} has no shell surface`, 4000)
    const text = expandPastes(rawText)
    const target = dispatchTarget(repo)
    if (!target) return flash('no projects discovered yet')
    if (!dirExistsImpl(target)) return flash(`${basename(target) || target} no longer exists`)
    const typed = input
    let dispatched = false
    setInput('')
    try {
      // Streaming starts before the dispatch, not after: the run can finish inside the poll interval
      // and a subscription attached afterwards would miss the whole of it.
      await activateBackendRef.current?.(name)
      const ref = await backend.dispatch({
        prompt: text,
        directory: target,
        agent: agent ?? initialAgent ?? undefined,
        // `--model` on these CLIs takes their own model name (`sonnet`, `gpt-5`), not opencode's
        // provider/model pair, so only the model half travels. A provider that means nothing to the
        // target CLI would be rejected argv rather than a useful default.
        model: dispatchModel?.id ?? undefined,
      })
      // Past this point the session exists and is running: anything that fails from here is a
      // refresh problem, not a dispatch problem — same rule as the opencode path below.
      dispatched = true
      if (name !== DEFAULT_BACKEND) store.noteOrigin(target, ref.id, name)
      store.setProvisionalTitle(target, ref.id, text)
      // `backend` rides the membership so a restart knows which CLI this row belongs to before any
      // event has arrived — the same soft-migration shape as every other member field (absent means
      // opencode).
      addMember(target, ref.id, { prompt: text.slice(0, 2000), backend: name })
      // Relist parity with the opencode path (H2): the same per-row origin-tagging the periodic
      // listing does (streamBackend), then the shared tail. A CLI that hasn't written its record
      // yet just lists without the new row, and the next poll catches up.
      const list = backend.normaliseSessions(await backend.listSessions(target))
      for (const s of list) store.noteOrigin(target, s.id, name)
      noteDispatchedProject(target, list)
      if (thenAttach) attach({ id: ref.id, projectKey: target, backend: name })
      // No worktree isolation: creating one is opencode's `/experimental/worktree`, and there is no
      // equivalent to ask claude or copilot for. Said out loud in the notice rather than left for the
      // user to discover from a dirty checkout.
      else flash(`dispatched into ${basename(target) || target} on ${name} — it edits the checkout`, 5000)
    } catch {
      if (dispatched) return flash('session started, but the project list is stale')
      setInput((current) => (current === '' ? typed : current))
      flash(`${name} dispatch failed`)
    }
  }

  const dispatch = async (rawText: string, { thenAttach = false, agent, repo, shell = false, backend }: { thenAttach?: boolean; agent?: string; repo?: string; shell?: boolean; backend?: string } = {}) => {
    // Everything below this line is the opencode path, untouched. A dispatch is only diverted when
    // something actually named another backend — `@claude`, or a launch default — so the opencode
    // behaviour this whole phase must not change is reached by exactly the code that reached it
    // before.
    const backendName = backend ?? initialBackend
    if (backendName !== DEFAULT_BACKEND) return dispatchOnBackend(backendName, rawText, { thenAttach, agent, repo, shell })
    const text = expandPastes(rawText)
    // A `@agent` prefix on this dispatch wins; otherwise fall back to the launch --agent default.
    // Coalesce to undefined (not null) when neither is set — createSession omits the field entirely.
    const effectiveAgent = agent ?? initialAgent ?? undefined
    const target = dispatchTarget(repo)
    if (!target) return flash('no opencode projects discovered yet')
    // A target can outlive the directory (#22): a project record survives the listing that dropped
    // it, so a deleted session's worktree is still nameable, and dispatching into one is accepted
    // silently — the server creates a session against a path that is gone. Refuse before anything is
    // created, and before `setInput('')`, so the prompt is still in the input to retarget.
    if (!dirExistsImpl(target)) return flash(`${basename(target) || target} no longer exists`)
    const typed = input // put it back if the dispatch fails; retyping a lost prompt is miserable
    let dispatched = false
    setInput('')
    // Where the session will actually run. Isolation happens before the session exists, so there is
    // no window in which it could edit the shared working copy: agent view moves a background
    // session into its own worktree "before editing files", and this is fleetview's version of that.
    let worktree = target
    let isolated = false
    try {
      // isolate=false (FLEETVIEW_NO_ISOLATE) skips the worktree entirely — the session edits the
      // checkout directly, agent view's `bgIsolation: "none"`. Isolation stays the default.
      if (isolate && shouldIsolate(target, projects, parents)) {
        try {
          // GET /experimental/worktree returns objects ({name, directory}), and worktreeName takes
          // directory strings — passing the objects threw a TypeError into the silent catch below,
          // so every dispatch after the repo's first worktree ran unisolated. `?? w.name` because a
          // row without a directory still names a taken slot.
          const existing = ((await client.listWorktrees(target)) ?? []).map((w: any) =>
            typeof w === 'string' ? w : w?.directory ?? w?.name ?? '',
          )
          const created = await client.createWorktree(worktreeName(text, existing), target)
          if (created?.directory) {
            worktree = created.directory
            isolated = true
            // Stream it immediately rather than waiting for the poll to notice a new project —
            // this is the row the user is about to watch start.
            await streamProjectRef.current?.(worktree)
          }
        } catch {
          // Isolation is a safety measure, not a precondition. A server too old for
          // /experimental/worktree, or one that refuses, must not cost the user their dispatch —
          // it runs in the repository itself, exactly as it did before isolation existed. Said in
          // the dispatch confirmation rather than as its own notice, which the confirmation would
          // overwrite a few milliseconds later — a warning nobody can read is not a warning.
        }
      }
      const session = await client.createSession({ agent: effectiveAgent, model: dispatchModel }, worktree)
      // opencode names the session itself once the first turn lands; until then the row would read
      // "New session - <timestamp>", so show what was asked for.
      store.setProvisionalTitle(worktree, session.id, shell ? `! ${text}` : text)
      // membership added immediately after createSession succeeds, before promptAsync —
      // dispatch counts as "backgrounded" even if the prompt itself later fails.
      // The prompt rides the membership (capped — a pasted wall of text is not a lookup key) so
      // a pasted URL can find this session later, agent view's any-URL filter.
      addMember(worktree, session.id, { ...(shell ? { shell: true } : {}), prompt: text.slice(0, 2000) })
      // Same launch --agent fallback as the prompt branch's effectiveAgent — a `fleetview --agent
      // foo` run must not silently send `!` jobs as 'build' (the CLI's runBg --exec honors it).
      if (shell) await client.runShell(session.id, text, worktree, agent ?? initialAgent ?? 'build')
      else await client.promptAsync(session.id, text, worktree)
      // Past this point the session exists and is running. Anything that fails from here is a
      // refresh problem, not a dispatch problem — handing the prompt back would invite the user
      // to dispatch a second identical session.
      dispatched = true
      noteDispatchedProject(worktree, await client.listSessions(worktree))
      // Say where it went. An `@name` that matches no repository stays in the prompt and the
      // dispatch falls back to another project, which is otherwise invisible until you notice the
      // row is in the wrong place.
      if (thenAttach) attach({ id: session.id, projectKey: worktree })
      // Names the repository: the worktree path is a hashed cache directory that means nothing to
      // the user, and the repository is what they actually chose. When isolation was expected and
      // did not happen, the row is editing the shared checkout — worth knowing before a second
      // dispatch lands in the same place.
      else if (!isolated && shouldIsolate(target, projects, parents)) {
        // A worktree was wanted but the row edits the checkout — either isolation is off
        // (FLEETVIEW_NO_ISOLATE, a deliberate choice) or the server couldn't make one (a warning).
        const why = isolate ? 'not isolated, it edits the checkout' : 'isolation off, it edits the checkout'
        flash(`dispatched into ${basename(target) || target} — ${why}`, 5000)
      } else flash(`dispatched into ${basename(target) || target}`)
    } catch {
      setOfflineProjects((s) => new Set(s).add(worktree))
      if (dispatched) return flash('session started, but the project list is stale')
      // Only restore into an input the user hasn't started refilling: a dispatch can be in flight
      // for up to the client's 10s timeout, and overwriting a half-typed prompt with the failed
      // one is worse than losing it.
      setInput((current) => (current === '' ? typed : current))
      flash('dispatch failed — project marked offline')
    }
  }

  return { dispatch }
}
