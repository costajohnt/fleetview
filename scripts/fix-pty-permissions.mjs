#!/usr/bin/env node
// node-pty ships `spawn-helper` inside its npm tarball without the executable bit, so every fresh
// `npm install` produces a node-pty that loads fine and then fails every spawn with
// "posix_spawnp failed". Restoring the bit here is the whole fix.
//
// Only Unix builds have the helper; on Windows this finds nothing and exits quietly.
import { closeSync, constants, fchmodSync, fstatSync, openSync, readdirSync, existsSync } from 'node:fs'
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
    // O_NOFOLLOW then fchmod on the descriptor, not lstat-then-chmod: the old pair proved a fact
    // about the path and then re-resolved it, so a symlink swapped in between the two calls got its
    // TARGET chmodded. The open refuses a symlink outright (ELOOP), and fchmod applies to the exact
    // file the open returned — there is no second path resolution to race.
    let fd
    try {
      fd = openSync(helper, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      // Absent on this platform build, or a planted symlink — neither is a file to fix.
      if (error.code === 'ENOENT' || error.code === 'ELOOP' || error.code === 'ENOTDIR') continue
      console.warn(`fleetview: could not make ${helper} executable (${error.code}); attaching may fail`)
      continue
    }
    try {
      if (fstatSync(fd).isFile()) fchmodSync(fd, 0o755)
    } catch (error) {
      // A read-only or root-owned install tree is the user's to fix; say so rather than failing
      // the whole install.
      console.warn(`fleetview: could not make ${helper} executable (${error.code}); attaching may fail`)
    } finally {
      closeSync(fd)
    }
  }
}
