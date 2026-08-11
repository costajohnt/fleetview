# fleetview

One screen for all your background coding agents. Dispatch tasks to
[opencode](https://opencode.ai), Claude Code, or GitHub Copilot CLI; watch every session's
status live; answer their questions with a single keypress; attach to any of them. Close
fleetview and the sessions keep running — reopen and pick up where you left off.

![The fleetview roster: a task is dispatched from the input, isolates into its own worktree, streams progress, blocks on a question that is answered with a single keypress, and lands in completed](docs/demo.gif)

## 30 seconds to your first session

    npm i -g fleetview
    fleetview

Or try it without installing: `npx fleetview` — same thing, nothing left behind.

Type a task and press ⏎: a session starts on it. With the input empty, ⏎ on a row attaches to
that session, and `^z` detaches and leaves it running in the background.

Requirements: Node 24 or newer, macOS or Linux, and at least one of the `opencode`, `claude` or
`copilot` CLIs on `PATH` (each optional, one is enough). No registration: on first run fleetview
spawns one detached `opencode serve` and every directory you have ever run opencode in shows up
automatically, grouped by project with live status.

## What you get

**A live roster.** Sessions grouped by state — `needs input` on top, then `working`, then
`completed` — with each row showing what the session is doing right now, streamed as it happens
and never costing a model call. Open pull requests ride along as `#1234` labels, coloured by
what needs attention.

![A pinned group on top, a folded `… 3 more` line under working, and completed collapsed to its header and count](docs/images/groups.png)

**Answer without attaching.** `space` peeks at a session: its recent output, whatever it's
blocked on, and a reply input. A permission is `y`/`a`/`d`; a question is a numbered list you
answer by pressing the number.

![Peek on a blocked session: a permission banner with y/a/d, a question rendered as a numbered list, and the reply input](docs/images/peek-answer.png)

**One input for everything.** Type a task to dispatch it. `@repo` targets a repository, `@agent`
a subagent, `@claude`/`@copilot` another backend, `! cmd` runs a shell job, `s:blocked` filters.

![The dispatch input with `@` typed, listing subagents, repositories, and the claude/copilot backends to complete to](docs/images/dispatch-suggestions.png)

**Every dispatch is isolated.** Each session runs in its own git worktree on an ordinary branch,
created before the session exists, so three agents in one repository never fight over one working
copy. Merge back with `git merge` or a pull request. ([details](docs/guide.md#every-session-gets-its-own-worktree))

**Three backends, honestly compared.** opencode is the default and the most capable — it has a
server behind it. Claude Code and Copilot sessions are detached headless runs fleetview reads;
what they can't do, the roster says so instead of pretending. ([full table](docs/guide.md#backends))

**Scriptable.** `fleetview bg "<prompt>"` dispatches from any terminal, `fleetview --json`
reports states in the same words as `claude agents --json`, so scripts written against agent
view read fleetview too. ([CLI reference](docs/reference.md#from-the-shell))

**Locked down by default.** The opencode server fleetview spawns exposes shell execution, so
fleetview password-protects it with HTTP basic auth automatically. ([how](docs/reference.md#the-server-fleetview-spawns-is-password-protected))

## Where it comes from

fleetview is a deliberate port of Claude Code's agent view — the groups, the keys, the two-press
`^x`, the overloaded input, the worktree isolation and the `--json` state words are all agent
view's behaviour reproduced against opencode's server. Agent view is the specification; where
fleetview can't match it, or chooses not to, [the docs say so](docs/guide.md). `docs/audits/`
holds the review record: a parity audit plus independent security passes.

## Keys

↑↓ move · ⏎ attach, or dispatch if there's text · space peek · ^z detach · ^s regroup ·
^t pin · ^r rename · ^x stop (again: delete) · ^b browse all sessions · ? everything else

`?` shows the full list, generated from the same table the keys are bound from.

## Learn more

- **[Guide](docs/guide.md)** — the screen, dispatching, peek, attaching, backends, worktrees, mouse
- **[Reference](docs/reference.md)** — CLI, environment variables, the spawned server, how it works
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — from-source install and the development workflow
- **[SECURITY.md](SECURITY.md)** — threat model and how to report a vulnerability

Two things to know on an unfamiliar machine: `alt+1..9` can misfire over SSH, so set
`FLEETVIEW_NO_ALT_SWITCH=1` if you work remotely, and attaching needs `node-pty` (prebuilt on
macOS; Linux compiles it and needs `python3`, `make` and a C++ compiler).
