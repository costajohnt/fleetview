# GitHub Copilot CLI — wire notes

**Date:** 2026-07-25
**Verified against:** `GitHub Copilot CLI 1.0.75` (`copilot --version`), macOS arm64, installed via Homebrew at `/opt/homebrew/bin/copilot`
**Status:** spike complete; drives `src/backends/copilot/`

Everything below was observed by running the CLI, not read from documentation. Where the CLI's own
`--help` is quoted it is marked as such, because a flag existing in help and a flag behaving as
described are different claims. Five live runs paid for these findings; the fixtures under
`test/fixtures/` are the sanitized outputs so the test suite never has to make a sixth.

## Family

Process-backed, per issue #100's taxonomy. There is no server, no port, no HTTP API. A session is one
`copilot -p …` process that starts, runs to completion, and exits. Between runs the session exists
only as state on disk.

## Dispatch wire

```
copilot -p <prompt> --session-id <uuid> --output-format json --no-color --allow-all-tools
```

- **`--output-format json`** is the whole reason this backend is viable. Help calls it "JSONL, one
  JSON object per line", and that is exactly what lands on stdout: one event per line, the same event
  shapes copilot persists to its own `events.jsonl`. Text mode gives a human footer and nothing
  parseable.
- **`--session-id <uuid>`** is load-bearing and non-obvious. In JSON mode the session id is only
  announced in the *final* `result` line — a dispatch that read the id from the stream could not
  return a `SessionRef` until the run finished, which is the opposite of what backgrounding means.
  Help documents `--session-id` as "Resume an existing session or task by ID, **or set the UUID for a
  new session**", and the second half was verified: a `crypto.randomUUID()` passed in came back
  unchanged as the `result` line's `sessionId` and as the on-disk state directory name. fleetview
  therefore mints the id, and `dispatch()` can return before the model has said anything.
- **`--no-color`** because the log is parsed, not displayed.
- **`--allow-all-tools`** is what makes a headless run able to do work at all. See "Permissions".
- The prompt is one argv element; no shell quoting is involved because the process is spawned
  directly.

Working directory comes from the spawn's `cwd`, not from `-C`. Both exist; `cwd` keeps the directory
out of argv, which matters because copilot records argv-adjacent context into its own state.

### Event shapes actually seen on stdout

In first-to-last order for a trivial run (`reply with only the word: alpha`):

| `type` | what fleetview reads |
| --- | --- |
| `session.mcp_server_status_changed`, `session.mcp_servers_loaded`, `session.skills_loaded`, `session.tools_updated` | nothing — startup noise, all carry `"ephemeral": true` |
| `session.model_change`, `session.auto_mode_resolved` | nothing today; `data.chosenModel` is where `--model auto` resolves |
| `user.message` | nothing — fleetview already knows the prompt it sent |
| `assistant.turn_start` | session is working |
| `assistant.message_delta` | streaming text, `ephemeral` |
| `assistant.message` | `data.content` — the last non-empty one is the session's last output |
| `tool.execution_start` / `tool.execution_complete` | `data.error.code` on failure (see "Permissions") |
| `assistant.turn_end`, `assistant.idle` | turn over |
| `result` | terminal: `sessionId`, `exitCode`, `usage` |
| `abort` | run interrupted (`data.reason: "user_initiated"` on SIGTERM/^C) |
| `session.shutdown` | the transcript's terminal line; `data.shutdownType` says `"routine"` even for an aborted run |

`result` is the only line with no `data` wrapper — its fields sit at the top level. That asymmetry is
why the parser reads `event.type === 'result'` before it reaches for `event.data`.

**`result` is stdout-only** (verified 2026-07-27 against interactive, headless and SIGTERM-aborted
runs on 1.0.75): it never appears in `session-state/<id>/events.jsonl`, whose runs end with
`session.shutdown` instead. So a run fleetview spawned gets `result` in the captured stream, and a
discovered session's status has to be read off `session.shutdown` — with the `abort` events as the
only way to tell an interrupted run from a finished one, because `shutdownType` stays `"routine"`
either way.

`ephemeral: true` marks lines that are display-only duplicates of a durable line that follows
(`assistant.message_delta` → `assistant.message`). Skipping them is what stops the last-output text
from being reassembled twice.

## Session state on disk

Two independent stores under `~/.copilot/`:

1. **`session-state/<session-id>/`** — one directory per session:
   - `workspace.yaml` — `id`, `cwd`, `client_name`, `name`, `user_named`, `created_at`, `updated_at`.
   - `events.jsonl` — the durable event log, same shapes as stdout minus the `ephemeral` lines and
     minus `result` (stdout-only); it opens with `session.start` and ends with `session.shutdown`.
   - `session.db`, `checkpoints/`, `files/`, `research/` — copilot's own working state; not read.
   - `inuse.<pid>.lock` — **present only while a copilot process holds the session**. The filename
     carries the pid and the file's content is that same pid as ASCII. This is the running/finished
     marker; it is removed when the process exits, including on SIGTERM.
2. **`session-store.db`** — a SQLite database with `sessions(id, cwd, repository, host_type, branch,
   summary, created_at, updated_at)` plus `turns`, `session_refs` and an FTS index.

fleetview discovers through (1), not (2). The SQLite file is copilot's private schema with no version
guarantee, it runs in WAL mode (so a correct read means opening three files copilot is concurrently
writing), and its `updated_at` was observed lagging behind the session's real last activity. The
YAML+JSONL pair is plain text, append-only, and self-consistent. A directory listing plus one small
YAML read per session is also cheaper than pulling in a SQLite dependency this repo does not have.

`workspace.yaml`'s `cwd` is a **resolved real path**: a session dispatched into `/tmp/copilot-spike`
records `/private/tmp/copilot-spike` on macOS. Discovery compares against `realpathSync` of the
requested directory, or every session on a Mac goes missing.

## Resume

```
copilot --resume=<session-id> -p <text> --output-format json --no-color --allow-all-tools
```

Verified: a session dispatched with the prompt "reply with only the word: beta", resumed headlessly
with "reply with only the word you said before", answered "beta". The `result` line carried the
original session id, and no second state directory appeared — the same
`session-state/<id>/events.jsonl` grew. So resume is genuinely the same session, and `prompt()` is
just a second spawn.

Interactive attach is the same flag without `-p`:

```
copilot --resume=<session-id>
```

`--resume` also accepts a task id, an id prefix, or a session name; fleetview always has the full
uuid and passes that, since prefix matching would be ambiguous across a roster.

The `=` is not cosmetic. Help declares the flag as `-r, --resume[=value]` — an *optional* value —
and an optional-value flag only takes a value attached with `=`. Space-separated, the id parses as a
stray argument and copilot opens its interactive session picker instead. `--session-id <id>` takes a
required value and is passed as two argv entries, which is the form the spike ran.

## Permissions

A headless run **cannot ask**. Without `--allow-all-tools`, a run told to write a file produced five
`tool.execution_complete` events in a row, each:

```json
{"success": false, "error": {"message": "Permission denied and could not request permission from user", "code": "denied"}}
```

— `create`, then `bash` with a redirect, then `bash` with `sudo`, then two more probes — after which
the model gave up and explained that the directory was not writable, which was false. The run's
`result` line reported **`exitCode: 0`**. Nothing was written, nothing failed loudly, and the session
looked successful from the outside.

Three consequences, all of them design constraints rather than preferences:

1. `capabilities.questions` is **false**. There is no permission-request event to surface and no
   channel to answer one on. The interactive TUI has prompts; the headless wire does not.
2. fleetview dispatches with `--allow-all-tools` (help: "required for non-interactive mode"). A
   headless copilot session that cannot use tools is a chat box, not an agent. This is `--allow-all-tools`
   only — not `--allow-all` / `--yolo`, which would add `--allow-all-paths` and `--allow-all-urls` and
   drop the path sandbox entirely.
3. `exitCode` is not a health signal on its own. A denied session and a clean session both exit 0, so
   `failed` is derived from `error` events and a non-zero exit, and a run that produced no assistant
   output is not silently called `completed`.

## Abort

Spawning `copilot` starts **two** processes: a Node wrapper (`node /opt/homebrew/bin/copilot …`) and
the native binary it execs (`…/@github/copilot-darwin-arm64/copilot …`). Killing the wrapper alone was
verified not to kill the native child — it survived the signal, kept its `inuse.<pid>.lock`, and kept
running. So abort signals the **process group**: sessions are spawned `detached: true`, which makes
the child a group leader, and `process.kill(-pid)` reaches both. The native process removes its lock
file on the way out, so the running marker stays honest.

## Capabilities, and why

| flag | value | reason |
| --- | --- | --- |
| `fork` | `false` | no fork/branch/clone subcommand or flag exists in `copilot --help` |
| `rename` | `false` | `-n/--name` names a session **at creation**; nothing renames one afterwards, and re-running with a new name would start a new session |
| `questions` | `false` | headless denial is silent and unanswerable — see "Permissions" |

The contract also carried `liveEvents: false` (no stream to subscribe to — fleetview tails a log it
captured itself) and `discovery: true` (`~/.copilot/session-state/*/workspace.yaml` lists sessions
fleetview never started, with the cwd needed to place them); both facts hold, but nothing ever read
the flags, so they were dropped from `BackendCapabilities` (2026-07-27).

`delete` is likewise unsupported by the CLI. The `Backend` contract requires the method, so it
rejects rather than pretending: a roster key that silently did nothing is the failure mode
`capabilities` exists to prevent.

## Not built on

- **`--acp`** starts copilot as an [Agent Client Protocol](https://agentclientprotocol.com) server —
  a bidirectional JSON-RPC wire that would carry real permission requests and live events, i.e. the
  two things this backend is honest about lacking. It is the obvious next surface if `questions` or
  `liveEvents` ever need to become true. It is deliberately not this phase's wire: it needs a
  long-lived process per session and a client implementation, which is a second backend family, not a
  flag.
- **`--share` / `--share-gist`** export a session to markdown or a secret gist after a non-interactive
  run. Useful to a human, nothing for the roster to read.
- **`--continue`** resumes the most recent session. Ambiguous by definition with N sessions in a
  roster; fleetview always names the id.

## Cost of the spike

Five live runs. The text-mode footer for the smallest one reads:

```
Changes    +0 -0
AI Credits 0.84 (4s)
Tokens     ↑ 17.8k (12.3k cached, 5.5k written) • ↓ 41 (28 reasoning)
Resume     copilot --resume=1eaf1abb-c1be-4c98-8eaa-32d18f9ae961
```

`result.usage.premiumRequests` was `0`, `0.33` and `0.66` across the JSON-mode runs. The permission
probe was the expensive one at ~17s of API time, because a denied agent retries.
