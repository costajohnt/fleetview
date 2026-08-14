// Which project a bare (no `@repo`) dispatch runs in.
//
// Mirrors agent view's rule: "A new session runs in the directory you opened agent view from",
// plus "When agent view is grouped by directory, the highlighted row's directory becomes the
// dispatch target, so you can scroll to a group and dispatch into it without retyping the path."
//
// The launch cwd only wins when opencode already knows it as a project — fleetview can't dispatch
// into a directory the server has never seen, and silently creating one there would be worse
// than falling back to something the user can see on screen.
//
// ponytail: no @repo parsing here; that's the Phase 5 grammar. This function only answers the
// bare case, and takes everything it needs as arguments so it stays pure.
import { readdirSync, existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Project } from './types.ts'

// What `@` can complete to. Agent view lists "Git repositories one level below the launch
// directory ... [and] any directory that already has a session in the list", and skips any
// directory whose name contains a space.
//
// The directories-below-cwd half is a synchronous scan of one level, done once when fleetview starts;
// it is a handful of stat calls, not a walk.
export function repoChoices({
  cwd,
  projects = [],
  readDir = safeReadDir,
  isRepo = safeIsRepo,
}: {
  cwd?: string
  projects?: Project[]
  readDir?: (dir: string) => string[]
  isRepo?: (path: string) => boolean
}) {
  const byName = new Map<string, { name: string; worktree: string }>()
  const add = (worktree: string) => {
    const name = basename(worktree)
    if (!name || name.includes(' ')) return
    if (!byName.has(name)) byName.set(name, { name, worktree })
  }
  for (const p of projects) add(p.worktree)
  for (const entry of cwd ? readDir(cwd) : []) {
    const path = join(cwd!, entry) // loop only runs when cwd is set
    if (isRepo(path)) add(path)
  }
  return [...byName.values()]
}

function safeReadDir(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

const safeIsRepo = (path: string) => existsSync(join(path, '.git'))

// Candidates are tried in preference order and the first one that still exists on disk wins (#102).
// A project record outlives the directory — a temp worktree the OS cleaned up is still listed by the
// server — and without the skip the stale entry is chosen forever, so dispatch is permanently stuck
// behind "<name> no longer exists" with no way to recover in the UI.
export function pickTarget({
  cwd,
  projects = [],
  current,
  groupBy,
  dirExists = existsSync,
}: {
  cwd?: string
  projects?: Project[]
  current?: { projectKey?: string }
  groupBy?: string
  dirExists?: (dir: string) => boolean
}) {
  const known = new Set(projects.map((p) => p.worktree))
  const candidates = [
    groupBy === 'project' ? current?.projectKey : undefined,
    cwd && known.has(cwd) ? cwd : undefined,
    current?.projectKey,
    ...projects.map((p) => p.worktree), // projects arrive sorted newest-updated first
  ]
  return candidates.find((c): c is string => Boolean(c) && dirExists(c!)) ?? null
}
