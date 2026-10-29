import { basename } from 'node:path'
import { existsSync } from 'node:fs'
import { DEFAULT_BACKEND } from './backends/index.ts'
import { shouldIsolate, worktreeName, logNameCollision, createLocalWorktree, removeLocalWorktree } from './worktree.ts'
import type { AttachTarget, Backend, ListedSession, ModelPair, Project, StreamProject, Worktree } from './types.ts'
import type { SeenMap } from './seen-store.ts'
import type { SessionStore } from './session-store.ts'
import type { RosterClient } from './backends/opencode/client.ts'

// The dispatch pair, lifted out of App the same way usePeek and useDiscovery were: the opencode
// path (worktree isolation, shell jobs, provisional titles), the process-backed-CLI path, and the
// post-dispatch tail they share. Everything App owns and this needs is passed in explicitly; the
// hook is re-invoked per render, so each returned `dispatch` closes over that render's values
// exactly as the inline functions did.
//
// What a dispatch may be told about itself, from the parsed input: an `@agent`, an `@repo`, a `!`
// shell job, an `@backend`, and whether to attach straight after. Both paths take the same bag so a
// token means the same thing whichever CLI it lands on.
export type DispatchOptions = { thenAttach?: boolean; agent?: string; repo?: string; shell?: boolean; backend?: string }

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
  // Post-dispatch auto-select: the selection lands on the row the dispatch just created, so the
  // next Enter attaches to it. By identity (the ref), not a key — the row may render a poll
  // later, and App's identity re-resolution keeps looking every render until it appears.
  selectedSessionRef,
  setSelectedKey,
  dirExistsImpl = existsSync,
}: {
  client: RosterClient
  store: SessionStore
  seen?: SeenMap
  backendRegistry: Record<string, Backend>
  initialAgent?: string | null
  initialBackend: string
  dispatchModel: ModelPair | null
  isolate: boolean
  projects: Project[]
  parents: Map<string, string>
  input: string
  setInput: (value: string | ((current: string) => string)) => void
  flash: (message: string, ms?: number) => void
  attach: (row: AttachTarget) => void
  expandPastes: (text: string) => string
  dispatchTarget: (repo?: string) => string | undefined
  addMember: (worktree: string, id: string, extra?: Record<string, unknown>) => void
  seededProjectKeys: { current: Set<string> }
  setOfflineProjects: (updater: (s: Set<string>) => Set<string>) => void
  streamProjectRef: { current: StreamProject | null }
  activateBackendRef: { current: ((name: string, directory?: string) => Promise<void>) | null }
  selectedSessionRef: { current: { projectKey: string; id: string } | null }
  setSelectedKey: (key: string | null) => void
  dirExistsImpl?: (dir: string) => boolean
}) {
  // Same session identity (or both empty). Guards the post-dispatch auto-select: only fires when
  // the selection is still what it was when the dispatch left, so an arrow-key move made while the
  // network call was in flight is not clobbered.
  const sameSelection = (a: { projectKey: string; id: string } | null, b: { projectKey: string; id: string } | null) =>
    a?.id === b?.id && a?.projectKey === b?.projectKey
  // The post-dispatch tail both dispatch paths share (H2): the immediate relist that makes the new
  // row reflect the backend's own record now rather than on the next poll, and the offline-list
  // cleanup a successful dispatch has just proven right.
  const noteDispatchedProject = (worktree: string, list: ListedSession[]) => {
    seededProjectKeys.current.add(worktree)
    store.setSessions(worktree, list, seen)
    setOfflineProjects((s) => {
      const next = new Set(s)
      next.delete(worktree)
      return next
    })
  }

  // A dispatch onto a process-backed CLI. Deliberately a separate path rather than a generalisation
  // of the opencode one below: that path carries shell jobs, a provisional title written between
  // createSession and promptAsync, and opencode's own worktree endpoint — all of it covered by a
  // test corpus that must keep passing unchanged. What is shared is what is genuinely shared
  // (target resolution, the isolation rule, roster membership, the notice).
  const dispatchOnBackend = async (name: string, rawText: string, { thenAttach = false, agent, repo, shell = false }: DispatchOptions = {}) => {
    const backend = backendRegistry[name]
    if (!backend) return flash(`no ${name} backend`)
    // `!` is opencode's shell-job route (POST /session/:id/shell); a process-backed CLI has no
    // equivalent, and quietly sending the command as a prompt would run something else entirely.
    if (shell) return flash(`! shell jobs run on opencode — ${name} has no shell surface`, 4000)
    const text = expandPastes(rawText)
    const target = dispatchTarget(repo)
    if (!target) return flash(projects.length ? 'no valid projects available' : 'no projects discovered yet')
    if (!dirExistsImpl(target)) return flash(`${basename(target) || target} no longer exists`)
    const typed = input
    let dispatched = false
    setInput('')
    // Snapshot what was selected when the dispatch left: the auto-select below must not clobber an
    // arrow-key move the user made while the network call was in flight.
    const selAtDispatch = selectedSessionRef.current
    // Isolation, by the same rule and the same FLEETVIEW_NO_ISOLATE switch as the opencode path, but
    // made locally with `git worktree add`: these CLIs have nothing like /experimental/worktree.
    // It matters most here, because copilot runs with --allow-all-tools. A failure falls back to
    // the checkout and the notice says so, exactly as the opencode path does.
    const wantIsolation = shouldIsolate(target, projects, parents)
    let directory = target
    let isolated = false
    if (isolate && wantIsolation) {
      try {
        directory = createLocalWorktree(target, text)
        isolated = true
      } catch {}
    }
    try {
      // Streaming starts before the dispatch, not after: the run can finish inside the poll interval
      // and a subscription attached afterwards would miss the whole of it. A fresh worktree is in no
      // project record, so it is named explicitly.
      await activateBackendRef.current?.(name, directory)
      const ref = await backend.dispatch({
        prompt: text,
        directory,
        agent: agent ?? initialAgent ?? undefined,
        // `--model` on these CLIs takes their own model name (`sonnet`, `gpt-5`), not opencode's
        // provider/model pair, so only the model half travels. A provider that means nothing to the
        // target CLI would be rejected argv rather than a useful default.
        model: dispatchModel?.id ?? undefined,
      })
      // Past this point the session exists and is running: anything that fails from here is a
      // refresh problem, not a dispatch problem — same rule as the opencode path below.
      dispatched = true
      if (name !== DEFAULT_BACKEND) store.noteOrigin(directory, ref.id, name)
      store.setProvisionalTitle(directory, ref.id, text)
      // `backend` rides the membership so a restart knows which CLI this row belongs to before any
      // event has arrived — the same soft-migration shape as every other member field (absent means
      // opencode). `repo` does the same for a local worktree: opencode never lists it, so the
      // membership is what groups its rows under the repository and lets ^x^x find the parent.
      addMember(directory, ref.id, { prompt: text.slice(0, 2000), backend: name, ...(isolated ? { repo: target } : {}) })
      // Relist parity with the opencode path (H2): the same per-row origin-tagging the periodic
      // listing does (streamBackend), then the shared tail. A CLI that hasn't written its record
      // yet just lists without the new row, and the next poll catches up.
      const list = backend.normaliseSessions(await backend.listSessions(directory))
      for (const s of list) store.noteOrigin(directory, s.id, name)
      noteDispatchedProject(directory, list)
      if (thenAttach) attach({ id: ref.id, projectKey: directory, backend: name })
      else {
        // Land the selection on the row this dispatch just created, so Enter attaches to it —
        // unless the selection moved during the awaits above: the user's own navigation wins.
        if (sameSelection(selectedSessionRef.current, selAtDispatch)) {
          selectedSessionRef.current = { projectKey: directory, id: ref.id }
          setSelectedKey(null)
        }
        // Same wording as the opencode path: the repository the user chose, plus a warning only
        // when a worktree was wanted and the row edits the checkout instead.
        const why = isolated || !wantIsolation ? '' : isolate ? ' — not isolated, it edits the checkout' : ' — isolation off, it edits the checkout'
        flash(`dispatched into ${basename(target) || target} on ${name}${why}`, why ? 5000 : undefined)
      }
    } catch {
      if (dispatched) return flash('session started, but the project list is stale')
      // Nothing ran in the worktree, so it is empty by construction and goes without worktreeSafety:
      // with no session in it, nothing in the UI could ever reach it again. Best-effort, like the
      // opencode path's orphan cleanup: the dispatch has already failed either way.
      if (isolated) {
        try {
          removeLocalWorktree(directory, target)
        } catch {}
      }
      setInput((current) => (current === '' ? typed : current))
      flash(`${name} dispatch failed`)
    }
  }

  const dispatch = async (rawText: string, { thenAttach = false, agent, repo, shell = false, backend }: DispatchOptions = {}) => {
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
    // pickTarget already skipped every project whose worktree is gone (#102), so an empty target with
    // projects on the roster means all of them are stale — say that instead of naming a dead path.
    if (!target) return flash(projects.length ? 'no valid projects available' : 'no opencode projects discovered yet')
    // A target can outlive the directory (#22): a project record survives the listing that dropped
    // it, so a deleted session's worktree is still nameable, and dispatching into one is accepted
    // silently — the server creates a session against a path that is gone. Refuse before anything is
    // created, and before `setInput('')`, so the prompt is still in the input to retarget.
    if (!dirExistsImpl(target)) return flash(`${basename(target) || target} no longer exists`)
    const typed = input // put it back if the dispatch fails; retyping a lost prompt is miserable
    let dispatched = false
    setInput('')
    // Snapshot for the auto-select below — an arrow-key move made while this dispatch is in
    // flight must win over it.
    const selAtDispatch = selectedSessionRef.current
    // Where the session will actually run. Isolation happens before the session exists, so there is
    // no window in which it could edit the shared working copy: agent view moves a background
    // session into its own worktree "before editing files", and this is fleetview's version of that.
    let worktree = target
    let isolated = false
    let worktreeRemoved = false
    let created = false
    try {
      // isolate=false (FLEETVIEW_NO_ISOLATE) skips the worktree entirely — the session edits the
      // checkout directly, agent view's `bgIsolation: "none"`. Isolation stays the default.
      if (isolate && shouldIsolate(target, projects, parents)) {
        try {
          // GET /experimental/worktree returns objects ({name, directory}), and worktreeName takes
          // directory strings — passing the objects threw a TypeError into the silent catch below,
          // so every dispatch after the repo's first worktree ran unisolated. `?? w.name` because a
          // row without a directory still names a taken slot.
          const existing = ((await client.listWorktrees(target)) ?? []).map((w: Worktree | string | null | undefined) =>
            typeof w === 'string' ? w : w?.directory ?? w?.name ?? '',
          )
          const name = worktreeName(text, existing)
          // #128: a suffixed name means this prompt slugged onto an existing worktree. Reported
          // once as the new session inheriting another session's name with a different prompt —
          // log what was actually received so the next occurrence carries its own evidence.
          if (name !== worktreeName(text)) logNameCollision({ prompt: text, name, existing })
          const created = await client.createWorktree(name, target)
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
      const session = await client.createSession({ agent: effectiveAgent, model: dispatchModel }, worktree).catch(async (e) => {
        // The worktree was made for this session and nothing else: with no session in it, nothing
        // in the UI can reach it again (sandboxes are hidden from browse and `@repo`, and
        // removeWorktreeFor runs only on session delete). It is empty by construction, so it goes
        // without worktreeSafety. Best-effort: the dispatch has already failed either way.
        if (isolated) {
          worktreeRemoved = await client.removeWorktree?.(worktree, target).then(() => true, () => false) ?? false
        }
        throw e
      })
      // opencode names the session itself once the first turn lands; until then the row would read
      // "New session - <timestamp>", so show what was asked for.
      store.setProvisionalTitle(worktree, session.id, shell ? `! ${text}` : text)
      // membership added immediately after createSession succeeds, before promptAsync —
      // dispatch counts as "backgrounded" even if the prompt itself later fails.
      // The prompt rides the membership (capped — a pasted wall of text is not a lookup key) so
      // a pasted URL can find this session later, agent view's any-URL filter.
      addMember(worktree, session.id, { ...(shell ? { shell: true } : {}), prompt: text.slice(0, 2000) })
      created = true
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
      // Select the row this dispatch just created — the next Enter attaches to it instead of
      // whatever happened to be under the cursor. By identity, not pendingSelect: the row may not
      // render for another poll, and pendingSelect drops a request it can't resolve. Skipped when
      // the selection moved during the awaits above: the user's own navigation wins.
      if (!thenAttach && sameSelection(selectedSessionRef.current, selAtDispatch)) {
        selectedSessionRef.current = { projectKey: worktree, id: session.id }
        setSelectedKey(null)
      }
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
      // A removed worktree is a directory that no longer exists: the offline flag belongs on the
      // repository the user chose, which is the header they can see.
      setOfflineProjects((s) => new Set(s).add(worktreeRemoved ? target : worktree))
      if (dispatched) return flash('session started, but the project list is stale')
      // The session exists and is on the roster; only its prompt failed. Handing the prompt back
      // would invite a retry that makes a second, duplicate session — the row is the place to
      // resend it from.
      if (created) return flash('session created, prompt not sent — peek it to resend', 5000)
      // Only restore into an input the user hasn't started refilling: a dispatch can be in flight
      // for up to the client's 10s timeout, and overwriting a half-typed prompt with the failed
      // one is worse than losing it.
      setInput((current) => (current === '' ? typed : current))
      flash(worktreeRemoved ? 'dispatch failed — worktree removed, project marked offline' : 'dispatch failed — project marked offline')
    }
  }

  return { dispatch }
}
