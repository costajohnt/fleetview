import React from 'react'
import { test, expect } from 'vitest'
import { render } from 'ink-testing-library'
import { Peek, wrapLines } from '../src/ui/peek.ts'

// --- wrapLines: pure helper (F3) ---

test('wrapLines: empty string yields a single empty row', () => {
  expect(wrapLines('', 80)).toEqual([''])
})

test('wrapLines: a line exactly `columns` wide yields exactly one row, no trailing empty', () => {
  expect(wrapLines('abcde', 5)).toEqual(['abcde'])
})

test('wrapLines: multi-newline text yields one row per line, no wrapping needed', () => {
  expect(wrapLines('a\nb\nc', 80)).toEqual(['a', 'b', 'c'])
})

test('wrapLines: a line longer than columns hard-wraps into fixed-width chunks', () => {
  expect(wrapLines('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
})

test('wrapLines: an emoji string wraps without splitting a surrogate pair (M2)', () => {
  const line = '😀😀😀😀😀😀😀😀😀😀' // each emoji is a surrogate pair (2 UTF-16 code units)
  const chunks = wrapLines(line, 3)
  expect(chunks.join('')).toBe(line) // no data lost/reordered
  for (const chunk of chunks) {
    expect(/\p{Surrogate}/u.test(chunk)).toBe(false) // no lone surrogate half in any chunk
  }
})

// --- Peek: message bodies are untrusted terminal input (M12) ---

test('Peek: escape sequences in a message body are stripped before render (M12)', () => {
  // OSC 8 hyperlink (Ink passes it through, so a model could render a spoofed clickable link) and a
  // DCS sequence, which Ink's tokenizer also lets reach the terminal.
  const body = `a]8;;http://evil.exampleclick]8;;bPq;danger\\c`
  const frame = render(
    React.createElement(Peek, {
      target: { title: 't', projectKey: '/p' },
      messages: [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: body }] }],
      columns: 200,
    }),
  ).lastFrame()!
  expect(frame).not.toContain(']8;;') // no hyperlink escape survives
  expect(frame).not.toContain('P') // no DCS
  expect(frame).toContain('a]8;;http://evil.exampleclick]8;;bPq;danger\\c') // payload rendered as inert text
})

// --- #32: a shell job's output lives in a tool part, not a text part ---

test("#32: a message with no text parts renders its tool output, so a shell job's output is readable", () => {
  const frame = render(
    React.createElement(Peek, {
      target: { title: '! sleep 5 && echo shell-job-done', projectKey: '/p' },
      messages: [{ info: { role: 'assistant' }, parts: [{ type: 'tool', state: { output: 'shell-job-done\n' } }] }],
      columns: 200,
    }),
  ).lastFrame()!
  expect(frame).toContain('opencode:')
  expect(frame).toContain('shell-job-done')
})

test('#32: a normal turn still renders only its reply — tool output is a fallback, not an addition', () => {
  const frame = render(
    React.createElement(Peek, {
      target: { title: 't', projectKey: '/p' },
      messages: [
        {
          info: { role: 'assistant' },
          parts: [
            { type: 'text', text: 'done, the tests pass' },
            { type: 'tool', state: { output: 'a very long tool dump nobody asked for' } },
          ],
        },
      ],
      columns: 200,
    }),
  ).lastFrame()!
  expect(frame).toContain('done, the tests pass')
  expect(frame).not.toContain('nobody asked for')
})

// --- Peek: a failed turn's error (#24) ---

test('Peek: an assistant message with info.error renders the reason instead of an empty reply', () => {
  const frame = render(
    React.createElement(Peek, {
      target: { title: 't', projectKey: '/p' },
      messages: [
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'do the thing' }] },
        // The live shape: the turn failed server-side, so it carries no text parts at all.
        { info: { role: 'assistant', error: { name: 'APIError', data: { message: 'No endpoints found that support tool use.' } } }, parts: [] },
      ],
      columns: 200,
    }),
  ).lastFrame()!
  expect(frame).toContain('error: APIError: No endpoints found that support tool use.')
})

test('Peek: a turn that said something before failing keeps both the text and the error', () => {
  const frame = render(
    React.createElement(Peek, {
      target: { title: 't', projectKey: '/p' },
      messages: [
        { info: { role: 'assistant', error: { name: 'APIError', data: { message: 'boom' } } }, parts: [{ type: 'text', text: 'starting' }] },
      ],
      columns: 200,
    }),
  ).lastFrame()!
  expect(frame).toContain('starting')
  expect(frame).toContain('error: APIError: boom')
})

test('Peek: a message with no error renders no error line', () => {
  const frame = render(
    React.createElement(Peek, {
      target: { title: 't', projectKey: '/p' },
      messages: [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'all good' }] }],
      columns: 200,
    }),
  ).lastFrame()!
  expect(frame).toContain('all good')
  expect(frame).not.toContain('error:')
})

// --- Peek: truncation counts rendered rows, not message entries (F3) ---

// --- pending permission banner (Wave B) ---

test('Peek: pending permission renders a warning line with an id fallback when `permission` is absent, plus a key hint', () => {
  const { lastFrame } = render(
    React.createElement(Peek, {
      target: { title: 't', projectKey: '/p' },
      messages: [],
      pending: [{ id: 'p1' }],
    }),
  )
  const frame = lastFrame()
  expect(frame).toContain('⚠ permission: p1') // no `permission` field → falls back to id
  expect(frame).toContain('y allow · a always · d deny')
})

test('Peek: labels from the real permission.asked shape — `permission` + joined `patterns`', () => {
  const frame = render(
    React.createElement(Peek, {
      target: { title: 't', projectKey: '/p' },
      messages: [],
      pending: [{ id: 'p1', permission: 'bash', patterns: ['rm -rf tmp/'] }],
    }),
  ).lastFrame()
  expect(frame).toContain('⚠ permission: bash rm -rf tmp/')
})

// M3: the banners and the numbered options are wire text too — permission names, patterns, question
// headers and option labels are all the agent's strings, and only message bodies were stripped.
const OSC8 = ']8;;http://evil.exampleclick]8;;'
const DCS = 'Pq;danger\\'

test('Peek: escape sequences in a permission name and its patterns are stripped before render (M3)', () => {
  const frame = render(
    React.createElement(Peek, {
      target: { title: 't', projectKey: '/p' },
      messages: [],
      pending: [{ id: 'p1', permission: `bash${OSC8}`, patterns: [`rm -rf tmp/${DCS}`] }],
      columns: 200,
    }),
  ).lastFrame()!
  expect(frame).not.toContain(']8;;')
  expect(frame).not.toContain('P')
  expect(frame).toContain('⚠ permission: bash]8;;http://evil.exampleclick]8;; rm -rf tmp/Pq;danger\\')
})

test('Peek: escape sequences in a question header and its option labels are stripped before render (M3)', () => {
  const frame = render(
    React.createElement(Peek, {
      target: { title: 't', projectKey: '/p' },
      messages: [],
      pendingQuestions: [{ id: 'q1', questions: [{ header: `pick one${DCS}`, options: [{ label: `merge it${OSC8}` }] }] }],
      columns: 200,
    }),
  ).lastFrame()!
  expect(frame).not.toContain(']8;;')
  expect(frame).not.toContain('P')
  expect(frame).toContain('? question: pick onePq;danger\\')
  expect(frame).toContain('1. merge it]8;;http://evil.exampleclick]8;;')
})

// --- linked pull requests (Task 5) ---

const openPr = (number: number, over: Record<string, any> = {}) => ({ number, url: `https://github.com/o/r/pull/${number}`, state: 'OPEN', isDraft: false, headRefName: 'opencode/x', statusCheckRollup: [], reviewDecision: '', ...over })

test('peek lists every linked pull request with its state and url', () => {
  const target = { id: 's1', projectKey: '/repo', title: 'fix', prs: [openPr(12), openPr(34, { state: 'MERGED' })] }
  const frame = render(
    React.createElement(Peek, { target, messages: [], pending: [], pendingQuestions: [], columns: 100 }),
  ).lastFrame()
  expect(frame).toContain('#12')
  expect(frame).toContain('#34')
  expect(frame).toContain('merged')
  expect(frame).toContain('https://github.com/o/r/pull/12')
})

test('peek says why there is no pull request data rather than staying silent', () => {
  // Rows stay clean and there is no startup notice, so this line is the only place a user who
  // wonders where their label went can find out.
  const target = { id: 's1', projectKey: '/repo', title: 'fix', prs: [] }
  const frame = render(
    React.createElement(Peek, {
      target,
      messages: [],
      pending: [],
      pendingQuestions: [],
      prReason: 'gh is not installed',
      columns: 100,
    }),
  ).lastFrame()
  expect(frame).toContain('gh is not installed')
})

test('the pull request lines are reserved, so peek still fits its viewport', () => {
  const target = {
    id: 's1',
    projectKey: '/repo',
    title: 'fix',
    prs: [openPr(1), openPr(2), openPr(3)],
  }
  const messages = [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'y'.repeat(500) }] }]
  const frame = render(
    React.createElement(Peek, { target, messages, pending: [], pendingQuestions: [], maxRows: 10, columns: 60 }),
  ).lastFrame()
  expect(frame!.split('\n').length).toBeLessThanOrEqual(10)
})

test('Peek: multiple pending permissions show a "(+N more)" suffix on the oldest', () => {
  const frame = render(
    React.createElement(Peek, {
      target: { title: 't', projectKey: '/p' },
      messages: [],
      pending: [{ id: 'p1' }, { id: 'p2' }],
    }),
  ).lastFrame()
  expect(frame).toContain('⚠ permission: p1 (+1 more)')
})

test('Peek: no pending permissions renders no banner', () => {
  const frame = render(
    React.createElement(Peek, { target: { title: 't', projectKey: '/p' }, messages: [] }),
  ).lastFrame()
  expect(frame).not.toContain('⚠')
  expect(frame).not.toContain('allow')
})

// --- M7: permission banner wraps through the same path as message lines ---

test('M7: a long permission pattern is wrapped to the viewport width, not left overflowing', () => {
  const longPattern = 'a'.repeat(50)
  const { lastFrame } = render(
    React.createElement(Peek, {
      target: { title: 't', projectKey: '/p' },
      messages: [],
      pending: [{ id: 'p1', permission: 'bash', patterns: [longPattern] }],
      columns: 20,
    }),
  )
  const frame = lastFrame()
  const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, '') // color codes would otherwise inflate .length
  // only the wrapped banner rows themselves are in scope — the fixed-text hint line below it
  // ('y allow · a always · d deny') is intentionally not wrapped and is naturally >20 chars.
  const bannerRows = frame!.split('\n').map(stripAnsi).filter((l) => l.includes('⚠') || /^a+…?$/.test(l.trimEnd()))
  expect(bannerRows.length).toBe(2) // capped at 2 rows, not left to overflow further
  for (const line of bannerRows) expect(line.trimEnd().length).toBeLessThanOrEqual(20)
  expect(frame).toContain('…') // overflow is ellipsized, not silently dropped
  expect(frame).toContain('y allow · a always · d deny') // banner wrapping didn't clobber the hint line
})

// --- M8: question banner in peek (read-only) ---

// Field names verified against opencode 1.18.4's OpenAPI: QuestionInfo is
// {question, header, options: [{label, description}]}. Earlier code guessed `text`.
test('M8: pending question renders a "? question:" banner and its choices as a numbered list', () => {
  const frame = render(
    React.createElement(Peek, {
      target: { title: 't', projectKey: '/p' },
      messages: [],
      pendingQuestions: [
        {
          id: 'q1',
          sessionID: 's1',
          questions: [
            {
              question: 'proceed?',
              header: 'proceed',
              options: [
                { label: 'yes, rebase', description: '' },
                { label: 'no, merge', description: '' },
              ],
            },
          ],
        },
      ],
    }),
  ).lastFrame()
  expect(frame).toContain('? question: proceed?')
  expect(frame).toContain('1. yes, rebase')
  expect(frame).toContain('2. no, merge')
  expect(frame).toContain('press a number to answer')
})

test('a question with no predefined choices asks for a typed reply instead of numbers', () => {
  const frame = render(
    React.createElement(Peek, {
      target: { title: 't', projectKey: '/p' },
      messages: [],
      pendingQuestions: [{ id: 'q1', sessionID: 's1', questions: [{ question: 'which branch?', header: 'branch', options: [] }] }],
    }),
  ).lastFrame()
  expect(frame).toContain('type a reply and press ⏎')
})

test('the reply input shows a hint when empty and the typed text otherwise', () => {
  const base = { target: { title: 't', projectKey: '/p' }, messages: [] }
  expect(render(React.createElement(Peek, base)).lastFrame()).toContain('reply')
  expect(render(React.createElement(Peek, { ...base, reply: 'try again' })).lastFrame()).toContain('try again█')
})

test('M8: multiple pending questions show a "(+N more)" suffix on the oldest', () => {
  const frame = render(
    React.createElement(Peek, {
      target: { title: 't', projectKey: '/p' },
      messages: [],
      pendingQuestions: [
        { id: 'q1', questions: [{ question: 'a?', header: 'a', options: [] }] },
        { id: 'q2', questions: [{ question: 'b?', header: 'b', options: [] }] },
      ],
    }),
  ).lastFrame()
  expect(frame).toContain('? question: a? (+1 more)')
})

test('M8: questionLabel falls back to tool name, then id, when the question text is absent', () => {
  const withTool = render(
    React.createElement(Peek, {
      target: { title: 't', projectKey: '/p' },
      messages: [],
      pendingQuestions: [{ id: 'q1', questions: [], tool: 'ask' }],
    }),
  ).lastFrame()
  expect(withTool).toContain('? question: ask')

  const idOnly = render(
    React.createElement(Peek, {
      target: { title: 't', projectKey: '/p' },
      messages: [],
      pendingQuestions: [{ id: 'q1', questions: [] }],
    }),
  ).lastFrame()
  expect(idOnly).toContain('? question: q1')
})

test('M8: no pending questions renders no question banner', () => {
  const frame = render(
    React.createElement(Peek, { target: { title: 't', projectKey: '/p' }, messages: [] }),
  ).lastFrame()
  expect(frame).not.toContain('? question')
  expect(frame).not.toContain('attach to answer')
})

test('Peek: error prop renders a peek-local error line', () => {
  const frame = render(
    React.createElement(Peek, { target: { title: 't', projectKey: '/p' }, messages: [], error: "couldn't answer permission" }),
  ).lastFrame()
  expect(frame).toContain("couldn't answer permission")
})

test('Peek: a 3-line message with long lines renders within maxRows', () => {
  const longLine = 'x'.repeat(50) // at columns=20, each line wraps to 3 rows
  const messages = [
    {
      info: { role: 'assistant' },
      parts: [{ type: 'text', text: [longLine, longLine, longLine].join('\n') }],
    },
  ]
  const maxRows = 6
  const { lastFrame } = render(
    React.createElement(Peek, { target: { title: 't', projectKey: '/p' }, messages, maxRows, columns: 20 }),
  )
  const frameLines = lastFrame()!.split('\n')
  expect(frameLines.length).toBeLessThanOrEqual(maxRows)
})

// An exception thrown inside an Ink render takes down the whole app, so the one place that
// consumes raw server messages must not assume their shape.
test('a malformed message renders instead of crashing the app', () => {
  const frame = render(
    React.createElement(Peek, {
      target: { title: 't', projectKey: '/p' },
      messages: [{}, { info: {} }, { info: { role: 'assistant' } }],
    }),
  ).lastFrame()
  expect(frame).toContain('t')
})

test('a pull request line is wrapped in an OSC 8 hyperlink', () => {
  const target = { id: 's1', projectKey: '/r', title: 't', status: 'idle', prs: [openPr(9)] }
  const frame = render(React.createElement(Peek, { target, messages: [], pending: [], pendingQuestions: [], columns: 100 })).lastFrame()
  const row = frame!.split('\n').find((l) => l.includes('#9'))
  // Opener names the URL; a closer must follow or an unclosed link swallows the frame.
  expect(row).toContain(`\u001B]8;;${openPr(9).url}\u0007`)
  expect(row!.split('\u001B]8;;').length).toBe(3)
})

test('a pull request url carrying a control byte is not made a hyperlink', () => {
  // The URL half of OSC 8 is the one escape Ink passes through, so a BEL/ESC in it would terminate
  // the sequence early and let the rest drive the terminal. Such a line renders as plain text.
  const evil = `https://github.com/o/r/pull/9${String.fromCharCode(7)}\u001B]0;pwned`
  const target = { id: 's1', projectKey: '/r', title: 't', status: 'idle', prs: [openPr(9, { url: evil })] }
  const frame = render(React.createElement(Peek, { target, messages: [], pending: [], pendingQuestions: [], columns: 100 })).lastFrame()
  const row = frame!.split('\n').find((l) => l.includes('#9'))
  expect(row).not.toContain('\u001B]8;;')
  expect(row).not.toContain('\u001B]0;')
})

test('a non-http pull request url is not made a hyperlink', () => {
  const target = { id: 's1', projectKey: '/r', title: 't', status: 'idle', prs: [openPr(9, { url: 'file:///etc/passwd' })] }
  const frame = render(React.createElement(Peek, { target, messages: [], pending: [], pendingQuestions: [], columns: 100 })).lastFrame()
  const row = frame!.split('\n').find((l) => l.includes('#9'))
  expect(row).not.toContain('\u001B]8;;')
})
