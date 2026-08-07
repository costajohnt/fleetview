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

// How far the process's start time may sit from when the run was recorded before the pid is
// presumed recycled. The two are written the same instant, so a genuine match is off by
// milliseconds and lstart only resolves to the second — the slack is for a clock stepped between
// dispatch and abort, not for either of those. A recycled pid is off by hours or days.
export const PID_MATCH_SLACK_MS = 60 * 1000

// Whether a live process still looks like the run whose pid was recorded. Both process-backed
// backends persist a pid past the life of the run (claude's meta for up to 30 days, copilot's lock
// across a crash), and the OS may have reused that pid for an unrelated process.
//
// The id-in-command check is the strongest signal and needs no clock: every run is spawned with
// the session id in its argv. Failing that, the process must look like the right binary and have
// started within PID_MATCH_SLACK_MS of when the run was recorded — a recycled pid is off by hours
// or days. `recordedAt` is the meta's startedAt or the lock's mtimeMs; `looksLike` is the
// backend-specific command predicate (e.g. `cmd => cmd.includes('claude') || cmd.startsWith('node')`).
//
// One-sided check on purpose: a recycled pid can only have started *after* the meta was written, so
// `info.startedAt - recordedAt` is positive for a genuine match and large-and-positive for a
// recycled one. A clock stepped backwards must not strand a live run unabortable.
export function sameRun(
  info: Exclude<PidInfo, 'unavailable' | null>,
  id: string,
  recordedAt: number,
  looksLike: (command: string) => boolean,
): boolean {
  if (info.command.includes(id)) return true
  return looksLike(info.command) && Number.isFinite(recordedAt) && info.startedAt - recordedAt <= PID_MATCH_SLACK_MS
}
