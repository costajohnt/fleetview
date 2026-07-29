# Contributing to fleetview

Thanks for looking. fleetview is a small TypeScript ink TUI, and its guiding
constraint keeps it that way: it is a deliberate port of Claude Code's agent
view onto [opencode](https://opencode.ai) (and, increasingly, other backends).
Agent view is the specification — when in doubt about how something should
behave, that is the answer, and where fleetview diverges it says so in a comment
or the README.

## Setup

Prereqs: **Node 24+** and [opencode](https://opencode.ai) on your `PATH`.

    git clone https://github.com/costajohnt/fleetview.git
    cd fleetview && npm install && npm link
    fleetview

There is **no build step**. Node runs the `.ts` sources in `src/` directly by
stripping types at load, and `./src/cli.ts` is the published entry point. `tsc`
is only a type checker.

## The gate — all three must be green before a PR is ready

    npm run typecheck    # tsc --noEmit, zero errors
    npm test             # vitest, all green
    npm run preview      # regenerate docs/previews; CI diffs them

**Every PR that changes anything visual must commit updated preview frames**
(`npm run preview`, then commit `docs/previews/`). CI fails on an out-of-date
diff. The previews are byte-deterministic (fixed clock, `FORCE_COLOR`,
`REDUCED_MOTION`) so they behave the same locally and in CI.

## House rules

- **TypeScript, erasable syntax only.** No `enum`, `namespace`, parameter
  properties, or `import =` — Node's type stripper only erases, it does not
  transform. Use `import type` / `export type`, and explicit `.ts` extensions on
  relative imports (`verbatimModuleSyntax` is on).
- **Match agent view, or document the divergence.** New behaviour should track
  `claude agents`; a deliberate difference gets a one-line rationale in the code
  and, if user-facing, the README.
- **Types come from opencode's OpenAPI, not guesses.** Wire shapes live in
  `src/types.ts`, grounded in `curl http://127.0.0.1:4900/doc`. Prefer a real
  type over `any`; where a shape is genuinely dynamic or a dependency is
  untyped, use `any`/`unknown` with a `// TODO(types)` note saying why.
- **Small PRs, one concern each.** Branch, open a PR, squash-merge. A hook
  blocks committing to `main` directly.
- **Leave a runnable check behind.** Non-trivial logic gets a vitest test. Test
  frames are ANSI-stripped before matching; two stdin writes in one chunk read
  as a single keypress, so tick between them.

## Adding a backend

fleetview drives more than opencode through a `Backend` adapter
(`src/backends/`). A backend implements `listSessions` / `dispatch` / `prompt` /
`attach` (returns argv) / `events` / `abort` / `rename` / `delete`, plus a
`capabilities` object so the UI degrades honestly where a backend can't do
something (fork, rename, questions, delete, …). Server-backed (opencode: HTTP +
SSE) and process-backed (claude/copilot: headless CLI runs whose state is
inferred from a parsed stream) are the two families — copy the closest existing
adapter under `src/backends/` and wire it into `src/backends/index.ts`.

## Reporting bugs and asking for features

Open an issue. For a parity gap, say which agent-view behaviour is missing so it
can be checked against the spec. Security issues go through
[SECURITY.md](SECURITY.md), not a public issue.

## Commits and PRs

Conventional-ish prefixes (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`),
present tense, describe the behaviour change and why. PR descriptions state what
changed, how it was verified, and any deliberate divergence from agent view.
