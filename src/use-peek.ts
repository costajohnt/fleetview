import { useEffect, useRef, useState } from 'react'
import { useInput } from 'ink'
import { graphemes } from './text-utils.ts'
import { parseMouseEvents } from './ui/mouse.ts'
import { questionOptions, suggestedReply } from './ui/peek.ts'
import { OPENCODE_CAPABILITIES } from './backends/opencode/index.ts'

// Peek's controller: the state, the message fetch, the reply/answer paths and the panel's own key
// handling, lifted out of App so the roster closure stops carrying them. Everything App owns and
// this needs is passed in explicitly — there are no globals and no reaching back into App.
//
// `navRows`/`selectedKey`/`setSelectedKey` are what ↑/↓ walk (selection-follow), `attach` is what
// ⏎/→ do, `reconcileRef` is the shared per-worktree seed chain the failure paths reconcile through,
// and `rerender` is how the savedReplies ref (deliberately not state) reaches the screen.
// TODO(types): all inputs are App-owned dynamic collaborators (client, session store, nav rows,
// reconcile chain); typed loose because their real shapes live in other modules and closing them
// here would only duplicate/desync those definitions.
export function usePeek({
  client,
  store,
  navRows,
  selectedKey,
  setSelectedKey,
  attach,
  mode,
  setMode,
  rerender,
  reconcileRef,
  serverReady,
  attached,
  // Per-row backend wiring from App. `backendFor` returns null for opencode, which every path below
  // reads as "do exactly what you did before"; `capabilitiesOf` is the only thing allowed to decide
  // whether an answer key does anything.
  backendFor = () => null,
  capabilitiesOf = () => OPENCODE_CAPABILITIES,
}: {
  client: any
  store: any
  navRows: any[]
  selectedKey: any
  setSelectedKey: (key: any) => void
  attach: (target: any) => void
  mode: string
  setMode: (mode: string) => void
  rerender: () => void
  reconcileRef: { current?: ((projectKey: any) => Promise<any>) | null }
  serverReady: boolean
  attached: boolean
  backendFor?: (row: any) => any
  capabilitiesOf?: (row: any) => { questions: boolean }
}) {
  // "Undeliverable replies are saved and sent when the session's process starts again." Keyed by
  // `${projectKey}:${id}` so a saved reply follows its session and nothing else. Replies prefixed
  // with `!` are deliberately not saved — agent view doesn't either, because a shell command that
  // arrives much later is a different instruction than the one that was meant.
  const savedReplies = useRef(new Map())
  // M15: per-key send epoch. sendReply's success path deletes the saved key, which makes "user
  // sent a newer reply directly" indistinguishable from "nothing happened" — a failed flush's
  // catch would then re-queue the stale body and a later poll would deliver it AFTER the newer
  // reply (the "late reply is a different instruction" failure the comments above warn about).
  // Every successful send bumps the key's epoch; a flush only re-queues if the epoch it captured
  // is still current.
  const replyEpochs = useRef(new Map())
  // peekTarget: same shape as target, captured when peek opens — unlike other dialog targets it
  // DOES follow explicit ↑/↓ while peek is open (selection-follow), but never passive store churn.
  const [peekTarget, setPeekTarget] = useState<any>(null) // TODO(types): a session row from the store; dynamic wire shape
  // null = loading, 'error' = failed, 'unsupported' = this backend has no message API, array = loaded
  const [peekMessages, setPeekMessages] = useState<any[] | 'error' | 'unsupported' | null>(null)
  // M6: { id, message } | null — scoped to the session id it was raised for, so a reply that
  // fails after the user has already navigated to a different peek target can't paint its error
  // onto the wrong session (the failure race is real: navigation clears this to null immediately,
  // but the async .catch() can still resolve afterward with a stale closure over the old target).
  const [peekError, setPeekError] = useState<{ id: any; message: string } | null>(null)
  const [peekReply, setPeekReply] = useState('') // the peek panel's own input, separate from dispatch

  // Fetch on open/selection-change; the cleanup's `cancelled` flag is the latest-wins guard —
  // a superseded effect instance's resolution can never write over a newer target's state.
  useEffect(() => {
    if (mode !== 'peek' || !peekTarget) return
    let cancelled = false
    setPeekMessages(null)
    // `listMessages` is opencode's GET /session/:id/message. A process-backed session's transcript
    // is a file on disk in the CLI's own format and there is no read API in the Backend contract, so
    // asking the opencode server about an id it has never heard of would render a fetch failure for
    // a session that is perfectly healthy. Say what is actually true instead.
    if (backendFor(peekTarget)) {
      setPeekMessages('unsupported')
      return
    }
    client
      .listMessages(peekTarget.id, peekTarget.projectKey)
      .then((msgs: any) => { if (!cancelled) setPeekMessages(msgs) })
      .catch(() => { if (!cancelled) setPeekMessages('error') })
    return () => { cancelled = true }
  }, [mode, peekTarget])

  // Space on a roster row opens the panel on it.
  const openPeek = (row: any) => {
    setPeekTarget(row)
    setPeekError(null)
    setMode('peek')
  }

  // Oldest-first: session-store's pendingFor sorts by asked-order (M5).
  const peekPending = mode === 'peek' && peekTarget ? store.pendingFor(peekTarget.projectKey, peekTarget.id) : []
  // Answerable in place now: a question's options are pickable by number, and anything else can
  // be answered by typing in the peek reply input.
  const peekPendingQuestions =
    mode === 'peek' && peekTarget ? store.pendingQuestionsFor(peekTarget.projectKey, peekTarget.id) : []

  // Sends a follow-up to the peeked session. A `!` prefix runs the rest as a shell command
  // instead: "Prefix a reply with `!` to send a Bash command instead."
  const sendReply = async (text: string, row: any) => {
    setPeekReply('')
    setPeekError(null)
    const bang = text.startsWith('!')
    const body = bang ? text.slice(1).trim() : text
    if (!body) return
    const key = `${row.projectKey}:${row.id}`
    const backend = backendFor(row)
    // A `!` reply is opencode's shell route; the process-backed CLIs have no equivalent, and sending
    // the command as a prompt would run something else entirely.
    if (bang && backend) return setPeekError({ id: row.id, message: "! shell replies run on opencode only" })
    try {
      if (bang) await client.runShell(row.id, body, row.projectKey)
      // A follow-up IS in the Backend contract (prompt()), and on both process backends it is a
      // resume of the same session — so replies work here even where answering a permission cannot.
      else if (backend) await backend.prompt(row.id, body, row.projectKey)
      else await client.promptAsync(row.id, body, row.projectKey)
      replyEpochs.current.set(key, (replyEpochs.current.get(key) ?? 0) + 1) // M15: supersedes any in-flight flush
      savedReplies.current.delete(key)
    } catch {
      if (bang) {
        // A shell command that arrives minutes later is a different instruction than the one meant.
        setPeekError({ id: row.id, message: "couldn't run it — shell commands aren't saved" })
        return
      }
      // The saved-reply queue re-sends through `client` off a string key alone, with no way back to
      // the row's adapter — so a process-backed reply is reported as failed rather than queued to be
      // delivered to the wrong place later.
      if (backend) return setPeekError({ id: row.id, message: `couldn't send — ${backend.name} refused the resume` })
      savedReplies.current.set(key, body)
      setPeekError({ id: row.id, message: "couldn't send — saved for when it's reachable" })
      rerender()
    }
  }

  // Retried on the project poll rather than on a reachability signal. Waiting for one meant waiting
  // for `offlineProjects` to change, which a failed reply never does — so the queue sat there until
  // something unrelated happened. Just trying again on a timer is simpler and self-correcting: a
  // send that fails goes straight back in the queue for the next tick.
  const flushSavedReplies = useRef(() => {})
  flushSavedReplies.current = () => {
    for (const [key, body] of [...savedReplies.current]) {
      const at = key.lastIndexOf(':')
      const projectKey = key.slice(0, at)
      const id = key.slice(at + 1)
      savedReplies.current.delete(key)
      const epoch = replyEpochs.current.get(key) ?? 0 // M15: captured before the send
      client
        .promptAsync(id, body, projectKey)
        .then(() => rerender())
        .catch(() => {
          // Compare-and-swap: only re-queue when the slot is still empty AND no send for this key
          // succeeded since the flush started (M15). The user can type a new reply while this send
          // is in flight — an unconditional re-add would overwrite it with the stale body — and a
          // direct sendReply success leaves the slot empty, so without the epoch check a failed
          // flush would resurrect a reply the user already superseded.
          if (!savedReplies.current.has(key) && (replyEpochs.current.get(key) ?? 0) === epoch) {
            savedReplies.current.set(key, body)
          }
          rerender()
        })
    }
  }

  // Picks option N of the oldest pending question. The reply body is one answer array per
  // question, each holding the chosen labels, so a single choice is [[label]].
  const answerQuestion = async (index: number, row: any) => {
    // Capability gate: there is no channel to deliver the answer on, so clearing the banner locally
    // would be a lie the next poll would immediately contradict.
    if (!capabilitiesOf(row).questions) {
      return setPeekError({ id: row.id, message: 'this backend has no way to take an answer — → to attach' })
    }
    const request = peekPendingQuestions[0]
    const option = questionOptions(request)[index]
    if (!option) return
    setPeekError(null)
    // Optimistic, matching the permission path: clear locally so the banner goes immediately.
    store.apply(row.projectKey, { type: 'question.replied', properties: { sessionID: row.id, requestID: request.id } })
    try {
      await client.respondQuestion(request.id, [[option.label]], row.projectKey)
    } catch {
      setPeekError({ id: row.id, message: "couldn't answer question" })
      const reconcile = reconcileRef.current?.(row.projectKey) ?? Promise.resolve({ questions: false })
      reconcile.then((outcome: any) => {
        if (!outcome.questions) store.apply(row.projectKey, { type: 'question.asked', properties: request })
      })
    }
  }

  useInput(
    (input, key) => {
      if (parseMouseEvents(input).length) return // clicks are a roster affordance; not text
      // Same disambiguation as the dispatch input: with text in the reply, printable keys are
      // text; with it empty they are commands. That is what lets y/a/d and the number keys keep
      // working while a reply input owns the panel.
      const replyEmpty = peekReply.length === 0
      // Ink's own Ctrl+C handling is off (the dispatch input needs it), so every mode has to
      // answer for it or the key is silently inert.
      if (key.ctrl && input === 'c') {
        if (!replyEmpty) return setPeekReply('')
        setMode('roster')
        setPeekTarget(null)
        setPeekMessages(null)
        setPeekError(null)
        return
      }
      if (key.escape || (replyEmpty && (key.leftArrow || input === ' '))) {
        if (!replyEmpty) return setPeekReply('')
        setMode('roster')
        setPeekTarget(null)
        setPeekMessages(null)
        setPeekReply('')
        setPeekError(null)
      } else if (!replyEmpty && key.return && peekTarget) {
        void sendReply(peekReply.trim(), peekTarget)
      } else if (!replyEmpty && (key.backspace || key.delete)) {
        setPeekReply((t) => graphemes(t).slice(0, -1).join(''))
      } else if (key.tab) {
        // "Tab fills the input with a suggested reply." Only ever the session's own words — the
        // first option of the question it asked.
        const suggestion = suggestedReply(peekPendingQuestions[0])
        if (suggestion) setPeekReply(suggestion)
      } else if (key.upArrow || key.downArrow) {
        // #61: a typed reply is state worth protecting, the same way escape and Ctrl+C already
        // treat it. Retargeting `peekTarget` while a draft is live meant the next ⏎ sent the text
        // written for one session to a different one — a real `--resume`/`promptAsync` against the
        // wrong agent in the wrong repo, with no undo. So the first arrow with a draft consumes the
        // key to clear it, and only the next one navigates.
        if (!replyEmpty) return setPeekReply('')
        // Walk the session rows in screen order by their group-form nav key — the same key the
        // roster arrows and mouse set. Using `flat`/`keyOf` here compared two key vocabularies
        // (group-form selectedKey vs worktree-form keyOf), so the lookup never matched in state
        // grouping and every peek arrow jumped relative to row 0 instead of the peeked row.
        const sessRows = navRows.filter((r: any) => r.type === 'session')
        const cur = sessRows.findIndex((r: any) => r.key === selectedKey)
        const base = cur >= 0 ? cur : 0
        const i = key.upArrow ? Math.max(0, base - 1) : Math.min(sessRows.length - 1, base + 1)
        const nr = sessRows[i]
        if (nr) {
          setSelectedKey(nr.key)
          setPeekTarget(nr.session)
          setPeekError(null)
        }
      } else if (!replyEmpty && key.rightArrow) {
        // #61: ⏎ with a draft is consumed above as "send", but → fell through to attach and threw
        // the draft away silently. Same treatment as the arrows: clear it first, attach second.
        return setPeekReply('')
      } else if ((key.return || key.rightArrow) && peekTarget) {
        attach(peekTarget)
      } else if (
        replyEmpty &&
        /^[1-9]$/.test(input) &&
        peekTarget &&
        // Only when there are numbered choices to pick. An option-less question asks for a typed
        // reply, and that reply is allowed to start with a digit.
        questionOptions(peekPendingQuestions[0]).length > 0
      ) {
        void answerQuestion(Number(input) - 1, peekTarget)
      } else if (replyEmpty && (input === 'y' || input === 'a' || input === 'd') && peekTarget && peekPending.length > 0) {
        const payload = peekPending[0] // oldest first
        // Same gate as answerQuestion: a backend whose denials are reported after the fact has
        // nothing listening for y/a/d, so the key says why instead of pretending.
        if (!capabilitiesOf(peekTarget).questions) {
          return setPeekError({ id: peekTarget.id, message: 'this backend has no way to take an answer — → to attach' })
        }
        const reply = input === 'y' ? 'once' : input === 'a' ? 'always' : 'reject'
        setPeekError(null)
        // optimistic: apply the reply locally exactly as the real SSE permission.replied would,
        // so the banner clears immediately regardless of server round-trip latency.
        store.apply(peekTarget.projectKey, {
          type: 'permission.replied',
          properties: { sessionID: peekTarget.id, requestID: payload.id, reply },
        })
        client
          .respondPermission(payload.id, reply, peekTarget.projectKey)
          .catch(() => {
            setPeekError({ id: peekTarget.id, message: "couldn't answer permission" })
            // I1: a failed respond can mean the request never landed (server unreachable — the
            // original I3 case) OR that it already landed elsewhere (a concurrent answer from an
            // attached terminal, or a duplicate POST from a double keypress) and this catch is
            // just late news. Blindly re-adding would resurrect an already-answered permission
            // (phantom "waiting", poisoned retries). Reconcile via the authoritative reseed
            // instead — only fall back to a blind re-add when the reconcile fetch itself fails.
            // Through the shared chain, so this cannot interleave with a reconnect's seed for the
            // same project and resurrect an already-answered permission. If the reconcile itself
            // couldn't reach the server, fall back to putting the permission back — an unanswered
            // request the user can't see is worse than one shown twice.
            const reconcile =
              reconcileRef.current?.(peekTarget.projectKey) ?? Promise.resolve({ permissions: false })
            reconcile.then((outcome: any) => {
              // Only the permission list matters here; an unrelated endpoint failing must not put
              // an answered permission back on screen.
              if (!outcome.permissions) {
                store.apply(peekTarget.projectKey, { type: 'permission.asked', properties: payload })
              }
            })
          })
      } else if (key.backspace || key.delete) {
        setPeekReply((t) => graphemes(t).slice(0, -1).join(''))
      } else if (input && !key.ctrl && !key.meta) {
        const text = input.replace(/[\r\n]+/g, ' ').replace(/[\u0000-\u001F\u007F]/g, '')
        if (text) setPeekReply((t) => t + text)
      }
    },
    { isActive: mode === 'peek' && serverReady && !attached },
  )

  // M6: only surface peekError when it was raised for the session currently being peeked.
  const peekErrorMessage = peekError && peekTarget && peekError.id === peekTarget.id ? peekError.message : null
  const savedReply = peekTarget ? savedReplies.current.get(`${peekTarget.projectKey}:${peekTarget.id}`) ?? null : null

  return {
    peekTarget,
    peekMessages,
    peekReply,
    peekPending,
    peekPendingQuestions,
    peekErrorMessage,
    savedReply,
    openPeek,
    flushSavedReplies,
  }
}
