import { test, expect } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, utimesSync } from 'node:fs'
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

// events() calls this every 500ms and a finished session's transcript reaches megabytes, so an
// unchanged file must not be read again. Proven by rewriting the file behind the cache's back with
// the same size and mtime: a listing that re-read would show the new title, and one that trusted
// the cache shows the old.
test('a transcript whose mtime and size have not moved is not read again', () => {
  const h = home()
  const file = transcript(h, '/repo/alpha', 'aaaa-1111', [record('/repo/alpha', 'aaaa-1111'), { type: 'ai-title', aiTitle: 'AAAA', sessionId: 'aaaa-1111' }], 1_000_000)
  expect(listTranscripts('/repo/alpha', { home: h })[0].title).toBe('AAAA')
  const rewritten = readFileSync(file, 'utf8').replace('AAAA', 'BBBB')
  writeFileSync(file, rewritten)
  utimesSync(file, 1_000_000, 1_000_000)
  expect(listTranscripts('/repo/alpha', { home: h })[0].title).toBe('AAAA')
  // …and a real change is still picked up: the mtime moves, so the cached scan is discarded.
  utimesSync(file, 2_000_000, 2_000_000)
  expect(listTranscripts('/repo/alpha', { home: h })[0].title).toBe('BBBB')
  // …and so is a change that moves only the size: the key is mtime *and* size, so a rewrite of a
  // different length with the mtime put back is still re-read.
  writeFileSync(file, readFileSync(file, 'utf8').replace('BBBB', 'CCCC-and-then-some'))
  utimesSync(file, 2_000_000, 2_000_000)
  expect(listTranscripts('/repo/alpha', { home: h })[0].title).toBe('CCCC-and-then-some')
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
