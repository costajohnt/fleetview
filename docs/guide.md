# Using fleetview

The full tour of the screen, the input, peek, and attaching. For install and the quick pitch see
the [README](../README.md); for CLI flags, environment variables, and internals see the
[reference](reference.md).

## The screen

Three lines of header: `fleetview` and its version, the dispatch model (`provider/model`, or
`default model`) followed by the launch directory, and a count — `2 awaiting input · 1 working ·
4 completed`, with `N failed` appended when any have. A pixel anchor sits left of it, and drops
on a narrow terminal.

A row is a state glyph, the session's name, what it's doing, and its age. No directory: sessions
group by state (`pinned`, `needs input`, `working`, `completed` — an idle session that has
never run folds into `completed`) and the header carries
what the row doesn't. `^s` switches to project grouping, which moves the state onto the row as a
coloured word.

The glyph says two things at once. Colour is the state: cyan working, yellow needs input, green
completed, red failed, grey stopped, dim idle. Shape is what the session wants from you — `✳` is
asking, an animated `✻`/`✽` is working, `•` is settled, and `∙` means that project's event
stream is down so the row can't answer for itself. `FLEETVIEW_REDUCED_MOTION=1` holds the
animation still.

Age counts from when the session started and freezes at the run's duration once it finishes, so
a finished row says how long it took rather than how long ago it was. Names come from opencode,
which writes one from the first prompt about twenty seconds in; until then fleetview shows what
you typed. Rename with `^r`. The text after the name is the session's last output, refreshed as
it streams and never costing a model call.

A session with an open pull request carries a `#1234` label at the row's right edge (`3 PRs` when
there are several), coloured by the one most needing attention — yellow to act on, green healthy,
magenta merged, grey draft or closed — and hyperlinked to the pull request where the terminal
supports it. peek lists them all with their URLs.

Group headers are rows too: `↑`/`↓` land on them, `⏎` collapses (the header keeps a count, and
the choice persists), and `^x` deletes every session in the group — twice, like the per-session
form. `completed` folds into a `… N more` line when the screen runs out; failures, sessions with
an open pull request, and the row you have selected never fold.

![A pinned group on top, a folded `… 3 more` line under working, and completed collapsed to its header and count](images/groups.png)

## Dispatching

The input at the bottom is always focused. Type a task, press ⏎, and a new session starts on it.
Type another and you get a second session alongside the first, not a follow-up to it.

The input decides what ⏎, space and `?` mean: with text they act on the input, empty they act on
the selected row (attach, peek, shortcuts). Sessions go to the directory fleetview was launched
from when opencode already knows it as a project, otherwise to the selected row's project.

| Input | What it does |
|---|---|
| `@repo fix the flaky test` | runs the session in that repository. `@` lists projects with sessions plus git repos one level below the launch directory |
| `@agent ...` or `agent ...` | runs the session as that subagent. A subagent wins over a repository of the same name |
| `@claude ...`, `@copilot ...` | runs the session on that agent CLI instead of opencode. A subagent and a repository both win over a backend of the same name |
| `/command args` | sent to a new session as its first prompt |
| `! npm test` | runs a shell job instead of starting a session |
| `s:working`, `s:blocked` | filters the list instead of dispatching. Also `s:failed`, `s:idle`, and `a:name` by agent |
| `s:pr`, `s:review` | filters to sessions with an open pull request — the ready-for-review view, without a fourth section |
| `#1234` | filters to the session working on that pull request. A full PR URL works too |
| `/model provider/model` | sets the model for sessions dispatched from here. `/model default` clears it. Lasts for this run only |
| `/fork [prompt]` | copies the selected session's conversation into a new one; a prompt goes to the fork |
| `/exit` | closes fleetview |

`tab` applies the first `@` or `/` suggestion (on an empty input it types `@` to open the list).

![The dispatch input with `@` typed, listing subagents, repositories, and the claude/copilot backends to complete to](images/dispatch-suggestions.png)

`^t` pins or unpins the selected session — pinned sessions sit in their own group on top, in
bold. `⇧↑`/`⇧↓` move a row within its group and the order sticks from then on.

The prompt is not one line: `^j` inserts a newline, `^g` opens it in `$VISUAL`/`$EDITOR` and
takes back whatever you save, and it scrolls past five rows. A paste over 800 characters or two
lines collapses to a `[Pasted text #1]` placeholder so it can't push the roster off screen; the
session still receives the full text.

A shell job (`! cmd`) cleans up after itself: about five minutes after it finishes its session is
deleted and the row goes with it (`fleetview logs` reads its output before then).

## Backends

opencode is the default and the only backend with a server behind it. Claude Code and GitHub
Copilot CLI are process-backed: a session is a detached headless run whose output fleetview reads,
so there is less it can do and the roster says so rather than pretending.

| | opencode | claude | copilot |
|---|---|---|---|
| dispatch, follow-up prompt, stop, attach | yes | yes | yes |
| sessions started outside fleetview | yes | yes | yes |
| live events | yes | polled, ~0.5s | polled, ~1.5s |
| answer a question or permission from the roster | yes | no, attach to approve | no, denials are silent |
| rename (`^r`), `/fork`, delete (`^x^x`), `!` shell jobs, worktree isolation | yes | no | no |

Pick one for a dispatch with `@claude`/`@copilot`, or for the whole run with `--backend <name>` /
`FLEETVIEW_BACKEND`. `@` resolves a subagent first, then a repository, then a backend — so a project
called `claude` keeps `@claude`, and `--backend` is how you reach the CLI in that case.

A backend other than opencode is streamed only once something has asked for it: `--backend`,
`FLEETVIEW_BACKEND`, or a row from a previous run. Without that, fleetview reads nothing outside
opencode and the roster is exactly what it always was. When a second backend does have sessions,
every row grows a dim backend name after its title.

Only the roster TUI spans every backend. The shell commands (`ls`, `--json`, `attach`, `logs`,
`stop`, `rm`, `bg`) talk to the opencode server directly and so act on opencode sessions only.

![A roster with opencode, claude, and copilot sessions, each row carrying its dim backend name](images/backends.png)

Keys a backend can't do are refused with a one-line reason instead of failing quietly, and a
session with no message API says so in peek rather than showing a load error.

One trust note: a `@copilot` dispatch runs the Copilot CLI headless with `--allow-all-tools`, so
it auto-approves every tool call — shell and file writes included — directly in the checkout, with
no worktree isolation and denials it never surfaces. That is the same authority as running
`copilot` yourself, but worth knowing before you point it at an untrusted repo. `@claude` runs
without skip-permissions, so it denies by default.

## Keys

↑↓ move (rows and group headers) · ⏎ attach, dispatch if there's text, or collapse a group
header · ⇧⏎ (or ⌥⏎) dispatch and attach · space peek · → attach (with text typed, ← → move the
caret and ⌥← ⌥→ move it a word) · ^z detach and come back ·
^s state/project grouping · ^t pin · ⇧↑ ⇧↓ reorder within a group · ^r rename · ^x stop,
again within 2s to delete (on a group header: the whole group) · ^j newline · ^g edit the
prompt in $EDITOR · esc close peek, clear the input, or quit · ^c clear the input, again to
quit · ? shortcuts

`?` is the live list — it pages with `↓` and is generated from the same table the keys are bound
from, so it can't drift from this one.

![The shortcut list opened with ?, showing the key bindings and input grammar](images/help.png)

Two keys are fleetview's own, with no agent-view equivalent: `^b` browses every opencode session,
including ones started from opencode's own TUI, and `^a` adds or removes the selected one from
the roster. That matters because the main list only shows sessions you dispatched from fleetview
or added yourself; removing one from the roster doesn't stop it. A member whose session has gone
for good (deleted elsewhere, or its worktree removed) still gets a dim row under `completed` so
`^x` can drop it, rather than becoming an invisible entry you can only clear by editing
`roster.json`. A session dispatched with `fleetview bg` from another terminal joins a running
roster on the next poll, without a restart.

![Browse: every opencode session grouped by project, with `[roster]` marking the ones on the main list](images/browse.png)

## Peek

`space` opens the peek panel on the selected session: its recent output, whatever it's blocked
on, and an input of its own. Type there and press ⏎ to send a follow-up without attaching, or
prefix with `!` to run a shell command in that session instead. `↑`/`↓` peek adjacent sessions
without closing, `→` attaches, `esc` clears a half-typed reply and then closes the panel. A reply
you have started typing is protected: the first `↑`/`↓`/`→` after it clears the draft rather
than moving, so a follow-up written for one session can never be sent to another.

A pending permission is answerable with `y` allow once · `a` always · `d` deny; a pending
question shows its choices as a numbered list, answerable by pressing that number. Both only
work while the reply input is empty, the same rule as ⏎ and space in the main view, and the
oldest request is answered first. `tab` fills the reply with the choice the session offered so
you can edit it before sending. A blocked session also shows how long it has been waiting
(`waiting 3m`), which is a different number from the row's age.

![Peek on a blocked session: a permission banner with y/a/d, a question rendered as a numbered list, and the reply input](images/peek-answer.png)

A reply that can't be delivered is kept rather than lost: the panel says so, and it goes out as
the session's next prompt once it can. A `!` shell reply is never saved that way, since the
saved text would arrive as an ordinary prompt instead of running.

![The peek panel showing a session's recent output and a reply input at the bottom](images/peek.png)

## Attaching

`⏎` on an empty input, or `→`, attaches. opencode's real TUI takes over the terminal but
fleetview stays running behind it, every event stream still connected, so detaching drops you
back into a live roster rather than a cold start. `^z` detaches, `alt+1`…`alt+9` jump straight to
another session by position, and `/exit` inside opencode also comes back. Detaching never stops a
session. Back on the roster, a one-line "Your conversation moved to the background" notice sits
above the list with the session you just left selected, and the next `esc` that would have exited
re-opens that conversation instead. For `claude`/`copilot` attaches, a detach while the session is
mid-turn asks for a second press ("still working — press again to detach"), since killing the
interactive client there would kill the in-flight turn; opencode detaches immediately, its
sessions live on the server. The same second press guards `alt+1`…`alt+9` there, since switching
away kills that client exactly as detaching does.

Because fleetview stays resident, its terminal-level signals keep working while you're attached
to something else: the tab title carries the awaiting-input count, and the bell rings when a
session starts needing you or fails. For desktop notifications set `FLEETVIEW_NOTIFY_CMD` to a
shell command — it runs fire-and-forget on each transition with `FLEETVIEW_EVENT`
(`agent_needs_input`, `agent_completed`, `agent_failed`), `FLEETVIEW_SESSION_ID`,
`FLEETVIEW_SESSION_TITLE` and `FLEETVIEW_PROJECT` in its environment. A hook that fails is
silent; a notifier never takes down the roster.

Two chords come with caveats. `←`-on-an-empty-prompt detach isn't something fleetview can decide —
it sits in front of opencode's TUI and can't tell whether its prompt is empty — so `←` is forwarded
like any other key unless you set `FLEETVIEW_BACK_ARROW=1`, which trades **every** left-arrow for a
way back. And `alt+1..9` is best-effort: it's byte-indistinguishable from Escape-then-digit, so a
laggy link can misread an Escape in opencode as a switch; `FLEETVIEW_NO_ALT_SWITCH=1` turns it off.
`^z` is unaffected either way: one unambiguous byte, or under the kitty keyboard protocol (which
opencode's TUI switches on in terminals that speak it) one complete `CSI u` sequence, and fleetview
reads both.

### `←` back on an empty prompt (recommended)

opencode itself knows whether its prompt is empty, and its keybind layer already resolves keys by
input context (stock `ctrl+d`: exits on an empty prompt, deletes a character when there's text).
Binding `left` to `app_exit` inherits that, which is exactly Claude Code agent view's back-arrow:
`←` on an empty prompt ends the attach client and drops you back on the fleetview roster, `←` with
text in the prompt just moves the cursor.

Add to your opencode config (`~/.config/opencode/opencode.json` or `.jsonc` — merge into an
existing `keybinds` block rather than replacing it, keeping `app_exit`'s stock keys):

```jsonc
{
  "keybinds": {
    "app_exit": "ctrl+c,ctrl+d,left"
  }
}
```

Then restart the opencode server (`fleetview server stop`; the next fleetview start brings it back
up) — the keybind is loaded by the **server**, not the attach client, so it takes effect on the
next server start, not the next attach.

Two things to know. This changes standalone `opencode` too: `←` on an empty prompt there exits the
app. And it only covers opencode sessions — for attached `claude`/`copilot` sessions there is no
equivalent hook, so detach stays `^z` (or the `FLEETVIEW_BACK_ARROW=1` chord). Leave
`FLEETVIEW_BACK_ARROW` unset when using the keybind; the two would fight over the same key.

## Mouse

Clicking a row attaches in one press, clicking a group header collapses it, and the wheel scrolls
the selection. Mouse reporting takes over the terminal's own text selection, so hold Shift to
select text the usual way, or set `FLEETVIEW_NO_MOUSE=1` to turn mouse handling off entirely.

## Every session gets its own worktree

Dispatching three sessions into one repository would otherwise mean three agents editing the same
working copy. Each dispatch runs in its own git worktree instead, made before the session exists
— the same thing agent view does when it moves a background session into `.claude/worktrees/`
"before editing files".

opencode does the git work (`/experimental/worktree`): a real worktree on a branch named
`opencode/<name>` under `~/.local/share/opencode/worktree/`, named from your prompt, so `fix the
flaky tests` becomes `opencode/fix-the-flaky-tests`. Rows never mention any of it — a session
shows under the repository you dispatched into, because that is the thing you chose. Merging back
is yours: it's an ordinary branch, so `git merge opencode/<name>` or a pull request both work. Peek
on a finished isolated session spells that command out with the repository and branch filled in
(`merge back: git -C <repo> merge opencode/<name>`) to copy; it stops short of running it, because a
merge can conflict and the checkout it lands in may have work of your own in it.

Three cases skip isolation, matching agent view: a directory that isn't a git repository, one
that is already a linked worktree, and a server with no worktree support — the last says `not
isolated, it edits the checkout` on the dispatch line rather than failing.

To turn isolation off entirely — a single-session flow, or a build that depends on paths in the
main working tree — set `FLEETVIEW_NO_ISOLATE=1`. Every dispatch then edits the checkout directly
(agent view's `bgIsolation: "none"`), and the dispatch line says `isolation off, it edits the
checkout`. Isolation stays the default.

`^x^x` takes the worktree with the session, uncommitted changes included, but refuses when the
branch holds commits that exist nowhere else and says `kept the worktree — 2 unpushed commits`.
opencode's own endpoint has no such check, so fleetview checks before calling it.
