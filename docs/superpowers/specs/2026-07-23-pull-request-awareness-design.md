# Pull request awareness — design (2026-07-23)

The last substantial parity gap in `docs/audits/2026-07-22-agent-view-parity.md`: four ❌ rows that
are one feature. Agent view's page was re-read on 2026-07-23 for this design and is quoted below
wherever it decides something.

## What agent view actually does

> "When a session opens a pull request, a `#1234` label appears at the right edge of the row, linked
> to the pull request in terminals that support hyperlinks."

> "When a session is linked to more than one pull request, the label shows a count instead, such as
> `3 PRs`, colored by the open pull request that most needs attention."

| Colour | Pull request status |
| :--- | :--- |
| Yellow | Waiting on checks or review, or checks failed |
| Green | Checks passed and no review is blocking |
| Purple | Merged |
| Grey | Draft or closed |

> "a session moves to `Ready for review` when it has an open pull request"

> "`#<number>` or a PR URL — Shows: the session working on that pull request"

Linking, in agent view, has two sources: watching the session's own `gh` command output, and
> "pushing to a branch that has an open pull request, links it by looking up that branch with
> `gh pr view`"

roost implements the second only. Sessions run in worktrees on branches named `opencode/<slug>`, so
the branch is a natural, already-unique key. Scraping opencode's tool calls for `gh` invocations
would be the first source, and it is deliberately out of scope: it is a parser against an
unspecified output format, and the branch lookup already covers every PR a session actually pushed.

The page says nothing about refresh cadence or where the data comes from, so neither is a parity
constraint — but a poll is forced anyway. The colours encode CI state, and checks go green while the
session sits idle. No session event fires when that happens, so an event-driven or lazy refresh
could never turn a row green. Only a timer can.

## Architecture

### `src/pull-requests.js` (new)

Pure functions, plus two that shell out and take their runner as an argument so tests never touch
the network.

- `fetchPullRequests(dir, run)` — `gh pr list --state all --limit 50 --json
  number,url,state,isDraft,headRefName,statusCheckRollup,reviewDecision`, run with `cwd: dir`.
  `--state all` because merged and closed PRs have colours of their own. Returns `[]` and a reason
  on any failure.
- `branchOf(dir, run)` — `git -C dir rev-parse --abbrev-ref HEAD`. Local and cheap.
- `prStatus(pr)` — `'merged' | 'closed' | 'draft' | 'passing' | 'pending'`.
- `prColor(pr)` — the four colours in the table above.
- `mostUrgent(prs)` — which open PR colours a `N PRs` count.
- `prLabel(prs)` — `#1234`, or `3 PRs` when there is more than one.

### Keying, and why it is per repository

One `gh pr list` per *repository*, never per session and never per render. The result is a
branch → PRs map, so every session in that repository is answered by one subprocess. A session's own
branch comes from a `git rev-parse` in its project directory on the same tick.

This is the whole reason the feature is affordable. Polling `gh` per row per render — the shape the
handoff warned about — would be one network round trip per session per frame.

### Refresh

Piggybacks the existing 30s project poll in `app.js` (`projectPollMs`, the `refreshProjects`
effect). No second timer, no TTL bookkeeping, no cache-invalidation logic: the tick that already
re-lists projects also re-lists PRs, for the repositories it just enumerated.

Deliberately skipped, with the trigger for adding each:

- a manual refresh key — add when 30s of staleness after opening a PR actually annoys;
- a separate PR interval with its own TTL — add when repository count makes one `gh` call per repo
  per 30s measurably expensive;
- PR linking by scraping the agent's `gh` tool calls — add only if branch-keying is shown to miss
  real links.

### The four hats

**Row label.** `app.js` decorates each session object with `prs` while building groups; `roster.js`
renders `prLabel` at the right edge in `prColor`. The label is counted in `snippetBudget` alongside
the other fixed parts, so a row still cannot wrap past one physical line — the invariant the
viewport arithmetic depends on.

Hyperlinking the label (OSC 8) is not built. Agent view links it "in terminals that support
hyperlinks"; roost has no OSC 8 helper today, and the PR URL is listed in peek, which is the same
information one keypress away.

**`Ready for review`.** A new first entry in `STATE_GROUPS`, matching "has an open pull request".

This forces one real change: group assignment becomes **first-match-wins**. Today the predicates are
mutually exclusive because each tests `status`, so `stateGroups()` can test every group
independently and still produce a partition. Having an open PR is not mutually exclusive with any
status, so without first-match-wins a waiting session with an open PR would appear in two groups —
and the partition is what stops ↑/↓ visiting the same session twice.

A waiting session with an open PR therefore sorts as ready-for-review, because the page puts
`Ready for review` above `Needs input`. Its row still shows the waiting state and peek still shows
the pending request; only the group changes.

**Peek.** One line per linked PR beneath the title: number, state, check state, and the URL. When
`gh` gave a reason instead of data, that reason renders on this line instead.

**`#N` and PR URLs.** `parseInput` gains a branch returning `{kind: 'filter', filter: {pr: number}}`
for `#1234` and for a GitHub PR URL. `applyFilter` matches it against the session's `prs`.

The page defines this as a filter only — "Shows: the session working on that pull request" — so
filtering to that one row *is* the selector. No second jump-to-session mechanism is built.

## Failure

`gh` may be absent, unauthenticated, or the repository may have no GitHub remote. All three resolve
to the same thing: no PR data anywhere, no labels, no `Ready for review` group, and no change to how
roost behaves today. The reason is carried and shown on peek's PR line, which is where someone
wondering why their label is missing would look.

No startup notice: it would nag on every launch in every repository that will never have a PR, and
the notice row is scarce.

## Testing

Unit, against injected runners: the colour and status mapping across all five statuses, `prLabel`'s
singular and count forms, `mostUrgent`'s choice, `fetchPullRequests` on malformed JSON and on a
non-zero exit, the branch → PRs keying, first-match-wins group assignment with an open PR on a
waiting session, `snippetBudget` with a label present, and `parseInput` on `#1234` and on a PR URL.

Live, against a real repository with a real PR, because every parity claim in the audit docs that
was unit-tested only has been wrong at least once: that the label appears with the right colour, that
the session lands in `Ready for review`, that peek lists the PR, and that `#N` filters to it. Plus
the `gh`-unavailable path with `PATH` stripped of `gh`.

Every new test is red-verified — the fix broken, the test watched to fail, the fix restored. A test
that cannot be made to fail says so in its own comment rather than implying it discriminates.
