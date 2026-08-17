// Everything the dispatch input can mean, worked out from the raw string.
//
// Agent view overloads this one input with dispatching, targeting, shell jobs, view commands and
// filtering, and the only way to keep that legible is to decide it all in one pure function the
// key handler can just read the answer from.
//
//   ! cmd            → a shell job instead of a session
//   a:name / s:state → filter the list, don't dispatch
//   /command         → a command, some of which run in the view itself
//   @name            → a subagent if one matches, else a repository, else a backend to run on
//   name ...         → a subagent when the first word matches one
//
// Takes its vocabularies as arguments (agent names, repo names, backend names) so it stays pure and
// testable.
import { hasOpenPr } from './pull-requests.ts'
import type { PullRequest } from './types.ts'

// A parsed filter (see parseInput / applyFilter). Every axis is optional; at most one is set.
type Filter = { state?: string; agent?: string; url?: string; pr?: number; repo?: string; openPr?: boolean }

// The rendered row shape applyFilter reads. Sessions are a genuinely dynamic runtime shape assembled
// elsewhere; only the fields the filters touch are named here.
type Session = { status?: string; prs?: PullRequest[]; [key: string]: unknown }

// Commands agent view runs in the view rather than dispatching: "/exit and /quit close agent view
// ... /model sets the dispatch model". /login and /logout have no fleetview equivalent.
const VIEW_COMMANDS = new Set(['exit', 'quit', 'model', 'fork'])

// #51: the two view commands that take no arguments, and the only two whose action is
// irreversible. `/model <provider>/<model>` and `/fork [prompt]` legitimately take args
// (docs/guide.md, Dispatching), so they stay view commands whatever follows them; `/exit codes should be
// documented in the README` is a prompt that happens to start with the word, and quitting on it
// destroyed the text with no way to recover it.
const NO_ARG_VIEW_COMMANDS = new Set(['exit', 'quit'])

const FILTER = /^(a|s):(\S*)$/

// "`#<number>` or a PR URL — shows the session working on that pull request." Anchored on both ends
// so a prompt that merely mentions an issue number is still a prompt: `fix issue #12 in the parser`
// dispatches, `#12` filters.
const PR_NUMBER = /^#(\d+)$/
// Host anchored to github.com exactly — a URL is the one filter form that names its repository, so
// the owner/repo pair is kept and matched against the pull request's own URL instead of being
// thrown away and degrading to a bare number match that any repository's #N would satisfy.
const PR_URL = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/\S*)?$/

export function parseInput(
  raw: string,
  { agents = [], repos = [], backends = [] }: { agents?: string[]; repos?: string[]; backends?: string[] } = {},
) {
  const text = raw.trim()
  if (!text) return { kind: 'empty' }

  // "typing `!` as the first character of the dispatch input: the `!` shows as a prefix,
  // everything after it is the command"
  if (text.startsWith('!')) {
    const command = text.slice(1).trim()
    return command ? { kind: 'shell', command } : { kind: 'empty' }
  }

  const filter = FILTER.exec(text)
  if (filter) {
    const [, axis, value] = filter
    if (axis === 'a') return { kind: 'filter', filter: { agent: value } }
    // #113.5: `s:pr` is not a state — it is agent view's "ready for review" view, which fleetview
    // folds into completed rather than giving a fourth section. As a filter it costs one word of
    // vocabulary and restores the list on demand. `s:review` reads the same intent, so both work.
    if (value === 'pr' || value === 'review') return { kind: 'filter', filter: { openPr: true } }
    return { kind: 'filter', filter: { state: value } }
  }

  // Agent view defines this as a filter and nothing else — filtering to that one row is the
  // selector, so there is no second jump-to-session mechanism to build.
  const prNumber = PR_NUMBER.exec(text)
  if (prNumber) return { kind: 'filter', filter: { pr: Number(prNumber[1]) } }
  const prUrl = PR_URL.exec(text)
  if (prUrl) return { kind: 'filter', filter: { pr: Number(prUrl[3]), repo: `${prUrl[1]}/${prUrl[2]}` } }
  // "Any other URL filters to the sessions whose first prompt contained that URL" — a pasted link
  // is a lookup, not a prompt. Anchored like the PR forms so a prompt that merely mentions a URL
  // still dispatches.
  if (/^https?:\/\/\S+$/.test(text)) return { kind: 'filter', filter: { url: text } }

  if (text.startsWith('/')) {
    const [word, ...rest] = text.slice(1).split(/\s+/)
    // A bare `/` names no command; dispatching it would start a session whose entire prompt is a
    // slash.
    if (!word) return { kind: 'empty' }
    const isView = VIEW_COMMANDS.has(word) && !(rest.length && NO_ARG_VIEW_COMMANDS.has(word))
    return {
      kind: isView ? 'view-command' : 'command',
      command: word,
      args: rest.join(' '),
    }
  }

  const agentNames = new Set(agents)
  const repoNames = new Set(repos)
  const backendNames = new Set(backends)
  let agent
  let repo
  let backend
  // Split keeping the separators, so the prompt can be rebuilt with its own whitespace intact.
  // `^j` puts real newlines in the input and a prompt that came back as one flat line would make
  // that key pointless — the shape of a pasted diff or a numbered list is part of what was meant.
  const parts = text.split(/(\s+)/)
  const words = parts.filter((_, i) => i % 2 === 0)
  const gaps = parts.filter((_, i) => i % 2 === 1) // gaps[i] follows words[i]
  const kept: { word: string; gap?: string }[] = []
  for (const [i, word] of words.entries()) {
    if (word.startsWith('@') && word.length > 1) {
      const name = word.slice(1)
      // "When the same @name matches both a subagent and a sibling repository, the subagent takes
      // precedence."
      if (!agent && agentNames.has(name)) {
        agent = name
        continue
      }
      if (!repo && repoNames.has(name)) {
        repo = name
        continue
      }
      // Backends rank LAST, below both. The existing rule is "a subagent wins over a repository of
      // the same name", and a backend vocabulary of three fixed words dropped above repositories
      // would silently steal `@claude` from anyone with a repo called claude — a token that used to
      // pick a directory would start picking a CLI, which is the one thing this must not do. So
      // `@claude` selects the claude backend only when nothing else claims the name; where a repo
      // shadows it, `--backend claude` / FLEETVIEW_BACKEND still reach it.
      if (!backend && backendNames.has(name)) {
        backend = name
        continue
      }
      kept.push({ word, gap: gaps[i] }) // matches nothing: leave it rather than silently eating it
      continue
    }
    // "If the first word matches a custom subagent name, that subagent runs as the session's main
    // agent" — first word only, and only when nothing else already claimed the agent slot.
    if (i === 0 && !agent && agentNames.has(word)) {
      agent = word
      continue
    }
    kept.push({ word, gap: gaps[i] })
  }

  // Each kept word carries the whitespace that followed it, so newlines and runs of spaces inside
  // the prompt survive. The trailing gap is dropped, and a removed `@token` takes its own gap with
  // it rather than leaving a double space behind.
  const prompt = kept.map(({ word, gap }, i) => (i === kept.length - 1 ? word : word + (gap ?? ' '))).join('')
  return prompt ? { kind: 'dispatch', prompt, agent, repo, backend } : { kind: 'empty' }
}

// What the `@` and `/` suggestion list should show for the token being typed. Returns null when
// the caret isn't inside a completable token, so the caller can skip rendering entirely.
export function suggestFor(
  raw: string,
  {
    agents = [],
    repos = [],
    commands = [],
    backends = [],
  }: { agents?: string[]; repos?: string[]; commands?: string[]; backends?: string[] } = {},
) {
  const token = /(^|\s)([@/])(\S*)$/.exec(raw)
  if (!token) return null
  const [, , sigil, partial] = token
  const pool =
    sigil === '/'
      ? commands.map((name) => ({ name, kind: 'command' }))
      : // Listed in the same order parseInput resolves them, so the suggestion at the top is the one
        // the token would actually pick.
        [
          ...agents.map((name) => ({ name, kind: 'agent' })),
          ...repos.map((name) => ({ name, kind: 'repo' })),
          ...backends.map((name) => ({ name, kind: 'backend' })),
        ]
  const matches = pool.filter((entry) => entry.name.startsWith(partial))
  return matches.length ? { sigil, partial, matches: matches.slice(0, 8) } : null
}

// Applies a parsed filter to the rendered rows. `s:blocked` is agent view's alias for everything
// waiting on you, which in fleetview's vocabulary is the `waiting` state.
// Generic in the row so a caller gets back exactly what it handed in: App filters decorated roster
// rows and then renders them, and a `Session[]` return would strip every field the Roster reads.
export function applyFilter<T extends Session>(
  sessions: T[],
  filter: Filter | null | undefined,
  agentOf: (s: T) => string | undefined = () => undefined,
  promptOf: (s: T) => string | undefined = () => undefined,
): T[] {
  if (!filter) return sessions
  if (filter.state !== undefined) {
    const want = filter.state === 'blocked' ? 'waiting' : filter.state
    return sessions.filter((s) => stateAliases(s.status ?? '').includes(want))
  }
  if (filter.agent !== undefined) {
    const want = filter.agent
    return sessions.filter((s) => (agentOf(s) ?? '').startsWith(want))
  }
  if (filter.url !== undefined) {
    // Only sessions dispatched from fleetview carry their first prompt (on the roster member);
    // that matches agent view, whose "first prompt" is the dispatch text too.
    const want = filter.url
    return sessions.filter((s) => (promptOf(s) ?? '').includes(want))
  }
  // #113.5: an open pull request, whatever the session's state — the same predicate the row badge
  // and the completed-group fold already use, so the filter and the badges can never disagree.
  if (filter.openPr) return sessions.filter((s) => hasOpenPr(s.prs))
  if (filter.pr !== undefined) {
    // A URL filter carries its owner/repo and must match the pull request's own URL, so two
    // repositories that both have a #5 can't answer for each other. A bare `#5` has no repository
    // to pin, so it stays a number match. GitHub treats owner/repo case-insensitively.
    const wantRepo = filter.repo?.toLowerCase()
    return sessions.filter((s) =>
      (s.prs ?? []).some(
        (pr) =>
          pr.number === filter.pr &&
          (!wantRepo || (pr.url ?? '').toLowerCase().includes(`/${wantRepo}/pull/`)),
      ),
    )
  }
  return sessions
}

// Both fleetview's internal status keys and agent view's words are accepted, so `s:working` and
// `s:running` both do the obvious thing.
function stateAliases(status: string) {
  const words: Record<string, string[]> = {
    running: ['running', 'working'],
    waiting: ['waiting', 'blocked', 'needs', 'needsinput'],
    done: ['done', 'completed'],
    error: ['error', 'failed'],
    stopped: ['stopped'],
    idle: ['idle'],
  }
  return words[status] ?? [status]
}
