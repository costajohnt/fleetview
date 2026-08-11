import { useEffect, useRef } from 'react'
import { hasSession } from './roster-store.ts'
import { DEFAULT_BACKEND } from './backends/index.ts'
import { sandboxParents, allProjectDirectories } from './worktree.ts'
import { byBranch } from './pull-requests.ts'
import type { OpencodeEvent } from './types.ts'

// repoll keeps stale (vanished) projects in place — only union in what's fresh, never drop.
const sortProjects = (list: any[]) => [...list].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
const mergeProjects = (prev: any[], fresh: any[]) => {
  const freshKeys = new Set(fresh.map((p) => p.worktree))
  return sortProjects([...fresh, ...prev.filter((p) => !freshKeys.has(p.worktree))])
}

// The discovery/streaming effect: project polling, per-worktree seeding and SSE streams, the
// non-opencode backend discovery loop, pull-request refresh, and the external-roster sync — lifted
// out of App the same way usePeek was, so the roster closure stops carrying them. Everything App
// owns and this needs is passed in explicitly; the hook publishes its three entry points back
// through the refs App hands it (`reconcileRef`, `streamProjectRef`, `activateBackendRef`), which
// were already the seam between this effect and the rest of App.
// TODO(types): all inputs are App-owned dynamic collaborators (client, session store, roster ref,
// backend registry); typed loose because their real shapes live in other modules.
export function useDiscovery({
  serverReady,
  client,
  store,
  seen,
  server,
  connectEventsImpl,
  ensureServerImpl,
  onAction,
  exit,
  projectPollMs,
  initialBackend,
  backendRegistry,
  fetchPullRequestsImpl,
  branchOfImpl,
  persistRoster,
  rosterRef,
  setRosterState,
  seededProjectKeys,
  knownWorktrees,
  projectsListed,
  reconcileRef,
  streamProjectRef,
  activateBackendRef,
  flushSavedReplies,
  setOfflineProjects,
  setServerDown,
  setProjects,
  setPullRequests,
  // App-side roster removal (updateRoster + withoutMember): explicit delete evidence from the
  // stream is the only path allowed to prune members — see the onEvent handler below.
  onSessionDeleted,
}: {
  serverReady: boolean
  client: any
  store: any
  seen?: any
  server: any
  connectEventsImpl: any
  ensureServerImpl?: any
  onAction: (action: any) => any
  exit: () => void
  projectPollMs: number
  initialBackend: string
  backendRegistry: Record<string, any>
  fetchPullRequestsImpl: any
  branchOfImpl: any
  persistRoster?: ((roster: any) => void) & { reload?: () => any }
  rosterRef: { current: any }
  setRosterState: (roster: any) => void
  seededProjectKeys: { current: Set<string> }
  knownWorktrees: { current: Set<string> }
  projectsListed: { current: boolean }
  reconcileRef: { current: any }
  streamProjectRef: { current: any }
  activateBackendRef: { current: ((name: string) => Promise<void>) | null }
  flushSavedReplies: { current: () => void }
  setOfflineProjects: (updater: (s: Set<string>) => Set<string>) => void
  setServerDown: (down: boolean) => void
  setProjects: (updater: (prev: any[]) => any[]) => void
  setPullRequests: (prs: { byBranch: Map<string, any>; branches: Map<string, any>; reasons: Map<string, any> }) => void
  onSessionDeleted: (directory: any, id: any) => void
}) {
  const conns = useRef(new Map<string, any>()) // worktree -> stream handle, for unmount cleanup
  useEffect(() => {
    let cancelled = false
    let polling = false
    let intervalId: ReturnType<typeof setInterval> | undefined

    // Live-state reconciliation: GET /session/status + GET /permission + GET /question catch a
    // session mid-run or a permission/question already pending at fleetview launch/reconnect that a
    // fresh SSE stream wouldn't otherwise report until its next change. Best-effort — failures
    // never block seeding.
    // I2: statuses seed FIRST and are awaited before permissions+questions seed — session.status's
    // idle-clear must land ahead of the fresh pending seed, not race it, or a handler-style
    // clear could wipe an entry the authoritative reseed was about to (re)add. The __seq mark is
    // captured BEFORE issuing the GETs (the very first line) and passed to both seeds — it lets
    // seedPermissions/seedQuestions tell a pre-seed entry (safe to drop if the fresh list lacks it)
    // from one that landed live while these GETs were still in flight (must survive the replace).
    // That watermark is what makes it safe to connect the SSE stream before this seed lands (below).
    // Reports each list separately. A single combined flag conflated three independent requests:
    // a peek path that only cares whether `/question` succeeded would see failure because
    // `/session/status` timed out, and blind-re-add a question the fresh list had correctly
    // dropped — resurrecting a request the server has already accepted an answer for, which is
    // exactly what the fallback exists to avoid.
    // `additive: true` is the periodic pass's form of the pending seed. The default replace is
    // *authoritative* — an entry missing from the response is dropped — which is right when
    // reconnecting after missing events, but wrong to repeat on a timer: if `GET /permission` ever
    // omitted a genuinely pending request, a rare reconnect-only drop would become a recurring one.
    // So the timer used to seed statuses only. That left a real hole: a lost `session.status` frame
    // self-heals within one poll, but a lost `permission.asked`/`question.asked` frame had no
    // recovery path at all, and the row sat rendering "working" with a blocked run behind it and no
    // token spend until the user restarted. Systematic rather than rare, because opencode's event
    // stream is per-directory and a dispatched session runs in its own git worktree — statuses for
    // those still refresh (the poll hits GET /session/status per worktree), permissions and
    // questions had no equivalent. The additive mode only ADDS what the store is missing and never
    // deletes, so the timer can run it without the omission risk, and the authoritative replace
    // stays exactly where it was: mount, reconnect, and the peek reconcile paths.
    const seedLiveState = async (worktree: any, { pending = true, additive = false, closeRuns = false, relist = false }: any = {}) => {
      // Before anything else, because `setSessions` is the only thing that learns which sessions are
      // subagents, and every seed below can otherwise mint a row for one. A subagent spawned since
      // the last listing is unknown, so its first `session.status` creates a record; this is what
      // closes that window on the poll interval instead of leaving it open until the next reconnect
      // or dispatch. It also retires a session that has vanished from the listing — deleted from
      // opencode's own TUI, or by a `session.deleted` the stream was down for — with one exception
      // fleetview cannot close: a record it has never listed, which is indistinguishable from a
      // session created since the last listing (the row a dispatch has this instant created).
      if (relist) {
        try {
          const list = await client.listSessions(worktree)
          if (cancelled) return { permissions: false, questions: false }
          seededProjectKeys.current.add(worktree)
          // The one caller that retires vanished sessions, because it is the one chainSeed
          // serializes per worktree — so a stale listing can never land after a newer one and
          // delete what the newer one just saw. Every other caller refreshes without retiring.
          store.setSessions(worktree, list, seen, { retire: true })
        } catch {
          // A failed relist is not worth flagging the project offline for — the stream is the
          // authority on that, and the next tick tries again.
        }
      }
      const mark = store.seedMark()
      const outcome = { permissions: true, questions: true }
      await client
        .sessionStatus(worktree)
        .then((s: any) => store.seedStatuses(worktree, s, mark, { closeRuns }))
        .catch(() => {})
      if (!pending) return outcome
      // M4: each GET fails independently. If sessionStatus above succeeds but one of these two
      // fails, that half of the reseed silently no-ops — e.g. a session whose status seed just
      // landed idle can still show "waiting" off a pendingPermissions/pendingQuestions entry that
      // never got its authoritative reseed. Stale until the next reconnect's seedLiveState run;
      // self-healing, accepted rather than adding retry/backoff for a best-effort catch-up path.
      await Promise.all([
        client
          .listPermissions(worktree)
          .then((p: any) => store.seedPermissions(worktree, p, mark, { additive }))
          .catch(() => { outcome.permissions = false }),
        client
          .listQuestions(worktree)
          .then((q: any) => store.seedQuestions(worktree, q, mark, { additive }))
          .catch(() => { outcome.questions = false }),
      ])
      return outcome
    }

    // M2: per-worktree promise chain — mount/onOnline/repoll/reconcile all route seedLiveState
    // calls through this, so two seeds for the same worktree never overlap outside the watermark
    // protocol above. Also eliminates the startup double-fetch: mount's initial seed and the first
    // onOnline resync now run sequentially instead of both firing their GETs concurrently.
    const seedChains = new Map<string, Promise<any>>()
    const chainSeed = (w: any, options?: any) => {
      const failed = { permissions: false, questions: false }
      const next = (seedChains.get(w) ?? Promise.resolve()).then(() => seedLiveState(w, options)).catch(() => failed)
      seedChains.set(w, next)
      return next
    }
    // Published so the peek reconcile paths use the same chain. They used to call seedMark() and
    // seedPermissions/seedQuestions directly, which is exactly the overlap the chain prevents: a
    // reconnect's older snapshot could land after a newer one and re-insert a permission the
    // server had already accepted an answer for.
    reconcileRef.current = chainSeed
    streamProjectRef.current = (w: any) => seedAndStream(w)

    const seedAndStream = async (worktree: any) => {
      // M14: idempotency lives here, not at callers — the dispatch path and a poll tick can both
      // reach this for the same worktree (the poll awaits gh calls before computing newOnes), and
      // a second run's `conns.current.set` would orphan the first connection's stop() so it
      // reconnects and double-delivers forever. knownWorktrees covers the in-flight window (it is
      // added below and deleted on failure, so retries still work); conns covers established ones.
      if (conns.current.has(worktree) || knownWorktrees.current.has(worktree)) return
      knownWorktrees.current.add(worktree)
      try {
        const sessions = await client.listSessions(worktree)
        if (cancelled) return
        seededProjectKeys.current.add(worktree)
        store.setSessions(worktree, sessions, seen)
        const conn = connectEventsImpl(
          { ...server, directory: worktree },
          {
            onEvent: (directory: any, e: OpencodeEvent) => {
              store.apply(directory, e)
              // Explicit delete evidence only — never prune members merely absent from a listing;
              // offline projects must keep members (F1).
              const id = e.type === 'session.deleted' ? e.properties?.info?.id : undefined
              if (id && hasSession(rosterRef.current, directory, id)) {
                onSessionDeleted(directory, id)
              }
            },
            onOffline: (directory: any) => setOfflineProjects((s) => new Set(s).add(directory)),
            onOnline: (directory: any) => {
              setOfflineProjects((s) => {
                const next = new Set(s)
                next.delete(directory)
                return next
              })
              // project's stream just came back: re-seed in case we missed events while offline.
              // fire-and-forget — a racing failure re-flags it offline via other paths.
              client
                .listSessions(directory)
                .then((list: any) => {
                  seededProjectKeys.current.add(directory)
                  store.setSessions(directory, list, seen)
                  chainSeed(directory)
                })
                .catch(() => {})
            },
          },
        )
        if (cancelled) return conn.stop()
        conns.current.set(worktree, conn)
        // I2: fire-and-forget, not awaited — the stream is already connecting above, and the
        // seq-watermark inside seedLiveState makes a seed that resolves after live events have
        // already landed safe (event-fresh entries survive the replace instead of being deleted).
        // M2: routed through chainSeed, not called directly — serializes against any other
        // pending seed for this worktree (e.g. a fast onOnline flap right after mount).
        chainSeed(worktree)
      } catch {
        if (!cancelled) {
          setOfflineProjects((s) => new Set(s).add(worktree))
          knownWorktrees.current.delete(worktree) // let the next repoll retry it fully, not skip it forever
        }
      }
    }

    // Backends other than opencode, streamed only once something has asked for them: the launch
    // default (--backend / FLEETVIEW_BACKEND), a roster membership left by a previous run, or an
    // `@backend` dispatch. A pure-opencode user never activates one, so nothing here ever runs for
    // them — no extra polling, and no other tool's sessions in their roster.
    const activeBackends = new Set<string>([DEFAULT_BACKEND, initialBackend])
    for (const m of rosterRef.current.sessions as any[]) {
      if (m.backend && m.backend !== DEFAULT_BACKEND) {
        activeBackends.add(m.backend)
        // Without this a restored row is untagged in the store, and so swept as opencode's by the
        // three seeds the moment its project comes online.
        store.noteOrigin(m.worktree, m.id, m.backend)
      }
    }
    const backendConns = new Map<string, any>() // `${name}:${worktree}` → subscription, for unmount

    // Connect (once) and re-list (every call) one backend in one directory. Listing every time is
    // what makes discovery keep up: a process-backed backend has no event for "a session you have
    // never seen exists", so the periodic listing is the only way one started outside fleetview —
    // or by a previous fleetview run — ever appears.
    const streamBackend = async (name: string, worktree: string) => {
      if (name === DEFAULT_BACKEND) return // opencode has its own path above, unchanged
      const backend = backendRegistry[name]
      if (!backend) return
      const key = `${name}:${worktree}`
      if (!backendConns.has(key)) {
        // One normaliser per subscription, because it folds per-session state across events and two
        // directories' runs must never share that fold.
        const normalise = backend.createNormaliser()
        const conn = backend.events(
          { directory: worktree },
          {
            onEvent: (directory: string, event: unknown) => {
              for (const store_event of normalise(event)) {
                // Not every union member carries sessionID (session.updated nests an info object),
                // and the ones a normaliser emits all do — the loose read says so once.
                const id = (store_event.properties as { sessionID?: string }).sessionID
                if (id) store.noteOrigin(directory, id, name)
                store.apply(directory, store_event)
              }
            },
          },
        )
        if (cancelled) return conn.stop()
        backendConns.set(key, conn)
      }
      try {
        const list = backend.normaliseSessions(await backend.listSessions(worktree))
        if (cancelled) return
        for (const s of list) store.noteOrigin(worktree, s.id, name)
        // Never `retire: true`: that sweep is scoped to a project, not to a backend, so a claude
        // listing armed with it would delete the opencode rows in the same directory. Leaving these
        // records unlisted is also what keeps opencode's own retiring listing from deleting them —
        // it only sweeps records its own listings armed.
        store.setSessions(worktree, list, seen)
      } catch {
        // A CLI that isn't installed, or a state directory that doesn't exist. Both are "no sessions
        // here", and neither is worth flagging the project offline for.
      }
    }
    // Published for the dispatch path: `@claude fix the tests` has to start streaming claude before
    // the row it just created can ever update.
    activateBackendRef.current = async (name: string) => {
      activeBackends.add(name)
      await Promise.all([...knownWorktrees.current].map((w) => streamBackend(name, w)))
    }

    const refreshPullRequests = async (fresh: any[]) => {
      // One call per repository, never per worktree: a worktree shares its repository's remote, so
      // asking it the same question again would double the subprocesses for identical answers.
      const parentsNow = sandboxParents(fresh)
      const repoDirs = fresh.filter((p) => !parentsNow.has(p.worktree)).map((p) => p.worktree)
      const results = await Promise.all(repoDirs.map((dir: any) => fetchPullRequestsImpl(dir)))
      if (cancelled) return
      // Keyed by repository dir + branch, not bare branch: branch names are not unique across
      // repositories (every repo dependabot touches has a `dependabot/github_actions/...` branch),
      // and a bare-branch key let a session wear another repository's pull request label.
      const merged = new Map()
      repoDirs.forEach((dir: any, i: number) => {
        for (const [branch, list] of byBranch(results[i].prs)) merged.set(`${dir} ${branch}`, list)
      })
      // Reasons are scoped per repository, not collapsed to one global string: `repoDirs` and
      // `results` are index-aligned (one `gh` call per repo dir), so zip them into a map and keep
      // only the repos that actually failed. This is what lets peek show a session its OWN repo's
      // reason instead of a different repo's.
      const reasons = new Map()
      repoDirs.forEach((dir: any, i: number) => {
        if (results[i].reason) reasons.set(dir, results[i].reason)
      })
      // Branches are read for every directory including worktrees, because a session's key is the
      // branch of the directory it actually runs in, not of the repository that owns it.
      const branches = new Map()
      for (const p of fresh) {
        const branch = branchOfImpl(p.worktree)
        if (branch) branches.set(p.worktree, branch)
      }
      setPullRequests({ byBranch: merged, branches, reasons })
    }

    // #44: a `fleetview bg` dispatch from another terminal appends to roster.json and the running
    // TUI never noticed — it read the file once at mount and holds membership in React state, so
    // the session streamed fine in browse while its member row stayed invisible until restart.
    // Re-read on the tick that already polls projects and union in what state lacks.
    //
    // Additions only. Removals are deliberately NOT synced: two instances would fight over deletes,
    // and one instance's ^x would silently eat a membership the other is still using.
    //
    // Nothing already in state is ever rewritten from disk — a pin, rank, prompt or collapse this
    // instance just made stays exactly as it is, and groupBy/collapsed are never read at all. And
    // nothing is persisted here: these members are on disk already, and writing back would hand
    // makePersistRoster's `prev` a foreign member to later mistake for one of its own.
    const syncExternalMembers = () => {
      const disk = persistRoster?.reload?.() // null when unchanged, unreadable, or not wired (tests)
      if (!disk) return
      const have = new Set(rosterRef.current.sessions.map((m: any) => `${m.worktree}:${m.id}`))
      const added = disk.sessions.filter((m: any) => !have.has(`${m.worktree}:${m.id}`))
      if (added.length === 0) return
      const next = { ...rosterRef.current, sessions: [...rosterRef.current.sessions, ...added] }
      // The ref leads, as it does everywhere else in this effect (F1): updateRoster writes through
      // rosterRef.current, and a call site that fires before the state flush must see these members.
      rosterRef.current = next
      setRosterState(next)
    }

    const refreshProjects = async () => {
      if (polling) return
      polling = true
      flushSavedReplies.current() // anything queued by a failed peek reply gets another go
      // Before listProjects, not after: #43 ghosts a member whose worktree is in no project record,
      // and the listing is only fair evidence if it ran AFTER the member became known. Reading the
      // roster first makes that ordering unconditional.
      syncExternalMembers()
      try {
        // Sandboxes included: a worktree is not reliably published as a project row of its own, and
        // a session fleetview never streams is a row that never updates.
        const fresh = allProjectDirectories(await client.listProjects())
        if (cancelled) return
        setServerDown(false)
        projectsListed.current = true // #43: a completed round is the ghost arm's only evidence
        setProjects((prev) => mergeProjects(prev, fresh))
        // Pull requests refresh on the tick that already re-lists projects: no second timer and no
        // TTL bookkeeping. A poll is unavoidable rather than a shortcut — the label's colour encodes
        // CI state, and checks go green while the session sits idle, so no session event could ever
        // turn a row green.
        await refreshPullRequests(fresh)
        const newOnes = fresh.filter((p) => !knownWorktrees.current.has(p.worktree))
        await Promise.all(newOnes.map((p) => seedAndStream(p.worktree)))
        // Discovery for the process-backed backends rides the same tick: the directories fleetview
        // already shows are exactly the ones worth asking claude/copilot about, so a session started
        // outside fleetview in one of them joins the roster on the next poll. No-op when no backend
        // beyond opencode is active, which is the default.
        for (const name of activeBackends) {
          if (name === DEFAULT_BACKEND) continue
          await Promise.all(fresh.map((p) => streamBackend(name, p.worktree)))
        }
        // Re-reconcile the projects already streaming. Without this the only reconciliation paths
        // were first sight and a stream that dropped and came back — so a single lost
        // `session.status` frame on a healthy connection left a row animating "working" forever,
        // with no way back short of restarting fleetview. The seed is chained and watermarked, so a
        // periodic pass is safe; it just makes the state self-healing on the poll interval.
        for (const p of fresh) {
          if (!newOnes.includes(p) && seededProjectKeys.current.has(p.worktree)) {
            // A healthy poll: a session that has gone absent finished within the last interval, so
            // its run span can be closed. The reconnect path deliberately does not pass this — the
            // stream may have been down for an hour and the run may have ended at the start of it.
            // `additive`, not the default replace: the pending lists are refreshed by adding what
            // the server reports and the store lacks — a permission.asked/question.asked frame the
            // stream dropped — and never by deleting. See seedLiveState for why the authoritative
            // form must not run on a timer.
            chainSeed(p.worktree, { additive: true, closeRuns: true, relist: true })
          }
        }
      } catch {
        // transient listProjects failure — try to recover the server itself before the next poll tick
        try {
          const r = await ensureServerImpl(server)
          if (cancelled) return
          if (!r.ok) {
            setServerDown(true)
          } else if (r.server.port === server.port) {
            setServerDown(false) // same port came back healthy — streams self-recover
          } else {
            // ensureServer fell back to a different port and already persisted it to server.json —
            // remount on it rather than performing live client/stream surgery here.
            onAction({ type: 'reconnect' })
            exit()
          }
        } catch {
          if (!cancelled) setServerDown(true)
        }
      } finally {
        polling = false
      }
    }

    if (serverReady) {
      ;(async () => {
        await refreshProjects()
        if (cancelled) return
        intervalId = setInterval(refreshProjects, projectPollMs)
      })()
    }

    return () => {
      cancelled = true
      if (intervalId) clearInterval(intervalId)
      conns.current.forEach((c) => c.stop())
      conns.current.clear()
      backendConns.forEach((c) => c.stop())
      backendConns.clear()
    }
  }, [])
}
