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
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { Project } from './types.ts'

// #119: the durable form of "dispatch here unless I say otherwise" — an export in a shell profile,
// read once at launch. A tilde is expanded here because a quoted assignment
// (`FLEETVIEW_DEFAULT_PROJECT="~/repos/ui"`) reaches the process with the `~` still in it, and a
// relative path is resolved against the launch directory so `.` means what it says.
export function defaultProjectFromEnv(env: NodeJS.ProcessEnv = process.env, home = homedir(), base = process.cwd()): string | undefined {
  const raw = env.FLEETVIEW_DEFAULT_PROJECT?.trim()
  if (!raw) return undefined
  const expanded = raw === '~' ? home : raw.startsWith('~/') ? join(home, raw.slice(2)) : raw
  return resolve(base, expanded)
}

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
  dirExists = existsSync,
}: {
  cwd?: string
  projects?: Project[]
  readDir?: (dir: string) => string[]
  isRepo?: (path: string) => boolean
  dirExists?: (dir: string) => boolean
}) {
  const byName = new Map<string, { name: string; worktree: string }>()
  const add = (worktree: string) => {
    const name = basename(worktree)
    if (!name || name.includes(' ')) return
    if (!byName.has(name)) byName.set(name, { name, worktree })
  }
  // A project whose worktree is gone must not be completable either (#102): offering `@simon` for a
  // cleaned-up temp directory only leads back to the "no longer exists" dead end that skipping it in
  // pickTarget just removed. The cwd scan below is inherently current; only project records go stale.
  for (const p of projects) if (dirExists(p.worktree)) add(p.worktree)
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
  defaultProject,
  dirExists = existsSync,
}: {
  cwd?: string
  projects?: Project[]
  current?: { projectKey?: string }
  groupBy?: string
  defaultProject?: string
  dirExists?: (dir: string) => boolean
}) {
  const known = new Set(projects.map((p) => p.worktree))
  const candidates = [
    groupBy === 'project' ? current?.projectKey : undefined,
    cwd && known.has(cwd) ? cwd : undefined,
    // #119: a pinned default, above every fallback that is merely incidental. The two candidates
    // above it are explicit — the group the user scrolled to, the directory they launched from —
    // but the highlighted row under any other grouping and the newest-updated project below are
    // just whatever the roster happened to be showing, and that is exactly what put dispatches in
    // the wrong repository. Unlike the candidates around it this one need not be a known project:
    // its whole job is to name the repository that recency keeps losing to.
    defaultProject,
    current?.projectKey,
    ...projects.map((p) => p.worktree), // projects arrive sorted newest-updated first
  ]
  return candidates.find((c): c is string => Boolean(c) && dirExists(c!)) ?? null
}
