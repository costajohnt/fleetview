# fleetview — agent instructions

Instructions for coding agents working in this repository, including "set fleetview up on this
machine" requests. The README is the full documentation; this file is the short, executable
version of the parts an agent is usually asked to do.

## Set up fleetview on this machine

1. Prereqs: Node 24+ and [opencode](https://opencode.ai) on `PATH` (`node --version`,
   `opencode --version`).
2. `npm install -g fleetview` — the published package is the normal install. Only work from this
   clone when the task is to change fleetview itself: `npm install && npm link` from the
   repository root (install runs `prepare`, which emits `dist/` — the linked `fleetview` bin runs
   from there, so re-run `npm run build` after editing `src/`; tests and `node src/cli.ts` always
   run the TypeScript directly).
3. Verify: `fleetview --version` prints a version; `fleetview` opens the roster (needs a TTY —
   don't run it from a non-interactive shell to test, run `npm test` instead).
4. Continue with the keybind section below — it is the part of setup users actually ask for.

## Configure ← to leave an attached session (recommended)

Goal: while attached to a session, `←` on an **empty** prompt returns to the fleetview roster;
`←` with text in the prompt keeps moving the cursor. fleetview cannot decide this itself (it
can't see the prompt), so it is configured in opencode, whose keybind layer resolves keys by
input context.

1. Open the user's opencode config: `~/.config/opencode/opencode.json` or `opencode.jsonc`
   (create `~/.config/opencode/opencode.json` if neither exists). Note `.jsonc` may contain
   comments — edit carefully, don't round-trip it through a strict JSON parser.
2. Merge — do not replace — this into it, keeping any existing `keybinds` entries and keeping
   `app_exit`'s stock keys:

   ```json
   { "keybinds": { "app_exit": "ctrl+c,ctrl+d,left" } }
   ```

3. Restart the opencode server: `fleetview server stop`, then start `fleetview` once (it
   respawns the server). The keybind is loaded by the **server**, not the attach client — editing
   the config without a server restart changes nothing.
4. Verify without a human: spawn `opencode attach <server-url> -s <session-id> --dir <dir>`
   under a pty, wait ~5s for the TUI, write `\x1b[D`, and confirm the process exits within a
   couple of seconds. With text typed first, the same key must NOT exit.

Caveats to tell the user: this also makes standalone `opencode` exit on `←`-when-empty, and it
only covers opencode sessions — attached `claude`/`copilot` sessions detach with `ctrl+z` (or the
all-left-arrows `FLEETVIEW_BACK_ARROW=1` chord, which should stay unset when the keybind is in
use).

## Working on this codebase

- Gate before any PR: `npx tsc --noEmit` and `npm test` must be clean, and UI-affecting changes
  must regenerate `npm run preview` output and commit `docs/previews/` (CI diffs them).
- `CONTRIBUTING.md` has the full rules (erasable-TypeScript-only syntax, preview frames,
  add-a-backend guide); `SECURITY.md` has the threat model.
- Never write a raw ESC byte (0x1B) into source files — escape sequences are spelled as
  `\x1b` string literals throughout (`text-utils.ts`, `ui/notify.ts`, `peek.ts`, `shots.ts`),
  and tools that emit real control bytes (e.g. `perl -0pi`) have corrupted this repo's UTF-8
  before. Use targeted string-replacement editing only.
