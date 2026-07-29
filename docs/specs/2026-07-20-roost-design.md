# roost — design spec

**Date:** 2026-07-20
**Status:** approved (design), pending implementation plan
**One-liner:** A FleetView/Agent-View-style roster TUI for opencode. Manage many independent, backgrounded opencode sessions across multiple repos from one screen — dispatch, watch status, enter, rename, kill — without a terminal tab per session.

## Motivation

Claude Code's Agent View (aka "FleetView") lets you background sessions and manage them from one roster: see what's in progress / waiting / done, close the view without killing any running work, reopen later, enter any session to continue where you left off, rename them. opencode has no equivalent — its TUI is one active conversation at a time, and running many sessions means many terminal tabs.

opencode is natively client/server (`opencode serve` + HTTP API + SSE event stream), which makes the roster pattern a thin client rather than a reimplementation. roost is that client.

## Key decisions (locked)

1. **Enter = hand off to opencode's own TUI**, not a reimplemented conversation view. Entering a session spawns `opencode attach <url> -s <sessionId>`, which suspends roost and gives opencode's real TUI the terminal. On exit, roost resumes. We reuse opencode's entire conversation UI, permission prompts, and diff view.
2. **Multi-project.** Sessions span repos. roost tracks N `opencode serve` instances (one per repo root) and merges their sessions into one roster grouped by repo.
3. **roost owns detached servers + a registry.** "Add repo" spawns `opencode serve` as a detached process that outlives roost; roost records `repo → host:port → pid` in a registry file. Close roost, servers + sessions keep running. Reopen, roost reads the registry, health-checks, reattaches.
4. **roost is also the launcher.** An input bar dispatches new background sessions: type prompt, pick a registered repo, Enter → new session runs async and appears in the list.

## Verified feasibility (opencode CLI/API)

- `opencode serve --port N --hostname 127.0.0.1` — headless server for a repo. Also accepts `--mdns` (discovery), `--cors`, and `OPENCODE_SERVER_PASSWORD`.
- `opencode attach http://127.0.0.1:N -s <sessionId>` — attaches a terminal TUI to an already-running server and opens a specific existing session. This is the load-bearing "enter" mechanism; confirmed present in the CLI docs (`attach [url]`, flag `--session`/`-s`).
- HTTP API on each server:
  - `GET /session` — list sessions
  - `POST /session` — create session
  - `GET /session/:id` — session detail
  - `DELETE /session/:id` — remove session
  - `POST /session/:id/prompt_async` — send a prompt without blocking (background dispatch)
  - `GET /event` — SSE stream of bus events (status updates)
- OpenAPI 3.1 spec at `/doc`; an SDK can be generated from it.

## Architecture

Single ink app (roost) plus N detached `opencode serve` processes it owns.

```
┌─ roost (ink TUI) ───────────────────────────────┐
│  registry      source of truth (repos, port,pid)│
│  server-manager  spawn/health/kill detached      │
│  session-store   merged sessions, all servers    │
│  event-mux       N SSE /event streams → status   │
│  ui/             Roster · Launcher · Confirm      │
└──────┬───────────────┬───────────────┬──────────┘
       │ HTTP+SSE       │ HTTP+SSE      │
 opencode serve    opencode serve   opencode serve
  repoA :4101       repoB :4102      repoC :4103
 (detached — survive roost exit)
```

### Modules (each independently testable)

- **`registry.js`** — read/write `~/.config/roost/registry.json`; port allocation; stale-pid detection. Disk + pure logic only, no network.
  - Registry shape: `{ repos: [{ id, path, name, host, port, pid, addedAt }] }`.
- **`server-manager.js`** — detached spawn of `opencode serve` (`spawn(..., {detached:true}).unref()`), health check (`GET /` or `/session`), kill by pid, stale-pid reap. Wraps `child_process` only.
- **`session-store.js`** — aggregates `GET /session` across servers and applies `/event` deltas; groups by repo. Pure state reducer; network is injected so it can be unit-tested with fixtures.
- **`event-mux.js`** — opens one SSE `GET /event` per live server; normalizes bus events into `{ serverId, sessionId, status }`; reconnects on drop. Emits to the store.
- **`ui/`** — ink components. Read the store, emit intents (dispatch/enter/rename/kill/add-repo/remove-repo). No direct network calls.

## Data flow

- **Add repo:** pick dir → allocate free port → `server-manager` spawns detached `opencode serve --port N` → write registry → `event-mux` opens its stream.
- **List (on launch):** read registry → health-check each server → `GET /session` per live server → merge into store, grouped by repo. Dead servers flagged (offer restart).
- **Live status:** `event-mux` tails each `/event` SSE → status deltas → store → row re-render.
- **Dispatch:** launcher bar → prompt text + repo picker → `POST /session` then `POST /session/:id/prompt_async` → row appears `running`.
- **Enter:** suspend ink (`app.unmount()` / release stdin) → spawn `opencode attach http://host:port -s <id>` inheriting stdio → on child exit, re-mount roost and refresh.
- **Rename:** session rename endpoint (exact route verified at plan time) → optimistic store update.
- **Kill session:** confirm modal → `DELETE /session/:id`.
- **Remove repo:** confirm modal → kill server pid → drop from registry → close its stream.

## Status column

Target set: `running` · `waiting` (needs your input) · `done` · `error` · `idle`.

`waiting` (a pending permission/question) is the highest-value and least-certain state. **Plan-time task:** capture real `/event` payloads from a live server and map them to this set. If a "needs permission/question" signal is not derivable from the event bus, v1 ships with `running/done/error/idle` and documents the gap; `waiting` is added when the signal is confirmed. This is a known unknown, not a blocker.

## MVP scope

**In:** add/remove repo; detached servers + registry; roster grouped by repo; live status; launch (prompt + repo picker); enter (handoff via `attach -s`); rename; kill session; reattach on relaunch; restart a dead server.

**Out (grows later off the same store):** remote/phone access; web UI; fuzzy session search/jump; diff preview in-roster; cost/token tracking; git-worktree auto-creation; multi-select batch ops; auth beyond localhost.

## Stack & testing

- Node 26, ink, ESM.
- opencode access via generated SDK if clean, else a thin `fetch` wrapper — decided at plan time (default to fetch wrapper; adopt SDK only if it removes real code).
- Unit tests (vitest + ink-testing-library), network injected/mocked, one per non-trivial unit:
  - `registry` port allocation + stale-pid detection
  - `session-store` event reducer (fixtures → grouped state)
  - `event-mux` event → status mapping
- One manual smoke script against a real `opencode serve` (not in CI unit run).

## Risks

1. **`waiting` status derivability** — see Status column. Mitigation: enumerate live `/event` payloads first; degrade gracefully.
2. **~~Attach-to-existing-session~~ — RESOLVED.** `opencode attach <url> -s <id>` confirmed in CLI docs. Fork A stands.
3. **Detached-process hygiene (macOS)** — zombies, port reuse after crash. Mitigation: registry health-check on launch + stale-pid reap + port re-allocation.

## Non-goals

roost does not orchestrate agents to collaborate (no swarm, no shared task board, no inter-agent messaging). It manages independent sessions. That is the entire point — the swarm tools (ensemble, opencode-swarm) already exist and solve a different problem.
