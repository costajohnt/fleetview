// The on-disk mechanics every state store shares (registry, roster-store, seen-store). Extracted
// verbatim from the three copies each carried — a fix to how fleetview writes a file must land once.
import { openSync, writeSync, fsyncSync, closeSync, mkdirSync, chmodSync, renameSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Prefer the fleetview dir under `parent`, but keep reading an existing pre-rename roost one until
// the user (or a future migration) moves it — a rename must not orphan anyone's roster or server.
// `parent` is ~/.config for the config stores and ~/.local/state for the seen watermarks.
export const fleetviewDir = (parent: string) => {
  const fresh = join(parent, 'fleetview')
  const legacy = join(parent, 'roost')
  return existsSync(fresh) || !existsSync(legacy) ? fresh : legacy
}

// mkdir-chmod-tmp-rename-0600, the way every state file is written:
// - mkdir's `mode` only applies when it creates the dir, so a pre-existing one keeps whatever perms
//   it had — re-tighten on every write. Best-effort: a dir we can't chmod is no reason to fail the
//   write, and the 0o600 file mode still applies.
// - writeFileSync's `mode` is likewise only honored when the file doesn't exist, so overwriting in
//   place left a pre-existing file stuck on whatever perms it was first created with. Renaming a
//   fresh 0o600 tmp file over it fixes perms on every write and gets write-atomicity as a side
//   effect: a concurrent reader sees either the old file or the new one, never half.
// - The tmp name is per-pid: two fleetview instances must not share a tmp inode.
export function atomicWrite(file: string, data: string) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  try {
    chmodSync(dirname(file), 0o700)
  } catch {}
  const tmp = `${file}.${process.pid}.tmp`
  // fsync the tmp file's data before the rename, so a crash can't leave a truncated roster.json that
  // loadRoster then throws on. writeFileSync alone returns once the data is in the page cache, not on
  // disk. mode 0o600 for the same perms-on-every-write reason as the rename below.
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file)
}
