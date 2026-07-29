---
type: project-note
status: active
updated: 2026-07-28
tags: [audit, code-review, fleetview, tui, node-pty]
aliases: [fleetview audit]
---

# fleetview audit (2026-07-28)

Repo `~/dev/fleetview` @ commit `180f8b6`, branch `main`. Four parallel
read-only review streams (correctness, security, tests, architecture) plus
an adversarial verify pass on every CRITICAL/HIGH finding. Baseline:
`vitest run` — "Test Files  37 passed (37) / Tests  794 passed (794)";
`tsc --noEmit` clean (exit 0). 29,612 tracked lines. Five prior audits in
`docs/audits/` (latest 2026-07-25); findings below verified against current
code, not inherited.

Addendum 2026-07-28: every batch in "Suggested first PR batch" landed in #130
(squash 3b2c9eb) the same day; line references predate that merge.

---

## Critical

## High

### H1. CI never install-tests the shipped artifact — the exact failure mode that broke 0.2.0
`.github/workflows/ci.yml:26-31` The single `test` job runs `npm ci`,
`typecheck`, vitest (imports `src/*.ts` directly), and `npm run preview`
(which also imports `../src/ui/*.ts`, not dist). Verified nuance: since
dc0617d, `package.json`'s `"prepare": "npm run build"` means `npm ci` does
compile `dist/` — a build-breaking change fails CI — but nothing ever
*executes* the built bin or install-tests the pack. The 0.2.0 failure class
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) only manifests when the
package runs from under `node_modules`, so even `node dist/cli.js --version`
in CI would not have caught it; only a pack-and-install smoke does.
dc0617d's own commit message: "pack contents alone had never been
install-tested." `scripts/smoke.sh` is explicitly manual and tests the
opencode HTTP API, not the artifact. Fix: CI step —
`npm pack && npm i ./fleetview-*.tgz --prefix "$RUNNER_TEMP/x" && "$RUNNER_TEMP/x/node_modules/.bin/fleetview" --version`.

### H2. Claude discovery full-reads every transcript every 500ms
`src/backends/claude/index.ts:267` calls `listTranscripts` unconditionally
inside the `while (!stopped)` events loop (`POLL_MS = 500` at line 30;
`pollMs` injectable only for tests). `listTranscripts`
(`src/backends/claude/projects.ts:65-97`) calls `scan(file)` for every
`.jsonl` in the project dir, and `scan` does
`readFileSync(file, 'utf8')` of the entire transcript
(`projects.ts:34`) — the `includes('"cwd"')` substring checks only skip
`JSON.parse`, not the read. No mtime/size cache exists: the
`statSync().mtimeMs` at `projects.ts:79` feeds only `updatedAt`, never a
skip. Verified aggravations: transcripts belonging to *other* directories
are still full-read before the post-read cwd filter (`projects.ts:87`),
and self-dispatched sessions excluded from tailing (`index.ts:268`) are
still full-read in discovery. Net: N multi-MB transcripts re-read twice
per second for the life of the subscription, while the adjacent `tail()`
path (`index.ts:210-242`) reads only appended bytes. Fix: mtime-keyed
cache in `listTranscripts` (skip `scan()` when mtime unchanged), or run
discovery on a slower tier and let the 500ms loop tail known files only.

### H3. Worktree isolation silently breaks once the repo has any existing worktree
`src/app.ts:1157-1158` passes `client.listWorktrees(target)` — which
returns `Worktree[]` objects (`{name, directory, branch?}`,
`backends/opencode/client.ts:89`, `types.ts:84`, no normalization) —
straight into `worktreeName(text, existing)`, whose
`existing.map((dir) => dir.slice(dir.lastIndexOf('/') + 1))`
(`worktree.ts:95`) throws `TypeError: dir.slice is not a function` on the
first object. The throw lands in the deliberately-silent isolation catch
(`app.ts:1166-1172`, framed as "server too old / refuses"), so dispatch
proceeds with `worktree = target` — unisolated in the shared checkout,
the exact failure isolation exists to prevent — with only a "not
isolated" flash. Verified: `client: any` (`app.ts:132`, `TODO(types)`)
hides the mismatch from tsc, and the only test mocks `listWorktrees` as
`[]` (`test/app.test.ts:2328`), the one input that can't trigger it. First
isolation into a fresh repo works; every dispatch after that throws and
falls back. Fix: `existing.map((w) => w.directory)` at the call site, plus
a non-empty-list test.

### H4. opencode's status seed sweeps running claude/copilot rows to "completed"
`src/session-store.ts:628-633` — the absent-from-map sweep in
`seedStatuses` matches on `r.projectKey === projectKey` alone;
`SessionRecord` carries no backend field (store is deliberately
backend-blind per `backend-normalise.ts:1-12`). Claude/copilot rows share
the directory-string projectKey with opencode rows (`app.ts:526,542`) but
never appear in opencode's `GET /session/status` payload, and their
`statusSeq` was stamped once at `busy` (`session-store.ts:381`) — long
before the poll's `mark` (`app.ts:393`) — so the `statusSeq >= mark` guard
fails and the sweep sets `lastStatus='idle'` and (with `closeRuns:true`
from the periodic `chainSeed` at `app.ts:618-624`) closes the run span.
Neither normaliser re-emits while its own fold status is unchanged
(`backend-normalise.ts:134,153`), so nothing repairs it: a running
`@claude` session in any opencode-tracked repo flips to "completed"
within one 30s poll tick while still working, with a wrong short
`ranForMs`. Verified refinement: the `relist:true` half of the tick is
safe (backend rows never get `listed` armed, `session-store.ts:326,356-360`)
— only status is falsified, the row survives. Fix: scope the sweep to
opencode-sourced records (backend tag on the record, or sweep only rows
the opencode relist has `listed`).

## Medium

- **M1.** Real node-pty exercised nowhere — every PTY test runs against a
  hand-rolled fake (`test/pty-host.test.ts:8-24`; `vi.mock('node-pty', ...)`
  in `test/cli-attach.test.ts:6`, `test/cli-attach-exit.test.ts:5`).
  `attachPty` is DI-first, so the real integration surface (native binding
  load, spawn-helper execution, raw-mode/resize on a real pty) is validated
  only by manual use — and the spawn-helper permission bug this package
  works around lives exactly there. Fix: one CI-only integration test that
  `pty.spawn`s `printf` via real node-pty and asserts output/exit.
  (unverified)
- **M2.** `scripts/fix-pty-permissions.mjs` — the postinstall that runs on
  every user install — has zero tests (`scripts/fix-pty-permissions.mjs:11`).
  Lives outside the vitest include glob, so nothing covers its
  layout-dependent path arithmetic (dev checkout vs hoisted vs global
  install) or its symlink/EACCES branches. Fix: test that builds a fake
  `node_modules/node-pty/prebuilds` tree in tmp and asserts exec bit set,
  symlinks skipped, EACCES warns without throwing. (unverified)

- **M3.** `src/app.ts` is a 1,803-line god component (`app.ts:154-1791`) —
  verified: 54 hook calls, 4 `useInput` handlers, all-`any` props type
  (`app.ts:130-152`, flagged `TODO(types)` at lines 26/129). Every feature
  phase landed as closures inside `App`; `use-peek.ts` proves the
  extraction seam works but nothing else followed. Downgraded from HIGH on
  verify: no runtime defect, `any` debt is deliberate/documented, and
  `test/app.test.ts` (3,161 lines) covers behavior. Real seams: the mount
  effect (`app.ts:344-665`) and dispatch (`app.ts:1063-1288`) — both close
  over ~a dozen pieces of App state, so extraction is real work. Fix:
  extract `useProjectStreams` and `useDispatch` hooks first.
- **M4.** Backend abstraction bifurcated: opencode bypasses its own adapter
  in App — `app.ts:216-228` (`backendFor` returns `null` for opencode;
  fallback to `client.*`), direct `client.forkSession`/`renameSession`/
  `promptAsync` at `app.ts:1248,1699`, `use-peek.ts:121,151`. The adapter
  contract is exercised only by minority backends. Fix: route opencode
  verbs through `backendRegistry.opencode` (adapter is a one-line
  delegation to the same client methods). (unverified)
- **M5.** CLI subcommands opencode-only while roster is multi-backend —
  `cli.ts:299-310` (`matchSessions` searches only opencode), `cli.ts:403`
  (attach hardcodes `createOpencodeBackend`), `cli.ts:346-379` (ls/--json
  opencode-only); claude/copilot rows visible in TUI answer "no session
  matching" to `fleetview attach/ls/stop/rm`. Fix: fold
  `backend.listSessions` + normalisers into `matchSessions`; take argv from
  `backends[name].attach()`. (unverified)
- **M6.** `fork` capability flag has no contract method — `types.ts:141`,
  `backends/claude/index.ts:21`, `app.ts:1248` calls `client.forkSession`
  directly; claude stuck `fork:false` despite CLI support. Fix: add
  `fork(id, directory)` to `Backend`. (unverified)
- **M7.** Copilot log dir never reaped; claude's is —
  `backends/copilot/index.ts:70,204-206` vs claude's `reap()`/
  `KEEP_RUNS_MS` (`backends/claude/index.ts:92-113`). Retention fix applied
  where reported, not to the sibling with identical shape. Fix: port
  mtime-cutoff reap into copilot dispatch. (unverified)
- **M8.** Process-backend machinery triplicated across claude/copilot
  adapters — spawn-with-synthetic-failure-line, offset/decoder/rest file
  cursor, pid-guarded group SIGTERM each exist twice with already-divergent
  behavior (`backends/claude/index.ts:118-155,210-242,301-333` vs
  `backends/copilot/index.ts:87-123,188-250,275-317`). A third
  process-backed backend mints a third copy. Fix: extract
  `src/backends/proc.ts` (`spawnLogged`, reset-aware `tailFile`,
  `verifiedGroupKill`). (unverified)
- **M9.** Peek says "unsupported" for process backends though both
  transcript readers already exist — `use-peek.ts:78-81`; contract omission
  (`types.ts:183-201` has no message-read), while claude `scan()` and
  copilot events fold already parse message text. Fix: optional
  `listMessages?(ref)` on `Backend`. (unverified)
- **M10.** Copilot `deniedTools` counted and emitted but consumed nowhere —
  `backends/copilot/events.ts:47,103-105`, emitted
  `backends/copilot/index.ts:235-248`, normaliser never reads it
  (`backend-normalise.ts:142-161`). Fix: surface it ("N tools denied,
  attach to approve") or delete the field. (unverified)

- **M11.** (security) Default opencode server is an unauthenticated
  localhost RCE surface that fleetview spawns detached and leaves running —
  `cli.ts:120` (`ensureServer`), `backends/opencode/server-manager.ts:24-28`,
  `backends/opencode/client.ts:7-16`. Server exposes
  `POST /session/:id/shell`; `OPENCODE_SERVER_PASSWORD` opt-in, off by
  default; `detached:true` + `unref()` means the endpoint outlives the TUI.
  Root cause: opencode's "trusted localhost" model inherited, but fleetview
  escalates it from tool-lifetime to persistent. Fix: generate a random
  `OPENCODE_SERVER_PASSWORD` by default for servers fleetview spawns
  (header already plumbed), and/or reap the server on TUI exit. (unverified)
- **M12.** (security) Peek renders untrusted message bodies without
  `stripControl`; Ink passes DCS and OSC-8 through — `ui/peek.ts:12`
  (`messageText`, no strip) rendered at `ui/peek.ts:218`; contrast
  `session-store.ts:96,216` which strip titles/snippets. Reviewer verified
  experimentally against pinned `@alcalzone/ansi-tokenize` (Ink 7.1.1): it
  strips OSC 0/52/CSI but passes DCS (`ESC P … ESC \`) and OSC-8
  hyperlinks unchanged — a model reply can render a spoofed clickable link
  or send DCS bytes to the terminal. Fix: run peek `messageText` through
  `stripControl` like roster snippets.

- **M13.** Pending-list reseed deletes the synthetic claude/copilot
  "needs input" permission — `session-store.ts:645-649` (`seedPermissions`
  authoritative delete; same for `seedQuestions`) vs
  `backend-normalise.ts:73-88` (synthetic `${sessionID}:denied` entry).
  Reseed treats opencode's `GET /permission` as full project truth; the
  synthetic entry is never in that response and its `__seq` predates the
  mark, so any `pending:true` seed (mount, stream `onOnline` flap) deletes
  it and the normaliser won't re-emit while fold status stays
  `needs-input`. Row degrades to "completed" for a run a human still has
  to unblock. Fix: exempt synthetic-key entries or scope the delete to
  opencode-origin rows. (unverified)
- **M14.** `worktreeSafety` approves deleting unpushed commits when the
  parent repo is on a detached HEAD — `worktree.ts:124-132`. With no
  upstream, `base` comes from parent `rev-parse --abbrev-ref HEAD`, which
  on detached HEAD returns literal `"HEAD"`; resolved in the worktree's
  own context that yields `rev-list --count HEAD..HEAD` = 0 →
  `removable:true`, so `^x^x`/`fleetview rm` deletes commits existing
  nowhere else. `branchOf` (`pull-requests.ts:169`) explicitly refuses this
  sentinel; this path accepts it. Fix: treat `base === 'HEAD'` as no-base
  (`removable:false`). (unverified)
- **M15.** (still open from 2026-07-25 audit, B1) Shift+↑/↓ reorder
  resolves its group from rendered/folded `groups` (`app.ts:1561`), not
  `unfoldedGroups` — reordering under a filter promotes the filtered
  subset and persists wrong ranks. (unverified)
- **M16.** (still open from 2026-07-25 audit, B2) Relative `--cwd` never
  resolved — `cli.ts:563` passes `args.cwd` raw while `cli-args.ts:187-189`
  promises `--cwd .` works; only `bg` realpaths. (unverified)

## Low (selected)

- `test/claude-backend.test.ts:364` — hermeticity break: direct
  `createClaudeBackend({ runDir, spawnImpl })` omits `home`, defaulting to
  the developer's real `~/.claude` (`src/backends/claude/index.ts:44`);
  silently readdirs real transcripts every poll. Fix: add `home: tmp('home')`.
- `test/session-store.test.ts:945-957, 984-992` — real-clock duration
  assertions with tight margins (`ranForMs < 30` after a 40ms sleep);
  `createStore()` hardcodes `Date.now()` with no clock injection, so a
  30ms event-loop stall fails them spuriously. Fix: injectable `now`.
- `test/group-headers.test.ts:142` — 2.1s real sleep to expire the
  delete-arm window; window constant not injectable. Fix: inject arm window.
- `test/app.test.ts:87-95` — `pressUntil` retry loop makes first-keypress
  delivery unassertable; a genuine swallowed-keypress regression converges
  on the Nth press and stays green. Fix: Node-version-gated single-press
  test (skip on 24, run on 26+).
- `test/group-headers.test.ts:156-162` (and similar in `test/app.test.ts`)
  — negative assertions after a fixed 20ms `tick()` can't reliably fail;
  the suite's own poll-the-positive doctrine wasn't applied to negatives.
  Fix: pair the negative with a positive sentinel proving the pipeline
  flushed.
- `src/backends/claude/projects.ts:16,54,93` — dead field
  `ClaudeTranscript.entrypoint`: scanned per line of every transcript, zero
  consumers. Deleting it also cheapens H2's hot loop.
- `src/backends/claude/stream.ts:26-27,109-110` — dead fields
  `costUsd`/`durationMs` parsed from `result`, never read outside the
  reducer. Drop, or surface cost in peek's header for claude rows.
- `src/backends/claude/stream.ts:116` — `reduceRun` exported from
  production code, consumed only by tests.
- `src/backends/claude/index.ts:219` — claude tail can't recover from a
  shrunk/rewritten transcript (`if (size <= cursor.offset) return`);
  copilot has an explicit `reset` path (`copilot/index.ts:217-226,353-355`).
  A compacted/rewritten transcript freezes that session's tail permanently.
  Falls out of M8's shared `tailFile()`.
- `registry.ts:8-11` / `roster-store.ts:7-11` / `seen-store.ts:6-10` —
  `baseDir()` triplicated; `setAside` duplicated; pid-tmp+rename atomic
  write ritual ×4. One `store-io.ts` ends the synchronized-edit tax.
- `src/seen-store.ts:16` — `SeenEntry` type drifted from persisted shape:
  `session-store.ts:567` writes `stopped`, type lacks it (hidden by
  `Record<string, any>`).
- `src/app.ts:94-96` — stale comment (references removed
  `addSession/removeSession`) and `OPENCODE_CAPABILITIES` literal
  hand-copied in three places (adapter, app.ts, `use-peek.ts:34`).
- (security) `src/git-safe.ts:20-27` — hostile-repo-config hardening is a
  hand-enumerated 3-key allowlist (`core.fsmonitor`, `core.hooksPath`,
  `core.pager`); a future git/gh key that executes commands silently
  reopens the hole. Fix: regression test pinning the assumption; consider
  `GIT_CONFIG_GLOBAL=/dev/null` scoping.
- (security) `roster-store.ts:49-53`, `seen-store.ts:58-62`,
  `registry.ts:67-77` — tmp-file writes follow symlinks, predictable
  names; dir perms 0700 applied only on creation, never re-tightened.
  Fix: `chmod` 0700 on each save or `O_EXCL` tmp open.
- (security, info) prompts and any server-printed tokens persist plaintext
  under `~/.config`/`~/.local/state` (`server-manager.ts:19-22`, roster,
  run logs). Mitigated by 0600/0700 modes; flagged as a conscious choice.
- `src/app.ts:82` — fold protection for failure/open-PR rows breaks under
  manual ranks: group sort (`app.ts:813-816`) puts `rank` above
  protection, so a Shift+↑ ranked success can fold a protected row away.
  Fix: partition protected rows before slicing.
- `src/cli.ts:618-620` — `^g` with no `$EDITOR` is a silent no-op:
  `editPrompt` is async so it always returns a promise, and App's
  `flash('no $EDITOR configured')` (`app.ts:1549`) fires only on a
  non-thenable return. Fix: resolve a distinguishable `{noEditor:true}`.
- `src/dispatch-parse.ts:148` — slash-command suggestions offered
  mid-prompt where they can never execute (`parseInput` only honors a
  leading `/`, line 70); tab-completing embeds a literal `/command` in the
  dispatched text. Fix: offer the `/` pool only at position 0.
- (still open, 2026-07-25 B5) `worktree.ts:132-137` — `NaN unpushed
  commits` reaches the user when `ahead` isn't numeric.
- (still open, known L17) `scripts/smoke.sh` sends no auth header; fails
  against a password-protected server.

## Security summary

No command injection, no `pull_request_target`, no shell-interpolated
untrusted input anywhere — all process spawns use array argv with
`--`-terminated prompts, path-traversal guards cover copilot ids and
claude project encoding, and the prior audit's pid-kill issue is closed
(pid verified as `opencode serve` before SIGTERM). The two real exposures
are M11 (fleetview turns opencode's unauthenticated localhost RCE surface
from tool-lifetime into persistent by spawning it detached with the
password mitigation defaulted off) and M12 (peek renders agent-controlled
message bodies without `stripControl`, and Ink's tokenizer passes DCS and
OSC-8 through — a prompt-injection-to-terminal-escape path). The git-safe
hardening is genuinely good but is a hand-enumerated allowlist (Low);
state-file perms are correct at creation but never re-tightened (Low).

## Test quality

Unusually strong suite: 794 tests, dependency injection over module
patching, real git repos for worktree safety including a live
hostile-repo exploit test, fake timers where they matter, documented
deflaking doctrine, zero `.only`/`.skip`, no tautological assert-on-mock
patterns. Only `git-safe.ts`, `use-peek.ts`, and `types.ts` lack direct
test files, and all are covered indirectly. The gaps, in priority order:

1. Nothing install-tests the shipped artifact (H1) — the one class of
   failure that has actually shipped broken (0.2.0).
2. Real node-pty is exercised nowhere (M1); the spawn-helper permission
   bug this package exists to work around lives on that untested surface.
3. `scripts/fix-pty-permissions.mjs`, the postinstall every user runs,
   has zero tests (M2).
4. The `client: any` boundary let H3 (a `TypeError` on the happy path)
   through both tsc and a suite whose only `listWorktrees` mock returns
   `[]` — type the App props or add one non-empty-worktree test.
5. Minor determinism debt: real-clock margins, one 2.1s sleep, fixed-window
   negatives, one hermeticity break (Lows above).

## Refactoring map

Sequenced smallest/highest-payoff first:

1. **Type the App/client boundary** (`app.ts:129-152`) — the `any` props
   directly caused H3 and hide future contract drift. One session of work,
   prevents a bug class.
2. **`store-io.ts`** — merge the ×3 `baseDir()`, ×2 `setAside`, ×4
   atomic-write copies (Low). Mechanical, unblocks perms fixes in one place.
3. **`backends/proc.ts`** (M8) — extract `spawnLogged`, reset-aware
   `tailFile`, `verifiedGroupKill` from the claude/copilot twins. Fixes the
   claude shrunk-file freeze (Low) and copilot reap gap (M7) as
   side effects, and makes a codex/gemini backend ~150 lines.
4. **Backend origin tag on `SessionRecord`** — the root-cause fix shared
   by H4 and M13 (both are project-scoped reseeds deleting
   backend-sourced state). One field, two confirmed bugs closed.
5. **Unify opencode behind its adapter** (M4) + multi-backend CLI (M5) +
   `fork`/`listMessages` contract promotions (M6, M9). This is the
   remaining half of the #100 migration.
6. **Split `app.ts`** (M3) — extract `useProjectStreams` (344-665) and
   `useDispatch` (1063-1288) after 1 and 4 land; both close over ~a dozen
   pieces of state, so do it last, not first.

## Feature opportunities (ranked)

1. **(S) Cost/duration in peek header for claude rows** — `total_cost_usd`
   and `duration_ms` are already parsed per run (`stream.ts:26-27`) and
   currently dead; surfacing them deletes dead code by using it.
2. **(S) "N tools denied — attach to approve" line for copilot rows** —
   `deniedTools` already counted and emitted (M10), consumed nowhere.
3. **(M) Multi-backend `fleetview ls/attach/stop/rm`** (M5) — registry,
   normalisers, and per-backend `attach()` argv all exist; this is wiring.
4. **(M) Peek for claude/copilot sessions** (M9) — both transcript readers
   exist in-tree; add `listMessages?` to the contract.
5. **(L) Fourth process-backed backend (codex/gemini)** — honest after the
   `proc.ts` extraction; today it means a third hand-copy.

## Suggested first PR batch

1. **Correctness batch (small, high-value):** H3 one-liner
   (`existing.map((w) => w.directory)`) + non-empty worktree test; H4/M13
   backend-tag scoping of `seedStatuses`/`seedPermissions` sweeps; M14
   `base === 'HEAD'` guard. Fixes every confirmed
   wrong-behavior bug in one reviewable diff.
2. **CI batch:** H1 pack-and-install smoke step + M1 one real node-pty
   spawn test (CI-only) + M2 postinstall test. Three small additions to
   `ci.yml`/`test/`, closes the shipped-broken class.
3. **Security batch:** M12 `stripControl` in peek (one line) + M11 default
   `OPENCODE_SERVER_PASSWORD` for spawned servers.
4. **Perf:** H2 mtime-keyed `scan()` cache, deleting the dead `entrypoint`
   field in the same diff.
