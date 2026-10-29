# fleetview distribution + website — design

Date: 2026-07-28
Status: approved (design), pending implementation plan

## Goal

Make fleetview easy to discover, install, and trust for people who are not
John: a polished npm install path, a launcher shim inside opencode, and a
one-page site at fleetview.jcosta.tech. Phased 1 → 2 → 3, one PR each.

## Non-goals

- No Homebrew tap, no single-binary bundle, no lower Node floor (Node ≥24
  stays; the engines constraint is real — the codebase ships type-stripped
  JS but relies on Node 24 semantics elsewhere and CI only tests 24+).
- No Claude Code plugin shim (revisit on user pull).
- No framework, build step, or analytics on the site.
- The opencode plugin contains no fleetview logic — launcher only.

## Phase 1 — npm install polish

**Preflight, in the bin entry before anything else runs:**

- Node version gate: compare `process.versions.node` major against 24 at
  the very top of `dist/cli.js` (before any import that uses modern
  syntax can throw), exit 1 with:
  `fleetview needs Node >= 24 (you have 20.11.0). Upgrade: https://nodejs.org or brew upgrade node`.
  Must be written in syntax Node 18 can parse, or the gate never runs —
  keep it dependency-free `process.versions` string math.
- node-pty load failure: today a missing/broken native binding surfaces as
  a raw ESM import stack. Catch it where `pty` is first required (the
  existing `if (!pty)` fallback already exists for attach; extend the
  pattern to startup) and print one line naming the fix:
  `node-pty failed to build during install — reinstall with a C++ toolchain present (xcode-select --install on macOS)`.
  fleetview still starts (existing degraded no-pty path), the message
  explains what's missing.

**npx:**

- Verify `npx fleetview` works cold (fresh npx cache) on macOS; fix
  whatever it surfaces (postinstall runs under npx too — the permission
  script must tolerate the npx cache layout; it takes an install-root
  argument now, which helps testing this).
- Document it as the try-before-install path.

**README:**

- New top section, 30-second quickstart, before everything else:
  install (`npm i -g fleetview`), run (`fleetview`), dispatch a task,
  attach with Enter, detach with Ctrl+Z. One screenshot.
- Requirements line: Node ≥24, macOS/Linux, opencode and/or claude and/or
  copilot CLIs (each optional, at least one needed to be useful).

**Tests:** unit test for the version-gate string logic; the CI
pack-and-install smoke already proves the install path per release.

## Phase 2 — opencode plugin shim

- Separate small package (working name `opencode-fleetview`; confirm
  naming convention against opencode's plugin registry before publishing).
- Behavior: registers a `fleetview` command in opencode. On invoke:
  if `fleetview` resolves on PATH → spawn it (handing over the terminal
  or opening alongside, whichever the plugin API supports — research
  step decides); if not → print `npm i -g fleetview` one-liner.
- **Research gate before any code:** read opencode's current plugin API
  docs and one or two published plugins. No API use from memory. If the
  plugin API cannot sanely hand over the terminal, the fallback behavior
  is: print the launch instruction instead of spawning — still worth
  shipping for discoverability.
- Lives in its own repo (`costajohnt/opencode-fleetview`) so its release
  cadence is independent; README cross-links both directions.

## Phase 3 — fleetview.jcosta.tech

- `site/index.html` + `site/style.css` in the fleetview repo. Plain
  static, no build.
- Deploy: GitHub Pages via actions workflow (`.github/workflows/site.yml`,
  deploy-pages action, triggered on pushes to main touching `site/` or
  `docs/images/`). `site/CNAME` = `fleetview.jcosta.tech`.
- DNS (manual, John): one CNAME record `fleetview` → `costajohnt.github.io`
  at the jcosta.tech registrar. Site ships dark-launched on the default
  github.io URL until the record lands.
- Content, single page top to bottom:
  1. Hero: name, one-line pitch ("Claude Code's agent view for opencode,
     claude, and copilot — a roster TUI for backgrounded agent sessions"),
     roster screenshot from `docs/images/roster.png`.
  2. Install one-liner with copy button (the page's only JS, ~5 lines).
  3. Feature strip: multi-backend, dispatch, peek/answer, attach/detach,
     worktree isolation, PR awareness — each a sentence, three with
     screenshots (peek, dispatch-suggestions, backends — all already in
     `docs/images/`).
  4. Footer: GitHub, npm, ISC license note, "by John Costa" → jcosta.tech.
- Screenshots referenced from `docs/images/` (copied into `site/` by the
  workflow, not committed twice). The existing preview/shots pipeline
  keeps them current.
- Aesthetic: terminal-dark, monospace headings, matches the TUI's look.
  Responsive enough to read on a phone; no other design ambition.

## Success criteria

1. A stranger on a Mac with Node 24 goes from npm install to attached
   session in under a minute, and gets an actionable one-liner if their
   Node is old or their toolchain is missing.
2. `npx fleetview` works cold.
3. opencode users can discover and launch fleetview without leaving
   opencode.
4. fleetview.jcosta.tech loads fast, shows real screenshots, and the
   install command copies correctly.

## Risks

- opencode plugin API churn — mitigated by the research gate and by
  keeping the plugin logic-free.
- Pages workflow adds a second deploy surface to the repo — mitigated by
  scoping its trigger to `site/` paths so app CI stays untouched.
- npx + postinstall interactions are historically fiddly — that is why
  phase 1 explicitly tests the cold-npx path rather than assuming.
