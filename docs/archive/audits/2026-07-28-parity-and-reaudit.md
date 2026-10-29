---
type: project-note
status: active
updated: 2026-07-28
tags: [audit, code-review, parity, fleetview, tui]
aliases: [fleetview parity re-audit]
---

# fleetview parity check + re-audit (2026-07-28, post-fix)

Repo @ commit `a2ef490`, branch `main`, immediately after the audit-fix
merge (#130, squash `3b2c9eb`) and the audit-report docs push. Five
parallel streams: Claude Code agents-view parity (against current official
docs), correctness (focused on the fresh merge), security (focused on the
new password/strip/chmod code), tests (the 17 new tests), architecture
(merge consistency). Baseline: `vitest run` — "Test Files  39 passed (39)
/ Tests  811 passed (811)"; `tsc --noEmit` clean.

---

## Parity vs Claude Code agents view

Checked against the current official agent-view docs (fetched 2026-07-28)
plus recent changelog entries (v2.1.205 through v2.1.218). **Zero new gaps
since the 2026-07-21/22 parity audits.** Full matrix (168 capabilities,
per-item doc sources): `docs/audits/2026-07-28-parity-matrix.md`.

- **146 at parity**, verified through the 2026-07-23/24 live checks (PR
  awareness, worktree isolation + delete-refusal, full CLI surface,
  Shift+↑↓ reorder, `/fork`, notify hooks, shell-job auto-clean).
- **12 partial** — all deliberate, documented deferrals with workarounds
  (model-written summaries vs streamed output; structured y/a/d permission
  answers; image paste blocked at terminal level; `/resume` picker
  equivalent via browse+adopt except restore-deleted, which opencode
  cannot do; Alt+1..9 quick-switch off on laggy links; left-arrow
  empty-prompt detach architectural).
- **2 not applicable** — `respawn <id>` / `respawn --all`: opencode owns
  session lifecycle, no API exposed.
- New Claude Code features since the July 21/22 audits (detach
  confirmation, MCP dialogs, multi-PR, paste re-expansion) create no new
  gaps: each is either built, opencode-internal, or architecturally n/a.

## Critical

## High

### H1. `fleetview server status`/`stop` blind to their own password-protected server
`src/cli.ts:266-283` — `runServer` loads server.json then probes via
`isServerHealthyImpl(server)`, but `isServerHealthy`
(`server-manager.ts:52-56`) builds auth from `authHeader()`, which reads
only `env.OPENCODE_SERVER_PASSWORD` (`client.ts:11-16`) and ignores the
`ServerRef.password` field entirely. The env adoption line exists only in
`makeEnsureServer` (`cli.ts:113-117`), and `runServer` deliberately takes
no ensureServer. The probe endpoint is `/project`, which 401s
unauthenticated when a password is armed (documented in the repo's own
comment, `server-manager.ts:46-51`: "every probe came back 401 — which
reads as 'dead server'"). The stop branch returns "server is not running —
nothing to stop", exit 0, before ever reaching the kill. Framing verified:
`runServer`'s env-only probe predates today's merge; what `3b2c9eb`
changed is that a password-protected spawned server is now the *default*,
with the password only in server.json, never in a fresh process's env —
so `server status` reports unhealthy and `server stop` silently no-ops
against fleetview's own server. No test covers it (every runServer test
injects a fake health impl; the one real-binary test writes server.json
without a password). Fix: mirror the one env-adoption line into
`runServer` before the probe, plus a test with a passworded server.json.

### H2. ensureServer returns the password-less ref — mid-run recovery erases the minted password from server.json
`src/cli.ts:134-138` — after a successful spawn, `return { ok: true,
server }` hands back the original ref while `target` carries the minted
password; the credential lives only in env and on disk. App's recovery
path (`app.ts:632`) re-invokes `ensureServerImpl(server)` with that stale
ref when a poll tick fails: env already holds the password so `generated`
is null, `target = server` (no password field), and
`saveServer({ ...server, pid })` (`cli.ts:137`) rewrites server.json
WITHOUT the password — while the respawned child (inheriting env) still
enforces it. Invisible until the next fresh run: it adopts nothing, probes
unauthenticated, 401s, reads the server dead, mints a new password, and
lands on a fallback port — one duplicate server plus an orphan on the
original port whose password was never persisted anywhere. Verified: the
fallback path at `cli.ts:154` already returns the candidate correctly;
`test/cli.test.ts:45` actually asserts the buggy return shape; App tests
mock `ensureServerImpl` entirely. Fix: one token —
`return { ok: true, server: target }` — plus a recovery-path test.

### H3. Roster-restored claude/copilot rows never get the origin tag — H4/M13 sweeps still fire for them
`src/app.ts:499-503` — the mount effect seeds
`sessionBackends.current.set(key, m.backend)` directly from roster
memberships, bypassing `noteBackend`. Every later `noteBackend` for those
keys (listing at `app.ts:540`, events at `app.ts:528`) hits the dedup
early-return at `app.ts:207` BEFORE the `store.noteOrigin` call at 211 —
and nothing else ever writes `origin` (`session-store.ts:506-508` is the
only writer; `setSessions` merely carries `prev?.origin`). Exposure is
permanent for the process lifetime: with `origin` undefined the sweeps
treat the row as opencode-owned (`session-store.ts:650,670,698`), so a
restored running `@claude` row is force-idled by the periodic reconcile
and its synthetic `<id>:denied` entry is deleted — the exact bugs the
origin tag was merged today to fix, still live for the restore path.
Verified refinement: this fires on process restart and server reconnect
(the normal resume flow the roster exists for), NOT on every
attach/detach — attach keeps App mounted (`cli.ts:597-619`). A row whose
busy event lands after the current mark survives one sweep, but
listing-only restores (statusSeq undefined) are swept. Store-level tests
all call `noteOrigin` explicitly, so the bypass is untested. Fix: in the
roster-seed loop, route through `noteBackend` (or call `noteOrigin`
directly) instead of raw `map.set`.

## Medium

- **M1.** (security) Minted `OPENCODE_SERVER_PASSWORD` inherited by every
  dispatched agent process — `cli.ts:116,134` write it into
  `process.env`; claude/copilot dispatch spawns
  (`backends/claude/index.ts:121`, copilot equivalent) and the notify
  `sh -c` hook (`notify.ts:64`) pass no scoped env, so the least-trusted,
  prompt-injectable principals inherit the credential; one approved
  localhost HTTP call = ungated shell via `/session/:id/shell`, the exact
  route the mint closes. Fix: strip the var from dispatch-child and
  notify-hook env; keep for opencode server spawn and pty attach.
  (unverified)
- **M2.** (security) Fallback-port spawn path never verifies the minted
  password is enforced — `cli.ts:149-157` (also 136-138):
  `isAuthEnforced` runs only on the adopt branch; a foreign passwordless
  opencode on a fallback port answers the authed probe 200 (auth ignored
  when no password set), and fleetview persists a `server.json` claiming
  password protection for a server enforcing nothing, with a dead child's
  pid. Fix: run `isAuthEnforced` after any successful spawn-path probe;
  on failure warn and persist without the `password` field. (unverified)
- **M3.** (security) Peek permission/question banners and option labels
  render agent-controlled text unstripped — `ui/peek.ts:41,47,52,203`
  (`permissionLabel`, `questionLabel`, `o.label`); the M12 fix covered
  message bodies only, same component, same DCS/OSC-8 passthrough. Fix:
  strip inside the label helpers so cli.ts consumers benefit too.
  (unverified)

- **M4.** (architecture) User-set `OPENCODE_SERVER_PASSWORD` over an
  already-running generated-password server orphans it and spawns a
  duplicate — `cli.ts:116` lets user env outrank the persisted credential
  unconditionally; probe 401s, same-port respawn can't bind, fallback
  loop (`cli.ts:148-156`) spawns on port+1 while the orphan keeps its
  shell route alive under the old password. No reconciliation branch for
  "saved password exists AND user set a different one". Fix: on probe
  failure with user password, re-probe with saved password; warn or
  stop-and-respawn instead of walking ports. (unverified)

- **M5.** (correctness) Shrink-reset uses `size < offset` as proxy for
  "rewritten" — `backends/claude/index.ts:219`: a rename-over rewrite that
  lands equal-or-larger passes the guard, so the tail reads from a stale
  byte offset into unrelated new content; records between byte 0 and the
  old offset are silently never seen. The invariant is "same inode,
  append-only", which size alone can't witness. Fix: store `st.ino` in
  the cursor, reset on change; same for copilot's `readFrom`. (unverified)

## Low (selected)

### Correctness

- `cli.ts:582` — `--cwd` fix is half-done for symlinks: `resolve()` but
  not realpath, while opencode reports realpath'd dirs (`bg` at
  `cli.ts:223` realpaths for exactly this reason); macOS `/tmp` etc.
  still mismatch. Fix: `realpathSync` with fallback to `resolve`.
- `cli.ts:116` — stale generated password in server.json makes a 401 read
  as "dead", stranding ensureServer walking fallback ports past a
  healthy foreign server (related to M4's missing reconciliation). Fix:
  distinguish 401 from unreachable in `isServerHealthy`.
- `backends/claude/projects.ts:238` — `scanCache` never evicts
  directories that stop being polled; holds prompt/title strings for
  process lifetime. Memory-only; cap or age-out if touched.

### Architecture

- `backends/copilot/index.ts:86-109` — copilot `reap()` is a near-verbatim
  copy of claude's, already divergent (no injectable clock); a fresh
  instance of the deferred M8 duplication class. At minimum give copilot
  the `now` param.
- `cli.ts:138` vs `cli.ts:154` — inconsistent ServerRefs between the two
  success-after-spawn paths: initially flagged "harmless"; verification
  proved otherwise — see H2, which this is the root of.
- `git-safe.ts:2` — stale threat-model comment: "that server is
  unauthenticated" now false for the default case; hardening still
  warranted for adopted servers. Reword.
- `docs/audits/2026-07-28-full-repo-audit.md:362-375` — "Suggested first
  PR batch" all landed in `3b2c9eb` but the report carries no fixed
  marker, so it reads as open work. Fix: one-line addendum at top.

### Security

- `cli.ts:136-137` — mint/persist ordering: spawn before `saveServer`; a
  crash between them leaves a detached password-protected server whose
  password exists nowhere — later runs 401, read it dead, spawn
  duplicates across fallback ports. Fix: persist password before spawn,
  re-save with pid after.
- `server-manager.ts:20-21`, `claude/index.ts:87,120`, copilot log dir —
  log dirs/files created pre-hardening never re-tightened (0755/0644
  survive while collecting prompts); JSON stores got the chmod, log paths
  didn't. Fix: best-effort chmod in `spawnServer`/`ensureRunDir`.
- `ci.yml:21-22` — actions pinned by mutable tag, not SHA; small blast
  radius (no extra secrets), still worth pinning.

### Tests (17 new tests verified genuine: failure semantics spot-checked, hermetic, deterministic; no CRITICAL/HIGH)

- `test/pty-real.test.ts:8-14` — `test.skipIf(!pty)` skips exactly when
  node-pty fails to load, the failure class the test exists to catch; in
  CI a broken native binding is a green (skipped) run. Fix: under
  `process.env.CI`, assert `pty` truthy instead of skipping.
- `test/fix-pty-permissions.test.ts:59-64` — `process.argv` mutation
  restored inline, not in try/finally; an assertion failure leaks the
  fixture path into argv for later tests in the worker. Fix: restore in
  the existing `afterEach`.
- `src/backends/claude/projects.ts:96` — size-only cache invalidation
  branch untested (mtime unchanged, length changed); regression to
  mtime-only keying passes the suite. Fix: one more test step.
- `.github/workflows/ci.yml:30-34` — smoke asserts `--version` only;
  never requires node-pty in the installed tree, so the spawn-helper
  exec-bit (the postinstall's whole purpose, only observable
  post-install) is untested where it matters. Fix: `node -e` requiring
  node-pty and spawning `/bin/true` in the smoke prefix.
- `src/registry.ts:71-73` (+ roster/seen stores) — the 0700 re-tighten is
  now load-bearing (server.json holds a password) but has zero tests; the
  swallowing catch could be dropped invisibly. Fix: pre-create dir 0755,
  save, assert mode 0700.
- `src/cli.ts` password flow — two composite branches uncovered: minted
  password surviving the fallback-port walk, and stored password NOT
  clobbering a user-set env password. Fix: one test each on the existing
  fake-deps harness.
- `test/claude-backend.test.ts:387` — prior hermeticity LOW still stands
  and got worse: the defaulted real `homedir()` now also seeds the
  module-global `scanCache` with real-home entries; file-header comment
  ("home is always a fresh tmp dir") now factually wrong. Fix:
  `home: tmp('home')`.
- Prior suite LOWs all still stand unchanged (real-clock margins, 2.1s
  arm sleep, pressUntil masking, fixed-window negatives) — though the new
  shrink-reset test avoided the fixed-window pattern entirely.

## Security summary

The password mint was the right fix but shipped with four sharp edges,
all in its plumbing rather than its concept: the credential leaks to
dispatched agent processes and the notify hook (M1 — the most important
one, it re-opens the exact door the mint closed), enforcement is never
verified on the spawn path (M2), the in-process ref drops it (H2), and
`server status`/`stop` can't see it (H1). The peek strip needs extending
to permission/question labels in the same component (M3). Everything
else checked clean: stripControl itself is sound (ESC/C0/C1/DEL all
dropped, so no escape introducer survives), store perms correct,
argv/`--` discipline intact, git-safe applied at both git and gh sites.

## Test quality

The 17 new tests are genuine — failure semantics spot-checked, all
hermetic and deterministic, and the new code avoided the suite's old
fixed-window habit. Gaps are all secondary branches: the untested
password composite paths (fallback-port persist, env-wins adopt,
recovery re-entry — the exact paths H2/H1 live in), the size-only cache
invalidation, the load-bearing chmod, and the pty-real skip guard that
greens out on the failure it exists to catch. Prior LOWs unchanged.

## Refactoring map

1. Route the roster-seed loop through `noteBackend` (H3) — one line, and
   makes `noteBackend` the true single chokepoint it was designed as.
2. Return `target` from ensureServer (H2) + adopt password in `runServer`
   (H1) + strip env for dispatch children (M1) + `isAuthEnforced` after
   spawn (M2) — one password-hardening PR touching only cli.ts and the
   two backend spawn sites, with the missing composite-path tests.
3. Inode-keyed tail cursors for claude and copilot (M5) — small, shared
   shape, natural first step of the deferred M8 proc.ts extraction.
4. Deferred refactors from the previous report (app.ts split, proc.ts,
   multi-backend CLI, contract promotions) remain valid and unchanged.

## Suggested first PR batch

1. **Password-plumbing batch:** H1 + H2 + M1 + M2 + M4 + the mint/persist
   ordering Low + the ServerRef consistency fix, with tests for the
   recovery path, fallback-port persist, env-wins adopt, and a
   passworded-server.json `server status`/`stop` test. All one domain,
   one reviewable diff.
2. **Origin batch:** H3 one-liner + restored-from-roster sweep test.
3. **Strip batch:** M3 label stripping + tests.
4. **Cursor batch:** M5 inode reset both adapters + rewrite-larger test.

## Parity verdict

Parity holds. No code gaps to close; the two misses are opencode API
limitations, the twelve partials are documented deliberate choices. The
matrix (`2026-07-28-parity-matrix.md`) is the artifact to re-diff against
future Claude Code changelog entries.
