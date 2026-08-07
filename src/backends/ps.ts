// What ps knows about a live pid: when it started and what command line it is running. Both
// process-backed backends persist a pid past the life of the run it named (claude's run meta for up
// to thirty days, copilot's inuse lock across a crash), and the OS is free to hand that pid to an
// unrelated process — so before either backend group-SIGTERMs a stored pid, it asks whether the
// process still looks like the run the pid was recorded for.
import { execFileSync } from 'node:child_process'

// null = the pid does not exist (ps exited non-zero): the run already finished.
// 'unavailable' = ps itself is missing or does not speak this dialect (busybox has neither -o nor
// lstart): the caller cannot verify, which is not the same as verified-stale — refusing here would
// make every abort on such a host a silent no-op forever.
export type PidInfo = { startedAt: number; command: string } | 'unavailable' | null

export function psInfo(pid: number): PidInfo {
  // Non-positive pids are kill(2) wildcards (0 = own process group, -1 = everything signalable),
  // and a corrupt meta or lock is exactly where such a value would come from. Dead, not
  // 'unavailable': the caller must refuse to signal, not fall through to doing so. This chokepoint
  // covers every backend; the tiebreak probe below would otherwise run process.kill(0|-1, 0).
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  let out: string
  try {
    // lstart is a fixed five-token asctime date; command (the full argv, not the 15-char comm)
    // follows and may contain spaces. LC_ALL=C pins the month name to what Date.parse reads.
    // stderr is dropped: ps complains there about pids it rejects, and that would leak into
    // fleetview's alt-screen.
    out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart=,command='], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return 'unavailable' // no ps on the PATH at all
    // ps exits non-zero (with no error code) both for a dead pid and for options it does not speak
    // (busybox rejects -o lstart the same way it reports an absent pid). Signal 0 is the tiebreak:
    // a pid that demonstrably exists means the dialect, not the process, is what failed — without
    // this, every abort on such a host would read as "already finished" forever. EPERM counts as
    // exists: it is someone's process, just not ours to signal.
    try {
      process.kill(pid, 0)
      return 'unavailable'
    } catch (killErr) {
      return (killErr as NodeJS.ErrnoException)?.code === 'EPERM' ? 'unavailable' : null
    }
  }
  const tokens = out.trim().split(/\s+/)
  if (tokens.length < 6) return 'unavailable' // a ps that ignored the format string
  const startedAt = Date.parse(tokens.slice(0, 5).join(' '))
  if (!Number.isFinite(startedAt)) return 'unavailable'
  return { startedAt, command: tokens.slice(5).join(' ') }
}

// Whether a stored pid still looks like the run it was recorded for, i.e. whether abort() may
// signal it. Both process-backed backends persist a pid past the life of the run that named it, so
// the OS may have recycled it onto an unrelated process — which the group signal would kill.
//
// The argv carrying the session's id is the only accepted identity: every run is spawned with
// --session-id <id> or --resume(=)<id>, so a live run always shows it, where the old fallback (any
// claude/copilot-or-node born within a minute of the recorded time) accepted a whole class of
// processes and reopened the recycled-pid kill through that window. "No id in argv" is therefore
// refused rather than guessed at — including a ps that answered but cannot show argv. null (the
// run already finished) refuses too; 'unavailable' (no usable ps at all) passes, because
// unverifiable is not verified-stale, and refusing would make every abort on such a host a silent
// no-op forever.
export const sameRun = (info: PidInfo, id: string): boolean => info !== null && (info === 'unavailable' || info.command.includes(id))
