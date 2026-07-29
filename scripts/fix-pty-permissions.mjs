#!/usr/bin/env node
// node-pty ships `spawn-helper` inside its npm tarball without the executable bit, so every fresh
// `npm install` produces a node-pty that loads fine and then fails every spawn with
// "posix_spawnp failed". Restoring the bit here is the whole fix.
//
// Only Unix builds have the helper; on Windows this finds nothing and exits quietly.
import { chmodSync, readdirSync, existsSync, lstatSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'

// npm hoists node-pty to the top of whatever tree fleetview lands in — `<prefix>/node_modules/
// node-pty`, next to fleetview rather than under it — and the npx cache is the same shape. A path
// built from this script's own location therefore finds nothing on a real install, which is how
// every published version so far shipped with the exec bit still missing. Resolving the module
// finds it wherever it was hoisted to; tests pass a fixture root as argv[2] instead.
const root = process.argv[2]
const prebuilds = root
  ? join(root, 'node_modules', 'node-pty', 'prebuilds')
  : resolvePrebuilds()

function resolvePrebuilds() {
  try {
    return join(dirname(createRequire(import.meta.url).resolve('node-pty/package.json')), 'prebuilds')
  } catch {
    return null // node-pty isn't installed (optional dependency of a degraded install)
  }
}

if (prebuilds && existsSync(prebuilds)) {
  for (const platform of readdirSync(prebuilds)) {
    const helper = join(prebuilds, platform, 'spawn-helper')
    // lstat, not existsSync: existsSync follows symlinks, so a symlinked spawn-helper would make us
    // chmod 0o755 its target. Only chmod a real regular file at this path.
    let stat
    try {
      stat = lstatSync(helper)
    } catch {
      continue // not present on this platform build
    }
    if (!stat.isFile()) continue
    try {
      chmodSync(helper, 0o755)
    } catch (error) {
      // A read-only or root-owned install tree is the user's to fix; say so rather than failing
      // the whole install.
      console.warn(`fleetview: could not make ${helper} executable (${error.code}); attaching may fail`)
    }
  }
}
