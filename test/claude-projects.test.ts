import { test, expect } from 'vitest'
import { appendFileSync, cpSync, mkdtempSync, mkdirSync, readFileSync, renameSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeProjectDir, listTranscripts } from '../src/backends/claude/projects.ts'

// A fake ~/.claude/projects. The records are the shapes claude 2.1.220 actually writes, trimmed to
// the fields this module reads (see the wire notes).
const home = () => mkdtempSync(join(tmpdir(), 'fleetview-claude-home-'))

function transcript(h: string, directory: string, id: string, lines: unknown[], mtime?: number) {
  const dir = join(h, '.claude', 'projects', encodeProjectDir(directory))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${id}.jsonl`)
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  if (mtime !== undefined) utimesSync(file, mtime, mtime)
  return file
}

// A copy of a fake home at a fresh path, so a listing against it has no cache entry and reads every
// transcript whole — the "what a full re-read would say" reference an incremental scan is checked
// against (the cache is keyed by project folder path).
function mirror(h: string) {
  const copy = mkdtempSync(join(tmpdir(), 'fleetview-claude-mirror-'))
  cpSync(join(h, '.claude'), join(copy, '.claude'), { recursive: true })
  return copy
}

const record = (directory: string, id: string, extra: object = {}) => ({
  type: 'user',
  cwd: directory,
  sessionId: id,
  entrypoint: 'sdk-cli',
  message: { role: 'user', content: 'run the tests' },
  ...extra,
})

test('the folder name is the path with every non-alphanumeric character replaced', () => {
  expect(encodeProjectDir('/home/user/dev/demo')).toBe('-home-user-dev-demo')
  expect(encodeProjectDir('/home/user/dev/costajohnt.github.io')).toBe('-home-user-dev-costajohnt-github-io')
})

test('a directory claude has never run in lists nothing rather than throwing', () => {
  expect(listTranscripts('/nowhere', { home: home() })).toEqual([])
})

test('a session is listed with its ai-title and id', () => {
  const h = home()
  transcript(h, '/repo/alpha', 'aaaa-1111', [
    record('/repo/alpha', 'aaaa-1111'),
    { type: 'last-prompt', lastPrompt: 'run the tests', sessionId: 'aaaa-1111' },
    { type: 'ai-title', aiTitle: 'Run the failing suite', sessionId: 'aaaa-1111' },
  ])
  const [session] = listTranscripts('/repo/alpha', { home: h })
  expect(session.id).toBe('aaaa-1111')
  expect(session.directory).toBe('/repo/alpha')
  expect(session.title).toBe('Run the failing suite')
})

// events() calls this every 500ms and a live transcript is appended to between every pair of calls,
// so the scan reads only the bytes past its cursor. The contract this proves is the one that
// matters: what an incremental listing reports is what a full re-read of the same bytes would.
test('an appended transcript is read incrementally and reports what a full re-read would', () => {
  const h = home()
  const file = transcript(h, '/repo/alpha', 'aaaa-1111', [record('/repo/alpha', 'aaaa-1111'), { type: 'ai-title', aiTitle: 'AAAA', sessionId: 'aaaa-1111' }], 1_000_000)
  expect(listTranscripts('/repo/alpha', { home: h })[0].title).toBe('AAAA')
  // An append: the new record is folded over the cached one, and the cwd found before it is kept.
  appendFileSync(file, JSON.stringify({ type: 'ai-title', aiTitle: 'BBBB', sessionId: 'aaaa-1111' }) + '\n')
  const [after] = listTranscripts('/repo/alpha', { home: h })
  expect(after.title).toBe('BBBB')
  expect(after.directory).toBe('/repo/alpha')
  // Same file read cold by a listing with no cache at all — the incremental answer must match it.
  const cold = listTranscripts('/repo/alpha', { home: mirror(h) })[0]
  expect({ title: after.title, id: after.id, createdAt: after.createdAt }).toEqual({ title: cold.title, id: cold.id, createdAt: cold.createdAt })
})

// A record can be appended in two chunks — the poll lands mid-line as often as not — and a line
// split across two reads must still be parsed once, not dropped and not parsed twice.
test('a record appended across two polls is folded once the line completes', () => {
  const h = home()
  const file = transcript(h, '/repo/alpha', 'aaaa-1111', [record('/repo/alpha', 'aaaa-1111')])
  const line = JSON.stringify({ type: 'ai-title', aiTitle: 'Split across polls', sessionId: 'aaaa-1111' }) + '\n'
  appendFileSync(file, line.slice(0, 20))
  // Still the opening prompt (#46's fallback), not 'Split across polls': the partial line is held, not parsed.
  expect(listTranscripts('/repo/alpha', { home: h })[0].title).toBe('run the tests')
  appendFileSync(file, line.slice(20))
  expect(listTranscripts('/repo/alpha', { home: h })[0].title).toBe('Split across polls')
})

// A shrink or a rename-over is a different file: keeping the old offset would mean the scan never
// sees another byte of that session, or folds mid-line garbage from a stale position.
test('a truncated or replaced transcript is re-read from zero', () => {
  const h = home()
  const file = transcript(h, '/repo/alpha', 'aaaa-1111', [
    record('/repo/alpha', 'aaaa-1111'),
    { type: 'ai-title', aiTitle: 'Before the rewrite, a good long title', sessionId: 'aaaa-1111' },
  ])
  expect(listTranscripts('/repo/alpha', { home: h })[0].title).toBe('Before the rewrite, a good long title')
  // Shorter than the cursor: size < offset resets it.
  writeFileSync(file, [record('/repo/alpha', 'aaaa-1111'), { type: 'ai-title', aiTitle: 'After', sessionId: 'aaaa-1111' }].map((l) => JSON.stringify(l)).join('\n') + '\n')
  expect(listTranscripts('/repo/alpha', { home: h })[0].title).toBe('After')
  // Rename-over at an equal-or-larger size: only the inode says anything changed.
  const swap = `${file}.new`
  writeFileSync(
    swap,
    [record('/repo/alpha', 'aaaa-1111'), { type: 'ai-title', aiTitle: 'After the compaction rename', sessionId: 'aaaa-1111' }].map((l) => JSON.stringify(l)).join('\n') + '\n',
  )
  renameSync(swap, file)
  expect(listTranscripts('/repo/alpha', { home: h })[0].title).toBe('After the compaction rename')
})

// The age column means time-since-creation on every other row. The transcript's first record
// carries an ISO timestamp; the mtime is only the fallback for one that doesn't.
test('createdAt comes from the first record timestamp, and is 0 when no record carries one', () => {
  const h = home()
  transcript(h, '/repo/alpha', 'aaaa-1111', [
    record('/repo/alpha', 'aaaa-1111', { timestamp: '2026-07-28T17:03:36.985Z' }),
    record('/repo/alpha', 'aaaa-1111', { timestamp: '2026-07-29T11:50:56.000Z' }),
  ])
  transcript(h, '/repo/alpha', 'bbbb-2222', [record('/repo/alpha', 'bbbb-2222')])
  transcript(h, '/repo/alpha', 'cccc-3333', [record('/repo/alpha', 'cccc-3333', { timestamp: 'not a date' })])
  const byId = Object.fromEntries(listTranscripts('/repo/alpha', { home: h }).map((s) => [s.id, s.createdAt]))
  expect(byId['aaaa-1111']).toBe(Date.parse('2026-07-28T17:03:36.985Z')) // the first, not the last
  expect(byId['bbbb-2222']).toBe(0) // no timestamp at all: the caller falls back to the mtime
  expect(byId['cccc-3333']).toBe(0) // unparseable is the same as absent
})

// The first record's timestamp is immutable, so it survives every later append rather than being
// re-derived from whatever the newest chunk happens to contain.
test('createdAt is kept across appends', () => {
  const h = home()
  const file = transcript(h, '/repo/alpha', 'aaaa-1111', [record('/repo/alpha', 'aaaa-1111', { timestamp: '2026-07-28T17:03:36.985Z' })])
  expect(listTranscripts('/repo/alpha', { home: h })[0].createdAt).toBe(Date.parse('2026-07-28T17:03:36.985Z'))
  appendFileSync(file, JSON.stringify(record('/repo/alpha', 'aaaa-1111', { timestamp: '2026-08-01T00:00:00.000Z' })) + '\n')
  expect(listTranscripts('/repo/alpha', { home: h })[0].createdAt).toBe(Date.parse('2026-07-28T17:03:36.985Z'))
})

// ai-title is rewritten in place as the session is re-titled, so a transcript holds every title it
// has ever had and only the last one is current.
test('the last ai-title wins, and last-prompt is the fallback before there is one', () => {
  const h = home()
  transcript(h, '/repo/alpha', 'aaaa-1111', [
    record('/repo/alpha', 'aaaa-1111'),
    { type: 'ai-title', aiTitle: 'First guess', sessionId: 'aaaa-1111' },
    { type: 'ai-title', aiTitle: 'Better title', sessionId: 'aaaa-1111' },
  ])
  transcript(h, '/repo/alpha', 'bbbb-2222', [record('/repo/alpha', 'bbbb-2222'), { type: 'last-prompt', lastPrompt: 'fix the flake', sessionId: 'bbbb-2222' }])
  const byId = Object.fromEntries(listTranscripts('/repo/alpha', { home: h }).map((s) => [s.id, s.title]))
  expect(byId).toEqual({ 'aaaa-1111': 'Better title', 'bbbb-2222': 'fix the flake' })
})

// #46: claude names a session late (or never — 78 of the 857 transcripts on this machine have
// neither record), and the row used to render the bare session UUID for the whole of that window.
test('#46 a session with neither ai-title nor last-prompt is titled with its opening prompt', () => {
  const h = home()
  transcript(h, '/repo/alpha', 'aaaa-1111', [record('/repo/alpha', 'aaaa-1111')])
  // A caveat preamble is claude's own words, not the user's, so the prompt after it is the title.
  transcript(h, '/repo/alpha', 'bbbb-2222', [
    { ...record('/repo/alpha', 'bbbb-2222'), isMeta: true, message: { role: 'user', content: '<local-command-caveat>Caveat: …</local-command-caveat>' } },
    { ...record('/repo/alpha', 'bbbb-2222'), message: { role: 'user', content: 'research the mesh setup' } },
  ])
  // Content blocks rather than a plain string, and a tool-result record carrying no text at all.
  transcript(h, '/repo/alpha', 'cccc-3333', [
    { ...record('/repo/alpha', 'cccc-3333'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
    { ...record('/repo/alpha', 'cccc-3333'), message: { role: 'user', content: [{ type: 'text', text: '  ship\n  the release  ' }] } },
  ])
  const byId = Object.fromEntries(listTranscripts('/repo/alpha', { home: h }).map((s) => [s.id, s.title]))
  expect(byId).toEqual({ 'aaaa-1111': 'run the tests', 'bbbb-2222': 'research the mesh setup', 'cccc-3333': 'ship the release' })
})

// A prompt is not a title: pasted context is a normal way to open a session, and this string reaches
// `ls` on raw stdout where nothing truncates it.
test('#46 the opening-prompt fallback is capped, and a real title still wins over it', () => {
  const h = home()
  transcript(h, '/repo/alpha', 'aaaa-1111', [{ ...record('/repo/alpha', 'aaaa-1111'), message: { role: 'user', content: 'x'.repeat(5000) } }])
  transcript(h, '/repo/alpha', 'bbbb-2222', [
    { ...record('/repo/alpha', 'bbbb-2222'), message: { role: 'user', content: 'the opening prompt' } },
    { type: 'ai-title', aiTitle: 'What claude called it', sessionId: 'bbbb-2222' },
  ])
  const byId = Object.fromEntries(listTranscripts('/repo/alpha', { home: h }).map((s) => [s.id, s.title]))
  expect(byId['aaaa-1111']).toBe('x'.repeat(200))
  expect(byId['bbbb-2222']).toBe('What claude called it')
})

// The folder name is a lossy hash of the path: /repo/a.b and /repo/a-b encode identically, so the
// transcript's own cwd is what decides, or one repo's sessions show up in another's group.
test('a session whose cwd disagrees with the folder is not claimed by that directory', () => {
  const h = home()
  transcript(h, '/repo/a.b', 'aaaa-1111', [record('/repo/a.b', 'aaaa-1111')])
  transcript(h, '/repo/a-b', 'bbbb-2222', [record('/repo/a-b', 'bbbb-2222')])
  expect(listTranscripts('/repo/a.b', { home: h }).map((s) => s.id)).toEqual(['aaaa-1111'])
  expect(listTranscripts('/repo/a-b', { home: h }).map((s) => s.id)).toEqual(['bbbb-2222'])
})

test('sessions come back newest first', () => {
  const h = home()
  transcript(h, '/repo/alpha', 'older', [record('/repo/alpha', 'older')], 1_000_000)
  transcript(h, '/repo/alpha', 'newer', [record('/repo/alpha', 'newer')], 2_000_000)
  expect(listTranscripts('/repo/alpha', { home: h }).map((s) => s.id)).toEqual(['newer', 'older'])
})

// The directory also holds a `memory/` subdirectory and the odd non-transcript file; neither is a
// session, and a readdir that assumed otherwise would list a folder as a row.
test('non-transcript entries in the project folder are ignored', () => {
  const h = home()
  transcript(h, '/repo/alpha', 'aaaa-1111', [record('/repo/alpha', 'aaaa-1111')])
  mkdirSync(join(h, '.claude', 'projects', encodeProjectDir('/repo/alpha'), 'memory'), { recursive: true })
  writeFileSync(join(h, '.claude', 'projects', encodeProjectDir('/repo/alpha'), 'notes.txt'), 'x')
  expect(listTranscripts('/repo/alpha', { home: h }).map((s) => s.id)).toEqual(['aaaa-1111'])
})

test('a transcript that is not JSON at all is skipped, not fatal', () => {
  const h = home()
  const dir = join(h, '.claude', 'projects', encodeProjectDir('/repo/alpha'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'broken.jsonl'), '{"cwd": not json\n')
  transcript(h, '/repo/alpha', 'aaaa-1111', [record('/repo/alpha', 'aaaa-1111')])
  expect(listTranscripts('/repo/alpha', { home: h }).map((s) => s.id)).toEqual(['aaaa-1111'])
})
