import { useRef, type Dispatch, type SetStateAction } from 'react'
import { useInput, type Key } from 'ink'
import { stripEscapeResidue } from './text-utils.ts'
import { backspaceAt, deleteForwardAt, insertAt, motionOf, move, type Motion, type TextCursor } from './text-cursor.ts'
import { parseMouseEvents } from './ui/mouse.ts'
import { hasSession, withMember, withoutMember, type Roster } from './roster-store.ts'
import { isThenable } from './types.ts'
import type { AppAction, AttachTarget, BackendCapabilities, MouseEvent as SgrMouseEvent } from './types.ts'
import type { RosterSession } from './ui/view-types.ts'

// The roster's keyboard, lifted out of App the same way useDispatch and usePeek were. It is split
// in two: `rosterKey` is the pure decision (which key means what, given what is on screen), and
// `useRosterKeys` is the thin hook that performs the action it returns. Everything the decision
// reads is in RosterKeyState, so it can be unit-tested without rendering App.

// How long after a resume a bare Escape is treated as handoff residue rather than a quit.
export const RESUME_QUIET_MS = 50 // matches the pty host's stdin drain window

export type RosterKeyState = {
  input: string
  current: RosterSession | undefined
  selectedHeader: string | null
  // What ↑/↓ walks (App's navRows) and where the selection is in it.
  navRows: { key: string }[]
  navSel: number
  // The groups before fold/slice, which Shift+↑/↓ ranks across.
  unfoldedGroups: { sessions: RosterSession[] }[]
  suggestions: { partial: string; matches: { name: string }[] } | null | undefined
  view: string
  backgrounded: { id: string; projectKey: string; notice: boolean } | null
  allMembers: RosterSession[]
  now: number
  resumedAt: number
  // App's resumeQuietMs prop (RESUME_QUIET_MS by default); tests widen it rather than race 50ms.
  resumeQuietMs: number
  ctrlCArmedAt: number | null
}

export type RosterKeyAction =
  | { type: 'caret'; motion: Motion }
  | { type: 'insert'; text: string }
  | { type: 'paste'; text: string }
  | { type: 'backspace' }
  | { type: 'deleteForward' }
  | { type: 'setInput'; value: string }
  | { type: 'complete'; partial: string; name: string }
  | { type: 'armCtrlC' }
  | { type: 'quit' }
  | { type: 'roster'; update: (prev: Roster) => Roster }
  | { type: 'toggleView' }
  | { type: 'closeBrowse' }
  | { type: 'rename'; row: RosterSession }
  | { type: 'deleteGroup'; projectKey: string }
  | { type: 'stopOrDelete'; row: RosterSession }
  | { type: 'editor' }
  | { type: 'select'; key: string }
  | { type: 'toggleCollapsed'; projectKey: string }
  | { type: 'submit'; thenAttach: boolean }
  | { type: 'attach'; row: RosterSession }
  | { type: 'gone'; row: RosterSession }
  | { type: 'peek'; row: RosterSession }
  | { type: 'help' }

type RosterKey = Pick<Key, 'ctrl' | 'shift' | 'meta' | 'upArrow' | 'downArrow' | 'leftArrow' | 'rightArrow' | 'return' | 'tab' | 'escape' | 'backspace' | 'delete'>

export function rosterKey(s: RosterKeyState, ch: string, key: RosterKey): RosterKeyAction | null {
  const { current, selectedHeader, navRows, navSel } = s
  const empty = s.input.length === 0

  // #134: with text in the prompt the arrows move its caret — ⌥/ctrl+arrow and ESC b/f by
  // word, plain arrows by character. Before the ctrl branch because ctrl+arrow arrives with
  // `key.ctrl`; before the roster arrows because → on a non-empty prompt is a caret move, not
  // attach. An empty prompt keeps every arrow for the roster.
  if (!empty) {
    const motion = motionOf(ch, key)
    if (motion) return { type: 'caret', motion }
  }

  if (key.ctrl) {
    if (ch === 'c') {
      // "Clear the input; press twice to exit." Quitting on the first press meant a user
      // reaching for Ctrl+C to dismiss something lost the whole view instead.
      if (!empty) return { type: 'setInput', value: '' }
      if (s.ctrlCArmedAt && s.now - s.ctrlCArmedAt < 2000) return { type: 'quit' }
      return { type: 'armCtrlC' }
    }
    if (ch === 's') return { type: 'roster', update: (prev) => ({ ...prev, groupBy: prev.groupBy === 'state' ? 'project' : 'state' }) }
    // "Ctrl+T pins: the session moves to a pinned group at the top and its name renders bold."
    if (ch === 't' && current) {
      return {
        type: 'roster',
        update: (prev) => ({
          ...prev,
          sessions: prev.sessions.map((m) =>
            m.worktree === current.projectKey && m.id === current.id ? { ...m, pinned: !m.pinned } : m,
          ),
        }),
      }
    }
    if (ch === 'b') return { type: 'toggleView' }
    if (ch === 'a' && current) {
      return {
        type: 'roster',
        update: (prev) =>
          hasSession(prev, current.projectKey, current.id)
            ? withoutMember(prev, current.projectKey, current.id)
            : withMember(prev, current.projectKey, current.id),
      }
    }
    if (ch === 'r' && current) return { type: 'rename', row: current }
    if (ch === 'x' && selectedHeader) return { type: 'deleteGroup', projectKey: selectedHeader }
    if (ch === 'x' && current) return { type: 'stopOrDelete', row: current }
    // "Ctrl+J inserts a newline in the dispatch input." Terminals that report it as a plain
    // Return are indistinguishable here, which is why agent view documents it as needing
    // extended key reporting too.
    if (ch === 'j') return { type: 'insert', text: '\n' }
    // "Ctrl+G opens the dispatch prompt in $VISUAL or $EDITOR."
    if (ch === 'g') return { type: 'editor' }
    return null
  }

  // Nothing to move between on an empty list; without this the selection key becomes a
  // placeholder built from undefined.
  if (key.shift && (key.upArrow || key.downArrow) && current) {
    // Shift+↑/↓ moves the selected row within its group and materialises the whole group's
    // order as ranks on the memberships — from then on that group's order is manual and
    // persisted; sessions dispatched later arrive unranked below the ranked ones.
    // unfoldedGroups, not groups, for the same reason deleteGroup uses it: the rendered groups are
    // folded and sliced to the screen, so ranking off them writes ranks for the visible subset
    // only and silently promotes it above the rows that were folded away.
    const group = s.unfoldedGroups.find((g) => g.sessions.some((r) => r.id === current.id && r.projectKey === current.projectKey))
    if (!group) return null
    const idx = group.sessions.findIndex((r) => r.id === current.id && r.projectKey === current.projectKey)
    const target = key.upArrow ? idx - 1 : idx + 1
    if (target < 0 || target >= group.sessions.length) return null
    const order = [...group.sessions]
    ;[order[idx], order[target]] = [order[target], order[idx]]
    return {
      type: 'roster',
      update: (prev) => ({
        ...prev,
        sessions: prev.sessions.map((m) => {
          const at = order.findIndex((r) => r.projectKey === m.worktree && r.id === m.id)
          return at >= 0 ? { ...m, rank: at } : m
        }),
      }),
    }
  }
  // Arrows live in the roster; the input needs no cursor stop — typing anything, any time,
  // populates it (John's polish pass, reverting the input-as-arrow-stop experiment).
  if (key.upArrow) return navRows.length ? { type: 'select', key: navRows[Math.max(0, navSel - 1)].key } : null
  if (key.downArrow) return navRows.length ? { type: 'select', key: navRows[Math.min(navRows.length - 1, navSel + 1)].key } : null
  if (key.return) {
    // On a group header Enter collapses instead of dispatching — but only with an empty input,
    // because text in the prompt means the user is dispatching and the highlighted row is
    // incidental.
    if (selectedHeader && empty) return { type: 'toggleCollapsed', projectKey: selectedHeader }
    // Shift+Enter is only distinguishable in terminals with extended key reporting; Alt+Enter
    // (reported as meta) is the fallback the majority of terminals do send.
    return { type: 'submit', thenAttach: Boolean(key.shift || key.meta) }
  }
  // "Tab: On an empty input, browse all subagents. Otherwise apply the highlighted suggestion"
  if (key.tab && empty) return { type: 'setInput', value: '@' }
  if (key.tab) {
    if (!s.suggestions) return null // nothing to apply — never fall through and type a literal tab
    return { type: 'complete', partial: s.suggestions.partial, name: s.suggestions.matches[0].name }
  }
  if (key.rightArrow && empty && current) return { type: 'attach', row: current }
  if (key.escape) {
    // #47: the whole branch is gated, not just the quit. `^G` hands the terminal to $EDITOR
    // via a blocking spawnSync, so Ink never suspends and never drains — the editor's leftover
    // terminal-query bytes arrive as roster keystrokes, and a bare ESC among them hit
    // `setInput('')` below and wiped the prompt that was just edited, after editPrompt's
    // `finally` had already removed the temp file. Ignoring a genuinely-typed Escape within
    // 50ms of a resume costs nothing against a human reaction window.
    if (s.now - s.resumedAt < s.resumeQuietMs) return null
    if (!empty) return { type: 'setInput', value: '' }
    if (s.view === 'browse') return { type: 'closeBrowse' }
    // Esc while the "moved to the background" notice is still up undoes the switch and
    // re-opens that conversation (agent view: "Press Esc to undo the switch and return to the
    // conversation"). Attach through the LIVE row, not the remembered ref — if the session was
    // stopped or deleted in between, fall through and let Esc quit as usual. Esc keeps
    // clearing input / closing browse first; only the would-exit press in the undo window is
    // repurposed.
    const bg = s.backgrounded
    if (bg?.notice) {
      // The full member set, not the drawn rows: the session the user just left may sit in a
      // collapsed group or behind the `… N more` fold, and an Esc that promised an undo must
      // not quit the app because of how the list happened to be folded. Only a session that
      // is genuinely gone (stopped and removed) falls through to the normal quit.
      const live = s.allMembers.find((r) => r.id === bg.id && r.projectKey === bg.projectKey)
      if (live) return { type: 'attach', row: live }
    }
    // Quitting is the one irreversible thing Esc does — the quiet-window guard that protects
    // it now sits at the top of this branch (#47), because clearing a just-edited prompt is
    // destructive too and the temp file backing it is already gone.
    return { type: 'quit' }
  }
  if (key.backspace) return { type: 'backspace' }
  if (key.delete) return { type: 'deleteForward' }
  // #35: a group header has no `current`, so this used to fall through to the text handler and
  // silently type a leading space into the dispatch input — nothing on screen distinguishes
  // that from a peek that failed to open, so the next keystrokes joined a prompt the user
  // never meant to start and Enter dispatched it. On a header, space means what Enter means
  // there: collapse. Only with an empty input — text in the prompt means the user is typing,
  // and a space inside a sentence is a space.
  if (empty && ch === ' ' && selectedHeader) return { type: 'toggleCollapsed', projectKey: selectedHeader }
  // #34: peek reads a conversation that isn't there any more.
  if (empty && ch === ' ' && current?.ghost) return { type: 'gone', row: current }
  if (empty && ch === ' ' && current) return { type: 'peek', row: current }
  if (empty && ch === '?') return { type: 'help' }
  // A paste arrives as one chunk, so `ch` can carry newlines and other control bytes. Newlines
  // are kept now that `^j` makes the prompt multi-line; everything else non-printing is
  // dropped rather than embedded in a prompt that gets sent to a model.
  if (ch && !key.meta) {
    // The residue strip runs after the control strip, not before: what makes a focus report or
    // a paste marker read as typed text is exactly that its ESC has just been removed here.
    const text = stripEscapeResidue(ch.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ''))
    if (!text) return null
    // "Pasted text over 800 characters or more than two lines collapses to a placeholder."
    if (text.length > 800 || text.split('\n').length > 2) return { type: 'paste', text }
    return { type: 'insert', text }
  }
  return null
}

export function useRosterKeys({
  active,
  resumeQuietMs,
  mode,
  attachedRef,
  setAttached,
  resumedAt,
  backgrounded,
  setBackgrounded,
  handleMouse,
  input,
  setInput,
  setEdit,
  pastes,
  current,
  selectedHeader,
  navRows,
  navSel,
  unfoldedGroups,
  suggestions,
  view,
  setView,
  allMembers,
  setSelectedKey,
  updateRoster,
  capabilitiesOf,
  backendNameOf,
  setTarget,
  setMode,
  deleteGroup,
  stopOrDelete,
  toggleCollapsed,
  submit,
  attach,
  openPeek,
  onAction,
  exit,
  flash,
}: {
  active: boolean
  resumeQuietMs: number
  mode: string
  attachedRef: { current: boolean }
  setAttached: (attached: boolean) => void
  resumedAt: { current: number }
  backgrounded: { id: string; projectKey: string; notice: boolean } | null
  setBackgrounded: (b: null) => void
  handleMouse: (ev: SgrMouseEvent) => void
  input: string
  setInput: (value: string | ((current: string) => string)) => void
  setEdit: (update: (s: TextCursor) => TextCursor) => void
  // The paste buffer stays App's: expandPastes reads it on dispatch.
  pastes: { current: string[] }
  current: RosterSession | undefined
  selectedHeader: string | null
  navRows: { key: string }[]
  navSel: number
  unfoldedGroups: { sessions: RosterSession[] }[]
  suggestions: RosterKeyState['suggestions']
  view: string
  setView: Dispatch<SetStateAction<string>>
  allMembers: RosterSession[]
  setSelectedKey: (key: string | null) => void
  updateRoster: (updater: (prev: Roster) => Roster) => void
  capabilitiesOf: (row: AttachTarget) => BackendCapabilities
  backendNameOf: (row: AttachTarget) => string
  setTarget: (row: RosterSession) => void
  setMode: (mode: string) => void
  deleteGroup: (projectKey: string) => Promise<void>
  stopOrDelete: (row: RosterSession) => Promise<void>
  toggleCollapsed: (projectKey: string) => void
  submit: (opts: { thenAttach: boolean }) => void
  attach: (row: AttachTarget) => void
  openPeek: (row: RosterSession) => void
  onAction: (action: AppAction) => unknown
  exit: () => void
  flash: (message: string, ms?: number) => void
}) {
  const ctrlCArmed = useRef<number | null>(null) // timestamp of a first Ctrl+C on an empty input

  const run = (action: RosterKeyAction) => {
    switch (action.type) {
      case 'caret': return setEdit((s) => move(s, action.motion))
      case 'insert': return setEdit((s) => insertAt(s, action.text))
      case 'paste': {
        const existing = pastes.current.indexOf(action.text)
        // "Expands again if the same text is pasted a second time" — the same text is the same
        // attachment, so it keeps its number instead of accumulating duplicates.
        const index = existing >= 0 ? existing : pastes.current.push(action.text) - 1
        return setEdit((s) => insertAt(s, `[Pasted text #${index + 1}]`))
      }
      case 'backspace': return setEdit(backspaceAt)
      case 'deleteForward': return setEdit(deleteForwardAt)
      case 'setInput': return setInput(action.value)
      case 'complete': return setInput((t) => t.slice(0, t.length - action.partial.length) + action.name + ' ')
      case 'armCtrlC':
        ctrlCArmed.current = Date.now()
        return flash('press ^c again to exit')
      case 'quit':
        onAction({ type: 'quit' })
        return exit()
      case 'roster': return updateRoster(action.update)
      case 'toggleView':
        setView((v) => (v === 'main' ? 'browse' : 'main'))
        return setSelectedKey(null)
      case 'closeBrowse':
        setView('main')
        return setSelectedKey(null)
      case 'rename':
        // ^r opens nothing on a backend that cannot rename: the dialog would take a title, send it
        // nowhere, and leave the row unchanged. The status line says which backend and why.
        if (!capabilitiesOf(action.row).rename) return flash(`${backendNameOf(action.row)} can't rename a session`, 4000)
        setTarget(action.row)
        return setMode('rename')
      case 'deleteGroup': return void deleteGroup(action.projectKey)
      case 'stopOrDelete': return void stopOrDelete(action.row)
      case 'editor': {
        // The host owns the terminal handover, exactly as it does for attach, so this only asks
        // and applies the result.
        const done = onAction({ type: 'edit', text: input })
        if (isThenable(done)) {
          attachedRef.current = true
          setAttached(true)
          done.then(
            (edited) => {
              resumedAt.current = Date.now()
              attachedRef.current = false
              setAttached(false)
              if (typeof edited === 'string') setInput(edited)
            },
            () => {
              resumedAt.current = Date.now()
              attachedRef.current = false
              setAttached(false)
              flash('could not open an editor')
            },
          )
        } else flash('no $EDITOR configured')
        return
      }
      case 'select': return setSelectedKey(action.key)
      case 'toggleCollapsed': return toggleCollapsed(action.projectKey)
      case 'submit': return submit({ thenAttach: action.thenAttach })
      case 'attach': return attach(action.row)
      case 'gone': return flash(`"${action.row.title}" is gone — ^x removes it from the roster`, 4000)
      case 'peek': return openPeek(action.row)
      case 'help': return setMode('help')
    }
  }

  useInput(
    (ch, key) => {
      // #60: Ink (7 and 8: build/components/App.js handleReadable) splits one stdin read into
      // several key events and dispatches them all in one synchronous pass, but `isActive: false`
      // only takes effect at the next render — so a `→` and a `^X` arriving in the SAME chunk both
      // reach the roster and the ^X stops the row being attached to. The ref is synchronous,
      // mirroring the same guard in App's `attach`.
      if (attachedRef.current) return
      if (mode !== 'roster') return
      // The "moved to the background" state lasts exactly until the next interaction — any key or
      // click dismisses it whole. The Esc branch still sees this press's value through the render
      // closure, which is what makes Esc-right-after-detach the undo and every later Esc a normal
      // quit.
      //
      // #59: except inside the post-resume quiet window. Dismissing costs nothing when the user
      // typed it, but a stray byte left over from the child's terminal destroys the Esc-undo with
      // no way back — unlike clearing the input, this one is not recoverable.
      if (backgrounded && Date.now() - resumedAt.current >= resumeQuietMs) setBackgrounded(null)
      const mouse = parseMouseEvents(ch)
      if (mouse.length) {
        for (const ev of mouse) handleMouse(ev)
        return
      }
      const action = rosterKey(
        {
          input, current, selectedHeader, navRows, navSel, unfoldedGroups, suggestions, view, backgrounded, allMembers,
          now: Date.now(), resumedAt: resumedAt.current, resumeQuietMs, ctrlCArmedAt: ctrlCArmed.current,
        },
        ch,
        key,
      )
      if (action) run(action)
    },
    { isActive: active },
  )
}
