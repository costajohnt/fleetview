# Agent View vs roost v3 — parity audit (2026-07-21)

Reference: code.claude.com/docs/en/agent-view (extracted 2026-07-21). Judged against shipped code at a3c9c00.

## 1. Parity table

| Feature | Agent View | roost v3 actual | Verdict |
|---|---|---|---|
| Membership: only backgrounded/dispatched sessions | Dispatched, `--bg`, or backgrounded-from-interactive | Roster model: main view = members only (app.js:223 isMember); dispatch auto-adds (app.js:379) | PARITY |
| Add existing sessions | Only via backgrounding from inside | Browse (`b`) + `space` toggle (app.js:294-299) | ROOST-BETTER (necessary analog) |
| Delete: stop→delete, unpushed-commit refusal, worktree cleanup | Ctrl+X ×2 within 2s; guards | `x` confirm; browse hard-delete, main y/d/n (app.js:421-474). No stop-without-delete, no commit guard, no worktree awareness | PARTIAL |
| CLI `claude rm`, `--cwd` scoping | Yes | cli.js:85-88 rejects all args | MISSING |
| States: 6 (Working/Needs-input/Idle/Completed/Failed/Stopped) | Color-coded | 4 (running/waiting/done/idle, session-store.js:23-28); error glyph dead; no Failed/Stopped | PARTIAL |
| Working animated | Animated | Static ● (status-badge.js:5) | PARTIAL |
| Process-shape axis (✻/∙/✢) | Separate axis | None; nearest = per-project (offline) | N-A mostly (server owns sessions; no loop sessions) |
| State grouping + fold; failures never fold | Pinned→Review→Needs-input→Working→Completed | needs-input→working→done→idle (app.js:18-23); no pin/review tiers, no folding (scroll windowing instead) | PARTIAL |
| Directory grouping toggle, persisted | Ctrl+S | `s`, persisted in roster.json | PARITY |
| Reorder (Shift+↑↓), collapse groups | Yes | No | MISSING |
| Peek + **answer decisions inline** | Space; inline answers; ↑↓ moves | `→` peek last 2 msgs, ↑↓ follows, ⏎ attaches (app.js:314-343). NO inline answers — no permission-respond endpoint at all | PARTIAL (killer half missing) |
| Attach/detach loop | Enter/→; ←//exit back; never stops session | ⏎ → `opencode attach`; exit returns (cli.js:94-128) | PARITY (basic loop) |
| Ctrl+Z detach-to-origin, Alt+1..9 | Yes | None — attach unmounts roost entirely | MISSING (architecture) |
| Dispatch: bare prompt home row | Prompt bar is home | `n` modal launcher, 2-stage, no line editing | PARTIAL |
| Shift+Enter dispatch+attach | Yes | No | MISSING |
| @agent / @repo / /command / ! cmd / #PR | Yes | Repo-targeting only (picker) | MISSING (repo: parity) |
| Auto-name (small model); rename | Yes | Title = raw prompt; `r` rename works | PARTIAL |
| Pin + keep-alive | Ctrl+T | No pin; keep-alive N-A | MISSING / N-A |
| Rows: last-response content + last-interaction time | Yes | Badge + title + project label only; updatedAt tracked, never rendered | MISSING |
| PR status markers | Yes | None | MISSING |
| `?` help | Yes | Footer only; main footer omits `→ peek` | PARTIAL |
| Ran-while-away status | implicit | seen.json watermarks | PARITY |
| Auto-discovery of all projects | No (bg-only list) | Browse discovers everything incl. TUI sessions | ROOST-BETTER |
| Server-down resilience | n/a | offline flags, SSE backoff, respawn + port fallback | ROOST-BETTER |

## 2. Architecture-imposed limits

Attach = `spawnSync(..., stdio inherit)` after unmounting ink (cli.js:114,123); roost ceases to exist while attached — streams stopped (app.js:184-189). Unfixable in this shape: quick-switch (Alt+1..9), Ctrl+Z, live "another session needs input" signals during attach. Real fix = resident roost owning a child PTY (node-pty) with pane-swap chord — a project, not a patch. Cheap partial: keep event streams alive in the parent during attach (async spawn + suspended ink) → bell/OSC notification when another session flips to waiting. Everything else (inline answers, abort, row metadata, help) is plain REST + rendering.

## 3. UX critique

- First-run: better than Agent View (auto-server, discovery, teaching empty state).
- Dispatch: worse. Modal + 2 stages vs home-row prompt; no line editing; no dispatch+attach; raw-prompt titles make unreadable rows.
- **Waiting-state visibility — the big one.** `waiting` derives only from `permission.updated`; under auto-allow configs that never fires, and a session that ends its turn by ASKING A QUESTION renders **done/green** — inverted truth. Roost silently degrades to "everything looks finished"; triage requires peeking every green row. Also `permission.replied` unhandled → stale waiting badge after answering from an attached terminal.
- Done/idle semantics: `hasRun` sticky forever — done = "ran once ever". No failed state; crashed and successful runs look identical (session.error-type events ignored).
- Keys discoverability: footer honest but main view omits `→ peek`; no `?` overlay; context-dependent `x` semantics need a README paragraph (smell).
- Rows information-poor: no snippet, no relative time → not scannable.

## 4. Prioritized gaps

**Build next:**
1. Inline permission answer from peek — store permission payloads (not just ids), add respondPermission to client, y/n keys in peek.
2. Question-aware needs-input — idle transition + last message asks a question → waiting, not done; handle permission.replied. Fixes the auto-allow silent degrade.
3. Row metadata — relative time (updatedAt already flows) + last-message snippet captured from message events in the reducer (no extra fetches).
4. Stop without delete — client.abortSession (`POST /session/:id/abort`), `x` on running rows offers abort first.
5. Footer `→ peek` + wire failed state (map error events to the dead red glyph).

**Explicitly don't build:** pin/reorder/collapse (rosters small by design); small-model auto-naming (truncate instead); PR markers/#PR (weak payoff, needs gh plumbing); Alt+1..9 / Ctrl+Z before the PTY substrate exists; process-shape/loop indicators (no opencode equivalent); `! cmd` shell rows (tmux exists).
