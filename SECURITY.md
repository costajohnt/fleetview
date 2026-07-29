# Security

## Reporting a vulnerability

Please report security issues **privately**, not in a public issue:

- Preferred: GitHub's private vulnerability reporting — the **Security** tab of
  [this repository](https://github.com/costajohnt/fleetview/security) →
  *Report a vulnerability*.
- Or email **costajohnt@gmail.com** with `fleetview security` in the subject.

Include what you did, what happened, and the impact. This is a small hobby
project maintained by one person, so please allow a reasonable window before
public disclosure.

## Threat model — what fleetview does and doesn't expose

fleetview is a local terminal UI. It **opens no network listener of its own.**
What it does touch:

- **It spawns a detached `opencode serve` bound to loopback** (`127.0.0.1`,
  port 4900 or the next free port up to 4910). **That server is unauthenticated
  by default and exposes a route that runs arbitrary shell commands**, so
  anything able to reach `127.0.0.1` as your user — including a web page in your
  browser, via DNS rebinding — can execute code. This is opencode's surface, not
  fleetview's, but fleetview starts it, so: set `OPENCODE_SERVER_PASSWORD`
  before launching to require HTTP basic auth on every request. fleetview uses
  it for all requests and the event stream, the spawned server inherits it, and
  fleetview **warns** if a password is set but an already-running server on the
  port doesn't actually enforce it. The server host in `server.json` is
  validated as loopback so a planted/legacy config can't rebind it to the
  network. See the README's "The server is unauthenticated by default" section.
- **Process-backed backends spawn local CLIs** (`claude`, `copilot`) as headless
  runs, as your user. All spawns use argv arrays (no shell, no string
  concatenation), and `--resume`/`-C` carry ids and directories as discrete
  arguments.
- **Untrusted text is sanitized before it reaches your terminal.** Session
  titles, snippets, and model/tool output can contain terminal escape sequences;
  fleetview strips control bytes (`stripControl`) on the output paths so a
  crafted title can't drive your terminal (e.g. OSC clipboard writes).
- **Hostile-repo hardening:** `git`/`gh` invocations run with
  `GIT_CONFIG_NOSYSTEM` etc. so a malicious `.git/config` in a directory the
  server reports can't achieve code execution during PR polling.
- **State and logs** live under `~/.config/fleetview`, `~/.local/state/fleetview`,
  and the backends' own dirs, created `0o700`/`0o600` — they may contain prompts
  and output, so they are not world-readable.

## Supported versions

fleetview tracks `main`; fixes land there. There is no separate release train
(version is a placeholder until the first npm publish).
