import { test, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// `tsc --noEmit` is happy with `any` — it is a valid type, and every rule strict mode enforces is
// switched off inside one. So nothing in the toolchain notices when an `any` creeps back into a
// file that was deliberately typed, and the ones that already shipped got there exactly that way:
// one prop bag left loose, then everything downstream of it inherited the hole.
//
// This is the enforcement. Not an ESLint install for a single rule — the repo has no linter, and
// adding a toolchain to check one regex is more moving parts than the check.
//
// The allowlist is the point: every remaining `any` has to be named here with the reason it is a
// boundary fact rather than a shortcut, so adding one is a deliberate edit to this file rather
// than something that slides in with a feature.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// path → how many `any`s that file is allowed to carry, and why.
const ALLOWED = new Map<string, number>([
  // Ink types `stdout` as the concrete `NodeJS.WriteStream`; gated-stdout's Gate is a structural
  // stand-in for the five members Ink actually touches (write/columns/rows/isTTY/resize). No
  // structural type satisfies a class, and `as unknown as NodeJS.WriteStream` would be the same
  // cast wearing a hat — so the honest version is one `as any` with the reason above it.
  ['src/cli.ts', 1],
])

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return walk(path)
    return path.endsWith('.ts') ? [path] : []
  })

// Comments are stripped first: `as any` also occurs in prose ("the same path as any other failed
// run"), and a check that fires on a sentence is a check people learn to ignore. Stripping `//` to
// end of line can also eat the tail of a string holding `//` (a URL) — that risks missing an `any`,
// never inventing one, which is the right way round for a guard that has to stay trusted.
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

const ANY = /\bas\s+any\b|:\s*any\b|<any>|\bany\[\]/

const anyLines = (file: string) =>
  stripComments(readFileSync(file, 'utf8'))
    .split('\n')
    .filter((line) => ANY.test(line))

test('no `any` creeps back into src/ or scripts/', () => {
  const offenders: string[] = []
  for (const file of [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'scripts'))]) {
    const rel = relative(ROOT, file)
    const hits = anyLines(file)
    const budget = ALLOWED.get(rel) ?? 0
    if (hits.length > budget) {
      offenders.push(`${rel}: ${hits.length} (allowed ${budget})\n    ${hits.map((h) => h.trim()).join('\n    ')}`)
    }
  }
  expect(offenders.join('\n')).toBe('')
})

// An allowlist nobody prunes is how the next `any` gets in for free: the entry outlives the cast it
// excused, and the budget is sitting there when someone needs one.
test('the allowlist stays current — no entry excuses more than the file actually has', () => {
  const stale = [...ALLOWED].filter(([rel, budget]) => anyLines(join(ROOT, rel)).length < budget)
  expect(stale.map(([rel]) => rel)).toEqual([])
})
