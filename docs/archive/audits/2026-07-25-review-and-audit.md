---
type: project-note
status: active
updated: 2026-07-25
tags: [audit, code-review, fleetview, tui, opencode]
aliases: [fleetview audit 2026-07-25]
---

# fleetview review + audit (2026-07-25)

Repo `~/dev/fleetview` @ `741acba` (`main`, clean). Full read of all 26 source modules
(5,107 lines) plus the CLI surface, test harness, CI and scripts. Baseline verified
locally rather than assumed: **`npm test` → 25 files / 549 tests, all passing** on Node
22.18, and `npm run preview` produces no diff, so the visual gate is honest.

Every finding below was reproduced against running code — three of them with throwaway
tests written for this pass (recipes included) — rather than reported from inspection.
The previous audit's open items were re-checked against `main` instead of trusted; the
fixed ones are listed at the end so they aren't re-reported.

Overall: still a strong codebase. No CRITICAL, no HIGH. What is left is a cluster of
"derived-from-the-rendered-view" bugs — the same root cause the last audit fixed in one
place and not the other two — plus a `--cwd` flag that doesn't do what it says.

---

## Correctness

### B1 (Medium) — `⇧↑`/`⇧↓` under an active filter silently reorders the whole group

`src/app.js:1186-1204`. The reorder handler resolves the row's group from `groups`
(`src/app.js:674-679`), which is the **rendered** list: filtered by the dispatch input and
folded to the viewport. It then writes `rank: 0..n-1` onto exactly the members it can see
and leaves every other member unranked. Because the group sort is
`(a.rank ?? Infinity) - (b.rank ?? Infinity)` (`src/app.js:632`), "unranked" sorts last —
so the entire filtered subset is promoted above every row that was filtered out, and it is
persisted to `roster.json` immediately.

This is the same bug class as M6 in the 2026-07-24 audit. That one was fixed by having
`deleteGroup` read `unfoldedGroups` (`src/app.js:685-690, 1000-1004`); the reorder handler
was not given the same treatment.

**Failure scenario.** Five sessions in `completed`, ordered `rev one, rev two, done one,
done two, done three`. Type `a:build` to narrow to the three `done` rows, put the cursor on
`done two`, press `⇧↑`. Expected: `done one` and `done two` swap, nothing else moves.
Actual (verified):

    order before: ["rev one","rev two","done one","done two","done three"]
    order after : ["done two","done one","done three","rev one","rev two"]
    persisted ranks: {"c1":1,"c2":0,"c3":2}     // rev one / rev two left unranked

Two sessions the user never touched were pushed to the bottom of the group, and it stuck
across restarts.

**Repro** (drop in `test/`, run `npx vitest run`): render `App` with five roster members
that all land in `completed`, three carrying `agent: 'build'`; `stdin.write('a:build')`,
two `\x1b[B`, then `\x1b[1;2A`; compare the frame's row order before the filter and after
`\x1b` clears it.

**Fix.** Resolve the group and build `order` from `unfoldedGroups`, exactly as
`deleteGroup` does. A tighter version also refuses to rank at all while `activeFilter` is
set, since "move this row within a list you can only partly see" has no honest meaning.

---

### B2 (Medium) — `--cwd` only works with an absolute, fully-resolved path

`src/cli-args.js:142-148` (`underCwd`) and `src/dispatch-target.js:47-53` (`pickTarget`)
both compare the user's `--cwd` against opencode's project paths as raw strings.
`src/cli.js:399` hands `args.cwd ?? process.cwd()` to `App` without resolving it. So a
relative path matches nothing, in silence:

    parseArgs(["ls","--cwd","."])                       → {command:"ls", cwd:"."}
    underCwd("/Users/johncosta/dev/fleetview", ".")     → false
    pickTarget({cwd:".", projects:[/x/alpha,/x/beta]})  → "/x/alpha"   // not the cwd's project

Two user-visible symptoms: `fleetview ls --cwd .` prints `nothing running` however many
sessions are live, and a bare dispatch under `fleetview --cwd .` lands in an arbitrary
project instead of this one. The same applies to any path through a symlink, since
nothing is `realpath`ed.

The comment directly above `underCwd` (`src/cli-args.js:140-141`) promises the opposite:
*"Only sessions at or below `cwd`, so `--cwd .` in a repository means that repository."*
`fleetview bg` is the one command that gets it right — `src/cli.js:206` wraps it in
`realpathSync` — which is what makes the inconsistency a bug rather than a documented
limit.

**Fix.** `realpathSync(args.cwd)` once in `parseArgs`'s caller (or in `main()`), the way
`bg` already does, and fail loudly if it doesn't exist. The README has been updated in the
meantime to state the absolute-path requirement.

---

### B3 (Medium) — the bell and the notify hook fire on view changes, not state changes

`src/app.js:733-758`. The transition snapshot is built from `flat`
(`src/app.js:692`) — the filtered, folded, rendered rows — so any row leaving and
re-entering the view reads as a state transition. `newlyNotable`
(`src/ui/notify.js:74-83`) treats an absent-then-`waiting` key as news by design (that is
what makes a genuinely new block ring), so the round trip rings the bell **and** runs
`FLEETVIEW_NOTIFY_CMD` with `agent_needs_input`.

This is the last audit's L10, still open, now confirmed end to end rather than reasoned
about. Reproduced with `runNotifyHook` mocked: one session blocked on a real permission,
type `s:working`, press `esc`:

    hook events after filter round-trip: ["agent_needs_input"]

Every filter you type and clear re-notifies for every already-blocked session. `^b` into
browse and back does the same.

Same root cause, two more symptoms worth fixing in the same pass: `titleFor(flat)`
(`src/app.js:753`) and `Header sessions: flat` (`src/app.js:1519`) also count only rendered
rows, so the tab title and the header's `N awaiting input` both drop to zero while a filter
is active — the header confidently contradicts the roster.

**Fix.** Build the snapshot and both counts from the full member set
(`byProjectSessions` filtered by `isMember`) before `applyFilter`/`foldCompleted` run.
Notifications are about the world, not about the viewport.

---

### B4 (Low) — `npm test` runs test files inside `.claude/worktrees/`

`vitest.config.js` sets no `exclude`, so vitest's default include glob
(`**/*.{test,spec}.?(c|m)[jt]s?(x)`) walks agent worktrees checked out under
`.claude/worktrees/`. `.gitignore` only lists `node_modules/`, so nothing keeps them out.

Verified by planting `.claude/worktrees/stale/test/ghost.test.js` — vitest collected and
ran it. The consequence is that a local `npm test` silently runs several stale copies of
the suite from abandoned branches, and a broken test in a worktree nobody is using fails
the run.

This also explains the 2026-07-24 report's baseline of "71 test files / 1537 tests": that
was roughly three checkouts' worth of the same suite, not the suite. The real number then
was the same order as today's 25 / 549. CI is unaffected (a fresh checkout has no
worktrees), which is why it went unnoticed.

**Fix.** `exclude: [...configDefaults.exclude, '**/.claude/**']` in `vitest.config.js`, and
add `.claude/` to `.gitignore`.

---

### B5 (Low) — `NaN unpushed commits` reaches the user

`src/worktree.js:124-131`. `ahead` is `Number(git rev-list --count ...)`. The `NaN` case is
handled for the *decision* (`unpushed = true`, correctly refusing to delete) but not for
the *message*, which interpolates the raw value:

    worktreeSafety('/w','/r', run)  →  { removable:false, reason:'NaN unpushed commits' }

It surfaces verbatim in the TUI flash (`src/app.js:977`, `kept the worktree — NaN unpushed
commits`) and in `fleetview rm` (`src/cli.js:324`).

**Fix.** Reuse the existing `'could not read the worktree'` string when `ahead` isn't a
number — that is what actually happened.

---

### B6 (Low) — `package-lock.json` never got the rename

`package-lock.json:2,8,18` still carry `"name": "roost"` and `"bin": {"roost":
"src/cli.js"}`. Harmless with the npm in CI today, but it is the one file the rename
missed, and it will be wrong metadata the moment this is published.

**Fix.** `npm install --package-lock-only` and commit the three-line diff.

---

### B7 (Low) — the supported Node range is unstated and untested

No `engines` field in `package.json`. CI tests exactly one version
(`.github/workflows/ci.yml:19`, Node 22). The README said "Node 20+", but the repo's own
toolchain doesn't run there: vitest 4 → rolldown imports `styleText` from `node:util`,
added in Node **20.12**, so `npm test` on 20.10 dies at startup before a single test runs.

The runtime may well be fine on 20.x — nothing in `src/` obviously needs newer — but
nobody knows, because nothing tests it.

**Fix.** Add `"engines": { "node": ">=20.12" }` and either extend the CI matrix to the
lowest supported version or raise the claim to what CI actually proves. The README now
says 20.12+.

---

## Documentation drift (fixed in this pass)

All of these were wrong against `main` and are corrected in the README:

- **"`fleetview` takes no arguments; running it with any argument just prints a usage
  reminder and exits."** Untrue since the shell surface landed — the same README documents
  `ls`, `attach`, `logs`, `stop`, `rm`, `bg`, `server`, `--cwd` and `--json` ninety lines
  further down. This was the most misleading line in the file.
- **Row glyphs.** README described "`✻` normally, an animated `✽` while it works, `∙` when
  the stream is down". The actual scheme (`src/ui/status-badge.js:10-23`) is `✳` needs
  input, `✻`/`✽` working, `•` settled, `∙` stream down — visible in the README's own
  screenshot, which shows `•` on every completed row.
- **"`tab` applies the highlighted `@` or `/` suggestion."** Nothing is highlighted and
  there is no way to move a selection; `src/app.js:1221-1225` always applies
  `matches[0]`.
- **"To stop the server: kill the pid recorded in `server.json`."** `fleetview server stop`
  has existed since #47.
- **The mascot.** README called it "a small pixel tug". It draws an anchor.
- **`--cwd`** now states the absolute-path requirement (B2).
- Added: an environment-variable table (`FLEETVIEW_CONFIG_DIR`, `FLEETVIEW_STATE_DIR`,
  `FLEETVIEW_LOG_DIR` and `OPENCODE_SERVER_USERNAME` were undocumented) and a short
  Developing section covering `npm test` / `preview` / `shots`.

Still inconsistent in the source, left alone because it is a design question, not a bug:
`src/ui/header.js:31-38` describes the mascot as "a chunky pixel tug … a hull with two
porthole eyes". `MASCOT` (`src/ui/header.js:34-38`) draws neither a hull nor eyes. Either
the art or the comment is stale.

---

## Screenshots

`docs/images/` had three hand-captured PNGs covering the roster, help and a plain peek.
Four surfaces the README describes at length had no picture at all. Added, and made
regenerable rather than hand-captured — `scripts/shots.mjs` renders the **real**
components against fixtures (the same approach as `scripts/preview.mjs`), paints the ANSI
frame into a terminal-styled page and shoots it with headless Chrome:

| Image | Shows |
|---|---|
| `peek-answer.png` | a pending permission with `y`/`a`/`d`, a question as a numbered list, `waiting 4m`, the reply input |
| `groups.png` | full frame: pinned group, a `… 3 more` fold, `completed` collapsed to its header and count |
| `dispatch-suggestions.png` | the `@` completion list, agents and repos distinguished by colour |
| `browse.png` | `^b` browse, project grouping, the state word on the row, `[roster]` membership markers |

`npm run shots -- --shoot` regenerates them, so a UI change can be re-shot instead of
re-staged by hand. One scene was cut during this work rather than shipped: a `filtering`
frame showing the header alongside a narrowed list would have advertised B3 (header counts
follow the filter) as if it were intended behaviour.

---

## Feature opportunities

Ranked by value over effort; each names the seam that already exists.

1. **S — filter grammar in `fleetview ls`.** `parseInput` and `applyFilter`
   (`src/dispatch-parse.js`) are pure and take their vocabulary as an argument, and
   `listSessions` already builds the rows. `fleetview ls s:blocked` / `a:reviewer` is
   mostly wiring, and it makes the "what needs me?" question scriptable — which is the
   question the whole tool exists to answer. (Carried from the last audit; still unbuilt.)
2. **S — `fleetview bg --isolate`.** The TUI puts every dispatch in its own worktree
   because "three agents editing the same working copy" is the failure the tool exists to
   prevent — and then `bg` (`src/cli.js:194-230`) deliberately skips it. Scripted dispatch
   is exactly where an unattended agent edits your checkout unnoticed. `shouldIsolate` /
   `worktreeName` (`src/worktree.js`) are pure and already tested.
3. **M — SSE read timeout / heartbeat.** `src/event-mux.js:39-45` awaits the body forever;
   a half-open TCP connection (laptop sleep, VPN flap) stalls a project silently until
   undici's implicit 300s timeout. The reconnect machinery below it is already correct —
   it just never gets told. A per-chunk deadline that throws into the existing `catch`
   would make the roster self-heal in seconds instead of minutes.
4. **M — scrollable peek transcript.** Peek renders `messages.slice(-2)`
   (`src/ui/peek.js:120`). `wrapLines` and `windowLines` already do the viewport
   arithmetic, so `↑`/`↓` paging the transcript instead of hopping sessions (behind a
   modifier) is a small change to a panel that is currently a two-message keyhole.
5. **M — free-text search.** Filters cover state, agent, PR and URL but not "the session
   about the tokenizer". `applyFilter` has the seam; the store already keeps `title` and
   `snippet`.
6. **S — a lint script.** There is none, so nothing mechanical catches the dead exports
   (`isOpen`/`mostUrgent`/`prLabel`, issue #72) or unused imports that keep turning up in
   audits. `xo` matches the existing style closely enough to adopt with near-zero config.
7. **M — publish to npm.** `package.json` already has `bin`, `files` and a LICENSE; the
   README's install path is still `git clone` + `npm link`. The blockers are version
   `0.0.0` and the private repo, not the packaging.

---

## Previous audit's open items, re-checked against `main`

Confirmed **fixed**: H1 (peek nav vocabulary, #62), M0/H2 (`stripControl` + OSC-8 guard,
#63), M1/M2/M3 (auth-enforcement warning, loopback host, log perms, #64), M4/L6/L7
(mkdtemp editor, encoded ids, `lstat` in postinstall, #65), M5/M6 (SIGINT restore,
`deleteGroup` on the unfolded group, #66), M9/L5/L17-partial (`--version` from
package.json, unused import, some stale comments, #67).

Confirmed **still open** (beyond B1-B7 above): M7/M8/M11 and L1-L4 are tracked as issues
#68-#73. Not tracked anywhere and still true: **L8** — `src/cli.js:255` `process.kill`s a
pid read from `server.json` with no check it belongs to an `opencode serve`, so a stale or
planted pid signals an arbitrary process. **L13** — `src/cli.js:159-167` still lists
projects serially, and `listSessions` re-reads and re-parses `seen.json` once per project
(`src/cli.js:161`). **L14** — an ambiguous session-id prefix still resolves to whichever
project answers first (`src/cli.js:136-141`). **L17** — `scripts/smoke.sh:13` still says
"roost", and `smoke.sh` sends no auth header, so it fails against a
password-protected server.

## Test quality

Unchanged from the last read and still unusually good: dependency injection over module
patching throughout, error paths covered, names that match their assertions. The one new
observation is B4 — the suite you run locally is not the suite CI runs, and hasn't been
for a while.
