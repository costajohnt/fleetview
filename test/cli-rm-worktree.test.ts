import { test, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runRm } from '../src/cli.ts'

// `fleetview rm` on an isolated session: when its worktree goes, and what it says about it (H5, L1).
const worktree = '/x/wt/ses-abc'
const harness = ({ sessions = [{ id: 'ses_abc123' }] as any, removeWorktree = vi.fn(() => Promise.resolve(true)) as any, safety = { removable: true, reason: null } as any } = {}) => {
  const out: string[] = []
  const rosterFile = join(mkdtempSync(join(tmpdir(), 'fleetview-rm-wt-')), 'roster.json')
  writeFileSync(rosterFile, JSON.stringify({ groupBy: 'state', collapsed: [], sessions: [] }))
  const client = {
    listProjects: () => Promise.resolve([{ id: '/x/repo', worktree: '/x/repo', sandboxes: [worktree] }]),
    listSessions: vi.fn((dir: string) => (dir === worktree ? (typeof sessions === 'function' ? sessions() : Promise.resolve(sessions)) : Promise.resolve([]))),
    deleteSession: vi.fn(() => Promise.resolve(true)),
    removeWorktree,
  }
  const deps = {
    ensureServer: vi.fn(() => Promise.resolve({ ok: true, server: { host: '127.0.0.1', port: 4900 } })),
    serverFile: '/tmp/s.json',
    createClient: () => client,
    rosterFile,
    worktreeSafetyImpl: vi.fn(() => safety),
    log: (m: string) => out.push(m),
    error: vi.fn(),
    setExitCode: vi.fn(),
  }
  return { out, client, deps }
}

// A /fork sibling runs in the same worktree; removing it would pull the checkout out from under it.
test('rm keeps a worktree another session still uses', async () => {
  const h = harness({ sessions: [{ id: 'ses_abc123' }, { id: 'ses_fork9' }] })
  await runRm({ command: 'rm', id: 'ses_abc123' }, h.deps as any)
  expect(h.client.deleteSession).toHaveBeenCalledWith('ses_abc123', worktree)
  expect(h.client.removeWorktree).not.toHaveBeenCalled()
  expect(h.out).toEqual([`removed ses_abc123 — kept its worktree (1 other session still uses it): ${worktree}`])
})

test('rm keeps the worktree when its sessions cannot be listed', async () => {
  let calls = 0
  // First listing resolves the id; the post-delete one fails.
  const h = harness({ sessions: () => (calls++ === 0 ? Promise.resolve([{ id: 'ses_abc123' }]) : Promise.reject(new Error('down'))) })
  await runRm({ command: 'rm', id: 'ses_abc123' }, h.deps as any)
  expect(h.client.removeWorktree).not.toHaveBeenCalled()
  expect(h.out).toEqual([`removed ses_abc123 — kept its worktree (could not list its sessions): ${worktree}`])
})

test('rm does not claim the worktree is gone when removal rejects', async () => {
  const h = harness({ removeWorktree: vi.fn(() => Promise.reject(new Error('DELETE /experimental/worktree → 500: boom'))) })
  await runRm({ command: 'rm', id: 'ses_abc123' }, h.deps as any)
  expect(h.out).toEqual([`removed ses_abc123 — kept its worktree (removal failed: DELETE /experimental/worktree → 500: boom): ${worktree}`])
})

test('rm does not claim the worktree is gone when the client cannot remove worktrees', async () => {
  const h = harness()
  delete (h.client as any).removeWorktree
  await runRm({ command: 'rm', id: 'ses_abc123' }, h.deps as any)
  expect(h.out).toEqual([`removed ses_abc123 — kept its worktree (this server cannot remove worktrees): ${worktree}`])
})

test('rm removes the worktree when it was the last session and nothing would be lost', async () => {
  const h = harness()
  await runRm({ command: 'rm', id: 'ses_abc123' }, h.deps as any)
  expect(h.client.removeWorktree).toHaveBeenCalledWith(worktree, '/x/repo')
  expect(h.out).toEqual(['removed ses_abc123 and its worktree'])
})
