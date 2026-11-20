import { test, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Every path the listing opens or stats, so the test can say which transcripts it touched.
const touched: string[] = []
vi.mock('node:fs', async (orig) => {
  const fs = (await orig()) as typeof import('node:fs')
  const spy =
    <A extends unknown[], R>(fn: (...a: A) => R) =>
    (...a: A) => {
      if (typeof a[0] === 'string') touched.push(a[0])
      return fn(...a)
    }
  return { ...fs, openSync: spy(fs.openSync), statSync: spy(fs.statSync), readFileSync: spy(fs.readFileSync) }
})

const { createClaudeBackend } = await import('../src/backends/claude/index.ts')
const { encodeProjectDir } = await import('../src/backends/claude/projects.ts')

// #235: `logs`/`attach`/`stop` resolve an id by asking every backend for its sessions. On a folder
// with hundreds of transcripts, reading each to answer "which one is this id" took 12s; the id is
// the file name, so only the transcript it names is read.
test('#235 resolving an id reads only the transcript it names', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fleetview-claude-home-'))
  const dir = join(home, '.claude', 'projects', encodeProjectDir('/repo/alpha'))
  mkdirSync(dir, { recursive: true })
  const ids = ['aaaa-1111', 'aaab-2222', 'bbbb-3333']
  for (const id of ids)
    writeFileSync(join(dir, `${id}.jsonl`), JSON.stringify({ type: 'user', cwd: '/repo/alpha', sessionId: id, message: { role: 'user', content: `prompt ${id}` } }) + '\n')
  const b = createClaudeBackend({ home, runDir: join(home, 'runs') })
  touched.length = 0
  const found = await b.listSessions('/repo/alpha', 'aaaa')
  expect(found.map((s) => [s.id, s.title])).toEqual([['aaaa-1111', 'prompt aaaa-1111']])
  expect(touched.filter((p) => p.startsWith(dir) && !p.endsWith('aaaa-1111.jsonl'))).toEqual([])
  // A shorter prefix still finds every session it matches; the caller decides what is ambiguous.
  expect((await b.listSessions('/repo/alpha', 'aaa')).map((s) => s.id).sort()).toEqual(['aaaa-1111', 'aaab-2222'])
  // And without one, the listing is the whole folder, as before.
  expect((await b.listSessions('/repo/alpha')).map((s) => s.id).sort()).toEqual(ids)
})
