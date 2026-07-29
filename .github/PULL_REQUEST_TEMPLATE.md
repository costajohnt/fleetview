## What

<!-- What changed and why. If it changes behaviour, describe the behaviour. -->

## Agent-view parity

<!-- Does this match `claude agents`? If it deliberately diverges, say how and why. N/A for internals. -->

## Verification

- [ ] `npm run typecheck` clean
- [ ] `npm test` green
- [ ] `npm run preview` run and `docs/previews/` committed (if anything visual changed)
- [ ] Tested against a live opencode server (if it touches the roster/attach/dispatch/backend paths)
