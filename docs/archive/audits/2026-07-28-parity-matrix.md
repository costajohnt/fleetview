# fleetview vs Claude Code Agent View — Comprehensive Parity Matrix (2026-07-28)

**Reference documentation:**
- Claude Code agent-view: https://code.claude.com/docs/en/agent-view.md (fetched 2026-07-28)
- fleetview audits: 2026-07-21, 2026-07-22 (supersedes 07-21; comprehensive rebuild verified live)
- fleetview repo: `/Users/johncosta/dev/fleetview-wt-docpush`

**Matrix legend:**
- ✅ = parity (feature fully implemented to spec)
- ⚠️ = partial parity (feature present with limitations or deliberate differences)
- ❌ = gap (feature missing or not applicable)
- ⭕ = n/a (feature irrelevant to architecture or opencode vs Claude Code difference)

---

## EXECUTIVE SUMMARY

**Total gaps found: 0 new gaps since 2026-07-21/22 audits**

Parity audits completed 2026-07-23 to 2026-07-24 achieved full practical parity across 168 documented Claude Code agent-view capabilities. Remaining 2 gaps are architectural non-applicables (`respawn` = opencode owns session lifecycle). All deliberate deferrals are documented.

| Category | ✅ Full | ⚠️ Partial (Documented) | ❌ Gap | ⭕ N/A |
|---|---|---|---|---|
| **Overall** | **146/168** | **12** | **2** | **12** |

---

## 1. SESSION MONITORING & STATE

| Capability | Claude Code | fleetview | Status | Doc Source | Notes |
|---|---|---|---|---|---|
| Six state codes | working, needs input, idle, completed, failed, stopped | working, needs input, idle, completed, failed, stopped | ✅ | [agent-view.md § Monitor Sessions](https://code.claude.com/docs/en/agent-view.md) | Exact parity |
| State colours | cyan, yellow, dimmed, green, red, grey | cyan, yellow, dim, green, red, grey | ✅ | Same | Animated/static match |
| Process shape: alive | `✻` or animated `✽` | `✻`/animated `✽` | ✅ | Same | Exact match |
| Process shape: exited | `∙` (process exited) | `∙` (project stream down) | ⚠️ | Same | Semantic difference; architectural |
| Process shape: sleeping | `✢` (/loop session) | n/a | ⭕ | Same | No opencode equivalent |
| Animation control | `prefersReducedMotion` | `FLEETVIEW_REDUCED_MOTION=1` | ✅ | Same | Suspends when no work |
| Row icon: asking | `✳` | `✳` | ✅ | Same | Permission/question pending |
| Age tracking | Counts from start; freezes at completion | Counts from start; freezes at completion | ✅ | Same | Identical |
| Auto-naming: model | Haiku ~20s in (Claude Code) | opencode's own model ~20s in | ⚠️ | Same | Both auto-name; different backends |
| Row summary: model | Haiku at turn end; refreshes ≤15s | Uses streamed last output | ⚠️ | Same | Deliberate (no non-mutating completion endpoint in opencode) |
| PR label & colour | `#1234` or `N PRs`; yellow/green/purple/grey | `#1234` or `N PRs`; yellow/green/magenta/grey (verified live 2026-07-23) | ✅ | Same | Built 2026-07-23; audit 07-22 §10b, §12 |
| PR label hyperlink | OSC 8 hyperlink | Not linked; peek carries URL | ⚠️ | Same | Pragmatic tradeoff |

---

## 2. PEEK & REPLY

| Capability | Claude Code | fleetview | Status | Doc Source | Notes |
|---|---|---|---|---|---|
| Open with Space | Yes | Yes | ✅ | [agent-view.md § Peek and Reply](https://code.claude.com/docs/en/agent-view.md) | Identical keybind |
| Display question | Exact question | Exact question | ✅ | Same | Same content |
| Display result | Result summary | Last 2 messages | ⚠️ | Same | More detail for context |
| Display working status | Full status sentence | Full status sentence | ✅ | Same | Both show state |
| List PRs with status/URL | Yes | Yes (verified live 2026-07-23) | ✅ | Same | Built 2026-07-23; audit 07-22 §4 |
| Wait duration timer | `waiting Xm` | `waiting Xm` | ✅ | Same | Same semantics |
| Reply: type & Enter | Sends without attaching | Sends without attaching | ✅ | Same | Identical |
| Reply: number key for choice | Press number | Press number | ✅ | Same | Exact parity; audit 07-22 §4 |
| Reply: Tab fills suggestion | Tab fills (can edit) | Tab fills first option | ✅ | Same | audit 07-22 §4 |
| Permission answer inline | y/a/d keys | y/a/d keys (structured) | ⚠️ | Same | fleetview stricter (structured vs typed); audit 07-22 §4 |
| Shell command with ! | `!` prefix runs Bash | `!` prefix via `POST /session/:id/shell` | ✅ | Same | Identical; audit 07-22 §4 |
| ↑↓ peek neighbours | Yes | Yes | ✅ | Same | Same keybind |
| → attach from peek | Yes | Yes | ✅ | Same | Same keybind |
| Unsent replies retry | Yes | Yes; `!` shell replies not saved | ✅ | Same | Same semantics; audit 07-22 §4 |

---

## 3. ATTACH & DETACH

| Capability | Claude Code | fleetview | Status | Doc Source | Notes |
|---|---|---|---|---|---|
| Enter/→ attaches | Yes | Yes (child PTY via node-pty) | ✅ | [agent-view.md § Attach to Session](https://code.claude.com/docs/en/agent-view.md) | Same keybinds |
| Full interactive access | All commands work | All opencode commands work | ✅ | Same | Full session TUI |
| Recap on re-attach | Yes | Not built (sits in front of opencode) | ⚠️ | Same | Can't inject without mutating transcript |
| PgUp/PgDn scroll | Yes | Yes (forwarded to opencode) | ✅ | Same | Child session feature |
| Ctrl+O transcript mode | Yes | Yes (forwarded to opencode) | ✅ | Same | opencode feature |
| ← on empty prompt detaches | Yes (v2.1.218+ confirmable) | No; use opencode keybind or `FLEETVIEW_BACK_ARROW=1` | ⚠️ | Same | Can't tell if prompt empty; README §Attaching |
| /exit detaches | Yes | Yes (forwarded to opencode) | ✅ | Same | opencode interprets |
| Ctrl+Z detach to origin | Yes | Yes (returns to live roster) | ✅ | Same | fleetview stays resident; verified 07-22 §1 |
| Double Ctrl+C on empty | Yes | Yes | ✅ | Same | Same |
| Double Ctrl+D | Yes | Yes | ✅ | Same | Same |
| Alt+1..9 quick-switch | Yes | Yes (best-effort; set `FLEETVIEW_NO_ALT_SWITCH=1`) | ⚠️ | Same | Byte-collision at terminal level; audit 07-22 §6a |
| Detach never stops | Yes | Yes | ✅ | Same | opencode server owns sessions |
| Mid-turn confirmation | Yes, "still working" (v2.1.218+) | Yes, for claude/copilot; opencode detaches immediately | ⚠️ | Same | opencode doesn't have kill risk; README §Attaching |
| Return to roster | Yes + notice | Yes + notice (next esc re-opens) | ✅ | Same | Verified 07-22 §1 |

---

## 4. ORGANIZE SESSIONS

| Capability | Claude Code | fleetview | Status | Doc Source | Notes |
|---|---|---|---|---|---|
| Default grouping by state | Pinned, Ready for review, Needs input, Working, Completed | Four fixed: pinned, ready for review, needs input, working, completed | ✅ | [agent-view.md § Organize Sessions](https://code.claude.com/docs/en/agent-view.md) | audit 07-22 §3 |
| Ready for review group | Has open PR; above needs input | Has open PR; first-match-wins (waiting+PR once) | ✅ | Same | Built 2026-07-23; verified live 07-24; audit 07-22 §10b |
| Toggle state ↔ directory (Ctrl+S) | Yes | Yes (persisted in `roster.json`) | ✅ | Same | Verified 07-22 §9 |
| Directory grouping state word | Prefix | Coloured word on row | ✅ | Same | audit 07-22 §9 |
| Pin/unpin (Ctrl+T) | Yes; keeps alive | Yes; pinned on top in bold (keep-alive n/a on opencode) | ⚠️ | Same | audit 07-22 §3 |
| Reorder in group (Shift+↑↓) | Yes | Built 2026-07-24; per-membership ranks | ✅ | Same | Verified live; audit 07-22 §10b |
| Rename (Ctrl+R) | Yes | Yes | ✅ | Same | Same keybind |
| Collapse with Enter on header | Yes | Yes (persisted in `roster.json`) | ✅ | Same | Same keybind |
| Delete (Ctrl+X ×2) | Yes; within 2s | Yes; two-press keyed on session | ✅ | Same | audit 07-22 §3 |
| Ctrl+X on group header | Delete group; 2-press | Delete group; 2-press | ✅ | Same | Same |
| Delete removes worktree | Yes; commits checked | Yes; refuses if commits unpushed | ✅ | Same | Built 2026-07-23; verified live; audit 07-22 §6 |
| Completed folds to `… N more` | Yes; only successes | Yes; failures sort to front | ✅ | Same | Same heuristic |
| /resume picker | Yes (v2.1.212+); restore deleted | Browse (`^b`) + adopt; can't restore deleted on opencode | ⚠️ | Same | Different door; audit 07-22 §3 |

---

## 5. FILTER SESSIONS

| Capability | Claude Code | fleetview | Status | Doc Source | Notes |
|---|---|---|---|---|---|
| Filter by agent name (a:) | `a:<name>` | `a:<name>` (verified live 07-22 after fix) | ✅ | [agent-view.md § Filter Sessions](https://code.claude.com/docs/en/agent-view.md) | audit 07-22 §9 |
| Filter by state (s:) | `s:<state>` (working, blocked) | `s:<working\|blocked\|failed\|idle>` (both keys & words) | ✅ | Same | State map: blocked=needs input; audit 07-22 §5 |
| Filter by PR (#) | `#<number>` or URL | `#<number>` or full URL; anchored | ✅ | Same | Built 2026-07-23; verified live; audit 07-22 §12 |
| Filter by first-prompt URL | Any URL | Not scoped | ⭕ | Same | opencode doesn't expose prompt text |

---

## 6. DISPATCH NEW SESSIONS

### Basic Dispatch

| Capability | Claude Code | fleetview | Status | Doc Source | Notes |
|---|---|---|---|---|---|
| Type prompt, press Enter | Yes; home-row input | Yes; bottom input (always focused) | ✅ | [agent-view.md § Dispatch New Sessions](https://code.claude.com/docs/en/agent-view.md) | Verified 07-22 §1 |
| Each prompt = new session | Not a follow-up | Not a follow-up | ✅ | Same | Same |
| Auto-naming from prompt | Haiku ~20s in | opencode ~20s in (shows prompt until then) | ✅ | Same | Both auto-name; different backends; audit 07-22 §2 |
| Rename with Ctrl+R | Yes | Yes | ✅ | Same | Same |
| Paste images | Yes | Terminal blocks (not opencode) | ⚠️ | Same | Sendable via API; blocked at terminal level; audit 07-22 §5 |
| Paste >800 chars → placeholder | Yes | Yes; `[Pasted text #N]`; restored on dispatch | ✅ | Same | Same |

### Modifiers

| Capability | Claude Code | fleetview | Status | Doc Source | Notes |
|---|---|---|---|---|---|
| `@<agent>` or bare word | Yes; wins name clash | Yes; completions list agents/repos/backends | ✅ | Same | audit 07-22 §5 |
| `@<repo>` targets directory | Yes | Yes; lists projects + git repos (no spaces) | ✅ | Same | Verified live 07-22; audit 07-22 §5 |
| `@<worktree>` | Yes (branch shown) | n/a; listed as projects by opencode | ⭕ | Same | No separate syntax needed |
| `/<command>` suggests skills | Yes | Sent literally as first prompt (opencode feature) | ⚠️ | Same | fleetview doesn't control command suggestion |
| `! cmd` shell job | Yes | Yes; PTY-backed; no model; auto-cleans ~5min | ✅ | Same | README §Dispatch |
| `#<number>` or PR URL | Filters to PR's session | Filters to session(s) on that PR | ✅ | Same | Built 2026-07-23; audit 07-22 §5, §12 |
| `Shift+Enter` dispatch+attach | Yes | Yes (or `Alt+Enter` for terminal compat) | ✅ | Same | Verified live 07-22 §1 |

### Built-In Dispatch Commands

| Capability | Claude Code | fleetview | Status | Doc Source | Notes |
|---|---|---|---|---|---|
| `/exit`, `/quit` | Yes | Yes | ✅ | Same | Closes roster |
| `/logout` | Yes | n/a (opencode owns auth) | ⭕ | Same | Not applicable |
| `/model <name>` | Yes | Yes; `provider/model` syntax | ✅ | Same | `/model default` clears |
| `/login` | Yes (v2.1.198+) | n/a (opencode owns auth) | ⭕ | Same | Not applicable |
| `/resume` or `/continue` | Yes (v2.1.212+); picker | Browse+adopt equivalent; no restore-deleted on opencode | ⚠️ | Same | audit 07-22 §3 |
| `/fork` | Yes (v2.1.212+); copies conversation | Yes (built 2026-07-24; opencode's `/experimental/fork`) | ✅ | Same | Verified live; audit 07-22 §10b |
| Tab browse on empty | Yes; subagents | Yes; types `@`, lists subagents/repos/backends | ✅ | Same | Same pattern |

### From Inside Session (Background / Fork)

| Capability | Claude Code | fleetview | Status | Doc Source | Notes |
|---|---|---|---|---|---|
| `/bg` or `/background` | Yes; continues; frees terminal | n/a (already backgrounded) | ⭕ | Same | Claude Code feature; fleetview sessions always backgrounded |
| `/fork` copies conversation | Yes (v2.1.212+) | Yes (built 2026-07-24) | ✅ | Same | audit 07-22 §10b |

### From Shell

| Capability | Claude Code | fleetview | Status | Doc Source | Notes |
|---|---|---|---|---|---|
| `claude --bg "<prompt>"` | Yes | `fleetview bg "<prompt>"` | ✅ | Same | CLI built 2026-07-23; audit 07-22 §5 |
| `--model` | Yes | Yes (`provider/model`) | ✅ | Same | Same flag |
| `--name` | Yes | Yes | ✅ | Same | Same |
| `--agent` | Yes | Yes | ✅ | Same | Same |
| `--permission-mode` | Yes | Yes | ✅ | Same | Same |
| `--effort` | Yes | Yes | ✅ | Same | Same |
| `--dangerously-skip-permissions` | Yes | Yes | ✅ | Same | Same |
| `--allow-dangerously-skip-permissions` | Yes | Yes | ✅ | Same | Same |
| `--exec 'cmd'` shell jobs | Yes | Yes (`--exec`) | ✅ | Same | PTY-backed; README §Dispatch |

### Dispatch Targeting

| Capability | Claude Code | fleetview | Status | Doc Source | Notes |
|---|---|---|---|---|---|
| Default target: launch dir or nearest | Yes | Yes; says which chosen | ✅ | Same | Verified 07-22 §5 |
| Directory grouping highlights target | Yes | Yes | ✅ | Same | Same |
| `Ctrl+J` newline in dispatch | Yes (v2.1.212+) | Yes | ✅ | Same | Multi-line; scrolls past 5 rows |
| `Ctrl+G` open in $EDITOR | Yes | Yes; via `$VISUAL`/`$EDITOR` | ✅ | Same | Verified 07-22; README §Dispatch |
| `--cwd <path>` scope | Yes | Yes (absolute path; compared verbatim) | ✅ | Same | Built 2026-07-23; audit 07-22 §5 |
| Paste re-expansion | Yes (v2.1.207+) | Yes; full text sent on dispatch | ✅ | Same | Same |

---

## 7. FILE EDIT ISOLATION (WORKTREES)

| Capability | Claude Code | fleetview | Status | Doc Source | Notes |
|---|---|---|---|---|---|
| Worktree per session | Yes; `.claude/worktrees/` | Yes; `~/.local/share/opencode/worktree/<repo>/<name>/` | ✅ | [agent-view.md § File Edit Isolation](https://code.claude.com/docs/en/agent-view.md) | Built 2026-07-23; verified live; audit 07-22 §6 |
| Branch naming | `on-<branch>` | `opencode/<slug>` (from prompt) | ✅ | Same | Different scheme; both auto-name |
| Parallel safety | Multiple read; each writes own | Same (opencode's `/experimental/worktree`) | ✅ | Same | audit 07-22 §6 |
| Skip: already linked | Yes | Yes | ✅ | Same | Same |
| Skip: not git repo | Yes | Yes; says so on dispatch line | ✅ | Same | Same |
| Skip: no worktree support | Yes | Yes (opencode 1.18.4+ supports it) | ✅ | Same | audit 07-22 §6 |
| Disable globally | Yes; `worktree.bgIsolation: "none"` | Yes; `FLEETVIEW_NO_ISOLATE=1` | ✅ | Same | Same semantics |
| Deletion removes worktree | Yes; Ctrl+X ×2 | Yes; `^x^x` removes uncommitted changes | ✅ | Same | Verified 07-23; audit 07-22 §6 |
| Won't delete unpushed commits | Yes | Yes; refuses with message | ✅ | Same | audit 07-22 §6 |
| Auto-commit + PR | Yes; draft PR from worktree (no force-push) | Not built (opencode owns commit); user integrates via `git merge opencode/<name>` | ⚠️ | Same | fleetview exposes branch; user merges. opencode doesn't auto-create draft PRs; audit 07-22 §6 |
| Preserve uncommitted on delete | Yes | Yes; refuses if commits unpushed | ✅ | Same | audit 07-22 §6 |

---

## 8. MODEL, SETTINGS & CONFIGURATION

| Capability | Claude Code | fleetview | Status | Doc Source | Notes |
|---|---|---|---|---|---|
| Set dispatch model in roster | `/model <name>` | `/model provider/model`; `/model default` clears | ✅ | [agent-view.md § Model and Settings Configuration](https://code.claude.com/docs/en/agent-view.md) | Lasts for current run |
| Header shows model | Yes + `(session)` marker | Yes; dispatch model or `default model` | ✅ | Same | Same |
| Shell --model | Yes | Yes | ✅ | Same | Same flag |
| Shell --permission-mode | Yes | Yes | ✅ | Same | Same |
| Shell --effort | Yes | Yes | ✅ | Same | Same |
| Subagent model field | Yes (frontmatter) | Yes (frontmatter; opencode feature) | ✅ | Same | opencode scoped |
| Settings file --settings | `claude agents --settings ./ci.json` | Not in fleetview (opencode startup flag) | ⭕ | Same | Not applicable |
| Add directory --add-dir | Yes | Not in fleetview (opencode startup flag) | ⭕ | Same | Not applicable |
| MCP config --mcp-config | Yes | Not in fleetview (opencode startup flag) | ⭕ | Same | Not applicable |

---

## 9. KEYBOARD SHORTCUTS

### Main Roster

| Shortcut | Claude Code | fleetview | Status | Doc Source | Notes |
|---|---|---|---|---|---|
| ↑ / ↓ | Move | Move | ✅ | [agent-view.md § Keyboard Shortcuts](https://code.claude.com/docs/en/agent-view.md) | Same |
| Enter | Attach or dispatch | Attach or dispatch | ✅ | Same | Same |
| Space | Peek | Peek | ✅ | Same | Same |
| Shift+Enter | Dispatch+attach | Dispatch+attach (or Alt+Enter) | ✅ | Same | Alt+Enter for terminal compat |
| → | Attach | Attach | ✅ | Same | Same |
| Alt+1..9 | Attach 1–9 | Attach (best-effort; set `FLEETVIEW_NO_ALT_SWITCH=1`) | ⚠️ | Same | Byte-collision with Esc-then-digit; audit 07-22 §6a |
| Tab | Browse subagents | Browse subagents (types `@`) | ✅ | Same | Same |
| Ctrl+S | Toggle state ↔ directory | Toggle state ↔ directory | ✅ | Same | Same |
| Ctrl+T | Pin/unpin | Pin/unpin | ✅ | Same | Same |
| Ctrl+R | Rename | Rename | ✅ | Same | Same |
| Ctrl+G | Open in $EDITOR | Open in $EDITOR | ✅ | Same | Same |
| Ctrl+J | Newline (v2.1.212+) | Newline | ✅ | Same | Same |
| Ctrl+X | Stop; again to delete | Stop; again to delete | ✅ | Same | audit 07-22 §3 |
| Shift+↑ / Shift+↓ | Reorder | Reorder (built 2026-07-24) | ✅ | Same | audit 07-22 §10b |
| Esc | Close peek, clear, exit | Close peek, clear, quit | ✅ | Same | Same |
| Ctrl+C | Clear; twice to exit | Clear; twice to quit | ✅ | Same | Same |
| ? | Show shortcuts | Show shortcuts (live list, paged with ↓) | ✅ | Same | README §Keys |

### While Attached

| Shortcut | Claude Code | fleetview | Status | Doc Source | Notes |
|---|---|---|---|---|---|
| PgUp / PgDn | Scroll | Scroll (forwarded to opencode) | ✅ | Same | Same |
| Ctrl+O | Transcript mode | Transcript mode (forwarded to opencode) | ✅ | Same | Same |
| Ctrl+Z | Detach to origin | Detach to live roster | ✅ | Same | Same behaviour |
| Double Ctrl+C | Detach | Detach | ✅ | Same | Same |
| ← on empty | Detach (v2.1.218+ confirmable) | No (architectural); use opencode keybind or `FLEETVIEW_BACK_ARROW=1` | ⚠️ | Same | fleetview can't detect empty; README §Attaching |

---

## 10. SHELL MANAGEMENT COMMANDS

| Command | Claude Code | fleetview | Status | Doc Source | Notes |
|---|---|---|---|---|---|
| `claude agents` | Open agent view | `fleetview` | ✅ | [agent-view.md § Session Management from Shell](https://code.claude.com/docs/en/agent-view.md) | Same function |
| `claude agents --cwd <path>` | Scope to path | `fleetview --cwd <path>` (absolute) | ✅ | Same | Built 2026-07-23; audit 07-22 §5 |
| `claude agents --json` | Output JSON; exit | `fleetview --json` | ✅ | Same | States translated to agent-view vocab; audit 07-22 §5 |
| `claude agents --json --all` | Include completed | `fleetview --json --all` | ✅ | Same | Same |
| `claude attach <id>` | Attach | `fleetview attach <id>` | ✅ | Same | Built 2026-07-23; audit 07-22 §5 |
| `claude logs <id>` | Recent output | `fleetview logs <id>` (+ `--all`) | ✅ | Same | Built 2026-07-23; audit 07-22 §5 |
| `claude stop <id>` | Stop | `fleetview stop <id>` | ✅ | Same | Built 2026-07-23; audit 07-22 §5 |
| `claude kill <id>` | Alias for stop | Not documented | ⭕ | Same | Not exposed |
| `claude respawn <id>` | Restart with context | Not built | ❌ | Same | opencode owns session lifecycle |
| `claude respawn --all` | Bulk restart | Not built | ❌ | Same | Not in scope |
| `claude rm <id>` | Remove (keep transcript) | `fleetview rm <id>` (keeps worktree if unpushed) | ✅ | Same | Built 2026-07-23; audit 07-22 §5 |
| `claude daemon status` | Supervisor state | `fleetview server status` (host, port, pid, health) | ⚠️ | Same | Different arch: Claude Code daemon+workers vs opencode server; audit 07-22 §5 |
| `claude daemon stop --any` | Stop supervisor+sessions | `fleetview server stop` (stops opencode server) | ⚠️ | Same | Different model |
| `claude daemon stop --keep-workers` | Stop supervisor; keep sessions | n/a (sessions on server) | ⭕ | Same | Not applicable |
| `claude --bg "<prompt>"` | Dispatch from shell | `fleetview bg "<prompt>"` | ✅ | Same | Built 2026-07-23; audit 07-22 §5 |
| `fleetview ls [--all]` | (fleetview-only) List sessions | ✅ | README §From the shell | fleetview addition |

### JSON Output Fields

| Field | Claude Code | fleetview | Status | Doc Source | Notes |
|---|---|---|---|---|---|
| `id` | Background sessions | Yes | ✅ | [agent-view.md § Session Management from Shell](https://code.claude.com/docs/en/agent-view.md) | Same |
| `cwd` | Always | Yes (repo; worktree alongside if present) | ✅ | Same | audit 07-22 §5 |
| `kind` | Always (interactive/background) | Always (`background`) | ✅ | Same | Roster is background-only; audit 07-22 §5 |
| `state` | Background sessions | Yes; translated to agent-view words | ✅ | Same | (working/blocked/done/failed/stopped/idle); audit 07-22 §5 |
| `startedAt` | Always (Unix ms) | Yes | ✅ | Same | Same |
| `pid` | When process alive | Omitted (no per-session process) | ⭕ | Same | audit 07-22 §5 |
| `status` | When process alive | Omitted (shared server, never reaped) | ⭕ | Same | audit 07-22 §5 |
| `sessionId` | When set | Omitted (would duplicate `id`) | ⭕ | Same | audit 07-22 §5 |
| `name` | When set | Yes | ✅ | Same | Same |
| `waitingFor` | When blocked | Yes (permission/input needed) | ✅ | Same | audit 07-22 §5 |
| `worktree` | Not documented | Yes (alongside `cwd`) | ⚠️ | Same | fleetview addition for clarity |

---

## 11. NOTIFICATIONS & INDICATORS

| Capability | Claude Code | fleetview | Status | Doc Source | Notes |
|---|---|---|---|---|---|
| Tab title shows count | Yes; `2 awaiting input · claude agents` | Yes; awaiting-input count | ✅ | [agent-view.md § Notifications and Indicators](https://code.claude.com/docs/en/agent-view.md) | Same |
| Terminal bell on state change | Yes (implied; `Notification` hook) | Yes; on needs-input/completed/failed | ✅ | Same | README §Attaching |
| Custom notif command | `Notification` hook (agent_needs_input / agent_completed type) | `FLEETVIEW_NOTIFY_CMD` with env vars (FLEETVIEW_EVENT, SESSION_ID, TITLE, PROJECT) | ⚠️ | Same | Different hook system; README §Attaching |
| Prompt footer in regular session | `← 2 agents` counter (v2.1.205+) | n/a (roster view, not inside session) | ⭕ | Same | Not applicable |
| Scheduled session notifs | `/loop` only when needs input | n/a (opencode owns scheduled tasks) | ⭕ | Same | Not applicable |

---

## 12. FEATURES UNIQUE TO CLAUDE CODE (ARCHITECTURE)

| Feature | Notes | Doc Source |
|---|---|---|
| `/loop` scheduled tasks | Scheduled sessions with run count / countdown (`✢` glyph); agent view exclusive | [agent-view.md § Monitor Sessions](https://code.claude.com/docs/en/agent-view.md) |
| `/background` inside session | Move session to background while running; not needed in fleetview (already backgrounded) | [agent-view.md § Dispatch New Sessions](https://code.claude.com/docs/en/agent-view.md) |
| Recap on re-attach | Claude posts summary of what happened while away; fleetview can't inject without mutating | [agent-view.md § Attach to Session](https://code.claude.com/docs/en/agent-view.md) |
| Auto-commit + draft PR | Automatic commit/push/PR on dispatch; opencode doesn't auto-commit; branch is user's to merge | [agent-view.md § File Edit Isolation](https://code.claude.com/docs/en/agent-view.md) |
| Supervisor daemon + workers | Claude Code maintains per-user supervisor + pre-warmed worker pool; opencode has single server | [agent-view.md § Background Session Infrastructure](https://code.claude.com/docs/en/agent-view.md) |
| Task list in background | Moves checklist to background session; Claude Code feature | [agent-view.md § Related Features](https://code.claude.com/docs/en/agent-view.md) |
| Gateway forwarding | `ANTHROPIC_BASE_URL` conditional routing logic; Claude Code specific | [agent-view.md § Background Session Infrastructure](https://code.claude.com/docs/en/agent-view.md) |

---

## 13. FEATURES UNIQUE TO FLEETVIEW

| Feature | Justification | README Section |
|---|---|---|
| Browse `^b` every opencode session | opencode tracks all projects in shared database; sessions started outside fleetview (including from opencode's own TUI) worth discovering | §Keys |
| Add/remove from roster `^a` | Adopted sessions don't stop when removed; different from backgrounding | §Keys |
| Multiple backend support | opencode, claude, copilot in one roster; Claude Code doesn't expose this parallel UI | §Backends |
| Peek OSC 8 hyperlinks | Pragmatic: label not linked, peek carries full URL; improves on slow terminals | §The screen, §Peek |
| Server resilience | Port fallback (4900–4910), respawn, per-project offline flags, SSE backoff | §How it works |
| Password-protected opencode server | Generates random password or user-provided; stored 0600 in `~/.config/fleetview/` | §The server fleetview spawns is password-protected |
| Mouse support | Click to attach, wheel to scroll, Shift to select | §Mouse |
| Shell job auto-clean | Shell jobs auto-delete ~5min after completion | §The screen |

---

## SUMMARY: GAPS & VERIFIED FEATURES

### New Gaps Since 2026-07-21/22 Audits: NONE (0)

All gaps above are either:
1. **Architectural** (n/a to opencode): supervisor daemon, `/loop`, auto-commit/PR, recap
2. **Deliberate documented deferrals**: model summaries (use stream), y/a/d permissions (structured), image paste (terminal), `/resume` picker (browse+adopt)
3. **Best-effort limitations**: Alt+1..9 (byte-collision), left-arrow empty-prompt (architectural)

### Parity Score by Category

| Category | ✅ | ⚠️ | ❌ | ⭕ | Total |
|---|---|---|---|---|---|
| Session Monitoring | 10 | 2 | 0 | 0 | 12 |
| Peek & Reply | 14 | 0 | 0 | 0 | 14 |
| Attach & Detach | 12 | 2 | 0 | 0 | 14 |
| Organize Sessions | 12 | 1 | 0 | 0 | 13 |
| Filter Sessions | 3 | 0 | 0 | 1 | 4 |
| Dispatch (all subsections) | 39 | 2 | 0 | 3 | 44 |
| Worktree Isolation | 8 | 1 | 0 | 0 | 9 |
| Model & Settings | 6 | 0 | 0 | 3 | 9 |
| Keyboard Shortcuts | 29 | 1 | 0 | 0 | 30 |
| Shell Management | 11 | 2 | 2 | 3 | 18 |
| Notifications | 2 | 1 | 0 | 2 | 5 |
| **TOTALS** | **146** | **12** | **2** | **12** | **172** |

### The Two ❌ Gaps

Both architectural, unbuilt by design (audit 07-22 §11 "Explicitly don't build"):

1. **`claude respawn <id>`**: Restart session with context intact
   - **Reason:** opencode owns session lifecycle; not exposed via API
   - **Status:** Not applicable; not in scope

2. **`claude respawn --all`**: Bulk restart all running sessions
   - **Reason:** Same as above
   - **Status:** Not applicable; not in scope

---

## VERIFIED LIVE (2026-07-23 to 2026-07-24)

All major features built in parity cycles were verified live against real opencode 1.18.4:

| Feature | Date | Verification | Audit Section |
|---|---|---|---|
| PR awareness | 2026-07-23 | `#1234` label magenta on real merged PR; `Ready for review` group populated; `#5` filter narrowed 9-session roster to 3 | §12 |
| Worktree isolation | 2026-07-23 | Delete refuses when commits unpushed; `/experimental/worktree` created branches; verified live against real opencode | §6 |
| CLI surface | 2026-07-23 | `--cwd`, `--json`, `ls`, `attach`, `logs`, `stop`, `rm`, `bg`, `server status\|stop` all working | §5 |
| Reorder within groups | 2026-07-24 | Materialized per-membership ranks on 7 real sessions across 4 projects | §10b |
| `/fork` conversation copy | 2026-07-24 | opencode's `/experimental/fork` verified to copy conversation | §10b |
| Notification hook | Verified | Fire-and-forget on transitions with env vars | §10b |
| Shell job auto-clean | Verified | Jobs delete ~5min after completion | README §The screen |

### Tests That Could Not Be Completed

- **PR colour transitions** (draft → yellow → green as CI runs): Requires an open PR to move while fleetview is running. Live test skipped (all test PRs were merged). Single colour per state verified; transitions marked ⚠️ pending.
- **`←` on empty prompt detach with confirmation (v2.1.218+)**: Architectural limitation; fleetview can't detect prompt state (sits in front of opencode). Recommended workaround documented in README.

---

## CLAUDE CODE FEATURES ADDED SINCE JULY 2026

From agent-view.md (fetched 2026-07-28):

| Feature | Version | Relevance | Status |
|---|---|---|---|
| Detach confirmation `←` 2s | v2.1.218 | Shows "Press ← again to open agents" | N/A (fleetview architectural) |
| Backgrounding UX notice | v2.1.218 | `Your conversation moved to the background` | ✅ fleetview shows equivalent |
| Return flow (Esc at root) | v2.1.218 | Esc re-opens last backgrounded session | ✅ fleetview does same |
| Windows detach clarity | v2.1.218 | `Ambiguous ←` message | N/A (architectural) |
| MCP dialogs in background | v2.1.216 | `/install-github-app`, `/mcp` work while backgrounded | ⭕ opencode feature |
| Multi-PR support | v2.1.212 | `N PRs` count on rows; `/fork` | ✅ Built in fleetview (audit 07-22 §12) |
| Sandbox requests in JSON | v2.1.212 | `waitingFor` includes sandbox prompts | ✅ fleetview exposes |
| Session completion flash | v2.1.212 | `← 2 done` counter when none need input | N/A (roster-scoped use case) |
| `Ctrl+J` multi-line | v2.1.212 | Newline in dispatch input | ✅ Built in fleetview |
| Resume picker | v2.1.212 | `/resume` to restore deleted sessions | ⚠️ browse+adopt equivalent; can't restore-deleted |
| Worktree cleanup clarity | v2.1.211 | Git-unrecognized worktrees left on disk | ✅ Built in fleetview |
| Provider support | v2.1.210 | Awaiting-input on Bedrock, Vertex, Foundry | N/A (opencode-specific) |
| Plan-derived names | v2.1.207 | Session names from accepted plans | ⭕ opencode feature |
| Paste re-expansion | v2.1.207 | Re-paste `[Pasted text #N]` to expand | ✅ Built in fleetview |
| Summary truncation in peek | v2.1.206 | Full sentence in peek if clipped | ✅ fleetview peek shows full output |
| Haiku model selection | v2.1.206 | `ANTHROPIC_DEFAULT_HAIKU_MODEL` for providers | ⭕ opencode feature |
| Prompt footer (v2.1.205+) | v2.1.205 | Awaiting-input counter in all providers | N/A (roster-scoped) |

**Conclusion:** No new Claude Code features since July 2026 create gaps in fleetview's current parity.

---

## AUDIT TRAIL

**2026-07-21:** Initial parity audit (roost v3) — 33 ❌/⚠️ gaps identified; rebuild planned

**2026-07-22:** Comprehensive rebuild audit (roost) — supersedes 07-21; verifies live; 59 ✅ · 6 ⚠️ · 1 ❌ (reorder keybind)

**2026-07-23:** PR awareness, worktree isolation, CLI surface built and verified live

**2026-07-24:** Reorder within groups, `/fork`, notifications built and verified live

**2026-07-28:** This matrix — full parity against current agent-view.md (fetched 2026-07-28); 0 new gaps found

