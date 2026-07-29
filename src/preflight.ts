#!/usr/bin/env node
// The bin entry, and the only file that runs before fleetview's Node floor is checked.
//
// ESM imports are hoisted: everything cli.ts imports is parsed and evaluated before the first
// line of cli.ts's own body runs, so a version check there would still crash a Node 20 user on
// modern syntax somewhere in the import graph before it could say why. This file imports nothing
// but node: builtins, keeps its own syntax old enough for any Node that can run ESM at all, and
// reaches cli.js through a dynamic import that only evaluates once the gate passes.
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const MIN_NODE_MAJOR = 24

// Exported for the unit test; pure string math, no process access.
export function nodeVersionError(version: string): string | null {
  const major = parseInt(String(version).split('.')[0], 10)
  // An unrecognisable version string is not worth refusing to start over — let it through and let
  // whatever actually breaks say so.
  if (isNaN(major) || major >= MIN_NODE_MAJOR) return null
  return 'fleetview needs Node >= ' + MIN_NODE_MAJOR + ' (you have ' + version + '). Upgrade: https://nodejs.org or brew upgrade node'
}

// Same entry guard as cli.ts: realpath argv[1] before comparing, because node resolves the ESM
// main module's symlinks for import.meta.url while argv[1] stays the symlink npm's bin shim made.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const problem = nodeVersionError(process.versions.node)
  if (problem) {
    console.error(problem)
    process.exit(1)
  }
  import('./cli.ts').then((cli) => cli.main()).catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
