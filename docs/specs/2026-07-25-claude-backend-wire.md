# Claude Code backend — wire notes (2026-07-25)

Everything below was run against the installed binary, not read from documentation. `claude --version`
reports **`2.1.220 (Claude Code)`**, and every shape quoted here came out of that build on macOS on
2026-07-25. Three of the captured streams are checked in under `test/fixtures/claude-run-*.jsonl`
(sanitised: home paths rewritten to `/home/user`, thinking blocks and their signatures dropped, the
~150-entry tool list truncated, per-message `uuid`/`request_id` removed). The tests read those files
rather than the CLI, so the suite never spends a token.

This is the process-backed half of #100. opencode's wire notes describe a server; there is no server
here. A claude session is one headless CLI run, and everything fleetview shows about it has to come
from that run's stdout or from the transcript the CLI leaves on disk.

## Dispatch

```
claude -p <prompt> --output-format=stream-json --verbose --session-id <uuid> [--model <m>] [--agent <a>]
```

`--verbose` is not optional. Without it the CLI refuses outright:

> `Error: When using --print, --output-format=stream-json requires --verbose`

`--session-id <uuid>` is the decision that shapes the rest of the backend. Without it the session id
only arrives on the `init` event, which means `dispatch()` would have to hold the child open, parse
stdout, and only then hand a `SessionRef` back — a spawn that is supposed to be detached turning into
a read loop with a timeout, and a window where fleetview has a running process it cannot name. With
it, fleetview mints the uuid, the id is known before the process exists, and the log file, the pid
sidecar and the roster row can all be keyed on it immediately. Verified: passing
`--session-id 11111111-2222-3333-4444-555555555555` produced `init.session_id` and `result.session_id`
of exactly that value, and the transcript landed at
`~/.claude/projects/<encoded-cwd>/11111111-2222-3333-4444-555555555555.jsonl`.

The stream is newline-delimited JSON, one object per line, and it is *not* only the events the docs
name. This machine's `SessionStart` hooks emitted seven `{"type":"system","subtype":"hook_started"}`
lines and their responses before anything else, and ten `{"type":"system","subtype":"thinking_tokens"}`
lines during the turn, plus a `{"type":"rate_limit_event",…}`. None of that is part of the contract —
it is what this user's configuration happens to add — which is the argument for the parser skipping
every line it doesn't recognise instead of switching exhaustively on `type`.

### `init`

```json
{"type":"system","subtype":"init","cwd":"/home/user/dev/demo","session_id":"a54d9303-…","tools":[…],
 "model":"claude-haiku-4-5-20251001","permissionMode":"default","claude_code_version":"2.1.220"}
```

`session_id` is the id. `cwd` is the directory the run is scoped to, which matters because resume is
keyed on it (below). The `tools` array is ~150 entries once MCP servers are loaded and nothing in
fleetview reads it; the fixtures truncate it to six so a diff stays reviewable.

### assistant messages

```json
{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001","id":"msg_…","role":"assistant",
 "content":[{"type":"text","text":"hello"}],"usage":{…}},"session_id":"a54d9303-…",
 "timestamp":"2026-07-25T20:44:26.701Z"}
```

One event per content block group, so a turn that thinks then answers emits a `thinking` block event
and then a `text` block event under the *same* `message.id`. Last-output is therefore the last
`text` block seen, not the last assistant event — an implementation that took the last event would
render a thinking block or a `tool_use` as the session's visible output. Tool calls arrive as
`content:[{"type":"tool_use","name":"Write","input":{…}}]` and their results come back as
`{"type":"user","message":{"content":[{"type":"tool_result",…}]}}`, so `user` events in a headless
run are tool plumbing, not a person.

### `result`

Exactly one, last, and it is the only event that says whether the run succeeded:

```json
{"type":"result","subtype":"success","is_error":false,"result":"hello","num_turns":1,
 "duration_ms":5366,"duration_api_ms":4912,"total_cost_usd":0.0419703,"stop_reason":"end_turn",
 "terminal_reason":"completed","permission_denials":[],"session_id":"a54d9303-…"}
```

`result` carries the final assistant text again, which makes it the cheapest last-output for a
finished run. Failure is `subtype:"error_during_execution"` with `is_error:true` and an `errors`
array of strings — captured verbatim in `claude-run-resume-error.jsonl`:

```json
{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,
 "errors":["No conversation found with session ID: a54d9303-…"]}
```

Note the process exit code is **0** in both cases. Success has to be read off the event, not off the
child's status.

## Permissions, and what "needs input" can honestly mean

Headless `-p` never blocks for a person. It resolves each tool call against the permission policy and
keeps going; there is no prompt on the stream to answer and no channel to answer it on. Three attempts
to make one appear all produced something else:

- `--disallowedTools Write` → the model gets a `tool_result` reading
  `<tool_use_error>Error: No such tool available: Write. Write exists but is not enabled in this
  context.</tool_use_error>`. That is tool availability, not permission.
- `--permission-mode plan` → `ExitPlanMode` is simply absent from the tool set, so the model ends the
  turn asking for confirmation in prose. `permission_denials` stays empty.
- a `permissions.deny` rule (`--settings '{"permissions":{"deny":["Bash(curl:*)"]}}'`) is the one that
  produces a real denial.

That last one is `claude-run-permission-denied.jsonl`. The tool result is
`"Permission to use Bash with command curl … has been denied."` and the run ends `subtype:"success"`,
`is_error:false`, but with:

```json
"permission_denials":[{"tool_name":"Bash","tool_use_id":"toolu_01473…",
  "tool_input":{"command":"curl -s https://example.com -o /dev/null; echo \"Exit status: $?\"",
                "description":"Run curl command and report exit status"}}]
```

and a final assistant text of `"Need permission to run the curl command. Approve the bash execution to
proceed."` So the run is *finished*, not *waiting* — but it stopped short of the work, and the only
way forward is a human. That is the closest true analogue of opencode's `permission.asked`, and it is
what this backend reports as needing input: a completed run whose `permission_denials` is non-empty.
The distinction matters for `capabilities.questions`, which is false: fleetview can surface that a
session was blocked, but it cannot answer from the roster the way it can for opencode. Answering
means attaching.

I did not manage to provoke a denial from this machine's own settings — they allow every tool the
probes reached — so the shape above comes from a run with a deny rule injected via `--settings`. It is
the same code path the CLI uses for a policy denial; I am flagging it because the fixture is
synthetic in that one respect.

## Resume

```
claude --resume <session-id> -p <follow-up> --output-format=stream-json --verbose
```

works after a headless run, and keeps the id: resuming `a54d9303-…` emitted `init.session_id` and
`result.session_id` of `a54d9303-…`, `num_turns:1`, `result:"world"`. It appends to the same
transcript file rather than starting a new one.

## The prompt is a positional, so it rides behind `--`

`-p` is bare `--print`; the prompt is a positional argument, and one starting with `-` is parsed as
flags — `claude -p '--version' …` prints `2.1.220 (Claude Code)` and exits instead of running
(verified 2026-07-27). `--` makes it literal: both

```
claude -p --output-format=stream-json --verbose --session-id <id> -- '--version reply with …'
claude --resume <id> -p --output-format=stream-json --verbose -- '-leading-dash follow-up'
```

were verified to deliver the dash-prefixed text as the prompt (the resume also recalled the prior
turn). fleetview therefore always passes the prompt last, behind `--`. Copilot does not need this:
its `-p` takes a required value, and `copilot -p '--version'` was verified to hand the literal
string to the model.

**Resume is scoped by cwd.** Running the same resume from a sibling directory fails immediately:

> `No conversation found with session ID: a54d9303-c663-4683-b1e8-3d432b999388`

with `subtype:"error_during_execution"` before any API call (`duration_ms:0`, `total_cost_usd:0`).
This is why `SessionRef.directory` is load-bearing for this backend and not just a roster label —
`prompt()` and attach both have to spawn in the session's own directory or the session does not exist
as far as the CLI is concerned. A bogus id in the right directory fails with the same shape, so
"wrong directory" and "unknown session" are indistinguishable from the stream; both mean the same
thing to the caller.

Attach argv is `claude --resume <session-id>`, run with cwd set to the session's directory — which is
what `pty-host.ts` already does (`cwd: target.worktree` in `cli.ts`). No extra flags: the interactive
picker only appears when `--resume` is given without a value.

## Discovery: `~/.claude/projects/`

One directory per project, one `<session-id>.jsonl` per session:

```
~/.claude/projects/-home-user-dev-demo/a54d9303-c663-4683-b1e8-3d432b999388.jsonl
```

The directory name is the absolute path with every non-alphanumeric character replaced by `-`.
Verified against `/private/tmp/claude-spike/s1` → `-private-tmp-claude-spike-s1` and
`/home/user/dev/example.github.io` → `-home-user-dev-example-github-io`, so both
`/` and `.` collapse the same way. That makes the encoding **lossy and not reversible**: `~/dev/a.b`
and `~/dev/a-b` land in the same folder. So the backend encodes a directory to *find* the folder
quickly, then re-reads `cwd` out of each transcript to decide whether the session really belongs to
it. `cwd` is on every `user` and `assistant` record and is the authoritative answer.

Per-record fields worth naming:

```json
{"type":"user","cwd":"/home/user/dev/demo","sessionId":"a54d9303-…","version":"2.1.220",
 "gitBranch":"HEAD","timestamp":"2026-07-25T20:44:21.628Z","permissionMode":"default",
 "promptSource":"sdk","entrypoint":"sdk-cli","message":{"role":"user","content":"Reply with exactly: hello"}}
```

`entrypoint` is `sdk-cli` for `-p` runs, which is how a fleetview-dispatched session can be told apart
from one the user started by hand.

Titles live in their own record types, not in the message stream:

```json
{"type":"ai-title","aiTitle":"Review security vulnerabilities in plugin rename","sessionId":"f2388ad3-…"}
{"type":"last-prompt","lastPrompt":"Review this change for security vulnerabilities. …","leafUuid":"9eaa…","sessionId":"…"}
```

`ai-title` is the good one and appears once the CLI has titled the session; it is rewritten in place,
so the *last* `ai-title` line wins. `last-prompt` is the fallback for a session too young to have been
titled. Across 79 project folders on this machine there were 4071 `ai-title` records and zero
`summary` records — older Claude Code wrote `{"type":"summary"}`, 2.1.220 does not, so nothing should
depend on it.

**There is no "running" marker.** Nothing in the transcript says a session is live; the file just stops
growing. So status for a *discovered* session is inferred from transcript mtime and nothing else,
while status for a session fleetview dispatched comes from the stream log fleetview captured plus the
pid it recorded. Those are two different qualities of answer and the backend keeps them apart rather
than pretending the discovered ones are as good.

What it does *not* keep apart is the output. A transcript's `assistant` records carry
`message.content` in the same shape the stream's do, so `events()` tails a discovered session's
transcript alongside the run logs and its last-output is real text rather than a guess. Only
completion is missing, and that is why such a session is seeded `idle` (`emptyTranscriptState` in
stream.ts) instead of `working`: nothing in the file can move it off, so `working` would be a claim
the transcript does not support. Ageing an idle session off its mtime is the roster's call, not this
backend's, and `listTranscripts` returns `updatedAt` for exactly that. A session fleetview dispatched
has both a captured stream and a transcript; the run log wins and the transcript is skipped, or every
assistant message would arrive twice.

## Retention

fleetview's own capture (`<config>/claude-runs/<id>.{jsonl,json}`) is swept on dispatch: a run whose
log has not been written to for thirty days is removed. mtime rather than the recorded start time,
because a session resumed last week is live work whatever day its first prompt was sent. Nothing
under `~/.claude/projects/` is ever touched — that is Claude Code's state, it outlives fleetview's
copy, and a discovered session survives the sweep of the run it came from.

## What the CLI cannot do

`claude --help` (2.1.220) has no rename and no delete for an existing session. `-n, --name <name>`
sets a display name at *session start* only, and the subcommand list (`agents`, `auth`, `auto-mode`,
`doctor`, `gateway`, `install`, `mcp`, `plugin`, `project`, `setup-token`, `ultrareview`, `update`)
has nothing that touches a stored session. Deleting one would mean unlinking a file out of
`~/.claude/projects/`, which is Claude Code's state and not fleetview's to reach into. Both come back
as `capabilities.rename: false` / an explicit error, not a silent no-op.

`--fork-session` exists and does the right thing (`"When resuming, create a new session ID instead of
reusing the original"`), but the `Backend` contract has no `fork()` for it to hang off, so
`capabilities.fork` is false today. It is a false that means "fleetview can't", not "claude can't",
and it flips the moment the contract grows the method.

## Capabilities, and the reason for each

| flag | value | why |
| :--- | :--- | :--- |
| `fork` | `false` | `--fork-session` exists; `Backend` has no `fork()` to invoke it. |
| `rename` | `false` | No CLI surface for renaming a stored session. |
| `questions` | `false` | Headless runs can't be answered mid-flight; a denial is reported after the fact and cleared by attaching. |
The contract also carried `liveEvents: false` (no push stream — fleetview tails a log it captured
itself) and `discovery: true` (`~/.claude/projects/` lists sessions fleetview never started); both
facts hold, but nothing ever read the flags, so they were dropped from `BackendCapabilities`
(2026-07-27).
