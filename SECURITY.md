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
  port 4900 or the next free port up to 4910). That server exposes a route that
  runs arbitrary shell commands, so an unauthenticated one would let anything
  able to reach `127.0.0.1` as your user (including a web page in your browser,
  via DNS rebinding) execute code. fleetview therefore password-protects every
  server it spawns: it generates a random password, passes it to the child as
  `OPENCODE_SERVER_PASSWORD` (HTTP basic auth), and stores it in
  `~/.config/fleetview/server.json` (mode 0600) so the next run can reach the
  same still-running server. A password you set in `OPENCODE_SERVER_PASSWORD`
  yourself is used instead and never written to disk. fleetview **says so** when
  it adopts an already-running server on the port that does not enforce a
  password, since that server is not one it spawned. The server host in
  `server.json` is validated as loopback so a planted or legacy config can't
  rebind it to the network. Details:
  [the server fleetview spawns is password-protected](docs/reference.md#the-server-fleetview-spawns-is-password-protected).
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

fleetview tracks `main`; fixes land there and ship in the next npm release.
There is no separate release train, so only the latest published version gets
fixes.
