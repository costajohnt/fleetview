---
type: project-note
status: active
updated: 2026-07-24
tags: [audit, code-review, fleetview, tui, opencode]
aliases: [fleetview audit]
---

# fleetview audit (2026-07-24)

Repo `~/dev/fleetview` @ commit `d825872` (branch `main`; `11b8c8c` / PR #60, a
cosmetic caret fix, merged upstream mid-audit — covered). 4 parallel read-only
review streams (correctness, security, tests, architecture) plus adversarial
verification of every HIGH and the load-bearing MEDs by fresh subagents, and a
direct byte-level probe of ink 7.1.1 to settle the one disputed finding.
Baseline: `npm test` → `Test Files 71 passed (71) / Tests 1537 passed (1537)`;
18,346 tracked lines; no lint script. Overall: a strong, well-tested codebase.
No CRITICAL. One real HIGH (correctness). The rest is hardening and cleanup.

---

## Critical

None.

---

## High

### H1. Peek ↑/↓ navigates from row 0, not the selected row
`src/app.js:691,1368-1381` Two key vocabularies collide. `navigableRows`/roster
arrows set `selectedKey` in group-form (`state:completed:ses_x`), while
`keyOf(row)` (`app.js:684`) rebuilds it from the session's own worktree
(`${row.projectKey}:${id}`). In the default state grouping — and for any
isolated (worktree) session in project grouping — `flat.findIndex(keyOf === selectedKey)`
never matches, so `sel` falls back to 0. First peek ↑ jumps to `flat[0]`, ↓ to
`flat[1]`, regardless of which row you peeked. Verified; test `app.test.js:887`
passes only coincidentally (2 sessions). Secondary symptom: because the peek
handlers write a session-form key back, closing peek resets the roster
highlight to the top. Fix: walk the session entries of `navRows` by their
group-form `key`; drop `flat`/`sel`/`keyOf` from the peek nav path.

---

## Medium

- **M0.** *(downgraded from an initial HIGH after a byte-level ink 7.1.1 probe.)*
  Server-derived text reaches the terminal with escape bytes intact.
  `src/cli-args.js:150` (`formatRow`, via `cli.js:162`) and `src/cli.js:280`
  (`logs`) write session titles/snippets/message text through `console.log` with
  no Ink backstop, so **every** escape class (OSC 52 clipboard, OSC 0/2 title,
  CSI) passes verbatim — the real hole. In the TUI, my probe showed ink 7.1.1
  strips OSC 0/52 and CSI; only **OSC 8** survives (Ink supports hyperlinks), and
  fleetview builds OSC 8 from an unvalidated `pr.url` at `src/ui/peek.js:89`.
  fleetview has no output sanitizer of its own (`app.js:1230,1430` are
  input-side and don't cover the C1 range either). Content is model output, i.e.
  reachable by prompt injection. Fix: strip C0/C1 control bytes and DEL
  in `snippet()` and once on `title` in `publicView` (covers both CLI sinks and
  residual TUI bytes in one place); scheme-check + control-strip the OSC-8 URL.

- **M1.** `src/server-manager.js:43-61` — health probe is liveness-only. If a
  passwordless opencode is already running on the port, setting
  `OPENCODE_SERVER_PASSWORD` is silently ignored (fleetview adopts the existing
  server; the password only applies to a server it spawns), defeating the
  README mitigation with no warning. Verified. Fix: after a health pass with a
  password set, probe once *without* the header and warn if it still returns 200.
- **M2.** `src/registry.js:44` → `src/server-manager.js:17` — `server.json`
  `host` is validated as a type, not as loopback; a planted or legacy
  `~/.config/roost/server.json` can make fleetview spawn the RCE-capable server
  bound to `0.0.0.0`. Fix: reject any host that isn't `127.0.0.1`/`::1`/`localhost`.
- **M3.** `src/server-manager.js:13-14` — server log dir/file created at umask
  defaults while every other state file uses `0o700`/`0o600`; server output
  (prompts, paths, tokens) is world-readable. Fix: `mode: 0o700` / `0o600`.
- **M4.** `src/cli.js:421-431` — `$EDITOR` handoff writes a predictable
  `fleetview-prompt-<pid>.txt` in `/tmp`; `writeFileSync` follows symlinks, so a
  pre-created symlink is a write-through / read-back gadget. Fix:
  `mkdtempSync(join(tmpdir(),'fleetview-'))`.
- **M5.** `src/cli.js:335` — external `SIGINT` isn't bridged, so a `kill -INT`
  (or the pty-host re-raise path) skips `restoreScreen`: the terminal is left in
  the alt screen with mouse reporting on and the cursor hidden. Fix: add
  `SIGINT` to the signal list.
- **M6.** `src/app.js:988-996` — `deleteGroup` reads the render-derived (folded,
  browse-sliced) `groups`, so `^x` on a group header deletes and counts only the
  on-screen subset; folded `… N more` completed sessions and browse rows past 10
  survive, contradicting the "every session in the group" contract. Verified
  (fold case is a pure bug; the filter case is defensible). Fix: resolve the
  group's full session list from the unfolded source.
- **M7.** `src/session-store.js:188-255` — `setSessions` never retires a session
  deleted elsewhere (only `parentID` children); a missed `session.deleted` (e.g.
  during a stream outage) leaves a ghost row until the process restarts. Verified
  and refined: dies on restart, not "forever," so lower urgency. The `app.js:281`
  comment claiming it retires TUI-deleted sessions is false for non-child
  sessions. Fix: sweep this project's non-child records absent from the fresh list.
- **M8.** `src/cli.js:165-417` — `main()` (the `bg` command, `server status/stop`,
  attach loop) has no injection seam and zero coverage. Fix: extract
  `runBg(args, deps)` / `runServer(args, deps)`.
- **M9.** `src/cli.js:31` — `VERSION = '0.0.0'` hardcoded while `header.js:456`
  reads package.json live; the first real release will print the wrong
  `--version`. Fix: read package.json via `createRequire`.
- **M10.** Five "finished statuses" definitions (`app.js:41`, `app.js:93`,
  `header.js:23` accidental copies vs `session-store.js:146`, `cli-args.js:137`
  deliberate). Fix: export one `FINISHED_STATUSES`, comment the two divergent sets.
- **M11.** `src/app.js` (1,569 lines) god component; ref escape hatches are the
  symptom. Fix: extract peek (~250-line unit), then a `useSessionStreams` hook.

## Low (selected)

- **L1.** `src/app.js:709-714` vs `src/cli.js:206-211` — `fleetview bg` roster
  additions are clobbered by a running interactive instance's wholesale
  `persistRoster`. Fix: merge-on-write (re-read + union before saving).
- **L2.** `src/pull-requests.js:120-123,143` — `git`/`gh` run with `cwd` set to
  server-supplied project dirs on every 30s poll; a hostile `.git/config`
  (`core.fsmonitor`/pager/aliases) is code execution. Fix: `GIT_CONFIG_NOSYSTEM`
  + scope to a known-good root.
- **L3.** `src/ui/notify.js:57-67` — notify hook gets `{...process.env}`
  (including `OPENCODE_SERVER_PASSWORD`) plus an untrusted title. Fix: minimal env.
- **L4.** `src/pull-requests.js:183,211,217` — `isOpen`/`mostUrgent`/`prLabel`
  dead since the `#N` row label was removed, kept green only by their tests.
- **L5.** `src/app.js:8` — `headerKey` imported, never used.
- **L6.** `src/client.js:50-67` — session ids interpolated into request paths
  without `encodeURIComponent` (the `directory` param gets it; the path doesn't).
- **L7.** `scripts/fix-pty-permissions.mjs:12-17` — `chmodSync` follows symlinks;
  `lstatSync(...).isFile()` first.
- **L8.** `src/cli.js:239` — `process.kill` on a pid from `server.json` with no
  check it looks like `opencode serve`; a stale/planted pid SIGTERMs an arbitrary
  process.
- **L9.** `src/app.js:1009,1035` — failed-delete rollback mints a bare member,
  dropping `prompt`/`shell`/`pinned`/`rank`; capture and re-insert the removed
  member verbatim.
- **L10.** `src/app.js:721-746` — bell/notify snapshot keyed on rendered `flat`,
  so view/fold toggles fabricate "transitions" and ring the bell. Build the
  snapshot from the store's full set.
- **L11.** `src/app.js:1279-1311` — savedReplies flush can re-send a superseded
  reply (no compare-and-swap on re-add).
- **L12.** `src/app.js:1041-1059` — `^x` flashes `stopped "<title>"` before the
  abort runs and never corrects it on failure.
- **L13.** `src/cli.js:120-151` — serial per-project `listSessions`; `Promise.all`.
- **L14.** `src/cli.js:120-125` — ambiguous id prefix silently resolves to the
  first project's match; collect all and error on >1.
- **L15.** `src/event-mux.js:33-45` — no SSE read-timeout/heartbeat; a half-open
  TCP connection stalls a project up to undici's implicit 300s `bodyTimeout`.
- **L16.** Duplicated infra: `baseDir()`/`setAside()`/atomic-save across
  `registry.js`/`roster-store.js`/`seen-store.js` (×3/×2/×3); three near-identical
  duration formatters (`roster.js:12,32`, `peek.js:289`); `titleBudget`
  reimplemented at `peek.js:179`; `browseGroups`/`projectMemberGroups` same shape.
- **L17.** Stale comments: `app.js:39` and `theme.js:19` narrate the removed `#N`
  label/header-count design; `scripts/smoke.sh:13` stale "roost" comment.
- **L18.** `scripts/preview.mjs:8` — REDUCED_MOTION pins frame 0, so
  animation-only regressions (like #60's blink) never diff in the preview gate;
  document the exclusion.
- **L19.** Tests: `src/text-utils.js` truncation-boundary untested (ZWJ/surrogate
  regression would pass green); `session-store.test.js:881,894` tautology;
  `event-mux.test.js:52-80` wall-clock/prototype-spy flakes; no live-server smoke
  tier behind an env gate.
- **L20.** Stale worktrees: `.claude/worktrees/prfix` (merged as #60) and
  orphaned `issue2-header`.

## Security summary

The README's "unauthenticated server" section is factually accurate on the
mechanics (detached spawn, shell route, auth header applied to REST/SSE/probe)
but insufficient on three points now filed as findings: it doesn't warn that an
already-running passwordless server silently defeats the password (M1), names
only port 4900 when the walk goes to 4910, and frames the risk as inbound-only
while omitting the outbound half — everything the server says is rendered
unsanitized (H2) and decides which dirs `git`/`gh` run in (L2). Clean: no
`shell: true`/`exec` with concatenated strings anywhere; argv arrays throughout;
`worktreeName` reduces prompts to `[a-z0-9-]`; the URL filter never fetches (no
SSRF); default bind is `127.0.0.1`; state files use `0o700`/`0o600`. The real
exposure is trust in server-supplied strings and paths (H2, M1-M3, L2, L8) — the
server is unauthenticated, so "opencode said it" is not a trust boundary.

## Test quality

Unusually strong: every src module except `text-utils.js` has direct tests,
mocks are dependency-injected rather than module-patched, error paths (corrupt
state files, ENOENT ambiguity, auth-on-probe) are covered, and test names match
assertions. Residue: `main()`/`bg` untested (M8), the 20ms-`tick()` idiom is the
flake pattern the file's own comment documents (should be `waitFor`), the
opencode/`gh` contracts are pinned only by hand-verification comments (no
env-gated live tier), and the few L19 flakes/tautologies.

## Refactoring map

1. One `stripControl` in text-utils (ships with H2). 2. `FINISHED_STATUSES`
export (M10). 3. Fold the three stores' `baseDir`/`setAside`/atomic-save into one
`config-file.js` — do it in the same pass that removes the ROOST fallbacks next
release. 4. One `fmtSpan(ms)` for the three duration formatters. 5. Extract peek
from `app.js` (M11), then `useSessionStreams`. 6. Merge
`browseGroups`/`projectMemberGroups` into `repoGroups({membersOnly, cap})`.

## Feature opportunities (ranked)

1. **S** — `fleetview bg --isolate`: reuse `worktree.js`'s pure pieces; closes
   the scripted-dispatch-edits-checkout gap (~10 lines).
2. **S** — filter grammar in `fleetview ls` (`applyFilter`/`parseInput` are pure
   and vocabulary-injected): `fleetview ls s:blocked`.
3. **M** — scrollable peek transcript (peek shows only `messages.slice(-2)`;
   `wrapLines`/`windowLines` already do the viewport math).
4. **M** — user-facing theme setting (`theme.js` was built for it; a `theme` key
   in roster.json is the cheap version).

## Suggested first PR batch

1. **H2** — output sanitizer + OSC-8 URL guard (security, self-contained).
2. **H1** — peek nav key-vocabulary fix (correctness, self-contained).
3. **Server-trust hardening** — M1 (auth-enforcement warn) + M2 (loopback host)
   + M3 (log perms), all "trust the server less."
4. **Local hardening** — M4 (mkdtemp editor) + L7 (postinstall lstat) + L6
   (encode id) + L8 (pid check).
5. **Correctness** — M5 (SIGINT restore) + M6 (deleteGroup full group).
6. **Chore** — M9 (`--version`) + L5 (unused import) + L17 (stale comments).

Bigger items (M7 ghost-row retire, M8/M11 extractions, L1 bg-roster merge, L2
hostile-cwd) are filed as issues for judgment rather than bundled here.
