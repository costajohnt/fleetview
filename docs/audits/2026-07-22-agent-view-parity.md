# roost vs Claude Code agent view — parity audit (2026-07-22)

Reference: <https://code.claude.com/docs/en/agent-view>, full page read 2026-07-22. Judged against
`f61894f` plus the Tab-on-empty-input commit. Supersedes `2026-07-21-agent-view-parity.md`, which
predates the rebuild and whose "explicitly don't build" list this work deliberately reverses.

Verified live against opencode 1.18.4 where it says "verified": roost driven inside a real PTY,
against a real `opencode serve`, with its OpenAPI document read for every wire shape.

## 1. The loop

| Agent view | roost | |
|---|---|---|
| Input at the bottom, always focused; type and press Enter to dispatch | same | ✅ verified live |
| Every prompt starts its own session, not a follow-up | same | ✅ |
| Enter attaches the selected session, or dispatches when the input holds text | same | ✅ |
| Shift+Enter dispatches and attaches | same, plus Alt+Enter, because `key.shift` only survives on terminals with extended key reporting | ✅ |
| Space peeks; ↑↓ move | same | ✅ verified live |
| Enter/→ attaches; the session takes over the terminal | same, via a child PTY | ✅ verified live |
| Detaching returns to a live list, never stops the session | same, on `ctrl+z` | ✅ verified live |
| List spans every project by default | same (roost always did) | ✅ verified live: 7 sessions across 4 projects |

## 2. Rows and state

| Agent view | roost | |
|---|---|---|
| Icon + name + summary + age | same | ✅ verified live |
| No directory on the row in state grouping | same — the per-row project label was deleted | ✅ |
| Colour = state, across six states | same six: working, needs input, idle, completed, failed, stopped | ✅ |
| Shape = process liveness (`✻` alive, animated `✽`, `∙` exited) | `✻`/`✽`/`∙`, where `∙` means the project's event stream is down — opencode has no per-session worker to die | ⚠️ closest available meaning |
| `✢` sleeping `/loop` session | no opencode equivalent | ⭕ n/a |
| Animation, off under `prefersReducedMotion` | same, off under `ROOST_REDUCED_MOTION=1`, and off entirely when nothing is working | ✅ |
| Age counts from creation, freezes at run duration | same | ✅ |
| Name written by a Haiku-class model | opencode names sessions itself ~20s in, from the first prompt, using its own small model. roost shows the typed prompt until then | ✅ verified live: became "Asking for ok reply" |
| Summary written by a Haiku-class model at turn end | roost uses the streamed last output, which is agent view's own between-turn behaviour | ⚠️ see §6 |
| Summary refreshes ≤ every 15s without a model request | same, from the stream | ✅ |
| State word prefixes the summary in directory grouping | same | ✅ |
| `#1234` PR label, coloured by status | same: `#1234` / `N PRs` at the row's right edge, coloured yellow/green/purple/grey by `prStatus`. Not hyperlinked (no OSC 8 helper; peek carries the URL) | ✅ verified live 2026-07-23: a real merged PR rendered `#5` in magenta (ANSI 35) on a live opencode session. Colour *transitions* on CI still unwatched — needs an open PR |

## 3. Organising

| Agent view | roost | |
|---|---|---|
| Groups: Pinned, Ready for review, Needs input, Working, Completed | four of five: `Ready for review` = has an open PR, slotted above `needs input`, with group assignment first-match-wins so a waiting+PR session appears once. Pinning was dropped with the move to always-rendered fixed groups | ✅ verified live 2026-07-24: a session on a branch with an open PR rendered under `ready for review` |
| Completed collects finished + failed + stopped | same | ✅ |
| Completed folds to `… N more`; failures never fold | same — failures sort to the front so the fold can only eat successes | ✅ |
| Ctrl+S switches state ↔ directory grouping, persisted | same | ✅ |
| Ctrl+T pins to the top and keeps the process alive | ordering only; opencode's one server never reaps sessions, so the keep-alive half has nothing to do | ⚠️ half is n/a |
| Ctrl+R renames | same | ✅ |
| Ctrl+X stops, again within 2s to delete | same. The arm is keyed on the session, not the row, so a reorder mid-arm re-arms instead of deleting the wrong one | ✅ |
| Ctrl+X on a group header deletes the group | same, with the two-press arm as the confirmation | ✅ |
| Shift+↑↓ reorders within a group | not built — needs a persisted manual order that would fight the recency sort; headers being selectable is the prerequisite and is now done | ❌ |
| Enter on a group header collapses it | same, and the collapsed set is persisted in `roster.json` | ✅ |
| Deleting removes Claude's worktree, with refusal rules | same: `^x^x` removes it and any uncommitted changes, and refuses when the branch holds commits that exist nowhere else | ✅ verified live |
| `/resume` picker brings a session back | browse (`^b`) already lists every session opencode knows, across projects, and `^a` adopts one — the same capability behind a different key. Agent view's picker also restores *deleted* sessions; opencode has no restore route (checked: no undelete/restore endpoint exists), so that half is impossible rather than unbuilt | ⚠️ different door |

## 4. Peek

| Agent view | roost | |
|---|---|---|
| Space opens/closes the panel | same | ✅ |
| Shows the question, the result, or the status sentence | same | ✅ |
| Reply input; Enter sends without attaching | same | ✅ |
| Numbered choices, answerable with a number key | same. Wire shape verified: `QuestionInfo` is `{question, header, options:[{label, description}]}`, and the reply is one answer array per question | ✅ |
| Permission prompts answerable inline | y / a / d — structured rather than agent view's typed reply | ⚠️ roost is stricter |
| `!` prefix runs a Bash command | same, via `POST /session/:id/shell` | ✅ |
| Tab fills a suggested reply | same, with the session's own first option — the only reply roost can suggest honestly | ✅ |
| Undeliverable replies are saved and sent later | same, retried on the project poll; `!` shell replies are deliberately not saved | ✅ |
| `waiting 3m` timer | same, from the oldest outstanding request — and absent for the prose heuristic, which has no moment it began | ✅ |
| Linked pull requests listed | same: peek lists every linked PR with its status and URL, one per line, and shows the `gh` failure reason (scoped to this session's repo) when there is no data | ✅ verified live 2026-07-23: peek on a real session showed `#5 merged · https://github.com/costajohnt/sandbox/pull/5` |
| ↑↓ peek neighbours, → attaches | same | ✅ |

## 5. Dispatch grammar

| Agent view | roost | |
|---|---|---|
| `@repo` targets a directory | same. Completions are projects with sessions plus git repos one level below the launch directory, skipping names with spaces | ✅ verified live |
| `@agent`, or a bare first word, selects a subagent | same, with the subagent winning a name clash | ✅ verified live |
| `/command` sent as the session's first prompt | same | ✅ |
| `! cmd` runs a shell job | same | ✅ |
| `#1234` / URL selects the PR's session | same, as a filter: `#N` or a GitHub PR URL narrows the roster to the session working on that PR. Agent view defines this as a filter, so filtering to the one row is the selector | ✅ verified live 2026-07-23: typing `#5` narrowed a 9-session roster to the 3 on that PR's branch |
| `a:` and `s:` filters, including `s:blocked` | same, accepting both roost's keys and agent view's words | ✅ |
| `/exit`, `/quit` close the view | same | ✅ |
| `/model <name>` sets the dispatch model for this run | same, as `provider/model`; `/model default` clears it | ✅ |
| `/login`, `/logout` | n/a — opencode owns auth | ⭕ |
| Tab browses subagents on an empty input, else applies the suggestion | same | ✅ |
| Header shows model, directory, and a summary count | same | ✅ verified live |
| Default target is the launch directory | same, falling back to the selected row's project, then the most recent, and it now says which it chose | ✅ |
| Directory grouping makes the highlighted row's directory the target | same | ✅ |
| Ctrl+J inserts a newline | same; the prompt is multi-line and the parser keeps its shape | ✅ |
| Ctrl+G opens `$EDITOR` | same, via `$VISUAL`/`$EDITOR` and a temp file, with the render gate closed for the handover | ✅ |
| Image paste, pasted-text collapsing | pasted-text collapsing built (>800 chars or >2 lines → `[Pasted text #N]`, restored on dispatch). Images are **not** blocked by opencode as previously recorded here — `prompt_async` accepts a `file` part (`{mime, url, filename?}`), so an image is sendable. The blocker is the terminal: a pasted image does not reach a TUI's stdin as data | ⚠️ half |

## 6a. Known limits found by review (2026-07-23)

Seven rounds of independent review ran over this after the parity work. Two limits are worth
recording because they are properties of the setup rather than bugs to fix:

**`alt+1..9` is best-effort.** A real `alt+1` and an Escape followed by a `1` are byte-identical;
only arrival timing separates them, and a laggy link that stalls and then flushes delivers both in
one read with the timing gone. A lone trailing Escape is held 40ms to catch the split case, which
helps locally and cannot help over SSH. `ROOST_NO_ALT_SWITCH=1` disables the chord. `ctrl+z` detach
is a single byte and unambiguous everywhere.

**The `?` heuristic is a guess and is treated as one.** A session whose last line ends in a question
mark sorts into `needs input`, but it does not ring the bell or add to the terminal tab title's
count — those follow `pendingRequest`, which is true only for a permission or question the server
actually reported. This is the split that keeps a guess from interrupting the user.

## 6. Deliberate gaps

**`←` on an empty prompt does not detach.** Agent view *is* the session, so it knows whether its
prompt is empty. roost sits in front of opencode's TUI and cannot tell, so `←` is forwarded like any
other key and detaching is Ctrl+Z, which agent view also documents. Alt+1..9 works.

**Model-written row summaries.** opencode exposes no non-mutating completion endpoint.
`POST /session/:id/summarize` compacts the real conversation, and `POST /session/:id/message` writes
into it — either would alter the user's transcript to decorate a row. The alternative, a hidden
scratch session per summary, is a lot of machinery for text the streamed output already carries. The
naming half of this, which matters more, is fully covered by opencode's own auto-naming.

**Worktree isolation — built (2026-07-23), no longer a gap.** Every dispatch now runs in its own
worktree, created before the session exists, via `POST /experimental/worktree`. Rows still group by
repository; the worktree is never shown. `^x^x` removes it along with uncommitted changes and
refuses when the branch holds commits that exist nowhere else. The skip rules match agent view's:
not a git repository, already a linked worktree, or a server without the endpoint (which falls back
to the repository and says so on the dispatch line).

Two things worth recording. `GET /project` publishes each worktree as a project of its own *and*
lists it in its repository's `sandboxes` array, which is the entire parent↔worktree mapping — roost
keeps no bookkeeping of its own. And `DELETE /experimental/worktree` enforces nothing: it removes a
worktree holding uncommitted changes, and its branch, without complaint (verified by losing a file
to it), so every refusal rule lives in roost.

**Pull request awareness.** The `#1234` label, the `Ready for review` group, PR-coloured status, and
the `#N`/URL filters are one feature wearing four hats. All of it needs `gh` plumbing roost doesn't
have.

**CLI surface — built (2026-07-23).** `roost --cwd`, `--json`, `ls`, `attach`, `logs`, `stop`, `rm`,
`--help`. States are translated to agent view's vocabulary (`working`/`blocked`/`failed`) so a script
written against one works against the other, `cwd` reports the repository with the worktree beside
it, and `rm` keeps a worktree holding commits that exist nowhere else. `daemon status` has no
analogue: roost's server is one `opencode serve`, not a supervisor with workers.

## 7. Where roost differs on purpose

- **Browse (`^b`) and roster membership (`^a`).** opencode tracks every project in one database, so
  sessions started outside roost — including from opencode's own TUI — exist and are worth adopting.
  Agent view has no equivalent because a Claude Code session is only listed once backgrounded.
- **Permissions answered with y/a/d** rather than a typed reply: opencode's permission requests are
  structured, so the structured answer is the honest UI.
- **Server resilience.** Port fallback, respawn, per-project offline flags, and SSE backoff have no
  agent-view counterpart; roost talks to a server it doesn't own.

## 8. Verified live, not just unit-tested

- roost driven inside a real PTY: boot, browse (7 real sessions across 4 projects), `?` help, `@`
  completion listing real agents and repos, and a real dispatch that reached `working` and then
  `completed`.
- opencode auto-naming: a session created without a title became "Reply with single word ok"; an
  identical session created *with* a title kept it for 48s+. This is why roost stopped sending one.
- The `failed` state came from a genuine `session.error`; a healthy dispatch emits none, checked by
  capturing `/event` during a clean run.
- node-pty against a real child: suspend/resume ordering, output, and the write gate.
- **The whole attach loop, driven end to end**: browse, Enter, opencode's real TUI drawing in
  place, `ctrl+z`, and roost repainting its roster. This caught two bugs the suite could not:
  `cli.js` never returned the attach promise, so App took its unmount fallback instead of
  suspending; and Ink skips writing a frame identical to its last, so after the attached session
  cleared the screen roost came back to a blank terminal until `instance.clear()` dropped that
  memory. Both are fixed and re-verified.
- Attaching to a session whose worktree has been deleted: `opencode attach --dir` exits 1 with no
  output, which used to look exactly like a keypress that didn't register. roost now says
  `couldn't attach: <path> no longer exists`.
- The tab title actually reaching the terminal (`ESC ]0;roost BEL`) with the rendered frame
  intact. Worth noting why this mattered: the notification module was fully unit-tested while
  `app.js` never called it, because the edit that wired it up had failed silently. A green suite
  said nothing about it; driving the real binary is what caught it.
- `spawn-helper` ships from npm without its executable bit, which fails every spawn with
  `posix_spawnp failed`; a postinstall step fixes it.

## 9. Claims re-verified live (2026-07-22, after review round 1)

An independent review found the `a:` filter had been marked ✅ while completely broken — the App
never passed the agent accessor, so it matched nothing and blanked the roster. The unit test passed
because it injected its own accessor and never exercised the wiring. That makes every ✅ in this
document suspect on its own, so the ones covered only by unit tests were re-driven against a real
server and a real terminal:

| Claim | Result |
|---|---|
| browse lists sessions grouped by project | ✅ live |
| `^a` adopts a session and it appears in the main view | ✅ live |
| `^s` switches to project grouping, header names the directory | ✅ live |
| project grouping puts the state word on the row | ✅ live |
| `^t` pins into a `pinned` group | ✅ live |
| `s:working` narrows the rows, not just the footer | ✅ live |
| space opens peek with its reply input | ✅ live |

One apparent failure during this sweep turned out to be the harness, not roost: repeated runs left
adopted sessions in `roster.json`, so a later run's `^a` was toggling membership *off*. Traced by
logging every roster mutation — a single toggle, `before=2 after=1` — rather than assumed either way.

## 10. Confirmed about opencode's event bus

`GET /event?directory=X` is genuinely scoped to that project. Probed by watching one project's
stream while mutating a session in another: zero foreign session ids appeared. This matters because
`connectEvents` keys every event by the directory of the stream it arrived on — a global bus would
have inserted every session into every project's key space and filled each group with ghost rows.

## 10b. Where parity stands (2026-07-23, after the build waves)

59 ✅ · 6 ⚠️ · 1 ❌. The one remaining ❌ is a keybinding.

**Pull request awareness** was built and driven live 2026-07-23 (§12), and all four hats are now ✅.
Three were verified then: the `#1234` label rendered magenta for a real merged PR in a real terminal
against live opencode, peek listed that PR with its URL, and typing `#5` filtered a 9-session roster
down to the 3 on that branch. Driving it live also found and fixed a real bug the unit tests could
not (§12) — the exact reason this document refuses to call anything done on the suite alone. The
fourth hat, the `Ready for review` group, was watched populating live 2026-07-24: a session was
created in a sandbox worktree on `dependabot/github_actions/actions/checkout-7` — a branch with an
*open* pull request (#9) — and fleetview in a PTY against the live server rendered it under
`ready for review`, above `needs input`, with a yellow `#9` at the row's right edge (open,
review required). No `gh pr create` was needed after all: an already-open dependabot PR plus a git
worktree on its branch was enough. The colour *transitions* (grey draft → yellow/green as CI runs)
remain unwatched — that still needs an open PR whose checks move while fleetview is up.

**`Shift+↑↓` reordering within a group** — built 2026-07-24: a reorder materialises the group's
visible order as per-membership ranks that win over the recency sort; unranked rows keep the old
order below. With it, pinning (`^t`, back after its removal), `/fork` (opencode's own
`/session/:id/fork`, live-verified to copy the conversation), `fleetview bg`, `fleetview server
status|stop`, the notification hook, shell-job auto-clean, OSC 8 peek links, and the any-URL filter
all landed the same day — the ❌ column is empty.

The ⚠️ rows are all deliberate or structural, and none is a build item:

- process-liveness shape, and `^t`'s keep-alive half — opencode has no per-session worker to die or
  keep alive, so there is nothing to represent;
- model-written summaries — no non-mutating completion endpoint exists, and roost uses the streamed
  output, which is agent view's own between-turn behaviour;
- permissions answered `y`/`a`/`d` — opencode's requests are structured, so a structured answer is
  the honest UI and roost is deliberately stricter;
- image paste — sendable via a `file` part, blocked by terminals rather than by opencode;
- `/resume` — browse plus `^a` is the same capability; restoring deleted sessions is impossible
  against opencode's API.

## 11. What to build next, in order

~~2. Worktree isolation with the delete-refusal rules.~~ Built 2026-07-23 — see §6.

~~1. PR awareness, which unlocks the label, the `Ready for review` group, and the `#N` filters at
   once.~~ Built and driven live 2026-07-23 — see §12. Label, peek and `#N` filter are ✅; only the
   `Ready for review` group and the live colour transitions remain, both needing one outward-facing
   `gh pr create`.
3. `Shift+↑↓` reordering, the last group-header key.
4. `/resume`-style reattachment.

## 12. Pull request awareness (built 2026-07-23)

Design and plan in `docs/superpowers/specs/2026-07-23-pull-request-awareness-design.md` and
`docs/superpowers/plans/2026-07-23-pull-request-awareness.md`. Seven commits on `feat/pr-awareness`,
each task red-verified and reviewed, plus one whole-branch review.

**How it works.** `src/pull-requests.js` runs `gh pr list --state all --json ...` once per
repository, keyed by branch. Agent view links a PR by looking up the branch a push landed on
(`gh pr view`); roost keys the same way, and sessions run in worktrees on `opencode/<slug>`, so the
branch is already unique. The fetch piggybacks the existing 30s project poll — no second timer —
because the label's colour encodes CI state and checks go green while a session sits idle, so no
session event could ever drive the colour. Sessions are decorated with `prs` at `byProjectSessions`,
the one place every view derives from, and peek's target is decorated the same way at its call site
(peek reads from the store, which carries no `prs`). Failure of `gh` (missing, unauthenticated, no
remote) resolves to no data plus a per-repository reason shown in peek, never a startup notice.

**The four hats.** `#1234`/`N PRs` label at the row's right edge, coloured yellow/green/purple/grey
by `prStatus` and counted in the snippet budget so a labelled row still can't wrap. A `Ready for
review` group (has an open PR) above `needs input`, which forced group assignment to first-match-wins
so a waiting+PR session appears once. Linked PRs listed in peek with status and URL. `#N` or a PR URL
as a roster filter, anchored so a prompt merely mentioning `#12` still dispatches.

**Deliberately not built.** The label is not an OSC 8 hyperlink (no helper exists; peek carries the
URL). PR linking by scraping the agent's own `gh` tool output (branch-keying covers every PR a
session pushed). A manual refresh key and a separate PR interval (the 30s piggyback suffices).

**Driven live 2026-07-23.** roost was run in a PTY against the live opencode server on this machine
(9 real sessions across 12 projects). The full `refreshPullRequests` path — real project list, real
worktree branches, real `gh pr list` — produced a correct label: a `sandbox` session on branch
`sandbox-dependabot` rendered `#5` at the row's right edge in magenta (ANSI 35), the merged colour.
Peek on it showed `#5 merged · <url>`. Typing `#5` narrowed the roster from 9 sessions to the 3 on
that branch. The 11 `gh` calls took ~1.2s, comfortable inside the 30s poll. The parser was also fed
real `gh` JSON from five other repos, exercising every colour: failing/yellow, draft/grey,
passing/green, merged/magenta, closed/grey, and an open PR with passing checks but `REVIEW_REQUIRED`
correctly yellow.

**A bug only live testing could find.** Seven stale worktree directories all showed peek "gh is not
installed" while `gh` was installed and working. `execFile` throws `ENOENT` both for a missing binary
and for a missing `cwd`, and opencode keeps listing worktrees after their directories are cleaned up.
Fixed so `ENOENT` only claims gh is missing when the directory is actually present; a vanished
directory reports no reason at all. This is exactly the class of failure — green suite, wrong against
the real server — that the working agreements warn about, and it would have shipped without the live
pass.

**Still not watched.** The `Ready for review` group and the grey → yellow → green colour transitions
both need an *open* PR to move a session, and the only live PR on this machine was merged. One
outward-facing `gh pr create` on a session's branch is all that is left.
