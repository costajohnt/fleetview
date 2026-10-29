# roost — independent audit, round 2 (2026-07-23)

Follow-up to `2026-07-22-independent-audit.md`, re-run against `2b91580` after the fixes landed.
Same method: pinned worktree, live server, no claim taken from a commit message.

Audited tree: `2b91580` (`main` == `feat/fleetview-dispatch` == HEAD — the ff-merge happened).
Nine new commits, `+1127 / -76` across 18 files.

Suite: **412 passed (412), 5 consecutive clean runs.**

Headline: **six of seven findings are genuinely fixed.** One fix is incomplete in a way that
matters more than the original finding — the security hardening makes roost fail to start, and the
README documents the broken configuration as verified working.

---

## R-1 (High, regression) — Turning on the documented auth support stops roost booting

`src/client.js:8` adds `authHeader()`, and both the REST client (`src/client.js:24`) and the event
stream (`src/event-mux.js:30`) send it. Both are correct — I verified them live.

`src/server-manager.js:36` does not. `isServerHealthy` still issues a bare `fetch` to `/project`
with no headers, and it is the gate on every startup path in `makeEnsureServer`
(`src/cli.js:70,74,88`).

**Live evidence.** A real `opencode serve` on 4901 with `OPENCODE_SERVER_PASSWORD` set:

```
GET /project                        -> 401     (unauthenticated)
GET /project -u opencode:<pw>       -> 200
GET /project -u anyuser:<pw>        -> 401     (username matters; roost's default matches)
GET /event   -u opencode:<pw>       -> 200
```

With that same variable exported, against that same live server:

```
isServerHealthy({port:4901})  ->  false
client.listProjects()         ->  4 projects     (the client fix works)
```

And the full startup path, `makeEnsureServer` driven against the live 4901 server with `spawnServer`
stubbed so it did not spawn eleven real ones:

```
ensureServer against the LIVE password-protected server on 4901:
  ok: false   reason: server did not become healthy
  spawn attempts on ports: 4901,4902,4903,4904,4905,4906,4907,4908,4909,4910,4911
```

The sequence a user gets: healthy check 401s → roost spawns a second server on the occupied port →
polls it for 10s (20 × 500ms), every poll 401 → reaps it → probes `opencode --version`, finds it →
walks ports 4902–4911, spawning and polling each for 10s. Roughly **110 seconds** of spawning, then
the screen reads `opencode server unreachable — restart roost`. It never recovers, because every
server it spawns inherits the password and therefore 401s the same unauthenticated health check.

`README.md:75-84` tells the user to do exactly this:

```
export OPENCODE_SERVER_PASSWORD="$(openssl rand -hex 16)"
roost
```

and states "Verified against opencode 1.18.4: unauthenticated requests then get 401 and roost's own
get 200." That is true of `client`, and only of `client`. The health check was not in the sample.

Fix is one line — `isServerHealthy` needs the same header — plus a test that exercises it with the
variable set. Worth noting the original finding is now *worse* off than before the fix: previously
the risk was accepted and undocumented; now there is a documented mitigation that bricks startup,
which is the kind of thing someone turns on right before a trip.

**What I verified about the rest of the auth work, and it is all correct:**

- Username defaults match opencode's own (`-u` "defaults to `OPENCODE_SERVER_USERNAME` or
  `'opencode'`", per `opencode attach --help`) — `src/client.js:12` uses exactly that pair.
- `opencode attach -p` "defaults to `OPENCODE_SERVER_PASSWORD`" (same help output), and `attachPty`
  passes `env = process.env` through to `pty.spawn` (`src/pty-host.js:135,149`), so the attach child
  inherits it. The README's claim here holds.
- The spawned server inherits it too — `spawnServer` does not override `env`.
- Opt-in rather than default is the right call, and the reasoning in the comment is sound.

---

## R-2 (Medium, incomplete) — Subagent ghosts survive for a child roost hasn't listed yet, and the stated bound is wrong

The `childIds` approach (`src/session-store.js:40`) is the right design and it works. Re-running my
round-1 repro:

```
known child, status event  -> [ ses_parent ]                       ← fixed
UNKNOWN child, question    -> [ ses_child/waiting, ses_parent/idle ]  ← still ghosts
  seen.json keys           -> [ /repo:ses_parent, /repo:ses_child ]   ← still persisted
  after a listSessions     -> [ ses_parent ]                       ← pruned
```

`childIds` is only ever populated by `setSessions` (`src/session-store.js:164`). A subagent spawned
*after* the last `listSessions` is unknown, so its `session.status` / `question.asked` /
`permission.asked` still mints a row that browse displays, `^a` can adopt, and `snapshot()` writes
into `seen.json`.

The comment at `src/session-store.js:47-50` says the exposure "is bounded by one poll rather than
being permanent." **It is not.** `listSessions` has exactly three call sites
(`src/app.js:267,293,614`): first sight of a project, a stream that dropped and reconnected, and
after a dispatch. The new periodic pass added in this round deliberately runs
`chainSeed(w, { pending: false, closeRuns: true })` (`src/app.js:339`) — statuses only, no
`listSessions`. So on a healthy long-running roost the real bound is "until the next dispatch,
reconnect, or restart", which can be hours.

That is much better than round 1 and the remaining hole is narrow, but the comment states a
guarantee the code does not provide. Either have the periodic pass refresh `childIds`, or correct
the comment.

## R-3 (Low, not fixed) — The stranded comment block is still stranded

`src/session-store.js:335-344`: the three comment blocks describing `clearHeuristicWaiting` and
`markStopped` still sit above `setProvisionalTitle`, unchanged. The peek comment and the
`question.replied` "unverified" comment were both fixed correctly; this one was missed.

---

## Verified fixed

| Round-1 finding | Status | How I checked |
|---|---|---|
| **F-1** subagent ghost rows | **Fixed** for listed children; see R-2 for the residual | replayed the live child payloads against the real store |
| **F-2** unauth server / shell route | **Fixed in client + SSE + attach; broken in the health check** — see R-1 | live 401/200 matrix on a password-protected server |
| **F-3** `?` heuristic false "needs input" | **Risk removed, heuristic kept** — deliberate, documented | `pendingRequest` on the public view (`session-store.js:139`); bell (`app.js:520`), tab title (`notify.js:16`) and header (`header.js:14`) all gate on it. Reproduced: rhetorical sign-off → `status: waiting, pendingRequest: false`, so it sorts into `needs input` and rings nothing |
| **F-4** three lying comments | **2 of 3 fixed** — see R-3 | `peek.js:64` now describes the answerable panel; `session-store.js:282` records the verified `requestID` |
| **F-5** reconcile outside the seed chain | **Fixed** | `reconcileRef` publishes `chainSeed`; both peek paths route through it (`app.js:866,950`), and per-list outcome flags replace the conflated single failure flag — a better fix than the one I proposed |
| **F-6** Ctrl+C / Alt+N divergences | **Fixed** | Ctrl+C is now two-press with a 2s arm (`app.js:729`); Alt+N is documented as best-effort, made disableable with `ROOST_NO_ALT_SWITCH=1`, and the ambiguity is written up honestly in the parity doc's new §6a |
| **F-7** `main` 15 commits stale | **Fixed** | `main`, `feat/fleetview-dispatch` and HEAD all at `2b91580` |

On **F-3**: I recommended deleting the heuristic; the team kept it and cut it off from every
interrupting channel instead. Having read the reasoning, that is defensible — it still earns a row
its place in `needs input` for free, and `s:blocked` deliberately includes it. The `isQuestion`
refinement (`session-store.js:7-19`) is a real improvement too: a reply ending in a fenced code
block or an indented `var name: String?` no longer reads as a question. I would still delete it
eventually, but it is no longer a defect.

---

## New work reviewed, no defects found

The nine commits did considerably more than answer round 1. I reviewed all of it:

- **`ranForMs` rebuilt on a measured run span** (`runStartedAt`/`runEndedAt`, one local clock).
  This is a genuine correctness fix I had not caught: the old version subtracted `createdAt` from
  `updatedAt`, so a session adopted from opencode's TUI reported hours. The `!wasRunning` guard is
  right — I confirmed live that opencode emits multiple `busy` frames per turn (three in my own
  capture), which would have restamped the start on each one.
- **`closeRuns` split between the periodic pass and reconnect.** Correct, and the reasoning is
  exactly right: after an outage the gap is unknown, so reporting null and falling back to an age
  beats fabricating a duration.
- **Error retirement anchored on a server timestamp with an explicit UNKNOWN sentinel.** The
  ordering-dependence it removes is real.
- **`seedStatuses` null and shape guards** (`session-store.js:434-443`). Both are correct and both
  matter: `client.#req` returns `null` for a 2xx with an empty body, and treating that as an
  authoritative empty map would have marked every session in a project idle.
- **`statusSeq` carried through `setSessions`** — a real hole, closed.
- **The periodic re-reconcile** (`app.js:329-345`). Previously a single lost `session.status` frame
  on a healthy stream left a row animating "working" forever. Chained and watermarked, so safe.
- **`node-pty` made optional** with a `spawnSync` fallback. Correct call for Linux installs.
- **Terminal restore on signal** (`pty-host.js:19-42`). Right problem — a roost killed mid-attach
  left the shell in raw mode. One note, not a finding: the SIGINT/SIGTERM/SIGHUP handlers install
  on first attach and stay installed for the process lifetime, so a later Ctrl+C re-raises with the
  default disposition rather than unmounting Ink. Behaviourally the same as before the change,
  since nothing handled those signals previously.
- **The Alt+N escape-window reader** (`makeChordReader`). The 40ms hold is the standard trade, the
  tests cover split/coalesced/real-Escape/teardown, and — unusually — the docs now say plainly that
  it cannot be made exact over a laggy link. That honesty is worth more than the feature.
- **Filters now apply in browse** (`app.js:407`), and the header count agrees with the tab title
  (`header.js:14`). Both were real inconsistencies.

---

## What I would do next

1. **Fix R-1 today.** `isServerHealthy` needs the auth header. Until then the README section should
   not be there, because following it breaks the tool. Add a test that sets the variable and asserts
   `ensureServer` returns `ok: true` against an authenticated server.
2. **R-2**: refresh `childIds` on the periodic pass, or correct the comment to say what the bound
   actually is.
3. **R-3**: move the stranded comment block.
4. Then the round-1 list stands unchanged: **worktree isolation** is still the largest remaining
   correctness gap, and still ahead of `--cwd` in my ranking.

Everything else from round 1 is closed. The fix quality was high — F-5 in particular was solved
better than I proposed, and several of the nine commits fixed real bugs I had not found.

---

## Addendum — R-1/R-2/R-3 closed (`3f8eae9`)

All three fixed, tested, and re-verified live.

**R-1.** `isServerHealthy` now sends the same credential (`src/server-manager.js:37`). Against a
real `opencode serve` on 4901 with `OPENCODE_SERVER_PASSWORD` set:

```
before:  isServerHealthy -> false   ensureServer -> ok:false, spawn attempts: 4901…4911 (11)
after:   isServerHealthy -> true    ensureServer -> ok:true,  spawn attempts: (none)
         SSE stream authenticated -> true      client.listProjects -> 4 projects
         bare GET /project -> 401              (the protection still works)
```

The no-password path is unchanged: `isServerHealthy(4900) -> true`, `ensureServer ok: true`, and no
`authorization` header is sent at all. Both covered by tests.

**R-2.** Two changes, because the first alone was not enough. `upsert` now refuses a session already
known to be a child (`src/session-store.js:72`) — filtering the derived views only hid the record,
and the live status map that named the child re-created it the moment `setSessions` pruned it. And
the project poll now relists (`src/app.js:229`, `:355`), which is the only thing that learns what is
a subagent, so the remaining window — a child roost has never listed — really is one poll interval
wide, as the comment claimed.

Both tests were red-verified against the un-fixed code. The first attempt at the store test passed
without the fix, because it asserted only on view-filtered accessors; it now asserts on
`pendingFor`/`pendingQuestionsFor`, which are not filtered, and fails without the guard.

**R-3.** The two comment blocks are back on `markStopped` and `clearHeuristicWaiting`.

Suite: **416 passed (416), 5 consecutive clean runs.**

---

## New finding — opencode deletes a dirty worktree without refusing

Found while probing whether `/experimental/worktree` can back the isolation feature. It can, and the
create half is clean:

```
POST /experimental/worktree?directory=<repo>  {name:"roost-test-1"}
  -> {name:"roost-test-1", branch:"opencode/roost-test-1",
      directory:"~/.local/share/opencode/worktree/<repo-hash>/roost-test-1"}
```

A real `git worktree`, on a real branch, listed by `git worktree list`. `GET` lists them and
`POST /experimental/worktree/reset` exists.

The delete half has no safety at all. With an uncommitted modification in the worktree:

```
git -C <worktree> status --short     ->  M a.txt
DELETE /experimental/worktree {directory}  ->  200 true
ls <worktree>                        ->  (gone)
git branch -a                        ->  opencode/roost-test-1 also gone
```

The uncommitted change was destroyed silently. Agent view's entire deletion story is refusal rules —
"`claude rm <id>` keeps the worktree if uncommitted changes", "neither removes a worktree with
unpushed commits". **opencode's endpoint implements none of them**, so roost cannot delegate that
half. Any isolation feature has to run its own `git status --porcelain` and unpushed-commit check
before calling DELETE, and `^x^x` on an isolated session has to refuse rather than delete.

This is worth knowing regardless of whether roost builds isolation: anything else calling that
endpoint has the same hazard.
