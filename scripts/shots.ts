// README screenshots, generated rather than hand-captured.
//
// Each scene renders the REAL components (the same ones the app mounts) against fixture data,
// exactly like scripts/preview.ts — then the ANSI frame is painted into a terminal-styled HTML
// page and shot with headless Chrome. Nothing here is a mockup: the pixels come from the same
// render path the running app uses, so a UI change that would look wrong in the README shows up
// the moment the shots are regenerated.
//
//   node scripts/shots.ts           write docs/images/*.html
//   node scripts/shots.ts --shoot   ...and screenshot them to docs/images/*.png
//
// --shoot needs a Chrome/Chromium binary: $CHROME, or puppeteer's cached chrome-headless-shell.
process.env.FORCE_COLOR = '3'
process.env.FLEETVIEW_REDUCED_MOTION = '1' // pin animation frames so reruns are byte-stable

const React = (await import('react')).default
const { render } = await import('ink-testing-library')
const { writeFileSync, mkdirSync, readdirSync, existsSync, statSync } = await import('node:fs')
const { execFileSync } = await import('node:child_process')
const { dirname, join } = await import('node:path')
const { fileURLToPath } = await import('node:url')
const { homedir } = await import('node:os')

// TODO(types): src components are untyped here; cast to any so fixture props (loose render shapes) pass.
const { Roster } = (await import('../src/ui/roster.ts')) as any
const { DispatchInput } = (await import('../src/ui/dispatch-input.ts')) as any
const { Peek } = (await import('../src/ui/peek.ts')) as any
const { Header } = (await import('../src/ui/header.ts')) as any

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs', 'images')
mkdirSync(OUT, { recursive: true })

const COLUMNS = 96
const NOW = 1_753_000_000_000

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────
const session = (id: string, title: string, status: string, over: any = {}) => ({
  id,
  projectKey: '/repo',
  title,
  status,
  updatedAt: NOW - 3 * 60_000,
  createdAt: NOW - 3 * 60_000,
  ...over,
})

// A question exactly in the shape opencode 1.18.4's question.asked carries (see ui/peek.ts).
const question = {
  id: 'q1',
  sessionID: 's1',
  questions: [
    {
      question: 'The retry loop has no backoff. How should I fix it?',
      options: [
        { label: 'add exponential backoff' },
        { label: 'cap retries at 3' },
        { label: 'leave it and open an issue' },
      ],
    },
  ],
}

// permission.asked's verified shape: {id, sessionID, permission, patterns, ...}
const permission = { id: 'p1', sessionID: 's1', permission: 'bash', patterns: ['git push'] }

// ── scenes ──────────────────────────────────────────────────────────────────────────────────────
// TODO(types): scene map holds arbitrary React elements keyed by name; any keeps fixtures loose.
const scenes: Record<string, any> = {}

// Peek answering in place — the surface no existing screenshot shows: a pending permission with
// its y/a/d hint, a question rendered as a numbered list, and the reply input under both.
scenes['peek-answer'] = React.createElement(
  Peek,
  {
    target: session('s1', 'fix the flaky tests', 'waiting', { waitingSince: NOW - 4 * 60_000 }),
    messages: [
      {
        info: { role: 'assistant' },
        parts: [{ type: 'text', text: 'Three of the four failures are the same retry loop timing out.' }],
      },
    ],
    pending: [permission],
    pendingQuestions: [question],
    columns: COLUMNS,
    maxRows: 24,
    now: NOW,
  },
)

// The input's grammar, mid-completion: `@` opened the target list and tab applies the first match.
scenes['dispatch-suggestions'] = React.createElement(DispatchInput, {
  value: 'rework the importer @',
  view: 'main',
  kind: 'dispatch',
  columns: COLUMNS,
  focused: true,
  suggestions: {
    sigil: '@',
    partial: '',
    matches: [
      { name: 'reviewer', kind: 'agent' },
      { name: 'plan', kind: 'agent' },
      { name: 'fleetview', kind: 'repo' },
      { name: 'importer', kind: 'repo' },
      { name: 'claude', kind: 'backend' },
      { name: 'copilot', kind: 'backend' },
    ],
  },
})

// Browse (^b): every opencode session, grouped by project, with `[roster]` marking membership.
const browseGroups = [
  {
    projectKey: '/repo/fleetview',
    repoName: 'fleetview',
    sessions: [
      session('s1', 'fix the flaky tests', 'waiting', { projectKey: '/repo/fleetview', snippet: 'retry loop?' }),
      session('s2', 'port the parser', 'running', { projectKey: '/repo/fleetview', snippet: 'tokenizer' }),
    ],
  },
  {
    projectKey: '/repo/importer',
    repoName: 'importer',
    sessions: [
      session('s5', 'started from opencode’s own TUI', 'done', { projectKey: '/repo/importer', ranForMs: 6 * 60_000 }),
      session('s6', 'spike the csv reader', 'idle', { projectKey: '/repo/importer' }),
    ],
  },
]
scenes['browse'] = React.createElement(
  Roster,
  {
    groups: browseGroups,
    selectedKey: '/repo/importer:s5',
    offlineProjects: new Set(),
    columns: COLUMNS,
    now: NOW,
    showStateWord: true,
    markMembers: new Set(['/repo/fleetview:s1', '/repo/fleetview:s2']),
  },
)

// A full frame: header + roster + input, the way the three stack on screen.
const stateGroups = [
  {
    projectKey: 'state:waiting',
    repoName: 'needs input',
    empty: true,
    sessions: [session('s1', 'fix the flaky tests', 'waiting', { snippet: 'should I delete the retry loop?', pendingRequest: true })],
  },
  {
    projectKey: 'state:running',
    repoName: 'working',
    empty: true,
    sessions: [session('s2', 'port the parser', 'running', { snippet: 'rewriting tokenizer edge cases' })],
  },
  {
    projectKey: 'state:completed',
    repoName: 'completed',
    empty: true,
    sessions: [
      session('s4', 'spike the importer', 'error', { ranForMs: 11 * 60_000 }),
      session('s3', 'update the readme', 'done', { ranForMs: 4 * 60_000 }),
    ],
  },
]
// A whole frame — header, roster, input — with the group machinery on show: a pinned group on top,
// `completed` collapsed to its header and count, and the working group folded to a `… N more` line.
const pinnedGroup = {
  projectKey: 'state:pinned',
  repoName: 'pinned',
  sessions: [session('s0', 'ship the release notes', 'waiting', { pinned: true, snippet: 'which version should I tag?' })],
}
scenes['groups'] = React.createElement(
  React.Fragment,
  null,
  React.createElement(Header, {
    sessions: [pinnedGroup, ...stateGroups].flatMap((g) => g.sessions),
    model: { providerID: 'anthropic', id: 'claude-opus-5' },
    cwd: '/repo/fleetview',
    columns: COLUMNS,
  }),
  React.createElement(Roster, {
    groups: [
      pinnedGroup,
      stateGroups[0],
      { ...stateGroups[1], hidden: 3 },
      stateGroups[2],
    ],
    selectedKey: 'header:state:completed',
    collapsed: new Set(['state:completed']),
    offlineProjects: new Set(),
    columns: COLUMNS,
    now: NOW,
  }),
  React.createElement(DispatchInput, { value: '', view: 'main', kind: 'empty', columns: COLUMNS, focused: true }),
)

// Multi-backend: opencode + claude + copilot sessions in one roster. The dim backend tag only
// appears once more than one backend is active (showBackendTag), so every row carries it here.
const backendGroups = [
  {
    projectKey: 'state:waiting',
    repoName: 'needs input',
    empty: true,
    sessions: [session('s1', 'fix the flaky tests', 'waiting', { snippet: 'should I delete the retry loop?', pendingRequest: true })],
  },
  {
    projectKey: 'state:running',
    repoName: 'working',
    empty: true,
    sessions: [
      session('s2', 'port the parser', 'running', { snippet: 'rewriting tokenizer edge cases', backend: 'claude' }),
      session('s3', 'draft the changelog', 'running', { snippet: 'summarising the merge log', backend: 'copilot' }),
    ],
  },
  {
    projectKey: 'state:completed',
    repoName: 'completed',
    empty: true,
    sessions: [session('s4', 'update the readme', 'done', { ranForMs: 4 * 60_000, backend: 'claude' })],
  },
]
scenes['backends'] = React.createElement(
  React.Fragment,
  null,
  React.createElement(Header, {
    sessions: backendGroups.flatMap((g) => g.sessions),
    model: { providerID: 'anthropic', id: 'claude-opus-5' },
    cwd: '/repo/fleetview',
    columns: COLUMNS,
  }),
  React.createElement(Roster, {
    groups: backendGroups,
    selectedKey: 'state:running:s2',
    collapsed: new Set(),
    offlineProjects: new Set(),
    showBackendTag: true,
    columns: COLUMNS,
    now: NOW,
  }),
  React.createElement(DispatchInput, { value: '', view: 'main', kind: 'empty', columns: COLUMNS, focused: true }),
)

// ── ANSI → HTML ─────────────────────────────────────────────────────────────────────────────────
// Only the SGR codes the theme actually emits: bold/dim, the eight basic foregrounds and their
// bright-background counterpart used for the selected row. Anything else is dropped rather than
// guessed at, so an unhandled code shows up as missing styling instead of wrong styling.
const FG: Record<number, string> = {
  30: '#4b5058', 31: '#ff6d6d', 32: '#5af78e', 33: '#ffd866',
  34: '#77aaff', 35: '#ff8ce0', 36: '#56d4dd', 37: '#d8dee9',
  90: '#6b7280', 91: '#ff6d6d', 92: '#5af78e', 93: '#ffd866',
  94: '#77aaff', 95: '#ff8ce0', 96: '#56d4dd', 97: '#ffffff',
}
const BG: Record<number, string> = { 40: '#000000', 47: '#d8dee9', 100: '#41454d', 107: '#ffffff' }

const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }) as Record<string, string>)[c])

// Dim (SGR 2) is rendered by blending the foreground toward the window background, NOT by CSS
// opacity: opacity fades the whole span including its background, so a dim run inside the selected
// row's highlight punched a hole in it. A terminal dims the glyph, not the cell.
const WINDOW_BG = [0x1b, 0x1d, 0x21]
const DEFAULT_FG = '#d8dee9'
const dimmed = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const mix = (c: number, bg: number) => Math.round(c * 0.55 + bg * 0.45)
  return `#${[mix(r, WINDOW_BG[0]), mix(g, WINDOW_BG[1]), mix(b, WINDOW_BG[2])].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

function ansiToHtml(frame: string) {
  let state: { fg: string | null; bg: string | null; bold: boolean; dim: boolean } = { fg: null, bg: null, bold: false, dim: false }
  let open = false
  let out = ''
  const closeSpan = () => {
    if (open) {
      out += '</span>'
      open = false
    }
  }
  const openSpan = () => {
    const fg = state.dim ? dimmed(state.fg ?? DEFAULT_FG) : state.fg
    const style = [
      fg ? `color:${fg}` : '',
      state.bg ? `background:${state.bg}` : '',
      state.bold ? 'font-weight:700' : '',
    ].filter(Boolean).join(';')
    if (!style) return
    out += `<span style="${style}">`
    open = true
  }
  // Split on SGR sequences, keeping them, so text and codes alternate.
  for (const token of frame.split(/(\[[0-9;]*m)/)) {
    if (!token) continue
    const sgr = /^\[([0-9;]*)m$/.exec(token)
    if (!sgr) {
      closeSpan()
      openSpan()
      out += escapeHtml(token)
      closeSpan()
      continue
    }
    for (const raw of (sgr[1] || '0').split(';')) {
      const code = Number(raw || 0)
      if (code === 0) state = { fg: null, bg: null, bold: false, dim: false }
      else if (code === 1) state.bold = true
      else if (code === 2) state.dim = true
      else if (code === 22) { state.bold = false; state.dim = false }
      else if (code === 39) state.fg = null
      else if (code === 49) state.bg = null
      else if (FG[code]) state.fg = FG[code]
      else if (BG[code]) state.bg = BG[code]
    }
  }
  closeSpan()
  return out
}

// A macOS-style terminal window, matching the hand-captured screenshots already in the README so
// the generated ones sit next to them without looking like a different tool.
//
// Metrics are pinned rather than left to the font stack: Menlo advances exactly 0.6em per cell, so
// the window's pixel size can be computed in Node (see `fit` below) and passed to Chrome as an
// exact --window-size. A generic `monospace` fallback would advance differently and the screenshot
// would clip or float in dead space.
const CHAR_W = 9 // 15px Menlo, 0.6em advance
const LINE_H = 21.75 // 15px * 1.45
const PAD = 26 // body padding
const PRE_X = 20 // pre horizontal padding
const PRE_Y = 38 // pre vertical padding (18 top + 20 bottom)
const BAR_H = 33

const page = (title: string, frame: string) => `<!doctype html>
<meta charset="utf-8">
<style>
  :root { color-scheme: dark }
  * { box-sizing: border-box }
  body { margin: 0; padding: ${PAD}px; background: #0b0d10; font-family: Menlo, monospace }
  .window { width: max-content; border-radius: 10px; overflow: hidden; background: #1b1d21;
            box-shadow: 0 18px 50px rgba(0,0,0,.55) }
  .bar { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: #2b2e33; height: ${BAR_H}px }
  .dot { width: 12px; height: 12px; border-radius: 50% }
  .title { flex: 1; text-align: center; margin-right: 46px; color: #d8dee9;
           font: 600 13px/1 ui-sans-serif, -apple-system, system-ui }
  pre { margin: 0; padding: 18px ${PRE_X}px 20px; color: #d8dee9; font-size: 15px; line-height: ${LINE_H}px;
        font-family: inherit; white-space: pre; tab-size: 8 }
</style>
<div class="window">
  <div class="bar">
    <div class="dot" style="background:#ff5f57"></div>
    <div class="dot" style="background:#febc2e"></div>
    <div class="dot" style="background:#28c840"></div>
    <div class="title">${escapeHtml(title)}</div>
  </div>
  <pre>${frame}</pre>
</div>
`

// The exact pixel window a frame needs, so Chrome's viewport is the screenshot and there is no
// dead space to crop (and nothing to crop with — this deliberately shells out to one binary).
// Trailing blanks are trimmed first: the roster pads every row to `columns`, which would otherwise
// make every shot the full 96 cells wide regardless of its content.
const fit = (frame: string) => {
  const rows = frame.split('\n').map((l) => l.replace(/\[[0-9;]*m/g, '').replace(/\s+$/, ''))
  while (rows.length > 1 && rows.at(-1) === '') rows.pop() // ink frames can end on a blank row
  const cols = Math.max(1, ...rows.map((l) => [...l].length))
  return {
    width: Math.ceil(PAD * 2 + PRE_X * 2 + cols * CHAR_W) + 2,
    height: Math.ceil(PAD * 2 + BAR_H + PRE_Y + rows.length * LINE_H) + 2,
  }
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────────
const written = []
for (const [name, element] of Object.entries(scenes)) {
  const frame = render(element).lastFrame() ?? ''
  const file = join(OUT, `${name}.html`)
  writeFileSync(file, page('fleetview', ansiToHtml(frame)))
  written.push({ name, file, ...fit(frame) })
  console.log(`${name}: ${frame.split('\n').length} rows → ${file}`)
}

if (!process.argv.includes('--shoot')) process.exit(0)

const findChrome = () => {
  if (process.env.CHROME) return process.env.CHROME
  const cache = join(homedir(), '.cache', 'puppeteer', 'chrome-headless-shell')
  if (!existsSync(cache)) return null
  // Newest install wins; each holds one <platform>/chrome-headless-shell binary.
  for (const version of readdirSync(cache).sort().reverse()) {
    for (const platform of readdirSync(join(cache, version))) {
      const bin = join(cache, version, platform, 'chrome-headless-shell')
      if (existsSync(bin) && statSync(bin).isFile()) return bin
    }
  }
  return null
}

const chrome = findChrome()
if (!chrome) {
  console.error('no Chrome found — set $CHROME to a chrome/chromium binary to shoot PNGs')
  process.exit(1)
}
for (const { name, file, width, height } of written) {
  execFileSync(
    chrome,
    [
      '--headless',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=2', // retina: the README images are read at full size
      `--window-size=${width},${height}`,
      `--screenshot=${join(OUT, `${name}.png`)}`,
      `file://${file}`,
    ],
    { stdio: 'ignore' },
  )
  console.log(`shot ${name}.png (${width}×${height})`)
}
