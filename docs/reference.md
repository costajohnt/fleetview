# Reference

CLI, environment variables, the spawned server, and how fleetview is put together. For the
screen-by-screen tour see the [guide](guide.md).

## From the shell

    fleetview                    open the roster
    fleetview --cwd <path>       open it scoped to sessions under <path>
    fleetview ls [--all]         one line per session; --all includes finished ones
    fleetview --json [--all]     the same list as JSON
    fleetview attach <id>        attach in this terminal
    fleetview logs <id> [--all]  recent output
    fleetview add <id>           put an existing session on the roster (the ^a key, scripted)
    fleetview stop <id>          stop it, leave it in the list
    fleetview rm <id>            delete it (keeps a worktree holding commits)
    fleetview bg "<prompt>"      dispatch a background session from the shell
                                 (--name, --agent, --model provider/model, --exec for a ! job)
    fleetview server status      the opencode server: host, port, pid, health
    fleetview server stop        stop that server (sessions stop streaming until restart)

These shell commands (`ls`, `--json`, `attach`, `logs`, `add`, `stop`, `rm`, `bg`) act on opencode
sessions only — they talk to the opencode server directly. The roster TUI is the only view that
shows sessions from every backend (opencode, claude, copilot).

Session ids can be abbreviated to any unique prefix. `--cwd` also fixes where a bare dispatch
lands; a relative path (`--cwd .`) is resolved against the current directory before it is matched
against opencode's project paths, so `--cwd .` means this repository.

States are reported in agent view's words — `working`, `blocked`, `failed`, `done`, `stopped`,
`idle` — so a script written against `claude agents --json` reads fleetview's output too. `cwd`
is the repository; when a session runs in its own worktree, that path comes along as `worktree`.
`kind` is always `background`, and `waitingFor` (`permission prompt` or `input needed`) is present
while a session is blocked on a reported request.

Three of agent view's documented fields have no fleetview equivalent and are deliberately omitted
rather than faked: `pid` and `status` describe a per-session OS process, but opencode runs one
shared server and never reaps a session, so there is nothing to report; `sessionId` would only
duplicate `id` (opencode's `ses_…` id is already `id`).

## Environment

| Variable | What it does |
|---|---|
| `OPENCODE_SERVER_PASSWORD` | HTTP basic auth for the opencode server; overrides the password fleetview generates, see [below](#the-server-fleetview-spawns-is-password-protected). `OPENCODE_SERVER_USERNAME` overrides the `opencode` default |
| `FLEETVIEW_NOTIFY_CMD` | shell command run on each needs-input / completed / failed transition |
| `FLEETVIEW_BACKEND` | default backend for dispatches: `opencode` (default), `claude`, `copilot`. `--backend` overrides it, and rejects an unknown name rather than falling back |
| `FLEETVIEW_NO_ISOLATE=1` | dispatches edit the checkout directly instead of a per-session git worktree |
| `FLEETVIEW_NO_ALT_SWITCH=1` | turn off `alt+1..9` quick-switch (recommended over SSH) |
| `FLEETVIEW_BACK_ARROW=1` | make every `←` detach while attached, at the cost of that key inside the session (prefer the opencode `app_exit` keybind in the [guide](guide.md#-back-on-an-empty-prompt-recommended) for empty-prompt-only) |
| `FLEETVIEW_NO_MOUSE=1` | turn off mouse handling entirely |
| `FLEETVIEW_REDUCED_MOTION=1` | hold the working animation still |
| `FLEETVIEW_CONFIG_DIR` | where `server.json` and `roster.json` live (default `~/.config/fleetview`) |
| `FLEETVIEW_STATE_DIR` | where `seen.json` lives (default `~/.local/state/fleetview`) |
| `FLEETVIEW_LOG_DIR` | where `server.log` lives (default `~/.local/state/fleetview/logs`) |

## The server fleetview spawns is password-protected

fleetview starts `opencode serve` detached, so it outlives fleetview and sits on port 4900 (or
the next free port up to 4910) until something stops it. That server exposes a route that runs
arbitrary shell commands, so an unauthenticated one hands code execution to anything able to reach
`127.0.0.1` as your user — including a browser page, via DNS rebinding.

opencode supports HTTP basic auth, so when fleetview spawns the server itself it generates a
random password, passes it to the child, and stores it in `~/.config/fleetview/server.json` (mode
0600) so the next fleetview run can still reach that same still-running server. fleetview uses it
for every request and event stream, and `opencode attach` picks it up from the same variable.

Set `OPENCODE_SERVER_PASSWORD` yourself to choose the password instead; a password you set is used
as-is and never written to disk:

    export OPENCODE_SERVER_PASSWORD="$(openssl rand -hex 16)"
    fleetview

Verified against opencode 1.18.4: unauthenticated requests then get 401 and fleetview's own get
200. A password only applies to a server fleetview itself spawns — if a passwordless opencode
already holds the port, fleetview reuses it as-is and warns that the server does not require a
password; stop that server to get a protected one.

The saved password is never handed to a listener that hasn't proved it wants one: fleetview probes
the port unauthenticated first and only retries with credentials against something that answered
401. If a listener rejects the saved password, that password is treated as burned — the server it
was saved for is gone, so a fresh one is minted for the replacement rather than reused. Adoption
also checks that the thing on the port answers like opencode (a well-formed project listing, not
merely a JSON array), and fleetview says so in one line whenever it adopts a server it did not
spawn itself.

## How it works

One detached `opencode serve` for everything: opencode tracks all projects in a shared database,
so a single server sees every project regardless of which directory spawned it. fleetview is a
thin client — REST for actions (scoped per-project via `?directory=`), SSE `/event` for live
status, one stream per project. Attaching runs `opencode attach <url> -s <id> --dir <worktree>`.

- `~/.config/fleetview/server.json` — `{host, port, pid}`; records the actual port when 4900 is taken
- `~/.config/fleetview/roster.json` — the roster and the grouping mode
- `~/.local/state/fleetview/seen.json` — per-session read/watermark state
- `~/.local/state/fleetview/logs/server.log` — the server's stdout/stderr
- `~/.local/share/opencode/worktree/<repo>/<name>/` — one worktree per dispatched session

`audits/` holds the review record — a parity audit against agent view plus independent security
passes.

## Install notes

fleetview is written in TypeScript that Node runs directly by stripping types at load — in a
clone there is no build step to think about (`npm install` emits `dist/` once via `prepare`, and
development runs the `.ts` in `src/`). The npm package ships plain JavaScript in `dist/`, because
Node refuses to strip types for anything under `node_modules`.

Installing builds `node-pty`, which is what lets fleetview keep running behind an attached
session. It ships prebuilt for macOS and Windows; on Linux it compiles and needs `python3`,
`make` and a C++ compiler. Without a usable `node-pty` fleetview still runs — attaching just
hands the terminal over wholesale, costing `^z` detach and `alt+1..9` quick-switch and nothing
else. (A postinstall step restores `spawn-helper`'s executable bit, which the npm tarball drops;
without it attaching fails with `posix_spawnp failed`.)

The wire shapes are verified against opencode 1.18.4, so a much newer server may drift. The
pre-rename `ROOST_*` variables and `roost` directories are still read for one more release.

## Developing

    npm run typecheck     tsc --noEmit (development runs the .ts directly; `npm run build` emits dist/ for publishing)
    npm test              the suite (vitest)
    npm run preview       regenerate docs/previews/*.txt — CI diffs these, so a UI change
                          must update them in the same commit
    npm run shots         regenerate the README screenshots (add --shoot for the PNGs;
                          needs a Chrome binary in $CHROME or puppeteer's cache)
    npm run demo          regenerate docs/demo.gif (needs vhs)

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the full workflow and
[SECURITY.md](../SECURITY.md) for the threat model and how to report a vulnerability.
