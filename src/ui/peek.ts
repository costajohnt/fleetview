import React from 'react'
import { basename } from 'node:path'
import { Box, Text } from 'ink'
import { graphemes, truncateGraphemes, osc8, stripControl } from '../text-utils.ts'
import { prStatus, prColor } from '../pull-requests.ts'
import { theme } from './theme.ts'

// Only 'text' parts are ever the actual reply — 'reasoning' parts carry `.text` too but are
// chain-of-thought and must never render (see .superpowers/sdd/v3-task-1-2-report.md).
// Defensive on shape, not on content: a message missing `parts` would otherwise throw inside
// render, and an exception in an Ink render takes down the whole app rather than one panel.
// stripControl (M12): the body is model/user text straight off the wire. Ink's tokenizer drops
// most escapes but passes DCS (ESC P … ESC \) and OSC 8 hyperlinks through, so an unstripped reply
// could drive the terminal or render a spoofed clickable link. Same treatment session-store.ts
// gives titles/snippets.
const messageText = (m: any) => stripControl((m?.parts ?? []).filter((p: any) => p.type === 'text').map((p: any) => p.text ?? '').join(' '))

const ROLE_LABEL: Record<string, string> = { user: 'you:', assistant: 'opencode:' }

// Hard-wraps `text` to terminal rows: split on '\n', then chop each resulting line into
// `columns`-wide chunks. Pure + exported so truncation math (F3) is unit-testable without ink.
// Chunks by grapheme cluster (M5: shared with the snippet/roster truncation helper), not code
// unit, so a surrogate pair or emoji+modifier sequence never gets split across chunks (M2).
// ponytail: width is grapheme count, not display width — every grapheme counts as 1 cell, so
// East-Asian-Wide/emoji glyphs that render 2 cells wide can still overflow a row. Upgrade to a
// wcwidth-style width-2 lookup per grapheme if that misalignment shows up in practice.
export function wrapLines(text: string, columns: number) {
  const width = Math.max(1, columns || 80)
  return text.split('\n').flatMap((line) => {
    if (line.length === 0) return ['']
    const g = graphemes(line)
    const chunks = []
    for (let i = 0; i < g.length; i += width) chunks.push(g.slice(i, i + width).join(''))
    return chunks
  })
}

// permission.asked's verified shape is {id, sessionID, permission, patterns, metadata, always,
// tool?} — there is no title/description field, so build the label from `permission` (+ patterns
// when present) and only fall back to the id when `permission` itself is missing.
// stripControl for the same reason messageText strips (M12): permission names and patterns are the
// agent's own strings off the wire, and Ink passes OSC 8 and DCS straight through to the terminal.
const permissionLabel = (p: any) => stripControl(p.permission ? `${p.permission}${p.patterns?.length ? ` ${p.patterns.join(', ')}` : ''}` : p.id)

// Verified against opencode 1.18.4's OpenAPI: question.asked is {id, sessionID, questions:
// [{question, header, options: [{label, description}], multiple, custom}], tool?}. Earlier code
// guessed `text`/`label` for the prompt; the field is `question`. Only the first sub-question of
// the oldest request is shown, and its options are what the number keys pick.
const questionLabel = (q: any) => {
  const first = q.questions?.[0]
  return stripControl(first?.question ?? first?.header ?? q.tool ?? q.id)
}

// Stripped here rather than at each render site so peek's numbered list, the Tab suggestion and
// use-peek's answer all get a clean label from one place. Stripping before the answer goes back on
// the wire is deliberate: a label that only matches with an ESC in it is not a label worth echoing.
export const questionOptions = (q: any) =>
  (q?.questions?.[0]?.options ?? []).map((o: any) => (typeof o?.label === 'string' ? { ...o, label: stripControl(o.label) } : o))

// "Press Tab to fill the input with a suggested reply." The only reply fleetview can suggest honestly
// is one the session already offered: the first option of a pending question. With no options
// there is nothing to suggest, and inventing one would put words in the user's mouth.
export const suggestedReply = (question: any) => questionOptions(question)[0]?.label ?? null

// "A `waiting Nm` line shows how long the session has waited — different from the row's age." The
// row's age is how long the session has existed; this is how long it has been sitting on you.
export function waitedLabel(since: number, now = Date.now()) {
  if (!since) return null
  const sec = Math.max(0, Math.floor((now - since) / 1000))
  if (sec < 60) return `waiting ${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `waiting ${min}m`
  const hr = Math.floor(min / 60)
  return hr < 24 ? `waiting ${hr}h` : `waiting ${Math.floor(hr / 24)}d`
}

// M7: caps a single banner line to at most `maxRows` wrapped rows, ellipsizing the last one if it
// still overflows after wrapping — a long permission pattern or question can't push past the
// reserved space and overflow the viewport.
// ponytail: ellipsis slice is a code-unit trim, not grapheme-aware like wrapLines — fine for the
// ascii-heavy patterns/labels this banner actually carries; revisit if emoji labels show up.
function wrapBanner(text: string, columns: number, maxRows = 2) {
  const wrapped = wrapLines(text, columns)
  if (wrapped.length <= maxRows) return wrapped
  const capped = wrapped.slice(0, maxRows)
  const last = capped[maxRows - 1]
  capped[maxRows - 1] = (last.length > 1 ? last.slice(0, -1) : last) + '…'
  return capped
}

// "Open the peek panel to see them all" — the row can only show a number and a colour, so peek is
// where a session's pull requests are actually listed, one per line, with the URL that the row
// deliberately does not hyperlink.
const prLine = (pr: any) => `${`#${pr.number}`} ${prStatus(pr)} · ${pr.url}`


// messages: null = loading, 'error' = fetch failed, [] = loaded-but-empty, array = loaded turns.
// pending: this session's pendingPermissions, OLDEST first — only the oldest is answerable, the
// rest just count toward the "(+N more)" hint. pendingQuestions: same shape, and answerable here —
// a question's predefined choices render as a numbered list and a number key picks one; anything
// else takes a typed reply. error: peek-local respondPermission failure line.
// TODO(types): props are session/opencode wire data plus dynamic UI state — any.
export function Peek({
  target,
  messages,
  pending = [],
  pendingQuestions = [],
  error,
  maxRows = Infinity,
  columns = 80,
  reply = '',
  savedReply = null,
  now,
  prReason = null,
  // Whether this session's backend can take an answer from the roster (backend.capabilities.
  // questions). The banners are unaffected — a blocked session is blocked either way — but the
  // `y allow · a always · d deny` line would be an offer fleetview cannot keep, so it is replaced by
  // what the user actually has to do.
  canAnswer = true,
  backend = null,
}: any) {
  let lines
  if (messages === null) lines = [{ text: 'loading…', dim: true }]
  else if (messages === 'error') lines = [{ text: "couldn't load messages", dim: true }]
  else if (messages === 'unsupported') lines = [{ text: 'no transcript over the wire — → to attach and read it', dim: true }]
  else if (messages.length === 0) lines = [{ text: 'no messages yet', dim: true }]
  else {
    lines = messages.slice(-2).flatMap((m: any) => {
      const role = m?.info?.role
      return [
        { text: role ? ROLE_LABEL[role] ?? `${role}:` : 'message:', dim: true },
        { text: messageText(m) },
      ]
    })
  }

  const waited = waitedLabel(target.waitingSince, now)
  const prs = target.prs ?? []
  // Each line is truncated rather than wrapped: a pull request URL is long, and letting three of
  // them wrap would eat the body of the panel on a narrow terminal.
  const prRows = prs.map((pr: any) => ({ text: osc8(pr.url, truncateGraphemes(prLine(pr), columns)), color: prColor(pr) }))
  // No pull requests and a reason means gh could not answer. Saying so here rather than as a
  // startup notice keeps fleetview from nagging in every repository that will never have one.
  const prReasonRow = prs.length === 0 && prReason ? truncateGraphemes(prReason, columns) : null
  const permLineText = pending.length > 0
    ? `⚠ permission: ${permissionLabel(pending[0])}${pending.length > 1 ? ` (+${pending.length - 1} more)` : ''}`
    : null
  const questionLineText = pendingQuestions.length > 0
    ? `? question: ${questionLabel(pendingQuestions[0])}${pendingQuestions.length > 1 ? ` (+${pendingQuestions.length - 1} more)` : ''}`
    : null
  const permRows = permLineText ? wrapBanner(permLineText, columns) : []
  const questionRows = questionLineText ? wrapBanner(questionLineText, columns) : []
  // "When the session asks a question with predefined choices, the peek panel shows them as a
  // numbered list and you can press a number key to pick one." Capped at 9 because that's how
  // many single keypresses there are — and capped again below by whatever the viewport allows,
  // since banners plus nine options can exceed a short terminal on their own.
  const allOptions = questionLineText ? questionOptions(pendingQuestions[0]).slice(0, 9) : []
  // Fixed cost before options: title + reply + each banner and its hint + the error line.
  const extras = (waited ? 1 : 0) + (savedReply ? 1 : 0) + prRows.length + (prReasonRow ? 1 : 0)
  const fixedReserve =
    2 + extras + (permLineText ? permRows.length + 1 : 0) + (questionLineText ? questionRows.length + 1 : 0) + (error ? 1 : 0)
  // Leave at least one row for the body; drop options rather than overflow the panel.
  const options = allOptions.slice(0, Math.max(0, maxRows - fixedReserve - 1))
  const optionsHidden = allOptions.length - options.length

  // Truncation must count rendered terminal ROWS, not message entries — a wrapped multi-line
  // message otherwise overflows the viewport even though it "counted" as one line (F3).
  const rows = lines.flatMap((l: any) => wrapLines(l.text, columns).map((text: string) => ({ text, dim: l.dim })))
  // reserve: title row + (permission banner rows + hint row) + (question banner rows + hint row) + (error row), all optional
  // reserve also covers the numbered options and the always-present reply input line.
  const reserved =
    2 +
    extras +
    (permLineText ? permRows.length + 1 : 0) +
    (questionLineText ? questionRows.length + 1 + options.length : 0) +
    (error ? 1 : 0)
  // When the banners alone fill the viewport there is no body to show. Emitting a floor of one row
  // regardless would put the panel over maxRows, so an over-full panel drops the body entirely
  // rather than overflowing the terminal.
  const roomForBody = maxRows - reserved
  const bodyRows = Math.max(0, roomForBody)
  const truncated = rows.length > bodyRows
  const slice = truncated ? rows.slice(0, Math.max(0, bodyRows - 1)) : rows

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(
      Box,
      { gap: 1 },
      // The title is unbounded — it holds the whole dispatch prompt until opencode names the
      // session — so it has to be cut here too, or this "one row" wraps to several.
      React.createElement(Text, { bold: true }, truncateGraphemes(target.title ?? '', Math.max(8, Math.floor(columns / 2)))),
      React.createElement(Text, { dimColor: true }, basename(target.projectKey) || target.projectKey),
    ),
    waited ? React.createElement(Text, { key: 'waited', dimColor: true }, waited) : null,
    ...prRows.map((r: any, i: number) => React.createElement(Text, { key: `pr${i}`, color: r.color }, r.text)),
    prReasonRow ? React.createElement(Text, { key: 'prReason', dimColor: true }, prReasonRow) : null,
    ...permRows.map((t, i) => React.createElement(Text, { key: `perm${i}`, color: theme.warn }, t)),
    permLineText
      ? React.createElement(
          Text,
          { dimColor: true },
          canAnswer ? 'y allow · a always · d deny' : `${backend ?? 'this backend'} can't be answered from here — → to attach`,
        )
      : null,
    ...questionRows.map((t, i) => React.createElement(Text, { key: `q${i}`, color: theme.info }, t)),
    ...options.map((o: any, i: number) =>
      React.createElement(Text, { key: `opt${i}` }, `  ${i + 1}. ${o.label}`),
    ),
    questionLineText
      ? React.createElement(
          Text,
          { dimColor: true },
          !canAnswer
            ? `${backend ?? 'this backend'} can't be answered from here — → to attach`
            : options.length
              ? `press a number to answer, tab to fill${optionsHidden > 0 ? ` (+${optionsHidden} more, attach to see)` : ''}`
              : 'type a reply and press ⏎',
        )
      : null,
    error ? React.createElement(Text, { color: theme.danger }, error) : null,
    // "Undeliverable replies are saved and sent when the session's process starts again, and the
    // error message says the reply was saved."
    savedReply
      ? React.createElement(Text, { color: theme.warn }, `saved — will send when it is reachable: ${truncateGraphemes(savedReply, Math.max(8, columns - 40))}`)
      : null,
    ...slice.map((l: any, i: number) => React.createElement(Text, { key: i, dimColor: l.dim }, l.text)),
    truncated ? React.createElement(Text, { dimColor: true }, '…') : null,
    // The reply input is what makes peek more than a viewer: "Type a reply in the peek panel and
    // press Enter to send it to that session."
    React.createElement(
      Text,
      { dimColor: reply.length === 0 },
      reply.length === 0 ? '> █ reply · ! runs a shell command · ← back' : `> ${reply}█`,
    ),
  )
}
